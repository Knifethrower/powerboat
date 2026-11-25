//! WebGL 1 -> GLES ops. JS (js/10_webgl.js) keeps the WebGL object wrappers and passes raw GL
//! names; the ops are thin, so a PIXI frame costs one fast call per GL call. Pixel-store flags
//! WebGL adds (UNPACK_FLIP_Y_WEBGL, UNPACK_PREMULTIPLY_ALPHA_WEBGL) are applied here on the CPU
//! at upload time for RGBA/UNSIGNED_BYTE data and for image sources.

use std::num::NonZeroU32;

use deno_core::{op2, OpState};
use glow::{HasContext, NativeBuffer, NativeFramebuffer, NativeProgram, NativeRenderbuffer, NativeShader, NativeTexture, NativeUniformLocation, NativeVertexArray};

use std::borrow::Cow;

use crate::canvas::demultiply;
use crate::image::convert_rgba;
use crate::ops::App;

thread_local! {
    /// (calls, nanoseconds) in WebGL ops since the last take, and the slowest op (ns, name).
    pub static GL_TIME: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
    pub static GL_SLOWEST: std::cell::Cell<(u64, &'static str)> = const { std::cell::Cell::new((0, "")) };
    /// Draws and clears since the last present: 0 = the frame drew nothing (MV skipped its render).
    pub static FRAME_DRAWS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
/// Per-op GL timing for the frame report, with POWERBOAT_OP_TIMES=1 (see canvas::OP_TIMES) or POWERBOAT_GL_HIST=1.
pub(crate) struct GlTimer(Option<std::time::Instant>, &'static str);
impl GlTimer {
    pub(crate) fn start(name: &'static str) -> GlTimer {
        GlTimer((*crate::canvas::OP_TIMES || *GL_HIST_ON).then(std::time::Instant::now), name)
    }
}
impl Drop for GlTimer {
    fn drop(&mut self) {
        let Some(t) = self.0 else { return };
        let ns = t.elapsed().as_nanos() as u64;
        GL_TIME.with(|c| {
            let (n, t) = c.get();
            c.set((n + 1, t + ns));
        });
        GL_SLOWEST.with(|c| {
            if ns > c.get().0 {
                c.set((ns, self.1));
            }
        });
        if *GL_HIST_ON {
            GL_HIST.with(|h| {
                let mut h = h.borrow_mut();
                let e = h.entry(self.1).or_insert((0, 0));
                e.0 += 1;
                e.1 += ns;
            });
        }
    }
}
/// POWERBOAT_GL_HIST=1: count and time per WebGL op, printed with the frame log.
// Times the ops itself (POWERBOAT_OP_TIMES not needed). Empty or "0" = off: the bench scripts always pass the
// variable, usually empty.
static GL_HIST_ON: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_GL_HIST").map_or(false, |v| !v.is_empty() && v != "0"));
thread_local! {
    static GL_HIST: std::cell::RefCell<std::collections::HashMap<&'static str, (u64, u64)>> = std::cell::RefCell::new(std::collections::HashMap::new());
}
pub fn take_gl_hist() -> Vec<(&'static str, u64, u64)> {
    GL_HIST.with(|h| {
        let mut v: Vec<_> = h.borrow_mut().drain().map(|(k, (n, t))| (k, n, t)).collect();
        v.sort_by(|a, b| b.2.cmp(&a.2));
        v
    })
}
pub fn take_gl_time() -> (u64, u64, u64, &'static str) {
    let (n, t) = GL_TIME.with(|c| c.replace((0, 0)));
    let (sn, sname) = GL_SLOWEST.with(|c| c.replace((0, "")));
    (n, t, sn, sname)
}
pub fn mark_drawn() {
    FRAME_DRAWS.with(|c| c.set(c.get() + 1));
}
thread_local! {
    /// The drawing buffer is due for its post-swap clear (see clear_drawing_buffer).
    static PENDING_CLEAR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The form overlay changed (op_ui_overlay): the frame is shown even if the game drew nothing.
    static UI_CHANGED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
/// After a swap: the clear happens before the game's next draw or clear, so a frame shown for
/// the form overlay alone still has the last game picture under it.
pub fn schedule_clear() {
    PENDING_CLEAR.with(|c| c.set(true));
}
/// Every draw and clear op calls this before touching the framebuffer.
pub fn before_draw(app: &App) {
    if PENDING_CLEAR.with(|c| c.replace(false)) {
        clear_drawing_buffer(app);
    }
}
pub fn take_ui_changed() -> bool {
    UI_CHANGED.with(|c| c.replace(false))
}
pub fn take_frame_draws() -> u64 {
    FRAME_DRAWS.with(|c| c.replace(0))
}

const UNPACK_FLIP_Y_WEBGL: u32 = 0x9240;
const UNPACK_PREMULTIPLY_ALPHA_WEBGL: u32 = 0x9241;
const UNPACK_COLORSPACE_CONVERSION_WEBGL: u32 = 0x9243;
const DEPTH_STENCIL: u32 = 0x84f9;
const DEPTH24_STENCIL8: u32 = 0x88f0;
const RGBA: u32 = 0x1908;
const UNSIGNED_BYTE: u32 = 0x1401;

/// The game canvas as an offscreen target (colour texture + depth/stencil renderbuffer) when the
/// canvas is not the window's size; `present` blits it letterboxed into the window.
pub struct MainFbo {
    pub fbo: NativeFramebuffer,
    tex: NativeTexture,
    rb: NativeRenderbuffer,
    pub w: u32,
    pub h: u32,
}

impl MainFbo {
    fn create(gl: &glow::Context, w: u32, h: u32) -> Result<MainFbo, String> {
        unsafe {
            let tex = gl.create_texture()?;
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w as i32, h as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
            gl.bind_texture(glow::TEXTURE_2D, None);
            let rb = gl.create_renderbuffer()?;
            gl.bind_renderbuffer(glow::RENDERBUFFER, Some(rb));
            gl.renderbuffer_storage(glow::RENDERBUFFER, DEPTH24_STENCIL8, w as i32, h as i32);
            gl.bind_renderbuffer(glow::RENDERBUFFER, None);
            let fbo = gl.create_framebuffer()?;
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
            gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
            gl.framebuffer_renderbuffer(glow::FRAMEBUFFER, glow::DEPTH_STENCIL_ATTACHMENT, glow::RENDERBUFFER, Some(rb));
            let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
            if status != glow::FRAMEBUFFER_COMPLETE {
                gl.bind_framebuffer(glow::FRAMEBUFFER, None);
                gl.delete_framebuffer(fbo);
                gl.delete_renderbuffer(rb);
                gl.delete_texture(tex);
                return Err(format!("main FBO {w}x{h} incomplete: 0x{status:x}"));
            }
            Ok(MainFbo { fbo, tex, rb, w, h })
        }
    }
    fn destroy(self, gl: &glow::Context) {
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            gl.delete_framebuffer(self.fbo);
            gl.delete_renderbuffer(self.rb);
            gl.delete_texture(self.tex);
        }
    }
}

/// Called from JS when the WebGL canvas's size is (re)set. The window's own size = no FBO.
#[op2(fast)]
pub fn op_gl_set_main_size(state: &mut OpState, w: u32, h: u32) {
    let _t = GlTimer::start("op_gl_set_main_size");
    let app = state.borrow_mut::<App>();
    if w == 0 || h == 0 {
        return;
    }
    // POWERBOAT_FORCE_FBO=1: render to the FBO even when the canvas is the window's size. So does
    // preserveDrawingBuffer: the window's back buffers do not keep their pixels from frame to frame (Mali hands
    // out an older one), and a page that redraws only what changed needs them kept.
    let force = app.preserve_drawing_buffer || std::env::var("POWERBOAT_FORCE_FBO").map(|v| v == "1").unwrap_or(false);
    let want = if w == app.width && h == app.height && !force { None } else { Some((w, h)) };
    if app.main_fbo.as_ref().map(|f| (f.w, f.h)) == want {
        return;
    }
    if let Some(old) = app.main_fbo.take() {
        old.destroy(&app.gl);
    }
    if want.is_none() {
        eprintln!("[powerboat] game canvas {w}x{h} = window: drawing straight into it");
    }
    if let Some((w, h)) = want {
        match MainFbo::create(&app.gl, w, h) {
            Ok(f) => {
                eprintln!("[powerboat] game canvas {w}x{h} -> FBO, window {}x{}", app.width, app.height);
                app.main_fbo = Some(f);
            }
            Err(e) => eprintln!("[powerboat] {e}; drawing straight to the window"),
        }
    }
    // JS believes framebuffer 0 is bound now (fresh context or a resize): make that true.
    let main = app.main_fbo.as_ref().map(|f| f.fbo);
    unsafe { app.gl.bind_framebuffer(glow::FRAMEBUFFER, main) }
}

/// End of frame: the FBO's colour, letterboxed into the window. Leaves the FBO bound again, so
/// JS's view of the state ("framebuffer 0") stays right. Scissor is disabled for the blit.
/// A Canvas 2D game canvas shown in the window (see App::main2d).
pub struct Main2d {
    canvas: u32,
    tex: Option<(NativeTexture, NativeFramebuffer, u32, u32)>,
}

/// MV's GameCanvas got a 2D context (PIXI's CanvasRenderer): present it from now on.
#[op2(fast)]
pub fn op_c2d_set_main(state: &mut OpState, canvas: u32) {
    let app = state.borrow_mut::<App>();
    eprintln!("[powerboat] game canvas uses Canvas 2D: presenting its pixmap");
    app.main2d = Some(Main2d { canvas, tex: None });
}

/// Uploads the 2D game canvas and blits it letterboxed into the window. Returns false if there is
/// nothing to show (the canvas is gone).
fn present_main2d(app: &mut App) -> bool {
    let gl = &app.gl;
    let Some(m) = app.main2d.as_mut() else { return false };
    let cs = app.canvases.flushed();
    let Some(c) = cs.get(m.canvas) else { return false };
    let (cw, ch) = (c.pixmap.width(), c.pixmap.height());
    unsafe {
        if m.tex.map(|t| (t.2, t.3)) != Some((cw, ch)) {
            if let Some((tex, fbo, _, _)) = m.tex.take() {
                gl.delete_framebuffer(fbo);
                gl.delete_texture(tex);
            }
            let (Ok(tex), Ok(fbo)) = (gl.create_texture(), gl.create_framebuffer()) else { return false };
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, cw as i32, ch as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
            gl.framebuffer_texture_2d(glow::READ_FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
            m.tex = Some((tex, fbo, cw, ch));
        }
        let (tex, fbo, _, _) = m.tex.unwrap();
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
        gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, cw as i32, ch as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(c.pixmap.data())));
        drop(cs);
        gl.bind_texture(glow::TEXTURE_2D, None);
        let scissor = gl.is_enabled(glow::SCISSOR_TEST);
        if scissor {
            gl.disable(glow::SCISSOR_TEST);
        }
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
        gl.color_mask(true, true, true, true);
        gl.clear_color(0.0, 0.0, 0.0, 1.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
        let (ww, wh) = (app.width as f32, app.height as f32);
        let scale = (ww / cw as f32).min(wh / ch as f32);
        let dw = (cw as f32 * scale).round() as i32;
        let dh = (ch as f32 * scale).round() as i32;
        let dx = ((ww as i32 - dw) / 2).max(0);
        let dy = ((wh as i32 - dh) / 2).max(0);
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
        // Row 0 of the pixmap is the top: flip into GL's bottom-up window.
        gl.blit_framebuffer(0, 0, cw as i32, ch as i32, dx, dy + dh, dx + dw, dy, glow::COLOR_BUFFER_BIT, glow::LINEAR);
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        if scissor {
            gl.enable(glow::SCISSOR_TEST);
        }
        let top = app.height as i32 - dy - dh;
        crate::video::present_overlay(app, (dx, top, dw, dh), (cw, ch));
    }
    true
}

/// HTML form elements over the game picture: JS paints them into a 2D canvas covering the game
/// canvas's CSS box (at window resolution) and names each element's rect in that box's CSS pixels;
/// the rects are blitted opaque into the game rect of the window.
pub struct UiOverlay {
    canvas: u32,
    css: (f32, f32),
    rects: Vec<[f32; 4]>,
    dirty: bool,
    dirty_logged: bool,
    tex: Option<(NativeTexture, NativeFramebuffer, u32, u32)>,
}

/// canvas 0 (or no rects) turns the overlay off; rects are x, y, w, h quads in CSS pixels of the game
/// canvas box (css_w x css_h).
#[op2(fast)]
pub fn op_ui_overlay(state: &mut OpState, canvas: u32, css_w: f32, css_h: f32, #[buffer] rects: &[f32]) {
    UI_CHANGED.with(|c| c.set(true));
    let app = state.borrow_mut::<App>();
    let rects: Vec<[f32; 4]> = rects.chunks_exact(4).map(|r| [r[0], r[1], r[2], r[3]]).collect();
    if canvas == 0 || rects.is_empty() {
        if let Some(u) = app.ui.take() {
            if let Some((tex, fbo, ..)) = u.tex {
                unsafe {
                    app.gl.delete_framebuffer(fbo);
                    app.gl.delete_texture(tex);
                }
            }
        }
        return;
    }
    let tex = app.ui.as_mut().and_then(|u| u.tex.take());
    app.ui = Some(UiOverlay { canvas, css: (css_w.max(1.0), css_h.max(1.0)), rects, dirty: true, dirty_logged: false, tex });
}

fn present_ui(app: &mut App) {
    let gl = &app.gl;
    let Some(u) = app.ui.as_mut() else { return };
    let cs = app.canvases.flushed();
    let Some(c) = cs.get(u.canvas) else { return };
    let (cw, ch) = (c.pixmap.width(), c.pixmap.height());
    unsafe {
        if u.tex.map(|t| (t.2, t.3)) != Some((cw, ch)) {
            if let Some((tex, fbo, _, _)) = u.tex.take() {
                gl.delete_framebuffer(fbo);
                gl.delete_texture(tex);
            }
            let (Ok(tex), Ok(fbo)) = (gl.create_texture(), gl.create_framebuffer()) else { return };
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, cw as i32, ch as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
            gl.framebuffer_texture_2d(glow::READ_FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
            u.tex = Some((tex, fbo, cw, ch));
            u.dirty = true;
        }
        let (tex, fbo, _, _) = u.tex.unwrap();
        if u.dirty {
            gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
            gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, cw as i32, ch as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(c.pixmap.data())));
            gl.bind_texture(glow::TEXTURE_2D, None);
            u.dirty = false;
        }
        let scissor = gl.is_enabled(glow::SCISSOR_TEST);
        if scissor {
            gl.disable(glow::SCISSOR_TEST);
        }
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
        // Overlay pixels per CSS pixel, and the game rect in the window (as present letterboxes it).
        let (kx, ky) = (cw as f32 / u.css.0, ch as f32 / u.css.1);
        let (gw0, gh0) = match (&app.main2d, &app.main_fbo) {
            (Some(m), _) => cs.get(m.canvas).map(|c| (c.pixmap.width(), c.pixmap.height())).unwrap_or((app.width, app.height)),
            (None, Some(f)) => (f.w, f.h),
            _ => (app.width, app.height),
        };
        let (ww, wh_f) = (app.width as f32, app.height as f32);
        let fit = (ww / gw0 as f32).min(wh_f / gh0 as f32);
        let (gw, gh) = ((gw0 as f32 * fit).round(), (gh0 as f32 * fit).round());
        let (gx, gy) = (((ww - gw) / 2.0).max(0.0).floor(), ((wh_f - gh) / 2.0).max(0.0).floor());
        let (sx, sy) = (gw / u.css.0, gh / u.css.1);
        if std::env::var_os("POWERBOAT_FORMS_DEBUG").is_some() && u.dirty_logged == false {
            eprintln!("[powerboat] forms overlay: pixmap {cw}x{ch} css {:?} game {gw0}x{gh0} -> {gx},{gy} {gw}x{gh} rects {:?}", u.css, u.rects);
            u.dirty_logged = true;
        }
        let wh = app.height as i32;
        for r in &u.rects {
            let (x0, y0, x1, y1) = (r[0], r[1], r[0] + r[2], r[1] + r[3]);
            let (s0, s1) = (((x0 * kx).round() as i32).max(0), ((x1 * kx).round() as i32).min(cw as i32));
            let (t0, t1) = (((y0 * ky).round() as i32).max(0), ((y1 * ky).round() as i32).min(ch as i32));
            if s1 <= s0 || t1 <= t0 {
                continue;
            }
            let (d0, d1) = ((gx + x0 * sx).round() as i32, (gx + x1 * sx).round() as i32);
            let (e0, e1) = (wh - (gy + y0 * sy).round() as i32, wh - (gy + y1 * sy).round() as i32);
            // Pixmap row 0 is the top; the window's GL y runs up.
            gl.blit_framebuffer(s0, t0, s1, t1, d0, e0, d1, e1, glow::COLOR_BUFFER_BIT, glow::LINEAR);
        }
        if scissor {
            gl.enable(glow::SCISSOR_TEST);
        }
    }
}

pub fn present(app: &mut App) {
    present_game(app);
    if app.ui.is_some() {
        present_ui(app);
        let fbo = app.main_fbo.as_ref().map(|f| f.fbo);
        unsafe { app.gl.bind_framebuffer(glow::FRAMEBUFFER, if app.main2d.is_some() { None } else { fbo }) };
    }
}

/// POWERBOAT_PRESENT_FILTER=nearest: the game canvas is scaled to the window without filtering (pixel art drawn
/// below the window size, e.g. CONSTRUCT_RENDER_SCALE=0.5: whole-number scales stay sharp). Default linear.
static PRESENT_NEAREST: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_PRESENT_FILTER").is_ok_and(|v| v == "nearest"));

fn present_game(app: &mut App) {
    if app.main2d.is_some() && present_main2d(app) {
        return;
    }
    let Some(f) = app.main_fbo.as_ref() else {
        // The canvas is the window: only a video overlay to draw.
        let (w, h) = (app.width, app.height);
        crate::video::present_overlay(app, (0, 0, w as i32, h as i32), (w, h));
        return;
    };
    let gl = &app.gl;
    unsafe {
        let scissor = gl.is_enabled(glow::SCISSOR_TEST);
        if scissor {
            gl.disable(glow::SCISSOR_TEST);
        }
        let mut clear = [0f32; 4];
        gl.get_parameter_f32_slice(glow::COLOR_CLEAR_VALUE, &mut clear);
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(f.fbo));
        gl.color_mask(true, true, true, true);
        gl.clear_color(0.0, 0.0, 0.0, 1.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
        let (ww, wh) = (app.width as f32, app.height as f32);
        let scale = (ww / f.w as f32).min(wh / f.h as f32);
        let dw = (f.w as f32 * scale).round() as i32;
        let dh = (f.h as f32 * scale).round() as i32;
        let dx = ((ww as i32 - dw) / 2).max(0);
        let dy = ((wh as i32 - dh) / 2).max(0);
        gl.blit_framebuffer(0, 0, f.w as i32, f.h as i32, dx, dy, dx + dw, dy + dh, glow::COLOR_BUFFER_BIT, if *PRESENT_NEAREST { glow::NEAREST } else { glow::LINEAR });
        gl.clear_color(clear[0], clear[1], clear[2], clear[3]);
        let (fbo, fw, fh) = (f.fbo, f.w, f.h);
        // The game rect in GL window coordinates is (dx, dy); the overlay wants it from the top.
        let top = app.height as i32 - dy - dh;
        crate::video::present_overlay(app, (dx, top, dw, dh), (fw, fh));
        let gl = &app.gl;
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
        if scissor {
            gl.enable(glow::SCISSOR_TEST);
        }
    }
}

/// WebGL's preserveDrawingBuffer: false (the default) clears the drawing buffer after each frame
/// shown. Construct 3's intro scenes do not redraw every pixel and rely on it; without the clear the
/// FBO kept the last frame and Mali's back buffers older ones (ghosting). Runs from before_draw
/// once schedule_clear (after the swap) asked for it. The
/// state the clear touches (clear values, masks, scissor, bound framebuffer) is put back.
pub fn clear_drawing_buffer(app: &App) {
    if app.preserve_drawing_buffer {
        return;
    }
    let gl = &app.gl;
    unsafe {
        let scissor = gl.is_enabled(glow::SCISSOR_TEST);
        let mut color = [0f32; 4];
        gl.get_parameter_f32_slice(glow::COLOR_CLEAR_VALUE, &mut color);
        let depth = gl.get_parameter_f32(glow::DEPTH_CLEAR_VALUE);
        let stencil = gl.get_parameter_i32(glow::STENCIL_CLEAR_VALUE);
        let mut cmask = [0i32; 4];
        gl.get_parameter_i32_slice(glow::COLOR_WRITEMASK, &mut cmask);
        let dmask = gl.get_parameter_bool(glow::DEPTH_WRITEMASK);
        let smask = gl.get_parameter_i32(glow::STENCIL_WRITEMASK);
        let bound = gl.get_parameter_framebuffer(glow::FRAMEBUFFER_BINDING);
        if scissor {
            gl.disable(glow::SCISSOR_TEST);
        }
        gl.bind_framebuffer(glow::FRAMEBUFFER, app.main_fbo.as_ref().map(|f| f.fbo));
        gl.color_mask(true, true, true, true);
        gl.depth_mask(true);
        gl.stencil_mask(0xff);
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear_depth_f32(1.0);
        gl.clear_stencil(0);
        gl.clear(glow::COLOR_BUFFER_BIT | glow::DEPTH_BUFFER_BIT | glow::STENCIL_BUFFER_BIT);
        gl.clear_color(color[0], color[1], color[2], color[3]);
        gl.clear_depth_f32(depth);
        gl.clear_stencil(stencil);
        gl.color_mask(cmask[0] != 0, cmask[1] != 0, cmask[2] != 0, cmask[3] != 0);
        gl.depth_mask(dmask);
        gl.stencil_mask(smask as u32);
        gl.bind_framebuffer(glow::FRAMEBUFFER, bound);
        if scissor {
            gl.enable(glow::SCISSOR_TEST);
        }
    }
}

/// The page's WebGL context attribute (10_webgl.js passes it at context creation).
#[op2(fast)]
pub fn op_gl_set_preserve_drawing_buffer(state: &mut OpState, on: bool) {
    state.borrow_mut::<App>().preserve_drawing_buffer = on;
}

fn nz(id: u32) -> Option<NonZeroU32> {
    NonZeroU32::new(id)
}
fn uloc(loc: i32) -> Option<NativeUniformLocation> {
    (loc >= 0).then(|| NativeUniformLocation(loc as u32))
}
// The op macro maps u8/u32/f32/f64 typed arrays only: JS passes Int32Arrays as Uint32Array views
// over the same bytes, reinterpreted here.
fn as_i32(v: &[u32]) -> &[i32] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const i32, v.len()) }
}
fn as_i32_mut(v: &mut [u32]) -> &mut [i32] {
    unsafe { std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut i32, v.len()) }
}
macro_rules! gl {
    ($state:expr) => {
        &$state.borrow::<App>().gl
    };
}

