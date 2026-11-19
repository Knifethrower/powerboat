//! 2D pages (ImpactJS games): the finished frame drawn into the window and swapped on a thread of its own
//! (POWERBOAT_PAGE_PRESENT=thread, the default when the drawing thread uploads frames; =main keeps it on the
//! JS thread). The JS thread used to draw the page quad and swap after every tick: on the TrimUI Smart
//! Pro ~0.5 ms of GL calls and a 1.2 ms swap per frame, and the RG Cube XX plaza ran at 44 fps with them
//! and 46-48 loops/s without (POWERBOAT_PAGE_PRESENT=0 diagnostic). Here a third context, sharing the drawing
//! thread's textures, owns the window surface: per frame it waits in the GPU for the upload's fence,
//! draws the letterboxed quad and the frame counter, and swaps. The JS thread hands the next frame over
//! once the previous one is shown, which paces it to the swaps as its own swap did.

use crate::upload::{EglFns, MainCtx};
use glow::HasContext;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const EGL_NONE: i32 = 0x3038;
const EGL_WIDTH: i32 = 0x3057;
const EGL_HEIGHT: i32 = 0x3056;
const EGL_DRAW: i32 = 0x3059;
const EGL_CONTEXT_CLIENT_VERSION: i32 = 0x3098;

/// The window's swap interval (main.rs: --no-vsync, POWERBOAT_SWAP_INTERVAL), set again on the present thread.
pub static SWAP_INTERVAL: AtomicI32 = AtomicI32::new(1);
/// A frame went to the present thread during this tick (main.rs: a drawn frame, no 60 Hz sleep).
pub static SENT: AtomicBool = AtomicBool::new(false);
/// Frames handed over, swaps and their ns since the last frame report.
pub static HANDED: AtomicU64 = AtomicU64::new(0);
pub static SWAPS: AtomicU64 = AtomicU64::new(0);
pub static SWAP_NS: AtomicU64 = AtomicU64::new(0);

struct Running {
    stop: Arc<AtomicBool>,
    handoff: crate::canvas::Handoff,
    join: Option<std::thread::JoinHandle<()>>,
    egl: EglFns,
    dpy: usize,
    win: usize,
    main_ctx: usize,
}
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static SHOT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

pub fn active() -> bool {
    RUNNING.lock().unwrap().is_some()
}

/// The next presented frame as a PPM (the window, as the main thread's screenshots read it).
pub fn request_shot(path: std::path::PathBuf) {
    *SHOT.lock().unwrap() = Some(path);
}

