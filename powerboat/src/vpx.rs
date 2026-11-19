//! VP8/VP9 decode through libvpx (WebM `<video>`), linked statically (build.rs).
//! From retsurf-rmmv (src/media/player/vpx.rs, Knifethrower, branch rmmv), unchanged.
//!
//! The few entry points the decoder needs, declared by hand against libvpx 1.8
//! (Ubuntu focal's, what the arm64 image links): its `vpx_codec_ctx_t` and
//! `vpx_image_t` layouts and its decoder ABI version, 12. libvpx emits frames in
//! display order, so a picture takes the timestamp of the packet that produced it.

use std::ffi::{c_char, c_int, c_long, c_uint, c_void, CStr};
use std::ptr;

/// `VPX_DECODER_ABI_VERSION`: 3 + `VPX_CODEC_ABI_VERSION` (4 + `VPX_IMAGE_ABI_VERSION` 5).
const VPX_DECODER_ABI_VERSION: c_int = 12;
const VPX_CODEC_OK: c_int = 0;
/// `VPX_IMG_FMT_PLANAR | 2`.
const VPX_IMG_FMT_I420: c_int = 0x102;

#[repr(C)]
struct CodecCtx {
    name: *const c_char,
    iface: *const c_void,
    err: c_int,
    err_detail: *const c_char,
    init_flags: c_long,
    config: *const c_void,
    priv_: *mut c_void,
}

#[repr(C)]
struct DecCfg {
    threads: c_uint,
    w: c_uint,
    h: c_uint,
}

#[repr(C)]
struct Image {
    fmt: c_int,
    cs: c_int,
    range: c_int,
    w: c_uint,
    h: c_uint,
    bit_depth: c_uint,
    d_w: c_uint,
    d_h: c_uint,
    r_w: c_uint,
    r_h: c_uint,
    x_chroma_shift: c_uint,
    y_chroma_shift: c_uint,
    planes: [*const u8; 4],
    stride: [c_int; 4],
    bps: c_int,
    user_priv: *mut c_void,
    img_data: *mut u8,
    img_data_owner: c_int,
    self_allocd: c_int,
    fb_priv: *mut c_void,
}