// ---- buffers ----------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_create_buffer(state: &mut OpState) -> u32 {
    let _t = GlTimer::start("op_gl_create_buffer");
    unsafe { gl!(state).create_buffer().map(|b| b.0.get()).unwrap_or(0) }
}
#[op2(fast)]
pub fn op_gl_delete_buffer(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_buffer");
    if let Some(n) = nz(id) {
        unsafe { gl!(state).delete_buffer(NativeBuffer(n)) }
    }
}
#[op2(fast)]
pub fn op_gl_bind_buffer(state: &mut OpState, target: u32, id: u32) {
    let _t = GlTimer::start("op_gl_bind_buffer");
    unsafe { gl!(state).bind_buffer(target, nz(id).map(NativeBuffer)) }
}
#[op2(fast)]
pub fn op_gl_buffer_data_size(state: &mut OpState, target: u32, size: u32, usage: u32) {
    let _t = GlTimer::start("op_gl_buffer_data_size");
    unsafe { gl!(state).buffer_data_size(target, size as i32, usage) }
}
#[op2(fast)]
pub fn op_gl_buffer_data(state: &mut OpState, target: u32, #[buffer] data: &[u8], usage: u32) {
    let _t = GlTimer::start("op_gl_buffer_data");
    unsafe { gl!(state).buffer_data_u8_slice(target, data, usage) }
}
#[op2(fast)]
pub fn op_gl_buffer_sub_data(state: &mut OpState, target: u32, offset: u32, #[buffer] data: &[u8]) {
    let _t = GlTimer::start("op_gl_buffer_sub_data");
    unsafe { gl!(state).buffer_sub_data_u8_slice(target, offset as i32, data) }
}
#[op2(fast)]
pub fn op_gl_get_buffer_parameter(state: &mut OpState, target: u32, pname: u32) -> i32 {
    let _t = GlTimer::start("op_gl_get_buffer_parameter");
    unsafe { gl!(state).get_buffer_parameter_i32(target, pname) }
}

