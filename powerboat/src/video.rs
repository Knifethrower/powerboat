//! `<video>`: WebM (Matroska demux, VP8/VP9 through static libvpx, `vpx.rs` from retsurf-rmmv) and
//! MP4 (ISO BMFF demux, H.264 through OpenH264 built from source; B-frames come out of the decoder
//! in display order). The soundtrack (Vorbis, Opus-less WebM, AAC) is decoded once into an
//! AudioBuffer that JS plays through the mixer (the video clock follows the AudioContext clock).
//! Frames convert I420 -> RGBA8 on the CPU at most once per displayed frame; `texImage2D(video)`
//! uploads them (PIXI's VideoBaseTexture, OMORI's YSP_VideoPlayer, Construct's Video plugin) and
//! MV's DOM `<video>` (Graphics.playVideo) is drawn by `present_overlay`.

use std::collections::HashMap;
use std::io::Cursor;

use deno_core::{op2, OpState};
use glow::HasContext;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

use crate::ops::App;
use crate::vpx::{Decoder, Vpx};

struct Packet {
    t: f64,
    data: Vec<u8>,
}

enum Codec {
    Vpx(Vpx, Option<Decoder>),
    /// Packets stay in decode order; `pts` holds the display times sorted, and output frame n is
    /// shown at pts[n]. `head` is the avcC's SPS/PPS as Annex B, `nal_len` its length-field size.
    /// hw: libpmhwdec (hwdec.rs), tried first; hw_state 0 = not tried, 1 = in use, 2 = none or it
    /// refused this stream (OpenH264 then). hw_eos: the end of stream was sent to it.
    H264 { dec: Option<openh264::decoder::Decoder>, head: Vec<u8>, nal_len: usize, pts: Vec<f64>, out: usize, annexb: Vec<u8>, hw: Option<crate::hwdec::HwDec>, hw_state: u8, hw_eos: bool, hw_q: std::collections::VecDeque<(usize, Pending)> },
}

pub struct Video {
    codec: Codec,
    packets: Vec<Packet>,
    next: usize,
    pub w: u32,
    pub h: u32,
    pub duration: f64,
    /// The current frame: I420 planes for the GPU conversion (yuvgl.rs), or RGBA on the CPU path.
    frame: Frame,
    /// Display time of the current frame; -1 before the first.
    frame_t: f64,
    dirty: bool,
    /// Overlay texture + read framebuffer for present_overlay (lazily made).
    tex: Option<(glow::NativeTexture, glow::NativeFramebuffer)>,
    tex_stale: bool,
    /// The soundtrack is Opus: decoded by op_video_open through audio::decode.
    audio_opus: bool,
}

#[derive(Default)]
pub struct Videos {
    next: u32,
    map: HashMap<u32, Video>,
    /// MV's DOM video: (id, x, y, w, h in game-canvas pixels).
    pub overlay: Option<(u32, f32, f32, f32, f32)>,
    /// The GPU converter, made on first use (Err: it failed, the CPU path is used).
    gl: Option<Result<crate::yuvgl::YuvGl, ()>>,
}

impl Videos {
    pub fn get(&self, id: u32) -> Option<&Video> {
        self.map.get(&id)
    }
}

/// AVCDecoderConfigurationRecord -> (SPS/PPS as Annex B, NAL length-field size).
fn parse_avcc(r: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let bad = || "bad avcC".to_string();
    if r.len() < 7 {
        return Err(bad());
    }
    let nal_len = (r[4] & 3) as usize + 1;
    let mut head = Vec::new();
    let mut i = 5;
    for set in 0..2 {
        let n = if set == 0 { (*r.get(i).ok_or_else(bad)? & 0x1f) as usize } else { *r.get(i).ok_or_else(bad)? as usize };
        i += 1;
        for _ in 0..n {
            let l = u16::from_be_bytes([*r.get(i).ok_or_else(bad)?, *r.get(i + 1).ok_or_else(bad)?]) as usize;
            i += 2;
            head.extend_from_slice(&[0, 0, 0, 1]);
            head.extend_from_slice(r.get(i..i + l).ok_or_else(bad)?);
            i += l;
        }
    }
    Ok((head, nal_len))
}

/// Length-prefixed NAL units (MP4) -> Annex B start codes.
fn to_annexb(data: &[u8], nal_len: usize, out: &mut Vec<u8>) {
    let mut i = 0;
    while i + nal_len <= data.len() {
        let mut l = 0usize;
        for b in &data[i..i + nal_len] {
            l = (l << 8) | *b as usize;
        }
        i += nal_len;
        let end = (i + l).min(data.len());
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&data[i..end]);
        i = end;
    }
}