extern "C" {
    fn vpx_codec_vp8_dx() -> *const c_void;
    fn vpx_codec_vp9_dx() -> *const c_void;
    fn vpx_codec_dec_init_ver(
        ctx: *mut CodecCtx,
        iface: *const c_void,
        cfg: *const DecCfg,
        flags: c_long,
        ver: c_int,
    ) -> c_int;
    fn vpx_codec_decode(
        ctx: *mut CodecCtx,
        data: *const u8,
        data_sz: c_uint,
        user_priv: *mut c_void,
        deadline: c_long,
    ) -> c_int;
    fn vpx_codec_get_frame(ctx: *mut CodecCtx, iter: *mut *const c_void) -> *const Image;
    fn vpx_codec_destroy(ctx: *mut CodecCtx) -> c_int;
    fn vpx_codec_err_to_string(err: c_int) -> *const c_char;
    fn vpx_codec_control_(ctx: *mut CodecCtx, ctrl_id: c_int, ...) -> c_int;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Vpx {
    Vp8,
    Vp9,
}

impl Vpx {
    /// Whether a packet starts a keyframe, read off its first bytes: WebM
    /// blocks reach us without their keyframe flag.
    pub(crate) fn is_keyframe(self, data: &[u8]) -> bool {
        let Some(&first) = data.first() else {
            return false;
        };
        match self {
            // VP8 frame tag: bit 0 clear is a key frame.
            Vpx::Vp8 => first & 1 == 0,
            // VP9 uncompressed header: frame_marker (2), profile (2, plus a
            // reserved bit at profile 3), show_existing_frame, frame_type (0 = key).
            Vpx::Vp9 => {
                if first >> 6 != 0b10 {
                    return false;
                }
                let profile = ((first >> 5) & 1) | (((first >> 4) & 1) << 1);
                // Index of the next field, counting from the top bit of `first`.
                let mut bit = 4;
                if profile == 3 {
                    bit += 1;
                }
                let read = |i: u32| (first >> (7 - i)) & 1;
                if read(bit) == 1 {
                    return false; // show_existing_frame
                }
                read(bit + 1) == 0
            }
        }
    }
}

/// One I420 picture as libvpx handed it over: borrowed until the next decode.
pub(crate) struct Picture<'a> {
    pub width: usize,
    pub height: usize,
    pub planes: [&'a [u8]; 3],
    pub strides: [usize; 3],
}

pub(crate) struct Decoder {
    ctx: Box<CodecCtx>,
}

// The context belongs to the one thread that created and drives it.
unsafe impl Send for Decoder {}

impl Decoder {
    pub(crate) fn new(codec: Vpx) -> Result<Self, String> {
        let mut ctx = Box::new(CodecCtx {
            name: ptr::null(),
            iface: ptr::null(),
            err: 0,
            err_detail: ptr::null(),
            init_flags: 0,
            config: ptr::null(),
            priv_: ptr::null_mut(),
        });
        // Two threads: the handhelds have four cores, and the game and the
        // compositor are busy on the others.
        // POWERBOAT_VPX_THREADS overrides (VP9 threads over tile columns, or rows with POWERBOAT_VP9_ROW_MT=1).
        let threads = std::env::var("POWERBOAT_VPX_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
        let cfg = DecCfg {
            threads,
            w: 0,
            h: 0,
        };
        let err = unsafe {
            let iface = match codec {
                Vpx::Vp8 => vpx_codec_vp8_dx(),
                Vpx::Vp9 => vpx_codec_vp9_dx(),
            };
            vpx_codec_dec_init_ver(&mut *ctx, iface, &cfg, 0, VPX_DECODER_ABI_VERSION)
        };
        if err != VPX_CODEC_OK {
            return Err(error_text(err));
        }
        // VP9D_SET_ROW_MT (vp8dx.h: VP8_DECODER_CTRL_ID_START 256 + 12): row-based threads, which
        // also help streams encoded without tile columns.
        if matches!(codec, Vpx::Vp9) && std::env::var("POWERBOAT_VP9_ROW_MT").is_ok_and(|v| v == "1") {
            let e = unsafe { vpx_codec_control_(&mut *ctx, 268, 1 as c_int) };
            if e != VPX_CODEC_OK {
                eprintln!("[powerboat] VP9 row-mt: {}", error_text(e));
            }
        }
        Ok(Self { ctx })
    }

    /// Decodes one packet; `each` sees every picture it completes (none for a
    /// VP8 alt-ref, one for a VP9 superframe's shown frame).
    pub(crate) fn decode(&mut self, data: &[u8], mut each: impl FnMut(Picture)) -> Result<(), String> {
        let err = unsafe {
            vpx_codec_decode(&mut *self.ctx, data.as_ptr(), data.len() as c_uint, ptr::null_mut(), 0)
        };
        if err != VPX_CODEC_OK {
            return Err(error_text(err));
        }
        let mut iter: *const c_void = ptr::null();
        loop {
            let img = unsafe { vpx_codec_get_frame(&mut *self.ctx, &mut iter) };
            if img.is_null() {
                return Ok(());
            }
            let img = unsafe { &*img };
            if img.fmt != VPX_IMG_FMT_I420 {
                return Err(format!("unsupported picture format {:#x}", img.fmt));
            }
            let (w, h) = (img.d_w as usize, img.d_h as usize);
            let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
            let strides = [img.stride[0] as usize, img.stride[1] as usize, img.stride[2] as usize];
            let plane = |i: usize, rows: usize, width: usize| unsafe {
                std::slice::from_raw_parts(img.planes[i], strides[i] * (rows - 1) + width)
            };
            each(Picture {
                width: w,
                height: h,
                planes: [plane(0, h, w), plane(1, ch, cw), plane(2, ch, cw)],
                strides,
            });
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { vpx_codec_destroy(&mut *self.ctx) };
    }
}

fn error_text(err: c_int) -> String {
    unsafe {
        let text = vpx_codec_err_to_string(err);
        if text.is_null() {
            format!("libvpx error {err}")
        } else {
            CStr::from_ptr(text).to_string_lossy().into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframes_from_the_bitstream() {
        // VP8: frame tag bit 0 is the inverse key frame flag.
        assert!(Vpx::Vp8.is_keyframe(&[0x50, 0x42]));
        assert!(!Vpx::Vp8.is_keyframe(&[0x51, 0x42]));
        // VP9 profile 0: 10 00 0 0 -> key; 10 00 0 1 -> inter; 10 00 1 x -> show existing.
        assert!(Vpx::Vp9.is_keyframe(&[0b1000_0000]));
        assert!(!Vpx::Vp9.is_keyframe(&[0b1000_0100]));
        assert!(!Vpx::Vp9.is_keyframe(&[0b1000_1000]));
        // Profile 3 has a reserved bit before show_existing_frame.
        assert!(Vpx::Vp9.is_keyframe(&[0b1011_0000]));
        assert!(!Vpx::Vp9.is_keyframe(&[0b1011_0010]));
        assert!(!Vpx::Vp8.is_keyframe(&[]));
    }
}