// ---- shaders / programs -----------------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_create_shader(state: &mut OpState, ty: u32) -> u32 {
    let _t = GlTimer::start("op_gl_create_shader");
    let app = state.borrow_mut::<App>();
    let id = unsafe { app.gl.create_shader(ty).map(|s| s.0.get()).unwrap_or(0) };
    app.progcache.create_shader(id, ty);
    id
}
#[op2(fast)]
pub fn op_gl_delete_shader(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_shader");
    if let Some(n) = nz(id) {
        let app = state.borrow_mut::<App>();
        app.progcache.delete_shader(id);
        unsafe { app.gl.delete_shader(NativeShader(n)) }
    }
}
#[op2(fast)]
pub fn op_gl_shader_source(state: &mut OpState, id: u32, #[string] src: &str) {
    let _t = GlTimer::start("op_gl_shader_source");
    if let Some(n) = nz(id) {
        let app = state.borrow_mut::<App>();
        app.progcache.shader_source(&app.gl, id, src);
        unsafe { app.gl.shader_source(NativeShader(n), src) }
    }
}
#[op2(fast)]
pub fn op_gl_compile_shader(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_compile_shader");
    let app = state.borrow_mut::<App>();
    app.progcache.compile_shader(&app.gl, id);
}
#[op2(fast)]
pub fn op_gl_get_shader_compile_status(state: &mut OpState, id: u32) -> bool {
    let _t = GlTimer::start("op_gl_get_shader_compile_status");
    let app = state.borrow_mut::<App>();
    app.progcache.compile_status(&app.gl, id)
}
#[op2]
#[string]
pub fn op_gl_get_shader_info_log(state: &mut OpState, id: u32) -> String {
    let _t = GlTimer::start("op_gl_get_shader_info_log");
    if state.borrow::<App>().progcache.is_deferred(id) {
        return String::new();
    }
    match nz(id) {
        Some(n) => unsafe { gl!(state).get_shader_info_log(NativeShader(n)) },
        None => String::new(),
    }
}
#[op2(fast)]
pub fn op_gl_create_program(state: &mut OpState) -> u32 {
    let _t = GlTimer::start("op_gl_create_program");
    unsafe { gl!(state).create_program().map(|p| p.0.get()).unwrap_or(0) }
}
#[op2(fast)]
pub fn op_gl_delete_program(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_program");
    if let Some(n) = nz(id) {
        let app = state.borrow_mut::<App>();
        app.progcache.delete_program(id);
        unsafe { app.gl.delete_program(NativeProgram(n)) }
    }
}
#[op2(fast)]
pub fn op_gl_attach_shader(state: &mut OpState, program: u32, shader: u32) {
    let _t = GlTimer::start("op_gl_attach_shader");
    if let (Some(p), Some(s)) = (nz(program), nz(shader)) {
        let app = state.borrow_mut::<App>();
        app.progcache.attach(program, shader);
        unsafe { app.gl.attach_shader(NativeProgram(p), NativeShader(s)) }
    }
}
#[op2(fast)]
pub fn op_gl_detach_shader(state: &mut OpState, program: u32, shader: u32) {
    let _t = GlTimer::start("op_gl_detach_shader");
    if let (Some(p), Some(s)) = (nz(program), nz(shader)) {
        let app = state.borrow_mut::<App>();
        app.progcache.detach(program, shader);
        unsafe { app.gl.detach_shader(NativeProgram(p), NativeShader(s)) }
    }
}
#[op2(fast)]
pub fn op_gl_link_program(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_link_program");
    let app = state.borrow_mut::<App>();
    app.progcache.link(&app.gl, id);
}
#[op2(fast)]
pub fn op_gl_validate_program(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_validate_program");
    if let Some(n) = nz(id) {
        unsafe { gl!(state).validate_program(NativeProgram(n)) }
    }
}
#[op2(fast)]
pub fn op_gl_use_program(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_use_program");
    unsafe { gl!(state).use_program(nz(id).map(NativeProgram)) }
}
#[op2(fast)]
pub fn op_gl_get_program_parameter(state: &mut OpState, id: u32, pname: u32) -> i32 {
    let _t = GlTimer::start("op_gl_get_program_parameter");
    match nz(id) {
        Some(n) => unsafe { gl!(state).get_program_parameter_i32(NativeProgram(n), pname) },
        None => 0,
    }
}
#[op2]
#[string]
pub fn op_gl_get_program_info_log(state: &mut OpState, id: u32) -> String {
    let _t = GlTimer::start("op_gl_get_program_info_log");
    match nz(id) {
        Some(n) => unsafe { gl!(state).get_program_info_log(NativeProgram(n)) },
        None => String::new(),
    }
}
#[op2(fast)]
pub fn op_gl_bind_attrib_location(state: &mut OpState, program: u32, index: u32, #[string] name: &str) {
    let _t = GlTimer::start("op_gl_bind_attrib_location");
    if let Some(p) = nz(program) {
        let app = state.borrow_mut::<App>();
        app.progcache.bind_attrib(program, index, name);
        unsafe { app.gl.bind_attrib_location(NativeProgram(p), index, name) }
    }
}
#[op2(fast)]
pub fn op_gl_get_attrib_location(state: &mut OpState, program: u32, #[string] name: &str) -> i32 {
    let _t = GlTimer::start("op_gl_get_attrib_location");
    match nz(program) {
        Some(p) => unsafe { gl!(state).get_attrib_location(NativeProgram(p), name).map(|i| i as i32).unwrap_or(-1) },
        None => -1,
    }
}
#[op2(fast)]
pub fn op_gl_get_uniform_location(state: &mut OpState, program: u32, #[string] name: &str) -> i32 {
    let _t = GlTimer::start("op_gl_get_uniform_location");
    match nz(program) {
        Some(p) => unsafe { gl!(state).get_uniform_location(NativeProgram(p), name).map(|l| l.0 as i32).unwrap_or(-1) },
        None => -1,
    }
}
/// [size, type, name] or null.
#[op2]
#[serde]
pub fn op_gl_get_active_uniform(state: &mut OpState, program: u32, index: u32) -> Option<(i32, u32, String)> {
    let _t = GlTimer::start("op_gl_get_active_uniform");
    let p = nz(program)?;
    unsafe { gl!(state).get_active_uniform(NativeProgram(p), index).map(|u| (u.size, u.utype, u.name)) }
}
#[op2]
#[serde]
pub fn op_gl_get_active_attrib(state: &mut OpState, program: u32, index: u32) -> Option<(i32, u32, String)> {
    let _t = GlTimer::start("op_gl_get_active_attrib");
    let p = nz(program)?;
    unsafe { gl!(state).get_active_attribute(NativeProgram(p), index).map(|a| (a.size, a.atype, a.name)) }
}
#[op2]
#[serde]
pub fn op_gl_get_shader_precision_format(state: &mut OpState, shader_type: u32, precision: u32) -> Option<(i32, i32, i32)> {
    let _t = GlTimer::start("op_gl_get_shader_precision_format");
    unsafe { gl!(state).get_shader_precision_format(shader_type, precision).map(|f| (f.range_min, f.range_max, f.precision)) }
}

