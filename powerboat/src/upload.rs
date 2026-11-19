//! Deferred Canvas 2D, the presented frame's upload on the drawing thread: a second EGL context that
//! shares textures with the main one uploads each finished frame straight from the canvas pixmap into
//! one of three textures and fences it; the main thread waits on the fence in the GPU (glWaitSync)
//! and draws with that texture. The JS thread no longer copies 0.7 MB per frame through the driver
//! (TrimUI Smart Pro plaza: memcpy + driver ioctls were ~6 % of its time). POWERBOAT_C2D_GPU_UPLOAD=0, or a
//! driver that refuses the shared context, keeps the copy in the frame buffer path.

use glow::HasContext;
use std::ffi::{c_void, CStr};

type Dpy = *mut c_void;
type Ctx = *mut c_void;
type Cfg = *mut c_void;
type Surf = *mut c_void;

const EGL_NONE: i32 = 0x3038;
const EGL_CONFIG_ID: i32 = 0x3028;
const EGL_CONTEXT_CLIENT_VERSION: i32 = 0x3098;
const EGL_WIDTH: i32 = 0x3057;
const EGL_HEIGHT: i32 = 0x3056;

/// The main context's EGL handles, taken on the main thread (where it is current).
#[derive(Clone, Copy)]
pub struct MainCtx {
    pub(crate) dpy: usize,
    pub(crate) ctx: usize,
    pub(crate) cfg: usize,
    pub(crate) version: i32,
}

pub(crate) struct EglFns {
    _lib: libloading::Library,
    pub(crate) create_context: unsafe extern "C" fn(Dpy, Cfg, Ctx, *const i32) -> Ctx,
    pub(crate) destroy_context: unsafe extern "C" fn(Dpy, Ctx) -> u32,
    pub(crate) create_pbuffer: unsafe extern "C" fn(Dpy, Cfg, *const i32) -> Surf,
    pub(crate) make_current: unsafe extern "C" fn(Dpy, Surf, Surf, Ctx) -> u32,
    pub(crate) current_surface: unsafe extern "C" fn(i32) -> Surf,
    pub(crate) query_surface: unsafe extern "C" fn(Dpy, Surf, i32, *mut i32) -> u32,
    pub(crate) swap_buffers: unsafe extern "C" fn(Dpy, Surf) -> u32,
    pub(crate) swap_interval: unsafe extern "C" fn(Dpy, i32) -> u32,
    proc_addr: unsafe extern "C" fn(*const std::ffi::c_char) -> *mut c_void,
    pub(crate) error: unsafe extern "C" fn() -> i32,
}

pub(crate) fn egl() -> Result<EglFns, String> {
    let lib = ["libEGL.so.1", "libEGL.so"].iter().find_map(|n| unsafe { libloading::Library::new(n) }.ok()).ok_or("no libEGL")?;
    unsafe {
        let e = |e: libloading::Error| e.to_string();
        Ok(EglFns {
            create_context: *lib.get(b"eglCreateContext\0").map_err(e)?,
            destroy_context: *lib.get(b"eglDestroyContext\0").map_err(e)?,
            create_pbuffer: *lib.get(b"eglCreatePbufferSurface\0").map_err(e)?,
            make_current: *lib.get(b"eglMakeCurrent\0").map_err(e)?,
            current_surface: *lib.get(b"eglGetCurrentSurface\0").map_err(e)?,
            query_surface: *lib.get(b"eglQuerySurface\0").map_err(e)?,
            swap_buffers: *lib.get(b"eglSwapBuffers\0").map_err(e)?,
            swap_interval: *lib.get(b"eglSwapInterval\0").map_err(e)?,
            proc_addr: *lib.get(b"eglGetProcAddress\0").map_err(e)?,
            error: *lib.get(b"eglGetError\0").map_err(e)?,
            _lib: lib,
        })
    }
}

impl EglFns {
    /// GL functions for the context current on this thread: libGLESv2's own, else eglGetProcAddress.
    pub(crate) fn gl(&self) -> glow::Context {
        let proc_addr = self.proc_addr;
        let gles = ["libGLESv2.so.2", "libGLESv2.so"].iter().find_map(|n| unsafe { libloading::Library::new(n) }.ok());
        let gl = unsafe {
            glow::Context::from_loader_function_cstr(|name: &CStr| {
                if let Some(Ok(p)) = gles.as_ref().map(|l| l.get::<*mut c_void>(name.to_bytes_with_nul())) {
                    if !p.is_null() {
                        return *p as *const c_void;
                    }
                }
                proc_addr(name.as_ptr()) as *const c_void
            })
        };
        std::mem::forget(gles); // the functions stay loaded for the thread's life
        gl
    }
}