/// Demuxes a whole WebM or MP4 file. Returns the video, plus the decoded soundtrack (rate, channels).
fn open(data: Vec<u8>) -> Result<(Video, Option<(u32, Vec<Vec<f32>>)>), String> {
    let mp4 = data.len() > 8 && &data[4..8] == b"ftyp";
    let mss = MediaSourceStream::new(Box::new(Cursor::new(data)), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    hint.with_extension(if mp4 { "mp4" } else { "webm" });
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("probe: {e}"))?;
    let vtrack = format.default_track(TrackType::Video).ok_or("no video track")?;
    let vid = vtrack.id;
    let vtb = vtrack.time_base;
    let Some(CodecParameters::Video(vp)) = vtrack.codec_params.clone() else { return Err("no video codec params".into()) };
    use symphonia::core::codecs::video::well_known::*;
    let mut codec = match vp.codec {
        CODEC_ID_VP8 => Codec::Vpx(Vpx::Vp8, None),
        CODEC_ID_VP9 => Codec::Vpx(Vpx::Vp9, None),
        CODEC_ID_H264 => {
            let rec = vp.extra_data.iter().find(|e| e.id == extra_data::VIDEO_EXTRA_DATA_ID_AVC_DECODER_CONFIG).ok_or("H.264 without avcC")?;
            let (head, nal_len) = parse_avcc(&rec.data)?;
            Codec::H264 { dec: None, head, nal_len, pts: Vec::new(), out: 0, annexb: Vec::new(), hw: None, hw_state: 0, hw_eos: false, hw_q: Default::default() }
        }
        c => return Err(format!("unsupported video codec {c:?}")),
    };
    let (w, h) = (vp.width.unwrap_or(0) as u32, vp.height.unwrap_or(0) as u32);
    let atrack = format.default_track(TrackType::Audio).map(|t| (t.id, t.codec_params.clone()));
    // Opus (our own --transcode-videos WebM): symphonia has no Opus decoder; op_video_open decodes
    // that soundtrack with audio::decode (libopus) instead.
    let audio_opus = matches!(&atrack, Some((_, Some(CodecParameters::Audio(ap)))) if ap.codec == symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS);
    let mut adec = match &atrack {
        _ if audio_opus => None,
        Some((_, Some(CodecParameters::Audio(ap)))) => symphonia::default::get_codecs()
            .make_audio_decoder(ap, &Default::default())
            .map_err(|e| eprintln!("[powerboat] video soundtrack not decodable: {e}"))
            .ok(),
        _ => None,
    };
    let aid = atrack.as_ref().map(|a| a.0);
    let mut packets = Vec::new();
    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut arate = 0u32;
    let mut inter: Vec<f32> = Vec::new();
    loop {
        let p = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(symphonia::core::errors::Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                eprintln!("[powerboat] video demux stopped: {e}");
                break;
            }
        };
        if p.track_id == vid {
            let t = vtb.map(|tb| tb.calc_time_saturating(p.pts).as_secs_f64()).unwrap_or(0.0);
            packets.push(Packet { t, data: p.data.to_vec() });
        } else if Some(p.track_id) == aid {
            if let Some(dec) = adec.as_mut() {
                if let Ok(buf) = dec.decode(&p) {
                    let n = buf.num_planes();
                    if n > 0 && buf.frames() > 0 {
                        arate = buf.spec().rate();
                        if channels.len() != n {
                            channels = vec![Vec::new(); n];
                        }
                        buf.copy_to_vec_interleaved::<f32>(&mut inter);
                        for (i, s) in inter.iter().enumerate() {
                            channels[i % n].push(*s);
                        }
                    }
                }
            }
        }
    }
    if packets.is_empty() {
        return Err("no video packets".into());
    }
    let cmp = |a: &f64, b: &f64| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    let times: Vec<f64> = match &mut codec {
        Codec::Vpx(..) => {
            packets.sort_by(|a, b| cmp(&a.t, &b.t));
            packets.iter().map(|p| p.t).collect()
        }
        Codec::H264 { pts, .. } => {
            // Display order; the first frame is shown from 0 (edit lists shift pts by the B-frame delay).
            let mut t: Vec<f64> = packets.iter().map(|p| p.t).collect();
            t.sort_by(cmp);
            let t0 = t[0];
            t.iter_mut().for_each(|x| *x -= t0);
            *pts = t.clone();
            t
        }
    };
    let last = *times.last().unwrap_or(&0.0);
    let step = if times.len() > 1 { (last - times[0]) / (times.len() - 1) as f64 } else { 1.0 / 30.0 };
    let mut duration = last + step;
    let audio = if channels.is_empty() { None } else { Some((arate, channels)) };
    if let Some((r, ch)) = &audio {
        duration = duration.max(ch[0].len() as f64 / *r as f64);
    }
    let v = Video {
        codec,
        packets,
        next: 0,
        w,
        h,
        duration,
        frame: Frame::new(w as usize, h as usize),
        frame_t: -1.0,
        dirty: false,
        tex: None,
        tex_stale: true,
        audio_opus,
    };
    Ok((v, audio))
}