// ---- uniforms ---------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_uniform1f(state: &mut OpState, loc: i32, x: f32) {
    let _t = GlTimer::start("op_gl_uniform1f");
    unsafe { gl!(state).uniform_1_f32(uloc(loc).as_ref(), x) }
}
#[op2(fast)]
pub fn op_gl_uniform2f(state: &mut OpState, loc: i32, x: f32, y: f32) {
    let _t = GlTimer::start("op_gl_uniform2f");
    unsafe { gl!(state).uniform_2_f32(uloc(loc).as_ref(), x, y) }
}
#[op2(fast)]
pub fn op_gl_uniform3f(state: &mut OpState, loc: i32, x: f32, y: f32, z: f32) {
    let _t = GlTimer::start("op_gl_uniform3f");
    unsafe { gl!(state).uniform_3_f32(uloc(loc).as_ref(), x, y, z) }
}
#[op2(fast)]
pub fn op_gl_uniform4f(state: &mut OpState, loc: i32, x: f32, y: f32, z: f32, w: f32) {
    let _t = GlTimer::start("op_gl_uniform4f");
    unsafe { gl!(state).uniform_4_f32(uloc(loc).as_ref(), x, y, z, w) }
}
#[op2(fast)]
pub fn op_gl_uniform1i(state: &mut OpState, loc: i32, x: i32) {
    let _t = GlTimer::start("op_gl_uniform1i");
    unsafe { gl!(state).uniform_1_i32(uloc(loc).as_ref(), x) }
}
#[op2(fast)]
pub fn op_gl_uniform2i(state: &mut OpState, loc: i32, x: i32, y: i32) {
    let _t = GlTimer::start("op_gl_uniform2i");
    unsafe { gl!(state).uniform_2_i32(uloc(loc).as_ref(), x, y) }
}
#[op2(fast)]
pub fn op_gl_uniform3i(state: &mut OpState, loc: i32, x: i32, y: i32, z: i32) {
    let _t = GlTimer::start("op_gl_uniform3i");
    unsafe { gl!(state).uniform_3_i32(uloc(loc).as_ref(), x, y, z) }
}
#[op2(fast)]
pub fn op_gl_uniform4i(state: &mut OpState, loc: i32, x: i32, y: i32, z: i32, w: i32) {
    let _t = GlTimer::start("op_gl_uniform4i");
    unsafe { gl!(state).uniform_4_i32(uloc(loc).as_ref(), x, y, z, w) }
}
#[op2(fast)]
pub fn op_gl_uniform1fv(state: &mut OpState, loc: i32, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform1fv");
    unsafe { gl!(state).uniform_1_f32_slice(uloc(loc).as_ref(), v) }
}
#[op2(fast)]
pub fn op_gl_uniform2fv(state: &mut OpState, loc: i32, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform2fv");
    unsafe { gl!(state).uniform_2_f32_slice(uloc(loc).as_ref(), v) }
}
#[op2(fast)]
pub fn op_gl_uniform3fv(state: &mut OpState, loc: i32, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform3fv");
    unsafe { gl!(state).uniform_3_f32_slice(uloc(loc).as_ref(), v) }
}
#[op2(fast)]
pub fn op_gl_uniform4fv(state: &mut OpState, loc: i32, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform4fv");
    unsafe { gl!(state).uniform_4_f32_slice(uloc(loc).as_ref(), v) }
}
#[op2(fast)]
pub fn op_gl_uniform1iv(state: &mut OpState, loc: i32, #[buffer] v: &[u32]) {
    let _t = GlTimer::start("op_gl_uniform1iv");
    unsafe { gl!(state).uniform_1_i32_slice(uloc(loc).as_ref(), as_i32(v)) }
}
#[op2(fast)]
pub fn op_gl_uniform2iv(state: &mut OpState, loc: i32, #[buffer] v: &[u32]) {
    let _t = GlTimer::start("op_gl_uniform2iv");
    unsafe { gl!(state).uniform_2_i32_slice(uloc(loc).as_ref(), as_i32(v)) }
}
#[op2(fast)]
pub fn op_gl_uniform3iv(state: &mut OpState, loc: i32, #[buffer] v: &[u32]) {
    let _t = GlTimer::start("op_gl_uniform3iv");
    unsafe { gl!(state).uniform_3_i32_slice(uloc(loc).as_ref(), as_i32(v)) }
}
#[op2(fast)]
pub fn op_gl_uniform4iv(state: &mut OpState, loc: i32, #[buffer] v: &[u32]) {
    let _t = GlTimer::start("op_gl_uniform4iv");
    unsafe { gl!(state).uniform_4_i32_slice(uloc(loc).as_ref(), as_i32(v)) }
}
#[op2(fast)]
pub fn op_gl_uniform_matrix2fv(state: &mut OpState, loc: i32, transpose: bool, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform_matrix2fv");
    unsafe { gl!(state).uniform_matrix_2_f32_slice(uloc(loc).as_ref(), transpose, v) }
}
#[op2(fast)]
pub fn op_gl_uniform_matrix3fv(state: &mut OpState, loc: i32, transpose: bool, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform_matrix3fv");
    unsafe { gl!(state).uniform_matrix_3_f32_slice(uloc(loc).as_ref(), transpose, v) }
}
#[op2(fast)]
pub fn op_gl_uniform_matrix4fv(state: &mut OpState, loc: i32, transpose: bool, #[buffer] v: &[f32]) {
    let _t = GlTimer::start("op_gl_uniform_matrix4fv");
    unsafe { gl!(state).uniform_matrix_4_f32_slice(uloc(loc).as_ref(), transpose, v) }
}

// ---- vertex attributes / draws ----------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_vertex_attrib_pointer(state: &mut OpState, index: u32, size: i32, ty: u32, normalized: bool, stride: i32, offset: i32) {
    let _t = GlTimer::start("op_gl_vertex_attrib_pointer");
    unsafe { gl!(state).vertex_attrib_pointer_f32(index, size, ty, normalized, stride, offset) }
}
#[op2(fast)]
pub fn op_gl_enable_vertex_attrib_array(state: &mut OpState, index: u32) {
    let _t = GlTimer::start("op_gl_enable_vertex_attrib_array");
    unsafe { gl!(state).enable_vertex_attrib_array(index) }
}
#[op2(fast)]
pub fn op_gl_disable_vertex_attrib_array(state: &mut OpState, index: u32) {
    let _t = GlTimer::start("op_gl_disable_vertex_attrib_array");
    unsafe { gl!(state).disable_vertex_attrib_array(index) }
}
#[op2(fast)]
pub fn op_gl_vertex_attrib4f(state: &mut OpState, index: u32, x: f32, y: f32, z: f32, w: f32) {
    let _t = GlTimer::start("op_gl_vertex_attrib4f");
    unsafe { gl!(state).vertex_attrib_4_f32(index, x, y, z, w) }
}
#[op2(fast)]
pub fn op_gl_draw_arrays(state: &mut OpState, mode: u32, first: i32, count: i32) {
    let _t = GlTimer::start("op_gl_draw_arrays");
    mark_drawn();
    before_draw(state.borrow::<App>());
    crate::ops::GlStats::add(&state.borrow::<App>().stats.draws, 1);
    unsafe { gl!(state).draw_arrays(mode, first, count) }
}
#[op2(fast)]
pub fn op_gl_draw_elements(state: &mut OpState, mode: u32, count: i32, ty: u32, offset: i32) {
    let _t = GlTimer::start("op_gl_draw_elements");
    mark_drawn();
    before_draw(state.borrow::<App>());
    crate::ops::GlStats::add(&state.borrow::<App>().stats.draws, 1);
    unsafe { gl!(state).draw_elements(mode, count, ty, offset) }
}
#[op2(fast)]
pub fn op_gl_vertex_attrib_divisor(state: &mut OpState, index: u32, divisor: u32) {
    let _t = GlTimer::start("op_gl_vertex_attrib_divisor");
    unsafe { gl!(state).vertex_attrib_divisor(index, divisor) }
}
#[op2(fast)]
pub fn op_gl_draw_arrays_instanced(state: &mut OpState, mode: u32, first: i32, count: i32, instances: i32) {
    let _t = GlTimer::start("op_gl_draw_arrays_instanced");
    mark_drawn();
    before_draw(state.borrow::<App>());
    crate::ops::GlStats::add(&state.borrow::<App>().stats.draws, 1);
    unsafe { gl!(state).draw_arrays_instanced(mode, first, count, instances) }
}
#[op2(fast)]
pub fn op_gl_draw_elements_instanced(state: &mut OpState, mode: u32, count: i32, ty: u32, offset: i32, instances: i32) {
    let _t = GlTimer::start("op_gl_draw_elements_instanced");
    mark_drawn();
    before_draw(state.borrow::<App>());
    crate::ops::GlStats::add(&state.borrow::<App>().stats.draws, 1);
    unsafe { gl!(state).draw_elements_instanced(mode, count, ty, offset, instances) }
}
#[op2(fast)]
pub fn op_gl_create_vertex_array(state: &mut OpState) -> u32 {
    let _t = GlTimer::start("op_gl_create_vertex_array");
    unsafe { gl!(state).create_vertex_array().map(|v| v.0.get()).unwrap_or(0) }
}
#[op2(fast)]
pub fn op_gl_bind_vertex_array(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_bind_vertex_array");
    unsafe { gl!(state).bind_vertex_array(nz(id).map(NativeVertexArray)) }
}
#[op2(fast)]
pub fn op_gl_delete_vertex_array(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_vertex_array");
    if let Some(n) = nz(id) {
        unsafe { gl!(state).delete_vertex_array(NativeVertexArray(n)) }
    }
}