/// On the main thread: the current context's display, context and config, or why not.
pub fn main_ctx() -> Result<MainCtx, String> {
    if std::env::var("POWERBOAT_C2D_GPU_UPLOAD").is_ok_and(|v| v == "0") {
        return Err("POWERBOAT_C2D_GPU_UPLOAD=0".into());
    }
    let lib = ["libEGL.so.1", "libEGL.so"].iter().find_map(|n| unsafe { libloading::Library::new(n) }.ok()).ok_or("no libEGL")?;
    unsafe {
        let e = |e: libloading::Error| e.to_string();
        let cur_dpy: unsafe extern "C" fn() -> Dpy = *lib.get(b"eglGetCurrentDisplay\0").map_err(e)?;
        let cur_ctx: unsafe extern "C" fn() -> Ctx = *lib.get(b"eglGetCurrentContext\0").map_err(e)?;
        let query: unsafe extern "C" fn(Dpy, Ctx, i32, *mut i32) -> u32 = *lib.get(b"eglQueryContext\0").map_err(e)?;
        let choose: unsafe extern "C" fn(Dpy, *const i32, *mut Cfg, i32, *mut i32) -> u32 = *lib.get(b"eglChooseConfig\0").map_err(e)?;
        let (dpy, ctx) = (cur_dpy(), cur_ctx());
        if dpy.is_null() || ctx.is_null() {
            return Err("no current EGL context".into());
        }
        let (mut id, mut version) = (0, 2);
        query(dpy, ctx, EGL_CONFIG_ID, &mut id);
        query(dpy, ctx, EGL_CONTEXT_CLIENT_VERSION, &mut version);
        let attrs = [EGL_CONFIG_ID, id, EGL_NONE];
        let mut cfg: Cfg = std::ptr::null_mut();
        let mut n = 0;
        if choose(dpy, attrs.as_ptr(), &mut cfg, 1, &mut n) == 0 || n < 1 {
            return Err(format!("no EGL config {id}"));
        }
        Ok(MainCtx { dpy: dpy as usize, ctx: ctx as usize, cfg: cfg as usize, version })
    }
}

/// Five: the one shown, the one handed to the present thread (crate::present), the newest not yet
/// taken, and two more, so a texture is rewritten only after it has been out of use for a frame or more
/// (the GPU may still be drawing the frame that showed it).
pub const SLOTS: usize = 5;

/// A frame uploaded on the drawing thread: its texture (a name shared with the main context) and the
/// fence the main context waits on before sampling it.
pub struct GpuFrame {
    pub slot: usize,
    pub tex: glow::NativeTexture,
    pub fence: glow::NativeFence,
    pub seq: u64,
    pub w: u32,
    pub h: u32,
}
// The fence and texture are plain GL names, used by one context at a time under the snaps lock.
unsafe impl Send for GpuFrame {}

/// Which slots the main thread holds (the texture it shows) or has not taken yet (the newest frame).
#[derive(Default, Clone, Copy)]
pub struct Slots {
    pub held: Option<usize>,
    pub last: Option<usize>,
    /// Handed to the present thread and not shown yet (it then becomes `held`).
    pub queued: Option<usize>,
    /// The frame sequence at which each slot was last let go of by the main thread.
    pub freed_at: [u64; SLOTS],
}

/// The drawing thread's side: its context and the three textures.
pub struct Uploader {
    _egl: EglFns,
    gl: glow::Context,
    tex: [Option<(glow::NativeTexture, u32, u32)>; SLOTS],
}

impl Uploader {
    /// On the drawing thread: a context sharing the main one's textures, current on a 1x1 pbuffer
    /// (or none: EGL_KHR_surfaceless_context).
    pub fn new(m: MainCtx) -> Result<Uploader, String> {
        let f = egl()?;
        unsafe {
            let (dpy, cfg, share) = (m.dpy as Dpy, m.cfg as Cfg, m.ctx as Ctx);
            let attrs = [EGL_CONTEXT_CLIENT_VERSION, m.version, EGL_NONE];
            let ctx = (f.create_context)(dpy, cfg, share, attrs.as_ptr());
            if ctx.is_null() {
                return Err(format!("eglCreateContext: {:#x}", (f.error)()));
            }
            let pb = [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
            let surf = (f.create_pbuffer)(dpy, cfg, pb.as_ptr());
            if (f.make_current)(dpy, surf, surf, ctx) == 0 {
                return Err(format!("eglMakeCurrent: {:#x}", (f.error)()));
            }
            let gl = f.gl();
            Ok(Uploader { _egl: f, gl, tex: [None; SLOTS] })
        }
    }

    /// Uploads `data` (w x h RGBA) into a slot neither held nor waiting to be taken, fenced.
    pub fn upload(&mut self, slots: &Slots, w: u32, h: u32, data: &[u8], seq: u64) -> Option<GpuFrame> {
        let slot = (0..SLOTS).filter(|&s| slots.held != Some(s) && slots.last != Some(s) && slots.queued != Some(s)).min_by_key(|&s| slots.freed_at[s])?;
        let gl = &self.gl;
        unsafe {
            let tex = match self.tex[slot] {
                Some((t, tw, th)) if (tw, th) == (w, h) => {
                    gl.bind_texture(glow::TEXTURE_2D, Some(t));
                    gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, w as i32, h as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(data)));
                    t
                }
                old => {
                    if let Some((t, ..)) = old {
                        gl.delete_texture(t);
                    }
                    let t = gl.create_texture().ok()?;
                    gl.bind_texture(glow::TEXTURE_2D, Some(t));
                    for (k, v) in [(glow::TEXTURE_MIN_FILTER, glow::NEAREST), (glow::TEXTURE_MAG_FILTER, glow::NEAREST), (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE), (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE)] {
                        gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
                    }
                    gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
                    gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA as i32, w as i32, h as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(data)));
                    self.tex[slot] = Some((t, w, h));
                    t
                }
            };
            gl.bind_texture(glow::TEXTURE_2D, None);
            let fence = gl.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0).ok()?;
            gl.flush();
            Some(GpuFrame { slot, tex, fence, seq, w, h })
        }
    }

    /// A fence of a frame that was replaced before the main thread took it.
    pub fn drop_fence(&self, fence: glow::NativeFence) {
        unsafe { self.gl.delete_sync(fence) };
    }
}