/// Size and frame rate of a file's video track (demux only, nothing decoded), for --transcode-videos:
/// None for a file without one (most .webm files of a Construct export are sound).
pub fn probe(data: Vec<u8>) -> Option<(u32, u32, f64)> {
    let mp4 = data.len() > 8 && &data[4..8] == b"ftyp";
    let mss = MediaSourceStream::new(Box::new(Cursor::new(data)), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    hint.with_extension(if mp4 { "mp4" } else { "webm" });
    let mut format = symphonia::default::get_probe().probe(&hint, mss, FormatOptions::default(), MetadataOptions::default()).ok()?;
    let track = format.default_track(TrackType::Video)?;
    let (vid, tb) = (track.id, track.time_base);
    let Some(CodecParameters::Video(vp)) = track.codec_params.clone() else { return None };
    let (w, h) = (vp.width.unwrap_or(0) as u32, vp.height.unwrap_or(0) as u32);
    let mut times = Vec::new();
    while let Ok(Some(p)) = format.next_packet() {
        if p.track_id == vid {
            times.push(tb.map(|tb| tb.calc_time_saturating(p.pts).as_secs_f64()).unwrap_or(0.0));
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let fps = if times.len() > 1 && times[times.len() - 1] > times[0] { (times.len() - 1) as f64 / (times[times.len() - 1] - times[0]) } else { 0.0 };
    Some((w, h, fps))
}

/// Every frame of a video in display order with its time, for --transcode-videos (transcode.rs).
/// Returns width, height, duration and the decoded soundtrack (rate, channels), if any.
pub fn decode_frames(data: Vec<u8>, mut each: impl FnMut(&crate::vpx::Picture, f64) -> Result<(), String>) -> Result<(u32, u32, f64, Option<(u32, Vec<Vec<f32>>)>), String> {
    let (mut v, audio) = open(data)?;
    let (w, h) = (v.w as usize, v.h as usize);
    match &mut v.codec {
        Codec::Vpx(kind, _) => {
            let mut dec = Decoder::new(*kind)?;
            for p in &v.packets {
                let mut r = Ok(());
                dec.decode(&p.data, |pic| {
                    if r.is_ok() && pic.width == w && pic.height == h {
                        r = each(&pic, p.t);
                    }
                })?;
                r?;
            }
        }
        Codec::H264 { head, nal_len, pts, .. } => {
            use openh264::decoder::{DecodeOptions, DecoderConfig, Flush};
            use openh264::formats::YUVSource;
            let cfg = DecoderConfig::new().flush_after_decode(Flush::NoFlush);
            let mut d = openh264::decoder::Decoder::with_api_config(openh264::OpenH264API::from_source(), cfg).map_err(|e| format!("openh264: {e}"))?;
            let step = if pts.len() > 1 { (pts[pts.len() - 1] - pts[0]) / (pts.len() - 1) as f64 } else { 1.0 / 30.0 };
            let mut n = 0usize;
            let mut emit = |yuv: &openh264::decoder::DecodedYUV, n: &mut usize| -> Result<(), String> {
                let t = pts.get(*n).copied().unwrap_or_else(|| pts.last().copied().unwrap_or(0.0) + step * (*n + 1 - pts.len()) as f64);
                *n += 1;
                if yuv.dimensions() != (w, h) {
                    return Ok(());
                }
                let (sy, su, sv) = yuv.strides();
                let pic = crate::vpx::Picture { width: w, height: h, planes: [yuv.y(), yuv.u(), yuv.v()], strides: [sy, su, sv] };
                each(&pic, t)
            };
            let mut buf = Vec::new();
            for (i, p) in v.packets.iter().enumerate() {
                buf.clear();
                if i == 0 {
                    buf.extend_from_slice(head);
                }
                to_annexb(&p.data, *nal_len, &mut buf);
                match d.decode_with_options(&buf, DecodeOptions::new().flush_after_decode(Flush::NoFlush)) {
                    Ok(Some(yuv)) => emit(&yuv, &mut n)?,
                    Ok(None) => {}
                    Err(e) => eprintln!("[powerboat] h264 frame {i}: {e}"),
                }
            }
            for yuv in d.flush_remaining().map_err(|e| format!("openh264 flush: {e}"))? {
                emit(&yuv, &mut n)?;
            }
        }
    }
    Ok((v.w, v.h, v.duration, audio))
}

impl Video {
    fn rewind(&mut self) {
        match &mut self.codec {
            Codec::Vpx(_, dec) => *dec = None,
            Codec::H264 { dec, out, hw, hw_state, hw_eos, hw_q, .. } => {
                *dec = None;
                *out = 0;
                hw_q.clear();
                // A hardware decoder is opened again from the first key frame.
                *hw = None;
                *hw_eos = false;
                if *hw_state == 1 {
                    *hw_state = 0;
                }
            }
        }
        self.next = 0;
        self.frame_t = -1.0;
    }
    /// Decodes up to time t (seconds). Returns true if the displayed frame changed.
    fn advance(&mut self, t: f64) -> Result<bool, String> {
        if t < self.frame_t {
            // Seek back: restart from the first keyframe (OMORI's movies are short).
            self.rewind();
        }
        let shown = match self.codec {
            Codec::Vpx(..) => self.advance_vpx(t)?,
            Codec::H264 { .. } => self.advance_h264(t)?,
        };
        if shown {
            self.dirty = true;
            self.tex_stale = true;
        }
        Ok(shown)
    }

    fn advance_vpx(&mut self, t: f64) -> Result<bool, String> {
        let Codec::Vpx(kind, dec) = &mut self.codec else { unreachable!() };
        if self.next >= self.packets.len() || self.packets[self.next].t > t {
            return Ok(false);
        }
        if dec.is_none() {
            *dec = Some(Decoder::new(*kind)?);
        }
        // Frames that will be overwritten before display still have to be decoded (inter
        // frames), but only the last one is converted.
        let mut shown = false;
        let (w, h) = (self.w as usize, self.h as usize);
        while self.next < self.packets.len() && self.packets[self.next].t <= t {
            let last = self.next + 1 >= self.packets.len() || self.packets[self.next + 1].t > t;
            let pkt = &self.packets[self.next];
            let frame = &mut self.frame;
            let mut got = false;
            dec.as_mut().unwrap().decode(&pkt.data, |pic| {
                if last && pic.width == w && pic.height == h {
                    frame.store(&pic, h >= 720);
                    got = true;
                }
            })?;
            if got {
                shown = true;
                self.frame_t = pkt.t;
            }
            self.next += 1;
        }
        Ok(shown)
    }

    fn advance_h264(&mut self, t: f64) -> Result<bool, String> {
        use openh264::decoder::{DecodeOptions, DecoderConfig, Flush};
        use openh264::formats::YUVSource;
        let Codec::H264 { dec, head, nal_len, pts, out, annexb, hw, hw_state, hw_eos, hw_q } = &mut self.codec else { unreachable!() };
        // Output frames due by t; only the last of them is converted.
        let target = pts.partition_point(|&p| p <= t);
        let (w, h) = (self.w as usize, self.h as usize);
        let bt709 = h >= 720;
        // The hardware decoder can hand out several pictures for one packet (B-frame reordering, pipelining):
        // the ones ahead of their time wait in hw_q as NV12 copies and are shown when due.
        let mut queued = false;
        while hw_q.front().is_some_and(|q| q.0 <= target) {
            let q = hw_q.pop_front().unwrap();
            if hw_q.front().is_none_or(|n| n.0 > target) {
                match q.1 {
                    Pending::Held(p) => self.frame.hold(p, bt709),
                    Pending::Copy(planes) => self.frame.put_nv12(planes, bt709),
                }
                self.frame_t = pts[q.0 - 1];
                queued = true;
            }
        }
        if target <= *out {
            return Ok(queued);
        }
        if *hw_state == 0 {
            *hw = crate::hwdec::HwDec::open(crate::hwdec::CODEC_H264, self.w, self.h);
            *hw_state = if hw.is_some() { 1 } else { 2 };
        }
        if *hw_state == 1 {
            let mut count = *out;
            let mut shown = false;
            let frame = &mut self.frame;
            let d = hw.as_mut().unwrap();
            let mut refused = false;
            while count < target {
                let data = if self.next < self.packets.len() {
                    annexb.clear();
                    if self.next == 0 {
                        annexb.extend_from_slice(head);
                    }
                    to_annexb(&self.packets[self.next].data, *nal_len, annexb);
                    self.next += 1;
                    Some(&annexb[..])
                } else if !*hw_eos {
                    *hw_eos = true;
                    None
                } else {
                    count = target;
                    continue;
                };
                let pts = if data.is_some() { self.next as i64 } else { 0 };
                let hold = d.hold;
                let mut r = d.send(data, pts, &mut |p| take_hw(p, hold, &mut count, target, (w, h), bt709, &mut shown, frame, hw_q));
                if r == crate::hwdec::PMHW_AGAIN {
                    // Every decoder buffer is held here: keep copies instead and send the unit again.
                    release_held(frame, hw_q);
                    r = d.send(data, pts, &mut |p| take_hw(p, hold, &mut count, target, (w, h), bt709, &mut shown, frame, hw_q));
                }
                if r == crate::hwdec::PMHW_UNSUPPORTED {
                    refused = true;
                    break;
                }
            }
            if !refused {
                *out = count;
                if shown {
                    self.frame_t = pts[target - 1];
                }
                return Ok(shown || queued);
            }
            // This stream is not for the hardware: OpenH264 from the start.
            eprintln!("[powerboat] video: hardware decoder refused the stream, decoding in software");
            *hw = None;
            *hw_state = 2;
            self.next = 0;
            *out = 0;
        }
        if dec.is_none() {
            // Single-threaded: OpenH264's threaded decoder (num_threads) crashed at 2 and 4 threads.
            let cfg = DecoderConfig::new().flush_after_decode(Flush::NoFlush);
            *dec = Some(openh264::decoder::Decoder::with_api_config(openh264::OpenH264API::from_source(), cfg).map_err(|e| format!("openh264: {e}"))?);
        }
        let d = dec.as_mut().unwrap();
        let mut shown = false;
        let frame = &mut self.frame;
        let mut take = |yuv: &openh264::decoder::DecodedYUV, out: &mut usize| {
            *out += 1;
            if *out == target && yuv.dimensions() == (w, h) {
                let (sy, su, sv) = yuv.strides();
                let pic = crate::vpx::Picture { width: w, height: h, planes: [yuv.y(), yuv.u(), yuv.v()], strides: [sy, su, sv] };
                frame.store(&pic, bt709);
                shown = true;
            }
        };
        while *out < target {
            if self.next < self.packets.len() {
                annexb.clear();
                if self.next == 0 {
                    annexb.extend_from_slice(head);
                }
                to_annexb(&self.packets[self.next].data, *nal_len, annexb);
                self.next += 1;
                match d.decode_with_options(annexb, DecodeOptions::new().flush_after_decode(Flush::NoFlush)) {
                    Ok(Some(yuv)) => take(&yuv, out),
                    Ok(None) => {}
                    // A damaged frame: skip it rather than stop the movie.
                    Err(e) => eprintln!("[powerboat] h264 frame {}: {e}", self.next - 1),
                }
            } else {
                // End of stream: the reorder buffer still holds the last frames.
                let rest = d.flush_remaining().map_err(|e| format!("openh264 flush: {e}"))?;
                if rest.is_empty() {
                    *out = target;
                    break;
                }
                for yuv in &rest {
                    take(yuv, out);
                }
            }
        }
        if shown {
            self.frame_t = pts[target - 1];
        }
        Ok(shown)
    }
}

/// One decoded frame. GPU mode keeps the planes tightly packed (a copy, cheaper than converting)
/// and converts when a texture wants it; CPU mode converts to RGBA right away.
struct Frame {
    gpu: bool,
    w: usize,
    h: usize,
    yuv: [Vec<u8>; 3],
    bt709: bool,
    /// yuv holds NV12 (Y, interleaved UV; hardware decoders) instead of I420.
    nv12: bool,
    rgba: Vec<u8>,
    /// rgba is out of date with yuv (filled on demand).
    rgba_stale: bool,
    /// The hardware decoder's picture shown now (zero-copy on the GPU path); yuv_stale: yuv not copied from it yet.
    held: Option<crate::hwdec::Held>,
    yuv_stale: bool,
    /// The held picture was drawn from its dmabuf: the GPU may still read it until this fence (None with
    /// gpu_used: no fences here, glFinish instead).
    held_fence: Option<glow::NativeFence>,
    held_gpu: bool,
    /// Pictures replaced after a zero-copy draw: back to the decoder only once the GPU is done with them
    /// (a put while a draw is in flight let kbase re-map the pages under cedar's cache flush, and lets the
    /// engine overwrite a frame the GPU still reads).
    retired: Vec<(crate::hwdec::Held, Option<glow::NativeFence>)>,
}

/// A hardware picture that came out ahead of its time.
enum Pending {
    Held(crate::hwdec::Held),
    Copy([Vec<u8>; 2]),
}

/// One picture from the hardware decoder: the one due now is shown, later ones wait in hw_q (in the
/// decoder's buffers for up to two, as copies beyond that: the buffer pool is small).
#[allow(clippy::too_many_arguments)]
fn take_hw(p: crate::hwdec::Held, hold: bool, count: &mut usize, target: usize, (w, h): (usize, usize), bt709: bool, shown: &mut bool, frame: &mut Frame, hw_q: &mut std::collections::VecDeque<(usize, Pending)>) {
    *count += 1;
    if p.width as usize != w || p.height as usize != h {
        return;
    }
    if *count == target {
        frame.hold(p, bt709);
        if !hold {
            frame.unhold(); // copied out, the buffer goes back now
        }
        *shown = true;
    } else if *count > target {
        if hw_q.len() >= 8 {
            hw_q.pop_front();
        }
        let held = hw_q.iter().filter(|q| matches!(q.1, Pending::Held(_))).count();
        let e = if hold && held < 2 {
            Pending::Held(p)
        } else {
            let mut planes = [Vec::new(), Vec::new()];
            copy_nv12(&p, w, h, &mut planes);
            Pending::Copy(planes)
        };
        hw_q.push_back((*count, e));
    }
}

/// Gives every held picture back to the decoder, keeping copies.
fn release_held(frame: &mut Frame, hw_q: &mut std::collections::VecDeque<(usize, Pending)>) {
    frame.unhold();
    for q in hw_q.iter_mut() {
        if let Pending::Held(p) = &q.1 {
            let mut planes = [Vec::new(), Vec::new()];
            copy_nv12(p, p.width as usize, p.height as usize, &mut planes);
            q.1 = Pending::Copy(planes);
        }
    }
}

impl Frame {
    fn new(w: usize, h: usize) -> Self {
        let gpu = crate::yuvgl::enabled();
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        Frame {
            gpu,
            w,
            h,
            yuv: if gpu { [vec![0; w * h], vec![0; cw * ch], vec![0; cw * ch]] } else { [Vec::new(), Vec::new(), Vec::new()] },
            bt709: false,
            nv12: false,
            rgba: if gpu { Vec::new() } else { vec![0; w * h * 4] },
            rgba_stale: false,
            held: None,
            yuv_stale: false,
            held_fence: None,
            held_gpu: false,
            retired: Vec::new(),
        }
    }
    fn store(&mut self, pic: &crate::vpx::Picture, bt709: bool) {
        self.retire();
        self.yuv_stale = false;
        self.bt709 = bt709;
        if self.nv12 {
            // Back from NV12 (a hardware decoder gave up): I420 planes again.
            self.nv12 = false;
            let n = self.w.div_ceil(2) * self.h.div_ceil(2);
            self.yuv = if self.gpu { [vec![0; self.w * self.h], vec![0; n], vec![0; n]] } else { [Vec::new(), Vec::new(), Vec::new()] };
            if !self.gpu && self.rgba.len() != self.w * self.h * 4 {
                self.rgba = vec![0; self.w * self.h * 4];
            }
            self.rgba_stale = false;
        }
        if !self.gpu {
            i420_to_rgba(pic, &mut self.rgba, bt709);
            return;
        }
        let t0 = std::time::Instant::now();
        let (cw, ch) = (self.w.div_ceil(2), self.h.div_ceil(2));
        for (i, (pw, ph)) in [(self.w, self.h), (cw, ch), (cw, ch)].into_iter().enumerate() {
            let (src, stride, dst) = (pic.planes[i], pic.strides[i], &mut self.yuv[i]);
            for y in 0..ph {
                dst[y * pw..(y + 1) * pw].copy_from_slice(&src[y * stride..y * stride + pw]);
            }
        }
        self.rgba_stale = true;
        prof_add(1, t0.elapsed().as_nanos() as u64);
        prof_add(3, 1);
    }
    /// A hardware decoder's NV12 picture becomes the current frame, kept in the decoder's buffer: the GPU
    /// path imports its dmabuf, everything else copies it out first (ensure_yuv).
    fn hold(&mut self, p: crate::hwdec::Held, bt709: bool) {
        self.retire();
        self.held = Some(p);
        self.nv12 = true;
        self.bt709 = bt709;
        self.yuv_stale = true;
        self.rgba_stale = true;
        prof_add(3, 1);
    }
    /// The held picture's visible area into yuv (whole rows copied: the planes may be uncached memory).
    fn ensure_yuv(&mut self) {
        if !self.yuv_stale {
            return;
        }
        self.yuv_stale = false;
        let Some(p) = self.held.as_ref() else { return };
        let (w, h) = (self.w, self.h);
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        if self.yuv[0].len() != w * h || self.yuv[1].len() != cw * ch * 2 {
            self.yuv = [vec![0; w * h], vec![0; cw * ch * 2], Vec::new()];
        }
        let [y, uv, _] = &mut self.yuv;
        copy_nv12_into(p, w, h, y, uv);
        // (timed as part of texImage2D, where it runs)
    }
    /// The held picture leaves the frame: straight back to the decoder unless the GPU drew from it.
    fn retire(&mut self) {
        let fence = self.held_fence.take();
        let gpu = std::mem::take(&mut self.held_gpu);
        if let Some(p) = self.held.take() {
            if gpu {
                self.retired.push((p, fence));
            }
        }
    }
    /// Retired pictures go back once their draws are done (GL thread).
    fn reap(&mut self, gl: &glow::Context) {
        if self.retired.is_empty() {
            return;
        }
        unsafe {
            let mut finished = false;
            for (_, fence) in &self.retired {
                match fence {
                    Some(f) => {
                        gl.client_wait_sync(*f, glow::SYNC_FLUSH_COMMANDS_BIT, 200_000_000);
                        gl.delete_sync(*f);
                    }
                    None if !finished => {
                        gl.finish();
                        finished = true;
                    }
                    None => {}
                }
            }
        }
        self.retired.clear(); // Held::drop: pmhw_put
    }
    /// The held picture goes back to the decoder (copied out first).
    fn unhold(&mut self) {
        self.ensure_yuv();
        self.retire();
    }
    /// A queued NV12 copy (copy_nv12) becomes the current frame.
    fn put_nv12(&mut self, planes: [Vec<u8>; 2], bt709: bool) {
        self.retire();
        self.yuv_stale = false;
        let [y, uv] = planes;
        self.yuv = [y, uv, Vec::new()];
        self.nv12 = true;
        self.bt709 = bt709;
        self.rgba_stale = true;
        prof_add(3, 1);
    }
    /// RGBA on the CPU (the GPU path's fallback, and NV12 frames on the CPU path).
    fn rgba(&mut self) -> &[u8] {
        self.ensure_yuv();
        if self.rgba_stale {
            if self.rgba.len() != self.w * self.h * 4 {
                self.rgba = vec![0; self.w * self.h * 4];
            }
            let cw = self.w.div_ceil(2);
            if self.nv12 {
                let (u, v): (Vec<u8>, Vec<u8>) = self.yuv[1].chunks_exact(2).map(|c| (c[0], c[1])).unzip();
                let pic = crate::vpx::Picture { width: self.w, height: self.h, planes: [&self.yuv[0], &u, &v], strides: [self.w, cw, cw] };
                i420_to_rgba_inner(&pic, &mut self.rgba, self.bt709);
            } else {
                let pic = crate::vpx::Picture { width: self.w, height: self.h, planes: [&self.yuv[0], &self.yuv[1], &self.yuv[2]], strides: [self.w, cw, cw] };
                i420_to_rgba_inner(&pic, &mut self.rgba, self.bt709);
            }
            self.rgba_stale = false;
        }
        &self.rgba
    }
}

/// Converts the current frame into `dst` on the GPU when that path is on. False: use RGBA.
fn convert_on_gpu(videos_gl: &mut Option<Result<crate::yuvgl::YuvGl, ()>>, gl: &glow::Context, f: &mut Frame, flip: bool, dst: glow::NativeTexture) -> bool {
    if !f.gpu {
        return false;
    }
    if videos_gl.is_none() {
        *videos_gl = Some(crate::yuvgl::YuvGl::new(gl).map_err(|e| eprintln!("[powerboat] video GPU conversion off: {e}")));
    }
    let Some(Ok(y)) = videos_gl.as_mut() else { return false };
    let zero_copy = f.held.as_ref().is_some_and(|p| y.convert_dmabuf(gl, p, f.w, f.h, f.bt709, flip, dst));
    if zero_copy {
        let fence = unsafe { gl.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0) }.ok();
        if let Some(old) = std::mem::replace(&mut f.held_fence, fence) {
            unsafe { gl.delete_sync(old) };
        }
        f.held_gpu = true;
    } else {
        f.ensure_yuv();
        y.convert(gl, &f.yuv, f.w, f.h, f.bt709, f.nv12, flip, dst);
    }
    // this frame's import re-targeted the external texture: the pictures before it are no longer bound
    f.reap(gl);
    dump_frame(gl, dst, f.w, f.h);
    true
}

/// POWERBOAT_VIDEO_DUMP=<n>: the n-th frame converted on the GPU (counted over all videos) is read back and
/// written as a quarter-size PPM to POWERBOAT_VIDEO_DUMP_FILE (default video_dump.ppm), to compare the
/// zero-copy and upload paths' colors (POWERBOAT_VIDEO_ZEROCOPY=0).
fn dump_frame(gl: &glow::Context, dst: glow::NativeTexture, w: usize, h: usize) {
    thread_local! {
        static N: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }
    let Some(want) = std::env::var("POWERBOAT_VIDEO_DUMP").ok().and_then(|v| v.parse::<u64>().ok()) else { return };
    let n = N.with(|c| {
        c.set(c.get() + 1);
        c.get()
    });
    if n != want {
        return;
    }
    let mut px = vec![0u8; w * h * 4];
    unsafe {
        let read = gl.get_parameter_i32(glow::READ_FRAMEBUFFER_BINDING) as u32;
        let Ok(fbo) = gl.create_framebuffer() else { return };
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
        gl.framebuffer_texture_2d(glow::READ_FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(dst), 0);
        gl.read_pixels(0, 0, w as i32, h as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut px)));
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, std::num::NonZeroU32::new(read).map(glow::NativeFramebuffer));
        gl.delete_framebuffer(fbo);
    }
    let (qw, qh) = (w / 4, h / 4);
    let mut out = format!("P6\n{qw} {qh}\n255\n").into_bytes();
    for y in 0..qh {
        for x in 0..qw {
            let i = ((y * 4) * w + x * 4) * 4;
            out.extend_from_slice(&px[i..i + 3]);
        }
    }
    let path = std::env::var("POWERBOAT_VIDEO_DUMP_FILE").unwrap_or_else(|_| "video_dump.ppm".into());
    match std::fs::write(&path, out) {
        Ok(()) => eprintln!("[powerboat] video: frame {n} ({w}x{h}) dumped to {path} at quarter size"),
        Err(e) => eprintln!("[powerboat] video: dump to {path}: {e}"),
    }
}