// ---- textures ---------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_create_texture(state: &mut OpState) -> u32 {
    let _t = GlTimer::start("op_gl_create_texture");
    unsafe { gl!(state).create_texture().map(|t| t.0.get()).unwrap_or(0) }
}
#[op2(fast)]
pub fn op_gl_delete_texture(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_texture");
    let app = state.borrow_mut::<App>();
    // Real framebuffers made for this texture go with it (FboCache); one bound now leaves the game
    // framebuffer with no color, as deleting an attached texture does.
    let bound = app.fbos.bound;
    let mut rebind = None;
    for (&fid, f) in app.fbos.fbos.iter_mut() {
        if let Some(r) = f.real.remove(&id) {
            unsafe { app.gl.delete_framebuffer(r) }
        }
        if f.color == id && !f.plain {
            f.color = 0;
            if fid == bound {
                rebind = nz(fid).map(NativeFramebuffer);
            }
        }
    }
    if let Some(own) = rebind {
        unsafe { app.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(own)) }
    }
    if let Some(n) = nz(id) {
        unsafe { app.gl.delete_texture(NativeTexture(n)) }
    }
}
#[op2(fast)]
pub fn op_gl_bind_texture(state: &mut OpState, target: u32, id: u32) {
    let _t = GlTimer::start("op_gl_bind_texture");
    unsafe { gl!(state).bind_texture(target, nz(id).map(NativeTexture)) }
}
#[op2(fast)]
pub fn op_gl_active_texture(state: &mut OpState, unit: u32) {
    let _t = GlTimer::start("op_gl_active_texture");
    unsafe { gl!(state).active_texture(unit) }
}
#[op2(fast)]
pub fn op_gl_tex_parameteri(state: &mut OpState, target: u32, pname: u32, param: i32) {
    let _t = GlTimer::start("op_gl_tex_parameteri");
    unsafe { gl!(state).tex_parameter_i32(target, pname, param) }
}
#[op2(fast)]
pub fn op_gl_tex_parameterf(state: &mut OpState, target: u32, pname: u32, param: f32) {
    let _t = GlTimer::start("op_gl_tex_parameterf");
    unsafe { gl!(state).tex_parameter_f32(target, pname, param) }
}
#[op2(fast)]
pub fn op_gl_get_tex_parameter(state: &mut OpState, target: u32, pname: u32) -> i32 {
    let _t = GlTimer::start("op_gl_get_tex_parameter");
    unsafe { gl!(state).get_tex_parameter_i32(target, pname) }
}
#[op2(fast)]
pub fn op_gl_generate_mipmap(state: &mut OpState, target: u32) {
    let _t = GlTimer::start("op_gl_generate_mipmap");
    unsafe { gl!(state).generate_mipmap(target) }
}
#[op2(fast)]
pub fn op_gl_pixel_storei(state: &mut OpState, pname: u32, param: i32) {
    let _t = GlTimer::start("op_gl_pixel_storei");
    let app = state.borrow_mut::<App>();
    match pname {
        UNPACK_FLIP_Y_WEBGL => app.unpack_flip_y = param != 0,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL => app.unpack_premultiply = param != 0,
        UNPACK_COLORSPACE_CONVERSION_WEBGL => {}
        _ => unsafe { app.gl.pixel_store_i32(pname, param) },
    }
}
/// texImage2D(..., null) calls and the bytes zero-filled for them (exit report).
pub static NULL_TEX: (std::sync::atomic::AtomicU64, std::sync::atomic::AtomicU64) = (std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0));
/// Bytes per texel of a colour upload format, or None (depth formats, unknown pairs: left to GL).
fn texel_bytes(format: u32, ty: u32) -> Option<usize> {
    let comps = match format {
        RGBA => 4,
        0x1907 => 3,          // RGB
        0x190A => 2,          // LUMINANCE_ALPHA
        0x1909 | 0x1906 => 1, // LUMINANCE, ALPHA
        _ => return None,
    };
    match ty {
        UNSIGNED_BYTE => Some(comps),
        0x8033 | 0x8034 | 0x8363 => Some(2),       // UNSIGNED_SHORT_4_4_4_4, _5_5_5_1, _5_6_5
        0x1406 => Some(comps * 4),                 // FLOAT
        0x8D61 | 0x140B => Some(comps * 2),        // HALF_FLOAT_OES, HALF_FLOAT
        _ => None,
    }
}
/// A new RGBA texture this large or larger (bytes) is cleared on the GPU rather than uploaded as zeros.
const GPU_CLEAR_MIN: usize = 256 * 1024;
/// POWERBOAT_GL_GPU_CLEAR=0: every texImage2D(..., null) uploads zeros again (A/B).
static GPU_CLEAR: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_GL_GPU_CLEAR").map_or(true, |v| v != "0"));
thread_local! {
    /// The framebuffer clear_new_texture attaches textures to (made on first use, kept).
    static CLEAR_FB: std::cell::Cell<Option<glow::NativeFramebuffer>> = const { std::cell::Cell::new(None) };
}
/// The texture bound to TEXTURE_2D (just allocated by texImage2D with no data) cleared to transparent black with
/// one glClear on a scratch framebuffer: what WebGL promises for a texture made without data, for the cost of a
/// GPU clear instead of a CPU upload of w x h zeros (2048 x 2048: 16 MB through the driver's tiling, tens of ms
/// on a Cortex-A53; render textures, Construct's text and layer textures). The framebuffer binding, scissor test,
/// color mask and clear color are put back. False when the framebuffer is not complete (the caller uploads zeros).
unsafe fn clear_new_texture(gl: &glow::Context) -> bool {
    let Some(tex) = gl.get_parameter_texture(glow::TEXTURE_BINDING_2D) else { return false };
    let fb = match CLEAR_FB.get() {
        Some(f) => f,
        None => match gl.create_framebuffer() {
            Ok(f) => {
                CLEAR_FB.set(Some(f));
                f
            }
            Err(_) => return false,
        },
    };
    let prev = gl.get_parameter_framebuffer(glow::FRAMEBUFFER_BINDING);
    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fb));
    gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
    let ok = gl.check_framebuffer_status(glow::FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE;
    if ok {
        let scissor = gl.is_enabled(glow::SCISSOR_TEST);
        let mask: [bool; 4] = gl.get_parameter_bool_array(glow::COLOR_WRITEMASK);
        let mut color = [0f32; 4];
        gl.get_parameter_f32_slice(glow::COLOR_CLEAR_VALUE, &mut color);
        if scissor {
            gl.disable(glow::SCISSOR_TEST);
        }
        gl.color_mask(true, true, true, true);
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
        gl.clear_color(color[0], color[1], color[2], color[3]);
        gl.color_mask(mask[0], mask[1], mask[2], mask[3]);
        if scissor {
            gl.enable(glow::SCISSOR_TEST);
        }
    }
    gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, None, 0);
    gl.bind_framebuffer(glow::FRAMEBUFFER, prev);
    ok
}
#[op2(fast)]
pub fn op_gl_tex_image_2d_null(state: &mut OpState, target: u32, level: i32, internalformat: i32, w: i32, h: i32, border: i32, format: u32, ty: u32) {
    let _t = GlTimer::start("op_gl_tex_image_2d_null");
    // WebGL fills a texture made without data with zeros (transparent black); GLES leaves it undefined, and the
    // PowerVR GE8300 (TrimUI Brick, muOS) shows recycled video memory there. Construct 3 makes its text textures
    // empty and fills them a frame later: Janosik's dialogue flashed noise. So colour textures get zeros. Large
    // zeroed buffers are fresh zero pages (calloc), read by the upload without being committed.
    let bytes = if w > 0 && h > 0 { texel_bytes(format, ty).map(|b| (w as usize * b).div_ceil(8) * 8 * h as usize) } else { None };
    NULL_TEX.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let gl = gl!(state);
    // Large RGBA textures are cleared on the GPU instead (clear_new_texture).
    if bytes.is_some_and(|n| n >= GPU_CLEAR_MIN) && target == glow::TEXTURE_2D && level == 0 && format == RGBA && ty == UNSIGNED_BYTE && *GPU_CLEAR {
        unsafe { gl.tex_image_2d(target, level, internalformat, w, h, border, format, ty, glow::PixelUnpackData::Slice(None)) };
        if unsafe { clear_new_texture(gl) } {
            return;
        }
    }
    match bytes {
        Some(n) => {
            NULL_TEX.1.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
            let zeros = vec![0u8; n];
            unsafe { gl.tex_image_2d(target, level, internalformat, w, h, border, format, ty, glow::PixelUnpackData::Slice(Some(&zeros))) }
        }
        None => unsafe { gl.tex_image_2d(target, level, internalformat, w, h, border, format, ty, glow::PixelUnpackData::Slice(None)) },
    }
}
#[op2(fast)]
pub fn op_gl_tex_image_2d_data(state: &mut OpState, target: u32, level: i32, internalformat: i32, w: i32, h: i32, border: i32, format: u32, ty: u32, #[buffer] data: &[u8]) {
    let _t = GlTimer::start("op_gl_tex_image_2d_data");
    { let st = &state.borrow::<App>().stats; crate::ops::GlStats::add(&st.uploads, 1); crate::ops::GlStats::add(&st.upload_bytes, (w.max(0) as u64) * (h.max(0) as u64) * 4); }
    let app = state.borrow::<App>();
    let converted;
    let pixels: &[u8] = if format == RGBA && ty == UNSIGNED_BYTE && (app.unpack_flip_y || app.unpack_premultiply) && w > 0 && h > 0 {
        converted = convert_rgba(data, w as usize, h as usize, app.unpack_flip_y, app.unpack_premultiply);
        &converted
    } else {
        data
    };
    unsafe { app.gl.tex_image_2d(target, level, internalformat, w, h, border, format, ty, glow::PixelUnpackData::Slice(Some(pixels))) }
}
/// texImage2D(target, level, internalformat, format, type, image): uploads a decoded image from
/// the image store as RGBA8 (the only layout MV/PIXI use). Returns false if the id is unknown.
#[op2(fast)]
pub fn op_gl_tex_image_2d_image(state: &mut OpState, target: u32, level: i32, image: u32) -> bool {
    let _t = GlTimer::start("op_gl_tex_image_2d_image");
    { let a = state.borrow::<App>(); crate::ops::GlStats::add(&a.stats.uploads, 1); crate::ops::GlStats::add(&a.stats.upload_bytes, a.images.get(image).map(|i| { let (w, h) = i.stored_wh(); (w * h * 4) as u64 }).unwrap_or(0)); }
    let app = state.borrow::<App>();
    let Some(img) = app.images.get(image) else { return false };
    {
        let Some(rgba) = img.rgba() else { return false };
        let (iw, ih) = img.stored_wh();
        let pixels = convert_rgba(&rgba, iw as usize, ih as usize, app.unpack_flip_y, app.unpack_premultiply);
        unsafe {
            app.gl.tex_image_2d(target, level, RGBA as i32, iw as i32, ih as i32, 0, RGBA, UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&pixels)));
        }
    }
    app.images.after_upload(image);
    true
}
/// The pixels of a Canvas 2D pixmap (premultiplied) as the upload wants them.
fn canvas_pixels<'a>(data: &'a [u8], w: usize, h: usize, flip_y: bool, premultiplied: bool) -> Cow<'a, [u8]> {
    if premultiplied {
        convert_rgba(data, w, h, flip_y, false)
    } else {
        // Straight alpha, flipped in the same pass when asked.
        let row = w * 4;
        let mut out = vec![0u8; data.len()];
        if flip_y && row > 0 && data.len() >= row * h {
            for (y, d) in out.chunks_exact_mut(row).take(h).enumerate() {
                let sy = h - 1 - y;
                demultiply(&data[sy * row..sy * row + row], d);
            }
        } else {
            demultiply(data, &mut out);
        }
        Cow::Owned(out)
    }
}
/// The 2D page presenter's upload (79_webpage.js): the page canvas's premultiplied pixels as they are
/// into the bound texture. With deferred Canvas 2D, the newest finished frame's copy, one behind.
/// The page presenter's per-frame upload: the same texture at the same size is updated in place
/// (texSubImage2D) instead of being reallocated by texImage2D every frame.
fn present_tex_upload(gl: &glow::Context, target: u32, w: u32, h: u32, data: &[u8]) {
    thread_local! {
        static SIZES: std::cell::RefCell<std::collections::HashMap<u32, (u32, u32)>> = Default::default();
    }
    unsafe {
        let tex = if target == glow::TEXTURE_2D { gl.get_parameter_texture(glow::TEXTURE_BINDING_2D).map(|t| t.0.get()) } else { None };
        let same = tex.is_some_and(|t| SIZES.with(|m| m.borrow().get(&t) == Some(&(w, h))));
        if same && std::env::var_os("POWERBOAT_PRESENT_REALLOC").is_none() {
            gl.tex_sub_image_2d(target, 0, 0, 0, w as i32, h as i32, RGBA, UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(data)));
        } else {
            gl.tex_image_2d(target, 0, RGBA as i32, w as i32, h as i32, 0, RGBA, UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(data)));
            if let Some(t) = tex {
                SIZES.with(|m| m.borrow_mut().insert(t, (w, h)));
            }
        }
    }
}
#[op2(fast)]
pub fn op_c2d_present_upload(state: &mut OpState, target: u32, canvas: u32) -> bool {
    let _t = GlTimer::start("op_c2d_present_upload");
    { let a = state.borrow::<App>(); crate::ops::GlStats::add(&a.stats.uploads, 1); crate::ops::GlStats::add(&a.stats.upload_bytes, a.canvases.size(canvas).map(|(w, h)| w as u64 * h as u64 * 4).unwrap_or(0)); }
    let app = state.borrow_mut::<App>();
    if crate::canvas::pipelined() {
        match app.canvases.present_frame(canvas) {
            Some(crate::canvas::Presented::Gpu(f)) => unsafe {
                // Uploaded on the drawing thread: the GPU waits for that upload, the CPU does not.
                app.gl.wait_sync(f.fence, 0, glow::TIMEOUT_IGNORED);
                app.gl.delete_sync(f.fence);
                app.gl.bind_texture(target, Some(f.tex));
                app.canvases.held_tex = Some(f.tex);
            },
            Some(crate::canvas::Presented::Cpu(f)) => {
                app.canvases.held_tex = None;
                present_tex_upload(&app.gl, target, f.w, f.h, &f.data);
                app.canvases.recycle(f);
            }
            // Nothing newer finished: the texture keeps the last frame.
            None => {
                if let Some(t) = app.canvases.held_tex {
                    unsafe { app.gl.bind_texture(target, Some(t)) };
                }
                return app.canvases.size(canvas).is_some();
            }
        }
        return true;
    }
    let cs = app.canvases.flushed();
    let Some(c) = cs.get(canvas) else { return false };
    present_tex_upload(&app.gl, target, c.pixmap.width(), c.pixmap.height(), c.pixmap.data());
    true
}
/// 2D pages: the page canvas's newest frame to the present thread (crate::present), started on the first
/// call. 1 handed over, 0 nothing newer, 2 not decided yet (this frame on the JS thread), -1 the page
/// presents on the JS thread from now on (POWERBOAT_PAGE_PRESENT=main, no drawing-thread uploads, a UI or
/// video overlay, or a driver that refused).
#[op2(fast)]
pub fn op_c2d_present_page(state: &mut OpState, canvas: u32) -> i32 {
    let _t = GlTimer::start("op_c2d_present_page");
    let app = state.borrow_mut::<App>();
    // Canvas 2D draws in each op (POWERBOAT_C2D_DEFER=0, or it fell back after too many waits): the page
    // presents on the JS thread, which needs the window surface back from a running present thread, or
    // it draws into the 1x1 pbuffer and the picture freezes.
    if !crate::canvas::pipelined() {
        if crate::present::active() {
            eprintln!("[powerboat] 2D page: Canvas 2D draws in each op now, the present moves back to the JS thread");
            crate::present::stop();
        }
        return -1;
    }
    // Those draw over the page on the JS thread's context.
    if app.ui.is_some() || app.videos.overlay.is_some() {
        if crate::present::active() {
            eprintln!("[powerboat] 2D page: a UI or video overlay, the present moves back to the JS thread");
            crate::present::stop();
        }
        return -1;
    }
    if !crate::present::active() {
        match app.canvases.gpu_upload() {
            None => return 2,
            Some(false) => return -1,
            Some(true) => {}
        }
        if let Err(e) = crate::present::start(app.canvases.handoff()) {
            eprintln!("[powerboat] 2D page: presented on the JS thread ({e})");
            return -1;
        }
        eprintln!("[powerboat] 2D page: presented on its own thread (POWERBOAT_PAGE_PRESENT=main: on the JS thread)");
    }
    match app.canvases.queue_frame(canvas) {
        crate::canvas::Queued::Sent => {
            crate::present::SENT.store(true, std::sync::atomic::Ordering::Relaxed);
            crate::present::HANDED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            1
        }
        // Swapped again, as the JS-thread present did with its held texture: a drawn frame.
        crate::canvas::Queued::Repeat => {
            crate::present::SENT.store(true, std::sync::atomic::Ordering::Relaxed);
            1
        }
        crate::canvas::Queued::Nothing => 0,
        crate::canvas::Queued::Cpu(f) => {
            app.canvases.recycle(f);
            0
        }
    }
}
/// texImage2D(target, level, internalformat, format, type, canvas).
#[op2(fast)]
pub fn op_gl_tex_image_2d_canvas(state: &mut OpState, target: u32, level: i32, canvas: u32) -> bool {
    let _t = GlTimer::start("op_gl_tex_image_2d_canvas");
    { let a = state.borrow::<App>(); crate::ops::GlStats::add(&a.stats.uploads, 1); crate::ops::GlStats::add(&a.stats.upload_bytes, a.canvases.size(canvas).map(|(w, h)| w as u64 * h as u64 * 4).unwrap_or(0)); }
    let app = state.borrow_mut::<App>();
    let cs = app.canvases.flushed();
    let Some(c) = cs.get(canvas) else { return false };
    let (w, h) = (c.pixmap.width(), c.pixmap.height());
    let pixels = canvas_pixels(c.pixmap.data(), w as usize, h as usize, app.unpack_flip_y, app.unpack_premultiply);
    unsafe {
        app.gl.tex_image_2d(target, level, RGBA as i32, w as i32, h as i32, 0, RGBA, UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&pixels)));
    }
    true
}
#[op2(fast)]
pub fn op_gl_tex_sub_image_2d_canvas(state: &mut OpState, target: u32, level: i32, x: i32, y: i32, canvas: u32) -> bool {
    let _t = GlTimer::start("op_gl_tex_sub_image_2d_canvas");
    { let a = state.borrow::<App>(); crate::ops::GlStats::add(&a.stats.uploads, 1); crate::ops::GlStats::add(&a.stats.upload_bytes, a.canvases.size(canvas).map(|(w, h)| w as u64 * h as u64 * 4).unwrap_or(0)); }
    let app = state.borrow_mut::<App>();
    let cs = app.canvases.flushed();
    let Some(c) = cs.get(canvas) else { return false };
    let (w, h) = (c.pixmap.width(), c.pixmap.height());
    let pixels = canvas_pixels(c.pixmap.data(), w as usize, h as usize, app.unpack_flip_y, app.unpack_premultiply);
    unsafe {
        app.gl.tex_sub_image_2d(target, level, x, y, w as i32, h as i32, RGBA, UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&pixels)));
    }
    true
}
#[op2(fast)]
pub fn op_gl_tex_sub_image_2d_data(state: &mut OpState, target: u32, level: i32, x: i32, y: i32, w: i32, h: i32, format: u32, ty: u32, #[buffer] data: &[u8]) {
    let _t = GlTimer::start("op_gl_tex_sub_image_2d_data");
    { let st = &state.borrow::<App>().stats; crate::ops::GlStats::add(&st.uploads, 1); crate::ops::GlStats::add(&st.upload_bytes, (w.max(0) as u64) * (h.max(0) as u64) * 4); }
    let app = state.borrow::<App>();
    let converted;
    let pixels: &[u8] = if format == RGBA && ty == UNSIGNED_BYTE && (app.unpack_flip_y || app.unpack_premultiply) && w > 0 && h > 0 {
        converted = convert_rgba(data, w as usize, h as usize, app.unpack_flip_y, app.unpack_premultiply);
        &converted
    } else {
        data
    };
    unsafe { app.gl.tex_sub_image_2d(target, level, x, y, w, h, format, ty, glow::PixelUnpackData::Slice(Some(pixels))) }
}
#[op2(fast)]
pub fn op_gl_tex_sub_image_2d_image(state: &mut OpState, target: u32, level: i32, x: i32, y: i32, image: u32) -> bool {
    let _t = GlTimer::start("op_gl_tex_sub_image_2d_image");
    { let a = state.borrow::<App>(); crate::ops::GlStats::add(&a.stats.uploads, 1); crate::ops::GlStats::add(&a.stats.upload_bytes, a.images.get(image).map(|i| { let (w, h) = i.stored_wh(); (w * h * 4) as u64 }).unwrap_or(0)); }
    let app = state.borrow::<App>();
    let Some(img) = app.images.get(image) else { return false };
    {
        let Some(rgba) = img.rgba() else { return false };
        let (iw, ih) = img.stored_wh();
        let pixels = convert_rgba(&rgba, iw as usize, ih as usize, app.unpack_flip_y, app.unpack_premultiply);
        unsafe {
            app.gl.tex_sub_image_2d(target, level, x, y, iw as i32, ih as i32, RGBA, UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&pixels)));
        }
    }
    app.images.after_upload(image);
    true
}
#[op2(fast)]
pub fn op_gl_copy_tex_sub_image_2d(state: &mut OpState, target: u32, level: i32, xo: i32, yo: i32, x: i32, y: i32, w: i32, h: i32) {
    let _t = GlTimer::start("op_gl_copy_tex_sub_image_2d");
    unsafe { gl!(state).copy_tex_sub_image_2d(target, level, xo, yo, x, y, w, h) }
}
#[op2(fast)]
pub fn op_gl_copy_tex_image_2d(state: &mut OpState, target: u32, level: i32, internalformat: u32, x: i32, y: i32, w: i32, h: i32, border: i32) {
    let _t = GlTimer::start("op_gl_copy_tex_image_2d");
    unsafe { gl!(state).copy_tex_image_2d(target, level, internalformat, x, y, w, h, border) }
}