/// On the main thread, with the main context current on the window: the main context moves to a 1x1
/// pbuffer and a new present thread takes the window surface. On failure the window stays with the
/// main context.
pub fn start(handoff: crate::canvas::Handoff) -> Result<(), String> {
    let m = crate::upload::main_ctx()?;
    let f = crate::upload::egl()?;
    let (dpy, ctx) = (m.dpy as *mut c_void, m.ctx as *mut c_void);
    let win = unsafe { (f.current_surface)(EGL_DRAW) };
    if win.is_null() {
        return Err("no current window surface".into());
    }
    unsafe {
        let pb = [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
        let pbuf = (f.create_pbuffer)(dpy, m.cfg as *mut c_void, pb.as_ptr());
        if pbuf.is_null() || (f.make_current)(dpy, pbuf, pbuf, ctx) == 0 {
            return Err(format!("main context off the window: {:#x}", (f.error)()));
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (st, h, w) = (stop.clone(), handoff.clone(), win as usize);
    let join = std::thread::Builder::new().name("present".into()).spawn(move || run(m, w, h, st, tx));
    let answer = match &join {
        Ok(_) => rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| Err("no answer from the present thread".into())),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = answer {
        stop.store(true, Ordering::Relaxed);
        handoff.wake();
        if let Ok(j) = join {
            let _ = j.join();
        }
        unsafe { (f.make_current)(dpy, win, win, ctx) };
        return Err(e);
    }
    *RUNNING.lock().unwrap() = Some(Running { stop, handoff, join: join.ok(), egl: f, dpy: m.dpy, win: win as usize, main_ctx: m.ctx });
    Ok(())
}

/// Stops the present thread and gives the window surface back to the main context: before a page falls
/// back to the main-thread present, and before the window goes at exit.
pub fn stop() {
    let Some(mut r) = RUNNING.lock().unwrap().take() else { return };
    r.stop.store(true, Ordering::Relaxed);
    r.handoff.wake();
    if let Some(j) = r.join.take() {
        let _ = j.join();
    }
    r.handoff.reset();
    let (dpy, win) = (r.dpy as *mut c_void, r.win as *mut c_void);
    unsafe { (r.egl.make_current)(dpy, win, win, r.main_ctx as *mut c_void) };
}

fn run(m: MainCtx, win: usize, h: crate::canvas::Handoff, stop: Arc<AtomicBool>, ready: std::sync::mpsc::Sender<Result<(), String>>) {
    let f = match crate::upload::egl() {
        Ok(f) => f,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let (dpy, win) = (m.dpy as *mut c_void, win as *mut c_void);
    let attrs = [EGL_CONTEXT_CLIENT_VERSION, m.version, EGL_NONE];
    let ctx = unsafe { (f.create_context)(dpy, m.cfg as *mut c_void, m.ctx as *mut c_void, attrs.as_ptr()) };
    if ctx.is_null() {
        let _ = ready.send(Err(format!("eglCreateContext: {:#x}", unsafe { (f.error)() })));
        return;
    }
    let release = || unsafe {
        (f.make_current)(dpy, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
        (f.destroy_context)(dpy, ctx);
    };
    if unsafe { (f.make_current)(dpy, win, win, ctx) } == 0 {
        let e = unsafe { (f.error)() };
        release();
        let _ = ready.send(Err(format!("eglMakeCurrent (window): {e:#x}")));
        return;
    }
    unsafe { (f.swap_interval)(dpy, SWAP_INTERVAL.load(Ordering::Relaxed)) };
    let gl = f.gl();
    let quad = match unsafe { Quad::new(&gl) } {
        Ok(q) => q,
        Err(e) => {
            release();
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut fps = crate::fpsmeter::FpsMeter::from_env();
    let mut seen = 0;
    // The frame on screen (its texture is the held slot): drawn again for a repeat.
    let mut last: Option<(glow::NativeTexture, u32, u32)> = None;
    while let Some(what) = h.take(&stop, &mut seen) {
        let shown = match what {
            crate::canvas::ToPresent::Frame(fr) => {
                unsafe {
                    gl.wait_sync(fr.fence, 0, glow::TIMEOUT_IGNORED);
                    gl.delete_sync(fr.fence);
                }
                last = Some((fr.tex, fr.w, fr.h));
                Some((fr.slot, fr.seq))
            }
            crate::canvas::ToPresent::Repeat(n) if last.is_none() => {
                h.repeated(n);
                continue;
            }
            crate::canvas::ToPresent::Repeat(_) => None,
        };
        let (tex, cw, ch) = last.unwrap();
        let (mut ww, mut wh) = (0, 0);
        unsafe {
            (f.query_surface)(dpy, win, EGL_WIDTH, &mut ww);
            (f.query_surface)(dpy, win, EGL_HEIGHT, &mut wh);
            quad.draw(&gl, tex, cw, ch, ww, wh);
        }
        if let Some(m) = fps.as_mut() {
            m.draw(&gl, ww as u32, wh as u32);
        }
        if let Some(p) = SHOT.lock().unwrap().take() {
            match crate::save_ppm(&gl, ww as u32, wh as u32, &p) {
                Ok(()) => eprintln!("[powerboat] screenshot {}", p.display()),
                Err(e) => eprintln!("[powerboat] screenshot failed: {e}"),
            }
        }
        let t = Instant::now();
        unsafe { (f.swap_buffers)(dpy, win) };
        let now = Instant::now();
        SWAP_NS.fetch_add((now - t).as_nanos() as u64, Ordering::Relaxed);
        SWAPS.fetch_add(1, Ordering::Relaxed);
        if let Some(m) = fps.as_mut() {
            m.swapped(now);
        }
        match shown {
            Some((slot, seq)) => h.shown(slot, seq),
            None => h.repeated(seen),
        }
    }
    release();
}

/// The page canvas as one quad, letterboxed and nearest-scaled (as 79_webpage.js draws it on the JS
/// thread); the shader ignores alpha (premultiplied pixels on an opaque window).
struct Quad {
    prog: glow::NativeProgram,
    buf: glow::NativeBuffer,
}
impl Quad {
    unsafe fn new(gl: &glow::Context) -> Result<Quad, String> {
        let sh = |ty: u32, src: &str| -> Result<glow::NativeShader, String> {
            let s = gl.create_shader(ty)?;
            gl.shader_source(s, src);
            gl.compile_shader(s);
            if !gl.get_shader_compile_status(s) {
                return Err(format!("present shader: {}", gl.get_shader_info_log(s)));
            }
            Ok(s)
        };
        let vs = sh(glow::VERTEX_SHADER, "attribute vec2 p; varying vec2 t; void main() { t = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }")?;
        let fs = sh(glow::FRAGMENT_SHADER, "precision mediump float; uniform sampler2D s; varying vec2 t; void main() { gl_FragColor = vec4(texture2D(s, t).rgb, 1.0); }")?;
        let prog = gl.create_program()?;
        gl.attach_shader(prog, vs);
        gl.attach_shader(prog, fs);
        gl.bind_attrib_location(prog, 0, "p");
        gl.link_program(prog);
        if !gl.get_program_link_status(prog) {
            return Err(format!("present program: {}", gl.get_program_info_log(prog)));
        }
        let buf = gl.create_buffer()?;
        gl.bind_buffer(glow::ARRAY_BUFFER, Some(buf));
        let v: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, &bytes, glow::STATIC_DRAW);
        Ok(Quad { prog, buf })
    }
    unsafe fn draw(&self, gl: &glow::Context, tex: glow::NativeTexture, cw: u32, ch: u32, ww: i32, wh: i32) {
        if cw == 0 || ch == 0 || ww <= 0 || wh <= 0 {
            return;
        }
        let k = (ww as f32 / cw as f32).min(wh as f32 / ch as f32);
        let (dw, dh) = ((cw as f32 * k).round() as i32, (ch as f32 * k).round() as i32);
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gl.viewport(0, 0, ww, wh);
        gl.clear_color(0.0, 0.0, 0.0, 1.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
        gl.viewport((ww - dw) >> 1, (wh - dh) >> 1, dw, dh);
        gl.use_program(Some(self.prog));
        gl.bind_buffer(glow::ARRAY_BUFFER, Some(self.buf));
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 0, 0);
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    }
}