// POWERBOAT_VIDEO_PROFILE=1: per video, time in advance (decode + convert), in the RGBA conversion, and
// in texImage2D(video) uploads; printed when the video closes.
thread_local! {
    static PROF: std::cell::Cell<(u64, u64, u64, u64)> = const { std::cell::Cell::new((0, 0, 0, 0)) };
}
fn prof_add(i: usize, ns: u64) {
    PROF.with(|p| {
        let mut v = p.get();
        match i {
            0 => v.0 += ns,
            1 => v.1 += ns,
            2 => v.2 += ns,
            _ => v.3 += ns,
        }
        p.set(v);
    });
}

/// Limited range: BT.601 (the VP8 default) or BT.709 (HD H.264); integer math. Large pictures are
/// split over four threads (a 1080p frame is 2M pixels).
fn i420_to_rgba(pic: &crate::vpx::Picture, out: &mut [u8], bt709: bool) {
    let t0 = std::time::Instant::now();
    i420_to_rgba_inner(pic, out, bt709);
    prof_add(1, t0.elapsed().as_nanos() as u64);
    prof_add(3, 1);
}
fn i420_to_rgba_inner(pic: &crate::vpx::Picture, out: &mut [u8], bt709: bool) {
    let (w, h) = (pic.width, pic.height);
    // (r_v, g_u, g_v, b_u) in 8.8 fixed point.
    let k: (i32, i32, i32, i32) = if bt709 { (459, 55, 136, 541) } else { (409, 100, 208, 516) };
    let rows = |y0: usize, out: &mut [u8]| {
        for (i, o) in out.chunks_exact_mut(w * 4).enumerate() {
            let y = y0 + i;
            let yrow = &pic.planes[0][y * pic.strides[0]..];
            let urow = &pic.planes[1][(y / 2) * pic.strides[1]..];
            let vrow = &pic.planes[2][(y / 2) * pic.strides[2]..];
            for x in 0..w {
                let c = (yrow[x] as i32 - 16) * 298;
                let d = urow[x / 2] as i32 - 128;
                let e = vrow[x / 2] as i32 - 128;
                let r = (c + k.0 * e + 128) >> 8;
                let g = (c - k.1 * d - k.2 * e + 128) >> 8;
                let b = (c + k.3 * d + 128) >> 8;
                let px = &mut o[x * 4..x * 4 + 4];
                px[0] = r.clamp(0, 255) as u8;
                px[1] = g.clamp(0, 255) as u8;
                px[2] = b.clamp(0, 255) as u8;
                px[3] = 255;
            }
        }
    };
    let out = &mut out[..w * h * 4];
    if w * h < 512 * 1024 {
        return rows(0, out);
    }
    let band = h.div_ceil(4);
    std::thread::scope(|s| {
        for (i, chunk) in out.chunks_mut(band * w * 4).enumerate() {
            let rows = &rows;
            s.spawn(move || rows(i * band, chunk));
        }
    });
}