// ---- framebuffers / renderbuffers -------------------------------------------------------------

/// Construct 2 renders to textures through one framebuffer whose color attachment it swaps at every switch:
/// framebufferTexture2D(layer texture) to draw into it, framebufferTexture2D(null) before going back to the
/// screen. A tiler driver reconfigures the framebuffer on each attachment change (Hypnospace Outlaw's desktop:
/// 6 % of the JS thread inside glFramebufferTexture2D on the RG Cube XX's Mali). Here a game framebuffer's
/// COLOR_ATTACHMENT0 texture selects one of its own real framebuffers, made once per texture with the same
/// renderbuffers, so the swap is a bind. Any other attachment (another point, a texture level, a cube face)
/// turns that framebuffer back into a plain one. POWERBOAT_FBO_PER_TEXTURE=0 attaches as asked.
#[derive(Default)]
pub struct FboCache {
    /// The game framebuffer last bound (its GL name; 0 = the canvas).
    bound: u32,
    fbos: std::collections::HashMap<u32, GameFbo>,
}
#[derive(Default)]
struct GameFbo {
    /// The texture at COLOR_ATTACHMENT0 (0: none; the framebuffer's own name is then bound).
    color: u32,
    /// Renderbuffer attachments (point, renderbuffer), repeated on every real framebuffer.
    rbs: Vec<(u32, u32)>,
    real: std::collections::HashMap<u32, NativeFramebuffer>,
    plain: bool,
}
static FBO_PER_TEXTURE: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_FBO_PER_TEXTURE").map_or(true, |v| v != "0"));

