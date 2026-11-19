/* Encoders for --transcode-videos (src/transcode.rs): VP9 through libvpx and Opus through libopus,
 * both already linked statically for decoding. A C shim keeps libvpx's large config and packet
 * structs out of the Rust FFI. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vpx/vpx_encoder.h>
#include <vpx/vp8cx.h>
#include <opus/opus.h>

typedef struct {
    vpx_codec_ctx_t ctx;
    vpx_image_t img;
    vpx_codec_iter_t iter;
    int w, h, cpu_used;
    unsigned long deadline;
    char err[256];
} powerboat_vp9enc;

static void set_err(powerboat_vp9enc *e, const char *what) {
    const char *d = vpx_codec_error_detail(&e->ctx);
    snprintf(e->err, sizeof e->err, "%s: %s%s%s", what, vpx_codec_error(&e->ctx), d ? " - " : "", d ? d : "");
}

/* Timestamps in 1/tb_den s units (tb_num 1). Realtime mode, one pass, no lag: packets come out
 * in input order. Returns NULL with *err set on failure. */
powerboat_vp9enc *powerboat_vp9enc_new(int w, int h, int tb_den, int kbps, int threads, int cpu_used, int kf_max, int cq, int good, char *err, int errlen) {
    powerboat_vp9enc *e = calloc(1, sizeof *e);
    vpx_codec_enc_cfg_t cfg;
    if (vpx_codec_enc_config_default(vpx_codec_vp9_cx(), &cfg, 0) != VPX_CODEC_OK) {
        snprintf(err, errlen, "vp9 config default failed");
        free(e);
        return NULL;
    }
    cfg.g_w = w;
    cfg.g_h = h;
    cfg.g_timebase.num = 1;
    cfg.g_timebase.den = tb_den;
    cfg.rc_target_bitrate = kbps;
    /* cq > 0: constant quality (VPX_Q, cq_level 0-63, like ffmpeg's -crf with -b:v 0). */
    cfg.rc_end_usage = cq > 0 ? VPX_Q : VPX_VBR;
    cfg.g_threads = threads;
    cfg.g_lag_in_frames = 0;
    cfg.g_pass = VPX_RC_ONE_PASS;
    cfg.kf_mode = VPX_KF_AUTO;
    cfg.kf_max_dist = kf_max;
    if (vpx_codec_enc_init(&e->ctx, vpx_codec_vp9_cx(), &cfg, 0) != VPX_CODEC_OK) {
        snprintf(err, errlen, "vp9 encoder init: %s", vpx_codec_error(&e->ctx));
        free(e);
        return NULL;
    }
    vpx_codec_control(&e->ctx, VP8E_SET_CPUUSED, cpu_used);
    if (cq > 0) vpx_codec_control(&e->ctx, VP8E_SET_CQ_LEVEL, cq);
    e->deadline = good ? VPX_DL_GOOD_QUALITY : VPX_DL_REALTIME;
    vpx_codec_control(&e->ctx, VP9E_SET_ROW_MT, 1);
    /* log2 tile columns: 2 tiles at 720p, which the decoder can thread over. */
    vpx_codec_control(&e->ctx, VP9E_SET_TILE_COLUMNS, w >= 1024 ? 1 : 0);
    e->w = w;
    e->h = h;
    e->cpu_used = cpu_used;
    vpx_img_wrap(&e->img, VPX_IMG_FMT_I420, w, h, 1, (unsigned char *)1);
    return e;
}

/* One I420 frame (y == NULL flushes). Returns 0 on success. */
int powerboat_vp9enc_encode(powerboat_vp9enc *e, const uint8_t *y, int sy, const uint8_t *u, int su, const uint8_t *v, int sv,
                       int64_t pts, unsigned long dur, int force_key) {
    vpx_image_t *img = NULL;
    if (y) {
        e->img.planes[VPX_PLANE_Y] = (unsigned char *)y;
        e->img.planes[VPX_PLANE_U] = (unsigned char *)u;
        e->img.planes[VPX_PLANE_V] = (unsigned char *)v;
        e->img.stride[VPX_PLANE_Y] = sy;
        e->img.stride[VPX_PLANE_U] = su;
        e->img.stride[VPX_PLANE_V] = sv;
        img = &e->img;
    }
    e->iter = NULL;
    if (vpx_codec_encode(&e->ctx, img, pts, dur, force_key ? VPX_EFLAG_FORCE_KF : 0, e->deadline) != VPX_CODEC_OK) {
        set_err(e, "vp9 encode");
        return -1;
    }
    return 0;
}

/* The next packet of the last encode call: 1 and the fields set, or 0 when there are no more. */
int powerboat_vp9enc_next(powerboat_vp9enc *e, const uint8_t **data, size_t *size, int64_t *pts, int *key) {
    const vpx_codec_cx_pkt_t *p;
    while ((p = vpx_codec_get_cx_data(&e->ctx, &e->iter)) != NULL) {
        if (p->kind != VPX_CODEC_CX_FRAME_PKT) continue;
        *data = p->data.frame.buf;
        *size = p->data.frame.sz;
        *pts = p->data.frame.pts;
        *key = (p->data.frame.flags & VPX_FRAME_IS_KEY) != 0;
        return 1;
    }
    return 0;
}

const char *powerboat_vp9enc_error(powerboat_vp9enc *e) { return e->err; }

void powerboat_vp9enc_free(powerboat_vp9enc *e) {
    if (!e) return;
    vpx_codec_destroy(&e->ctx);
    free(e);
}

/* Opus at 48 kHz. *lookahead gets the encoder delay in samples (OpusHead pre-skip). */
void *powerboat_opusenc_new(int channels, int kbps, int *lookahead) {
    int err = 0;
    OpusEncoder *o = opus_encoder_create(48000, channels, OPUS_APPLICATION_AUDIO, &err);
    if (err != OPUS_OK || !o) return NULL;
    opus_encoder_ctl(o, OPUS_SET_BITRATE(kbps * 1000));
    opus_int32 la = 0;
    opus_encoder_ctl(o, OPUS_GET_LOOKAHEAD(&la));
    *lookahead = la;
    return o;
}

/* One frame of `frame` samples per channel, interleaved; returns the packet length or < 0. */
int powerboat_opusenc_encode(void *o, const float *pcm, int frame, uint8_t *out, int max) {
    return opus_encode_float((OpusEncoder *)o, pcm, frame, out, max);
}

void powerboat_opusenc_free(void *o) { if (o) opus_encoder_destroy((OpusEncoder *)o); }