/// Draws MV's DOM video over the game picture (called after the FBO blit). `game` is the window
/// rect the game canvas occupies, `canvas` the canvas size.
pub fn present_overlay(app: &mut App, game: (i32, i32, i32, i32), canvas: (u32, u32)) {
    let Some((id, x, y, w, h)) = app.videos.overlay else { return };
    let gl = &app.gl;
    let Some(v) = app.videos.map.get_mut(&id) else { return };
    if v.frame_t < 0.0 {
        return;
    }
    unsafe {
        if v.tex.is_none() {
            let (Ok(tex), Ok(fbo)) = (gl.create_texture(), gl.create_framebuffer()) else { return };
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, v.w as i32, v.h as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
            gl.framebuffer_texture_2d(glow::READ_FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
            v.tex = Some((tex, fbo));
            v.tex_stale = true;
        }
        let (tex, fbo) = v.tex.unwrap();
        if v.tex_stale {
            if !convert_on_gpu(&mut app.videos.gl, gl, &mut v.frame, false, tex) {
                gl.bind_texture(glow::TEXTURE_2D, Some(tex));
                gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
                gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, v.w as i32, v.h as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(v.frame.rgba())));
            }
            v.tex_stale = false;
        }
        gl.bind_texture(glow::TEXTURE_2D, None);
        // Canvas pixels -> window pixels; GL's y runs up.
        let (gx, gy, gw, gh) = game;
        let sx = gw as f32 / canvas.0 as f32;
        let sy = gh as f32 / canvas.1 as f32;
        let x0 = gx + (x * sx).round() as i32;
        let x1 = gx + ((x + w) * sx).round() as i32;
        let wh = app.height as i32;
        let y_top = gy + (y * sy).round() as i32;
        let y_bot = gy + ((y + h) * sy).round() as i32;
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
        // The texture's row 0 is the picture's top: flip by swapping the destination's y.
        gl.blit_framebuffer(0, 0, v.w as i32, v.h as i32, x0, wh - y_top, x1, wh - y_bot, glow::COLOR_BUFFER_BIT, glow::LINEAR);
    }
}