impl FboCache {
    /// The real framebuffer that stands for game framebuffer `id` now.
    fn real(&self, id: u32) -> Option<NativeFramebuffer> {
        let own = nz(id).map(NativeFramebuffer);
        match self.fbos.get(&id) {
            Some(f) if !f.plain && f.color != 0 => f.real.get(&f.color).copied().or(own),
            _ => own,
        }
    }
}

#[op2(fast)]
pub fn op_gl_create_framebuffer(state: &mut OpState) -> u32 {
    let _t = GlTimer::start("op_gl_create_framebuffer");
    unsafe { gl!(state).create_framebuffer().map(|f| f.0.get()).unwrap_or(0) }
}
#[op2(fast)]
pub fn op_gl_delete_framebuffer(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_framebuffer");
    let app = state.borrow_mut::<App>();
    if let Some(f) = app.fbos.fbos.remove(&id) {
        for r in f.real.into_values() {
            unsafe { app.gl.delete_framebuffer(r) }
        }
    }
    let was_bound = app.fbos.bound == id && id != 0;
    if was_bound {
        app.fbos.bound = 0;
    }
    if let Some(n) = nz(id) {
        unsafe { app.gl.delete_framebuffer(NativeFramebuffer(n)) }
    }
    // WebGL: deleting the bound framebuffer binds null, the canvas (here the main FBO when there is one);
    // GL alone would fall back to framebuffer 0.
    if was_bound {
        unsafe { app.gl.bind_framebuffer(glow::FRAMEBUFFER, app.main_fbo.as_ref().map(|f| f.fbo)) }
    }
}
#[op2(fast)]
pub fn op_gl_bind_framebuffer(state: &mut OpState, target: u32, id: u32) {
    let _t = GlTimer::start("op_gl_bind_framebuffer");
    crate::ops::GlStats::add(&state.borrow::<App>().stats.fb_binds, 1);
    let app = state.borrow_mut::<App>();
    if target != glow::READ_FRAMEBUFFER {
        app.fbos.bound = id;
    }
    // WebGL's "null" framebuffer is the game canvas: the main FBO when there is one.
    let fb = match nz(id) {
        Some(_) => app.fbos.real(id),
        None => app.main_fbo.as_ref().map(|f| f.fbo),
    };
    unsafe { app.gl.bind_framebuffer(target, fb) }
}

#[op2(fast)]
pub fn op_gl_framebuffer_texture_2d(state: &mut OpState, target: u32, attachment: u32, textarget: u32, texture: u32, level: i32) {
    let _t = GlTimer::start("op_gl_framebuffer_texture_2d");
    let app = state.borrow_mut::<App>();
    let gl = &app.gl;
    let id = app.fbos.bound;
    let simple = *FBO_PER_TEXTURE && target != glow::READ_FRAMEBUFFER && attachment == glow::COLOR_ATTACHMENT0 && textarget == glow::TEXTURE_2D && level == 0;
    let Some(own) = nz(id).map(NativeFramebuffer) else {
        unsafe { gl.framebuffer_texture_2d(target, attachment, textarget, nz(texture).map(NativeTexture), level) };
        return;
    };
    let f = app.fbos.fbos.entry(id).or_default();
    if f.plain || !simple {
        if !f.plain {
            // Becomes a plain framebuffer: its own name, with the color the game attached last.
            f.plain = true;
            unsafe {
                gl.bind_framebuffer(target, Some(own));
                gl.framebuffer_texture_2d(target, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, nz(f.color).map(NativeTexture), 0);
            }
            for r in std::mem::take(&mut f.real).into_values() {
                unsafe { gl.delete_framebuffer(r) }
            }
        }
        unsafe { gl.framebuffer_texture_2d(target, attachment, textarget, nz(texture).map(NativeTexture), level) };
        return;
    }
    f.color = texture;
    let fb = match nz(texture) {
        None => own,
        Some(t) => match f.real.get(&texture) {
            Some(&r) => r,
            None => unsafe {
                let Ok(r) = gl.create_framebuffer() else { return };
                gl.bind_framebuffer(target, Some(r));
                gl.framebuffer_texture_2d(target, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(NativeTexture(t)), 0);
                for &(point, rb) in &f.rbs {
                    gl.framebuffer_renderbuffer(target, point, glow::RENDERBUFFER, nz(rb).map(NativeRenderbuffer));
                }
                f.real.insert(texture, r);
                r
            },
        },
    };
    unsafe { gl.bind_framebuffer(target, Some(fb)) }
}
#[op2(fast)]
pub fn op_gl_framebuffer_renderbuffer(state: &mut OpState, target: u32, attachment: u32, rbtarget: u32, rb: u32) {
    let _t = GlTimer::start("op_gl_framebuffer_renderbuffer");
    let app = state.borrow_mut::<App>();
    let gl = &app.gl;
    let id = app.fbos.bound;
    match app.fbos.fbos.get_mut(&id) {
        // A game framebuffer with its own real ones: the renderbuffer goes on all of them.
        Some(f) if !f.plain && nz(id).is_some() => {
            f.rbs.retain(|&(p, _)| p != attachment);
            f.rbs.push((attachment, rb));
            let own = NativeFramebuffer(nz(id).unwrap());
            for fb in std::iter::once(own).chain(f.real.values().copied()) {
                unsafe {
                    gl.bind_framebuffer(target, Some(fb));
                    gl.framebuffer_renderbuffer(target, attachment, rbtarget, nz(rb).map(NativeRenderbuffer));
                }
            }
            let cur = if f.color != 0 { f.real.get(&f.color).copied().unwrap_or(own) } else { own };
            unsafe { gl.bind_framebuffer(target, Some(cur)) }
        }
        _ => {
            // Not seen yet: note it, so real framebuffers made later get it too.
            if nz(id).is_some() {
                let f = app.fbos.fbos.entry(id).or_default();
                f.rbs.retain(|&(p, _)| p != attachment);
                f.rbs.push((attachment, rb));
            }
            unsafe { gl.framebuffer_renderbuffer(target, attachment, rbtarget, nz(rb).map(NativeRenderbuffer)) }
        }
    }
}
#[op2(fast)]
pub fn op_gl_check_framebuffer_status(state: &mut OpState, target: u32) -> u32 {
    let _t = GlTimer::start("op_gl_check_framebuffer_status");
    unsafe { gl!(state).check_framebuffer_status(target) }
}
#[op2(fast)]
pub fn op_gl_get_framebuffer_attachment_parameter(state: &mut OpState, target: u32, attachment: u32, pname: u32) -> i32 {
    let _t = GlTimer::start("op_gl_get_framebuffer_attachment_parameter");
    unsafe { gl!(state).get_framebuffer_attachment_parameter_i32(target, attachment, pname) }
}
#[op2(fast)]
pub fn op_gl_create_renderbuffer(state: &mut OpState) -> u32 {
    let _t = GlTimer::start("op_gl_create_renderbuffer");
    unsafe { gl!(state).create_renderbuffer().map(|r| r.0.get()).unwrap_or(0) }
}
#[op2(fast)]
pub fn op_gl_delete_renderbuffer(state: &mut OpState, id: u32) {
    let _t = GlTimer::start("op_gl_delete_renderbuffer");
    if let Some(n) = nz(id) {
        unsafe { gl!(state).delete_renderbuffer(NativeRenderbuffer(n)) }
    }
}
#[op2(fast)]
pub fn op_gl_bind_renderbuffer(state: &mut OpState, target: u32, id: u32) {
    let _t = GlTimer::start("op_gl_bind_renderbuffer");
    unsafe { gl!(state).bind_renderbuffer(target, nz(id).map(NativeRenderbuffer)) }
}
#[op2(fast)]
pub fn op_gl_renderbuffer_storage(state: &mut OpState, target: u32, internalformat: u32, w: i32, h: i32) {
    let _t = GlTimer::start("op_gl_renderbuffer_storage");
    // WebGL's unsized DEPTH_STENCIL is the sized DEPTH24_STENCIL8 on GLES 3.
    let fmt = if internalformat == DEPTH_STENCIL { DEPTH24_STENCIL8 } else { internalformat };
    unsafe { gl!(state).renderbuffer_storage(target, fmt, w, h) }
}
#[op2(fast)]
pub fn op_gl_get_renderbuffer_parameter(state: &mut OpState, target: u32, pname: u32) -> i32 {
    let _t = GlTimer::start("op_gl_get_renderbuffer_parameter");
    unsafe { gl!(state).get_renderbuffer_parameter_i32(target, pname) }
}

