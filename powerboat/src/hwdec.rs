//! Hardware video decoding through libpmhwdec (github.com/Knifethrower/pmhwdec: Allwinner video engine, Rockchip MPP,
//! V4L2 stateless/stateful decoders), loaded with dlopen at run time: the runtime has no link-time
//! dependency on it (it is GPL-2.0-or-later; its header is MIT) and works the same without it.
//! Looked for in POWERBOAT_PMHWDEC (a path), next to the executable, then by the system's search path.
//! On the RG Cube XX the video engine decodes 1080p H.264 in ~10 ms against ~89 ms for OpenH264.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::rc::Rc;
use std::sync::OnceLock;

pub const CODEC_H264: c_int = 0;
#[allow(dead_code)]
pub const CODEC_HEVC: c_int = 1;
pub const PMHW_AGAIN: c_int = 1;
pub const PMHW_UNSUPPORTED: c_int = -2;

/// pmhwdec.h's PmhwPicture (PMHWDEC_VERSION 1).
#[repr(C)]
pub struct Picture {
    pub width: c_int,
    pub height: c_int,
    pub left: c_int,
    pub top: c_int,
    pub format: c_int,
    pub plane: [*const u8; 2],
    pub stride: [c_int; 2],
    pub pts: i64,
    pub corrupt: c_int,
    pub dmabuf_fd: c_int,
    pub drm_fourcc: u32,
    pub drm_modifier: u64,
    pub offset: [u32; 2],
    pub priv_: *mut c_void,
}

struct Lib {
    _lib: libloading::Library,
    open: unsafe extern "C" fn(c_int, c_int, c_int) -> *mut c_void,
    send: unsafe extern "C" fn(*mut c_void, *const u8, c_int, i64) -> c_int,
    get: unsafe extern "C" fn(*mut c_void, *mut Picture) -> c_int,
    put: unsafe extern "C" fn(*mut c_void, *mut Picture),
    close: unsafe extern "C" fn(*mut c_void),
    backend: unsafe extern "C" fn(*const c_void) -> *const c_char,
}

fn lib() -> Option<&'static Lib> {
    static LIB: OnceLock<Option<Lib>> = OnceLock::new();
    LIB.get_or_init(|| {
        if std::env::var("POWERBOAT_HWDEC").is_ok_and(|v| v == "0") {
            return None;
        }
        let mut paths: Vec<std::path::PathBuf> = Vec::new();
        if let Some(p) = std::env::var_os("POWERBOAT_PMHWDEC") {
            paths.push(p.into());
        }
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
            paths.push(dir.join("libpmhwdec.so.1"));
            paths.push(dir.join("libpmhwdec.so"));
        }
        paths.push("libpmhwdec.so.1".into());
        paths.push("libpmhwdec.so".into());
        for p in paths {
            let Ok(l) = (unsafe { libloading::Library::new(&p) }) else { continue };
            let lib = unsafe {
                (|| -> Result<Lib, libloading::Error> {
                    Ok(Lib {
                        open: *l.get(b"pmhw_open\0")?,
                        send: *l.get(b"pmhw_send\0")?,
                        get: *l.get(b"pmhw_get\0")?,
                        put: *l.get(b"pmhw_put\0")?,
                        close: *l.get(b"pmhw_close\0")?,
                        backend: *l.get(b"pmhw_backend_name\0")?,
                        _lib: l,
                    })
                })()
            };
            match lib {
                Ok(lib) => {
                    eprintln!("[powerboat] hardware video decoding: {}", p.display());
                    return Some(lib);
                }
                Err(e) => eprintln!("[powerboat] {}: {e}", p.display()),
            }
        }
        None
    })
    .as_ref()
}

/// One hardware decoder. Access units go in as Annex B, pictures come out in display order.
pub struct HwDec {
    inner: Rc<Inner>,
    /// Pictures may stay in the decoder's buffers past the callback (zero-copy display); POWERBOAT_VIDEO_HOLD=0
    /// copies them out at once. (2026-10-30: cedar's ION cache flush oopsed the RG Cube XX kernel on
    /// pages Mali's import had unmapped; fixed in pmhwdec 21:42, and pictures go back only after the GPU
    /// is done with them: video.rs Frame::reap.)
    pub hold: bool,
}

struct Inner {
    lib: &'static Lib,
    d: *mut c_void,
}

impl Drop for Inner {
    fn drop(&mut self) {
        unsafe { (self.lib.close)(self.d) }
    }
}

/// A decoded picture still in the decoder's buffer: it goes back (pmhw_put) when dropped, and the decoder
/// closes only once all of them are back. Holding one keeps its dmabuf valid for zero-copy display.
pub struct Held {
    inner: Rc<Inner>,
    pic: Picture,
}

impl std::ops::Deref for Held {
    type Target = Picture;
    fn deref(&self) -> &Picture {
        &self.pic
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        unsafe { (self.inner.lib.put)(self.inner.d, &mut self.pic) }
    }
}

impl HwDec {
    /// None: no library, or no hardware for this codec/size here.
    pub fn open(codec: c_int, w: u32, h: u32) -> Option<Self> {
        let lib = lib()?;
        let d = unsafe { (lib.open)(codec, w as c_int, h as c_int) };
        if d.is_null() {
            return None;
        }
        let name = unsafe { CStr::from_ptr((lib.backend)(d)) }.to_string_lossy().into_owned();
        if std::env::var_os("POWERBOAT_VIDEO_DEBUG").is_some() {
            eprintln!("[powerboat] video: hardware decoder {name} for {w}x{h}");
        }
        let hold = match std::env::var("POWERBOAT_VIDEO_HOLD").ok().as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => true,
        };
        if std::env::var_os("POWERBOAT_VIDEO_DEBUG").is_some() && !hold {
            eprintln!("[powerboat] video: {name} pictures are copied out at once (no zero-copy)");
        }
        Some(Self { inner: Rc::new(Inner { lib, d }), hold })
    }
    /// Sends one access unit (None = end of stream). Each picture that comes out meanwhile is handed
    /// to `each`. Returns PMHW_OK, PMHW_ERROR (the unit was dropped), PMHW_UNSUPPORTED, or PMHW_AGAIN when
    /// the decoder has no free buffer and nothing comes out for ~50 ms: the caller holds too many pictures,
    /// gives some back and sends the same unit again.
    pub fn send(&mut self, data: Option<&[u8]>, pts: i64, each: &mut dyn FnMut(Held)) -> c_int {
        let mut idle = 0;
        loop {
            let r = unsafe {
                match data {
                    Some(d) => (self.inner.lib.send)(self.inner.d, d.as_ptr(), d.len() as c_int, pts),
                    None => (self.inner.lib.send)(self.inner.d, std::ptr::null(), 0, 0),
                }
            };
            let n = self.drain(each);
            if r != PMHW_AGAIN {
                return r;
            }
            if n > 0 {
                idle = 0;
            } else {
                idle += 1;
                if idle >= 50 {
                    return PMHW_AGAIN;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
    fn drain(&mut self, each: &mut dyn FnMut(Held)) -> usize {
        let mut n = 0;
        loop {
            let mut pic: Picture = unsafe { std::mem::zeroed() };
            if unsafe { (self.inner.lib.get)(self.inner.d, &mut pic) } != 1 {
                return n;
            }
            n += 1;
            each(Held { inner: self.inner.clone(), pic });
        }
    }
}