// ---- ops --------------------------------------------------------------------------------------

/// Opens a WebM file. Returns [id, width, height, duration, audio buffer id (0 = none), error].
#[op2]
#[serde]
pub fn op_video_open(state: &mut OpState, #[string] path: String) -> (u32, u32, u32, f64, u32, String) {
    // A VP9 copy made by --transcode-videos (<name>.powerboat.webm next to it) plays instead: H.264 at
    // 1080p decodes at ~10 fps on the handhelds, VP9 720p at ~100.
    let path = crate::casepath::existing(path);
    let converted = format!("{path}.powerboat.webm");
    let path = if std::path::Path::new(&converted).is_file() { converted } else { path };
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => return (0, 0, 0, 0.0, 0, format!("{path}: {e}")),
    };
    let t0 = std::time::Instant::now();
    let (mut v, audio) = match open(data) {
        Ok(r) => r,
        Err(e) => return (0, 0, 0, 0.0, 0, format!("{path}: {e}")),
    };
    // the mixer keeps 16-bit PCM
    let mut audio = audio.map(|(rate, ch)| (rate, ch.into_iter().map(|c| c.into_iter().map(crate::audio::to_i16).collect::<Vec<i16>>()).collect::<Vec<_>>()));
    if v.audio_opus {
        match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|d| crate::audio::decode(d, Some("webm"))) {
            Ok(a) => {
                v.duration = v.duration.max(a.1.first().map_or(0, |c| c.len()) as f64 / a.0 as f64);
                audio = Some(a);
            }
            Err(e) => eprintln!("[powerboat] video soundtrack (Opus): {e}"),
        }
    }
    let app = state.borrow_mut::<App>();
    let abuf = match (audio, app.audio.as_mut()) {
        (Some((rate, ch)), Some(sys)) => sys.add_buffer(rate, ch),
        _ => 0,
    };
    let (w, h, d) = (v.w, v.h, v.duration);
    if std::env::var_os("POWERBOAT_VIDEO_DEBUG").is_some() {
        eprintln!("[powerboat] video {path}: {w}x{h} {d:.2}s {} packets, audio {abuf}, opened in {} ms", v.packets.len(), t0.elapsed().as_millis());
    }
    app.videos.next += 1;
    let id = app.videos.next;
    app.videos.map.insert(id, v);
    (id, w, h, d, abuf, String::new())
}
/// Decodes up to t; returns 1 if a new frame is ready, 0 if not, -1 on a decode error.
#[op2(fast)]
pub fn op_video_advance(state: &mut OpState, id: u32, t: f64) -> i32 {
    let Some(v) = state.borrow_mut::<App>().videos.map.get_mut(&id) else { return -1 };
    let t0 = std::time::Instant::now();
    let r = v.advance(t);
    prof_add(0, t0.elapsed().as_nanos() as u64);
    match r {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(e) => {
            eprintln!("[powerboat] video decode: {e}");
            -1
        }
    }
}
#[op2(fast)]
pub fn op_video_rewind(state: &mut OpState, id: u32) {
    if let Some(v) = state.borrow_mut::<App>().videos.map.get_mut(&id) {
        v.rewind();
    }
}
#[op2(fast)]
pub fn op_video_close(state: &mut OpState, id: u32) {
    let app = state.borrow_mut::<App>();
    if std::env::var_os("POWERBOAT_VIDEO_PROFILE").is_some() {
        let (adv, conv, up, n) = PROF.with(|p| p.replace((0, 0, 0, 0)));
        let ms = |ns: u64| ns as f64 / 1e6 / n.max(1) as f64;
        eprintln!("[powerboat] video {id} profile: {n} frames shown; per frame decode {:.1} ms, RGBA convert {:.1} ms, texImage2D {:.1} ms", ms(adv.saturating_sub(conv)), ms(conv), ms(up));
    }
    if let Some(v) = app.videos.map.remove(&id) {
        if let Some((tex, fbo)) = v.tex {
            unsafe {
                app.gl.delete_framebuffer(fbo);
                app.gl.delete_texture(tex);
            }
        }
    }
    if app.videos.overlay.map(|o| o.0) == Some(id) {
        app.videos.overlay = None;
    }
}
/// MV's DOM video rect in game-canvas pixels; id 0 hides it.
#[op2(fast)]
pub fn op_video_overlay(state: &mut OpState, id: u32, x: f32, y: f32, w: f32, h: f32) {
    state.borrow_mut::<App>().videos.overlay = if id == 0 { None } else { Some((id, x, y, w, h)) };
}
/// texImage2D(video): the current frame as RGBA8 (flip/premultiply flags applied).
#[op2(fast)]
pub fn op_gl_tex_image_2d_video(state: &mut OpState, target: u32, level: i32, id: u32) -> bool {
    let app = state.borrow_mut::<App>();
    let Some(v) = app.videos.map.get_mut(&id) else { return false };
    v.dirty = false;
    let t0 = std::time::Instant::now();
    // The GPU path renders into the texture bound on the active unit (TEXTURE_2D, level 0 only).
    let bound = if target == glow::TEXTURE_2D && level == 0 && v.frame.gpu {
        unsafe { std::num::NonZeroU32::new(app.gl.get_parameter_i32(glow::TEXTURE_BINDING_2D) as u32).map(glow::NativeTexture) }
    } else {
        None
    };
    let on_gpu = bound.is_some_and(|t| convert_on_gpu(&mut app.videos.gl, &app.gl, &mut v.frame, app.unpack_flip_y, t));
    if !on_gpu {
        let px = crate::image::convert_rgba(v.frame.rgba(), v.w as usize, v.h as usize, app.unpack_flip_y, false);
        unsafe {
            app.gl.tex_image_2d(target, level, glow::RGBA as i32, v.w as i32, v.h as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&px)));
        }
    }
    prof_add(2, t0.elapsed().as_nanos() as u64);
    true
}

/// Tightly packed NV12 copy of a hardware picture (the decoder's buffer goes back when the callback returns).
fn copy_nv12(p: &crate::hwdec::Picture, w: usize, h: usize, planes: &mut [Vec<u8>; 2]) {
    let [y, uv] = planes;
    *y = vec![0; w * h];
    *uv = vec![0; w.div_ceil(2) * h.div_ceil(2) * 2];
    copy_nv12_into(p, w, h, y, uv);
}

fn copy_nv12_into(p: &crate::hwdec::Picture, w: usize, h: usize, y: &mut [u8], uv: &mut [u8]) {
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let (left, top) = (p.left.max(0) as usize, p.top.max(0) as usize);
    let (s0, s1) = (p.stride[0] as usize, p.stride[1] as usize);
    unsafe {
        for r in 0..h {
            let src = std::slice::from_raw_parts(p.plane[0].add((top + r) * s0 + left), w);
            y[r * w..(r + 1) * w].copy_from_slice(src);
        }
        for r in 0..ch {
            let src = std::slice::from_raw_parts(p.plane[1].add((top / 2 + r) * s1 + (left / 2) * 2), cw * 2);
            uv[r * cw * 2..(r + 1) * cw * 2].copy_from_slice(src);
        }
    }
}