// ---- state ------------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_enable(state: &mut OpState, cap: u32) {
    let _t = GlTimer::start("op_gl_enable");
    unsafe { gl!(state).enable(cap) }
}
#[op2(fast)]
pub fn op_gl_disable(state: &mut OpState, cap: u32) {
    let _t = GlTimer::start("op_gl_disable");
    unsafe { gl!(state).disable(cap) }
}
#[op2(fast)]
pub fn op_gl_is_enabled(state: &mut OpState, cap: u32) -> bool {
    let _t = GlTimer::start("op_gl_is_enabled");
    unsafe { gl!(state).is_enabled(cap) }
}
#[op2(fast)]
pub fn op_gl_blend_func(state: &mut OpState, s: u32, d: u32) {
    let _t = GlTimer::start("op_gl_blend_func");
    unsafe { gl!(state).blend_func(s, d) }
}
#[op2(fast)]
pub fn op_gl_blend_func_separate(state: &mut OpState, sr: u32, dr: u32, sa: u32, da: u32) {
    let _t = GlTimer::start("op_gl_blend_func_separate");
    unsafe { gl!(state).blend_func_separate(sr, dr, sa, da) }
}
#[op2(fast)]
pub fn op_gl_blend_equation(state: &mut OpState, mode: u32) {
    let _t = GlTimer::start("op_gl_blend_equation");
    unsafe { gl!(state).blend_equation(mode) }
}
#[op2(fast)]
pub fn op_gl_blend_equation_separate(state: &mut OpState, rgb: u32, a: u32) {
    let _t = GlTimer::start("op_gl_blend_equation_separate");
    unsafe { gl!(state).blend_equation_separate(rgb, a) }
}
#[op2(fast)]
pub fn op_gl_blend_color(state: &mut OpState, r: f32, g: f32, b: f32, a: f32) {
    let _t = GlTimer::start("op_gl_blend_color");
    unsafe { gl!(state).blend_color(r, g, b, a) }
}
#[op2(fast)]
pub fn op_gl_color_mask(state: &mut OpState, r: bool, g: bool, b: bool, a: bool) {
    let _t = GlTimer::start("op_gl_color_mask");
    unsafe { gl!(state).color_mask(r, g, b, a) }
}
#[op2(fast)]
pub fn op_gl_depth_mask(state: &mut OpState, flag: bool) {
    let _t = GlTimer::start("op_gl_depth_mask");
    unsafe { gl!(state).depth_mask(flag) }
}
#[op2(fast)]
pub fn op_gl_depth_func(state: &mut OpState, func: u32) {
    let _t = GlTimer::start("op_gl_depth_func");
    unsafe { gl!(state).depth_func(func) }
}
#[op2(fast)]
pub fn op_gl_depth_range(state: &mut OpState, near: f32, far: f32) {
    let _t = GlTimer::start("op_gl_depth_range");
    unsafe { gl!(state).depth_range_f32(near, far) }
}
#[op2(fast)]
pub fn op_gl_clear_depth(state: &mut OpState, d: f32) {
    let _t = GlTimer::start("op_gl_clear_depth");
    unsafe { gl!(state).clear_depth_f32(d) }
}
#[op2(fast)]
pub fn op_gl_clear_stencil(state: &mut OpState, s: i32) {
    let _t = GlTimer::start("op_gl_clear_stencil");
    unsafe { gl!(state).clear_stencil(s) }
}
#[op2(fast)]
pub fn op_gl_cull_face(state: &mut OpState, mode: u32) {
    let _t = GlTimer::start("op_gl_cull_face");
    unsafe { gl!(state).cull_face(mode) }
}
#[op2(fast)]
pub fn op_gl_front_face(state: &mut OpState, mode: u32) {
    let _t = GlTimer::start("op_gl_front_face");
    unsafe { gl!(state).front_face(mode) }
}
#[op2(fast)]
pub fn op_gl_scissor(state: &mut OpState, x: i32, y: i32, w: i32, h: i32) {
    let _t = GlTimer::start("op_gl_scissor");
    unsafe { gl!(state).scissor(x, y, w, h) }
}
#[op2(fast)]
pub fn op_gl_line_width(state: &mut OpState, w: f32) {
    let _t = GlTimer::start("op_gl_line_width");
    unsafe { gl!(state).line_width(w) }
}
#[op2(fast)]
pub fn op_gl_polygon_offset(state: &mut OpState, factor: f32, units: f32) {
    let _t = GlTimer::start("op_gl_polygon_offset");
    unsafe { gl!(state).polygon_offset(factor, units) }
}
#[op2(fast)]
pub fn op_gl_stencil_func(state: &mut OpState, func: u32, reference: i32, mask: u32) {
    let _t = GlTimer::start("op_gl_stencil_func");
    unsafe { gl!(state).stencil_func(func, reference, mask) }
}
#[op2(fast)]
pub fn op_gl_stencil_func_separate(state: &mut OpState, face: u32, func: u32, reference: i32, mask: u32) {
    let _t = GlTimer::start("op_gl_stencil_func_separate");
    unsafe { gl!(state).stencil_func_separate(face, func, reference, mask) }
}
#[op2(fast)]
pub fn op_gl_stencil_op(state: &mut OpState, fail: u32, zfail: u32, zpass: u32) {
    let _t = GlTimer::start("op_gl_stencil_op");
    unsafe { gl!(state).stencil_op(fail, zfail, zpass) }
}
#[op2(fast)]
pub fn op_gl_stencil_op_separate(state: &mut OpState, face: u32, fail: u32, zfail: u32, zpass: u32) {
    let _t = GlTimer::start("op_gl_stencil_op_separate");
    unsafe { gl!(state).stencil_op_separate(face, fail, zfail, zpass) }
}
#[op2(fast)]
pub fn op_gl_stencil_mask(state: &mut OpState, mask: u32) {
    let _t = GlTimer::start("op_gl_stencil_mask");
    unsafe { gl!(state).stencil_mask(mask) }
}
#[op2(fast)]
pub fn op_gl_stencil_mask_separate(state: &mut OpState, face: u32, mask: u32) {
    let _t = GlTimer::start("op_gl_stencil_mask_separate");
    unsafe { gl!(state).stencil_mask_separate(face, mask) }
}
#[op2(fast)]
pub fn op_gl_sample_coverage(state: &mut OpState, value: f32, invert: bool) {
    let _t = GlTimer::start("op_gl_sample_coverage");
    unsafe { gl!(state).sample_coverage(value, invert) }
}
#[op2(fast)]
pub fn op_gl_hint(state: &mut OpState, target: u32, mode: u32) {
    let _t = GlTimer::start("op_gl_hint");
    unsafe { gl!(state).hint(target, mode) }
}
#[op2(fast)]
pub fn op_gl_flush(state: &mut OpState) {
    let _t = GlTimer::start("op_gl_flush");
    unsafe { gl!(state).flush() }
}
#[op2(fast)]
pub fn op_gl_finish(state: &mut OpState) {
    let _t = GlTimer::start("op_gl_finish");
    unsafe { gl!(state).finish() }
}

// ---- queries ----------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_gl_get_integer(state: &mut OpState, pname: u32) -> i32 {
    let _t = GlTimer::start("op_gl_get_integer");
    unsafe { gl!(state).get_parameter_i32(pname) }
}
#[op2(fast)]
pub fn op_gl_get_float(state: &mut OpState, pname: u32) -> f32 {
    let _t = GlTimer::start("op_gl_get_float");
    unsafe { gl!(state).get_parameter_f32(pname) }
}
#[op2(fast)]
pub fn op_gl_get_bool(state: &mut OpState, pname: u32) -> bool {
    let _t = GlTimer::start("op_gl_get_bool");
    unsafe { gl!(state).get_parameter_bool(pname) }
}
#[op2(fast)]
pub fn op_gl_get_integer_n(state: &mut OpState, pname: u32, #[buffer] out: &mut [u32]) {
    let _t = GlTimer::start("op_gl_get_integer_n");
    unsafe { gl!(state).get_parameter_i32_slice(pname, as_i32_mut(out)) }
}
#[op2(fast)]
pub fn op_gl_get_float_n(state: &mut OpState, pname: u32, #[buffer] out: &mut [f32]) {
    let _t = GlTimer::start("op_gl_get_float_n");
    unsafe { gl!(state).get_parameter_f32_slice(pname, out) }
}
#[op2(fast)]
pub fn op_gl_read_pixels(state: &mut OpState, x: i32, y: i32, w: i32, h: i32, format: u32, ty: u32, #[buffer] out: &mut [u8]) {
    let _t = GlTimer::start("op_gl_read_pixels");
    unsafe { gl!(state).read_pixels(x, y, w, h, format, ty, glow::PixelPackData::Slice(Some(out))) }
}
