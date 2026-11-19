//! Canvas 2D on tiny-skia: one Pixmap + state stack per canvas, referenced from JS by id
//! (js/30_canvas2d.js is the CanvasRenderingContext2D wrapper). Pixels are premultiplied RGBA8
//! (tiny-skia's layout); getImageData/putImageData convert, texImage2D uploads them as they are
//! when PIXI asks for premultiplied textures.

use std::collections::HashMap;
use std::f32::consts::PI;

use deno_core::{op2, OpState};
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, LineCap, LineJoin, LinearGradient, Mask, Paint, Path, PathBuilder, Pattern,
    Pixmap, PixmapPaint, Point, Rect, Shader, SpreadMode, Stroke, Transform,
};

use crate::fonts::FontSpec;

thread_local! {
    /// (calls, nanoseconds) spent in Canvas 2D ops since the last take (frame debug).
    pub static C2D_TIME: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
}
/// POWERBOAT_OP_TIMES=1: time every Canvas 2D and GL op for the frame report. Off by default: each op
/// read the clock twice, and on the TrimUI Smart Pro (Allwinner A133) a clock read costs over a
/// microsecond (an ImpactJS game's busiest town scene: ~500 reads a frame, 2.3 % of the JS thread in vdso).
pub static OP_TIMES: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var_os("POWERBOAT_OP_TIMES").is_some());
struct OpTimer(Option<std::time::Instant>);
impl OpTimer {
    fn start() -> OpTimer {
        OpTimer(OP_TIMES.then(std::time::Instant::now))
    }
}
impl Drop for OpTimer {
    fn drop(&mut self) {
        let Some(t) = self.0 else { return };
        let ns = t.elapsed().as_nanos() as u64;
        C2D_TIME.with(|c| {
            let (n, t) = c.get();
            c.set((n + 1, t + ns));
        });
    }
}
pub fn take_c2d_time() -> (u64, u64) {
    C2D_TIME.with(|c| c.replace((0, 0)))
}

/// POWERBOAT_C2D_STATS=1: drawImage / fill paths by kind (calls, destination pixels), printed every 3 s.
static C2D_STATS_ON: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var_os("POWERBOAT_C2D_STATS").is_some());
thread_local! {
    static C2D_STATS: std::cell::RefCell<(std::time::Instant, std::collections::BTreeMap<String, (u64, f64)>)> =
        std::cell::RefCell::new((std::time::Instant::now(), Default::default()));
}
fn stat(kind: impl FnOnce() -> String, pixels: f32) {
    if !*C2D_STATS_ON {
        return;
    }
    C2D_STATS.with(|s| {
        let mut s = s.borrow_mut();
        let e = s.1.entry(kind()).or_insert((0, 0.0));
        e.0 += 1;
        e.1 += pixels.abs() as f64;
        if s.0.elapsed().as_secs_f64() >= 3.0 {
            let secs = s.0.elapsed().as_secs_f64();
            let mut v: Vec<_> = s.1.iter().map(|(k, (n, p))| (k.clone(), *n as f64 / secs, *p / secs)).collect();
            v.sort_by(|a, b| b.2.total_cmp(&a.2));
            let line: Vec<String> = v.iter().take(14).map(|(k, n, p)| format!("{k} {n:.0}/s {:.2} Mpx/s", p / 1e6)).collect();
            eprintln!("[powerboat] c2d paths: {}", line.join(", "));
            s.1.clear();
            s.0 = std::time::Instant::now();
        }
    });
}
use crate::ops::App;

#[derive(Clone)]
pub enum Style {
    Color(Color),
    Linear { x0: f32, y0: f32, x1: f32, y1: f32, stops: Vec<(f32, Color)> },
    /// A pattern from a canvas or image (premultiplied pixmap copy), repeat both ways.
    Pattern { pixmap: std::sync::Arc<Pixmap>, repeat: bool },
}

#[derive(Clone)]
pub struct State {
    pub transform: Transform,
    pub alpha: f32,
    pub blend: BlendMode,
    pub fill: Style,
    pub stroke: Style,
    pub line_width: f32,
    pub line_cap: LineCap,
    pub line_join: LineJoin,
    pub miter_limit: f32,
    pub font: FontSpec,
    pub text_align: u8,    // 0 left/start, 1 center, 2 right/end
    pub text_baseline: u8, // 0 alphabetic, 1 top/hanging, 2 middle, 3 bottom/ideographic
    pub smoothing: bool,
    pub clip: Option<std::sync::Arc<Mask>>,
}

impl Default for State {
    fn default() -> Self {
        State {
            transform: Transform::identity(),
            alpha: 1.0,
            blend: BlendMode::SourceOver,
            fill: Style::Color(Color::BLACK),
            stroke: Style::Color(Color::BLACK),
            line_width: 1.0,
            line_cap: LineCap::Butt,
            line_join: LineJoin::Miter,
            miter_limit: 10.0,
            font: FontSpec::default(),
            text_align: 0,
            text_baseline: 0,
            smoothing: true,
            clip: None,
        }
    }
}

pub struct Canvas2D {
    pub pixmap: Pixmap,
    pub state: State,
    stack: Vec<State>,
    path: PathBuilder,
    /// The transform when the path last grew: canvas paths keep the CTM they were built under, and
    /// Phaser's mask builds its clip path under another transform than the one current at clip().
    path_ts: Transform,
    /// Current point for arcs appended to an open path.
    last: Option<Point>,
    /// Block map of the pixels for drawing this canvas elsewhere; dropped on every mutable access.
    blocks: Option<Box<BlockMap>>,
    /// All pixels transparent: new or resized, nothing drawn since (Cmd::pixel_target).
    clear: bool,
}

impl Canvas2D {
    fn new(w: u32, h: u32) -> Canvas2D {
        Canvas2D {
            pixmap: Pixmap::new(w.max(1), h.max(1)).expect("pixmap"),
            state: State::default(),
            stack: Vec::new(),
            path: PathBuilder::new(),
            path_ts: Transform::identity(),
            last: None,
            blocks: None,
            clear: true,
        }
    }
    fn paint(&self, style: &Style) -> Paint<'static> {
        let st = &self.state;
        let mut paint = Paint::default();
        paint.anti_alias = true;
        paint.blend_mode = st.blend;
        paint.shader = match style {
            Style::Color(c) => {
                let mut c = *c;
                c.set_alpha(c.alpha() * st.alpha);
                Shader::SolidColor(c)
            }
            Style::Linear { x0, y0, x1, y1, stops } => {
                let stops: Vec<GradientStop> = stops
                    .iter()
                    .map(|(o, c)| {
                        let mut c = *c;
                        c.set_alpha(c.alpha() * st.alpha);
                        GradientStop::new(*o, c)
                    })
                    .collect();
                LinearGradient::new(Point::from_xy(*x0, *y0), Point::from_xy(*x1, *y1), stops, SpreadMode::Pad, Transform::identity())
                    .unwrap_or(Shader::SolidColor(Color::TRANSPARENT))
            }
            Style::Pattern { pixmap, repeat } => {
                // Pattern borrows the pixmap: hand out a leaked clone-free reference by keeping
                // the Arc alive for the paint's lifetime (the Arc lives in the state).
                let p: &'static Pixmap = unsafe { &*(std::sync::Arc::as_ptr(pixmap)) };
                Pattern::new(
                    p.as_ref(),
                    if *repeat { SpreadMode::Repeat } else { SpreadMode::Pad },
                    if st.smoothing { FilterQuality::Bilinear } else { FilterQuality::Nearest },
                    st.alpha,
                    Transform::identity(),
                )
            }
        };
        paint
    }
    fn stroke(&self) -> Stroke {
        Stroke {
            width: self.state.line_width,
            miter_limit: self.state.miter_limit,
            line_cap: self.state.line_cap,
            line_join: self.state.line_join,
            dash: None,
        }
    }
    fn clip(&self) -> Option<&Mask> {
        self.state.clip.as_deref()
    }
    fn fill_path_with(&mut self, path: &Path, style: Style) {
        stat(
            || {
                let kind = match &style { Style::Color(_) => "color", Style::Linear { .. } => "gradient", Style::Pattern { .. } => "pattern" };
                format!("fill {kind} {:?}", self.state.blend)
            },
            path.bounds().width() * path.bounds().height() * self.state.transform.sx * self.state.transform.sy,
        );
        let paint = self.paint(&style);
        let t = self.state.transform;
        let clip = self.state.clip.clone();
        self.pixmap.fill_path(path, &paint, FillRule::Winding, t, clip.as_deref());
    }
    fn stroke_path_with(&mut self, path: &Path, style: Style) {
        let paint = self.paint(&style);
        let stroke = self.stroke();
        let t = self.state.transform;
        let clip = self.state.clip.clone();
        self.pixmap.stroke_path(path, &paint, &stroke, t, clip.as_deref());
    }
    fn take_path(&mut self) -> Option<Path> {
        let pb = std::mem::replace(&mut self.path, PathBuilder::new());
        let path = pb.clone().finish();
        self.path = pb;
        let t = self.state.transform;
        if self.path_ts != t {
            // Drawing applies the current transform, so undo it and apply the path's.
            if let Some(inv) = t.invert() {
                return path.and_then(|p| p.transform(inv.pre_concat(self.path_ts)));
            }
        }
        path
    }
    /// The draws draw_pixmap makes with `blit`, a 1:1 copy: `blit`'s arguments, or None for any other path.
    /// draw_pixmap asks first (after its whole-image path); draw_batch plans runs of drawImage calls with it.
    /// - Unscaled part of a source at integer coordinates (sprite sheets, pre-rendered map layers: ImpactJS's
    ///   whole frame), optionally mirrored, with source-over / lighter / destination-out and no clip: a direct
    ///   premultiplied blend. tiny-skia's pattern path (highp pipeline) was ~85 % of an ImpactJS game's frame on an A53.
    ///   CTMs that are a translation up to float noise count as one.
    /// - The same at a sub-pixel offset, where draw_pixmap's nearest path (smoothing off, or on at an exact 1:1
    ///   translation) would sample it: nearest_as_blit says when that is a 1:1 copy.
    #[allow(clippy::too_many_arguments)]
    fn plan_blit(&self, src_w: i32, src_h: i32, sx: f32, sy: f32, sw: f32, sh: f32, dx: f32, dy: f32, dw: f32, dh: f32) -> Option<PlannedBlit> {
        let st = &self.state;
        let ts = st.transform;
        if !*FAST_BLIT || st.clip.is_some() || sw <= 0.0 || sh <= 0.0 || dw == 0.0 || dh == 0.0 {
            return None;
        }
        let mode = BlitMode::of(st.blend)?;
        // draw_pixmap's first path: the whole source at a whole-pixel offset, through tiny-skia.
        if ts.is_translate() && sw == dw && sh == dh && sx == 0.0 && sy == 0.0 && sw == src_w as f32 && sh == src_h as f32 && (dx + ts.tx).fract() == 0.0 && (dy + ts.ty).fract() == 0.0 {
            return None;
        }
        if sw == dw && sh == dh {
            if let Some((flip, tx, ty)) = near_translate(&ts) {
                // Mirrored: x -> tx - x, so the destination span is [tx - dx - dw, tx - dx).
                let ox = if flip { tx - dx - dw } else { tx + dx };
                if let (Some(ox), Some(oy)) = (whole(ox), whole(ty + dy)) {
                    if [sx, sy, sw, sh].iter().all(|v| v.fract() == 0.0) {
                        return Some(PlannedBlit { sx: sx as i32, sy: sy as i32, w: sw as i32, h: sh as i32, dx: ox, dy: oy, mode, flip, sub: false });
                    }
                }
            }
        }
        // (draw_pixmap's whole-number zoom comes next there; nearest_as_blit takes unit scales only, so the
        // order does not matter.)
        let nearest_anyway = ts.sx == 1.0 && ts.sy == 1.0 && ts.kx == 0.0 && ts.ky == 0.0 && sw == dw && sh == dh;
        if *SUBPIXEL_BLIT && (!st.smoothing || nearest_anyway) && ts.kx == 0.0 && ts.ky == 0.0 && ts.sx != 0.0 && ts.sy != 0.0 {
            let (kx, ky) = (ts.sx * dw / sw, ts.sy * dh / sh);
            let (l, t) = (ts.tx + dx * ts.sx, ts.ty + dy * ts.sy);
            let (pw, ph) = (self.pixmap.width() as i32, self.pixmap.height() as i32);
            if let Some((bx, by, bw, bh, ox, oy)) = nearest_as_blit(src_w, src_h, pw, ph, sx, sy, sw, sh, l, t, kx, ky) {
                return Some(PlannedBlit { sx: bx, sy: by, w: bw, h: bh, dx: ox, dy: oy, mode, flip: false, sub: true });
            }
        }
        None
    }
    /// drawImage core: src rect of a premultiplied pixmap -> dst rect, through the CTM.
    #[allow(clippy::too_many_arguments)]
    fn draw_pixmap(&mut self, src: tiny_skia::PixmapRef, blocks: Option<&BlockMap>, sx: f32, sy: f32, sw: f32, sh: f32, dx: f32, dy: f32, dw: f32, dh: f32) {
        if sw <= 0.0 || sh <= 0.0 || dw == 0.0 || dh == 0.0 {
            return;
        }
        let Some(rect) = Rect::from_xywh(dx.min(dx + dw), dy.min(dy + dh), dw.abs(), dh.abs()) else { return };
        let st = &self.state;
        let quality = if st.smoothing { FilterQuality::Bilinear } else { FilterQuality::Nearest };
        // Fast path: unscaled, axis-aligned copy of the whole source with an integer offset.
        let ts = st.transform;
        if ts.is_translate() && sw == dw && sh == dh && sx == 0.0 && sy == 0.0 && sw == src.width() as f32 && sh == src.height() as f32 {
            let ox = dx + ts.tx;
            let oy = dy + ts.ty;
            if ox.fract() == 0.0 && oy.fract() == 0.0 {
                stat(|| format!("image whole {:?}", st.blend), dw * dh);
                let pp = PixmapPaint { opacity: st.alpha, blend_mode: st.blend, quality };
                let clip = st.clip.clone();
                self.pixmap.draw_pixmap(ox as i32, oy as i32, src, &pp, Transform::identity(), clip.as_deref());
                return;
            }
        }
        // 1:1 copies (whole-pixel or sub-pixel offsets): plan_blit, which runs of them in draw_batch share.
        if let Some(b) = self.plan_blit(src.width() as i32, src.height() as i32, sx, sy, sw, sh, dx, dy, dw, dh) {
            stat(|| format!("image blit {:?}{}", st.blend, if b.flip { " mirrored" } else if b.sub { " sub-pixel" } else { "" }), (b.w * b.h) as f32);
            blit(&mut self.pixmap, src, blocks, b.sx, b.sy, b.w, b.h, b.dx, b.dy, st.alpha, b.mode, b.flip);
            return;
        }
        // A whole-number CTM scale (2x, 3x camera zoom) with smoothing off: each source pixel becomes a
        // k x k square; rows are widened once and blended like the 1:1 path. Mirroring left to tiny-skia.
        if *FAST_BLIT && st.clip.is_none() && sw == dw && sh == dh && !st.smoothing && ts.kx == 0.0 && ts.ky == 0.0 {
            if let (Some(k), Some(ky), Some(mode)) = (whole(ts.sx), whole(ts.sy), BlitMode::of(st.blend)) {
                if k == ky && (2..=4).contains(&k) {
                    if let (Some(ox), Some(oy)) = (whole(ts.tx + dx * ts.sx), whole(ts.ty + dy * ts.sy)) {
                        if [sx, sy, sw, sh].iter().all(|v| v.fract() == 0.0) {
                            stat(|| format!("image blit {:?} x{k}", st.blend), dw * dh * (k * k) as f32);
                            blit_scaled(&mut self.pixmap, src, blocks, sx as i32, sy as i32, sw as i32, sh as i32, ox, oy, k, st.alpha, mode);
                            return;
                        }
                    }
                }
            }
        }
        // Any other axis-aligned scale, flips included, with smoothing off (an ImpactJS game's camera zooming smoothly
        // through 1.3x, 1.7x, ...): nearest sampling at pixel centers, as tiny-skia's pattern does.
        // Smoothing on with an exact 1:1 translation too: tiny-skia samples those nearest as well (a pattern
        // under a translate-only transform drops to FilterQuality::Nearest). Sprites moving smoothly took that
        // pattern path: 192 32 px sprites at 60 fps on the RG-34XXSP (quixjs 1408). One difference: under an
        // identity CTM tiny-skia's fill_rect floors the rect (its saturate_round is floor), so offsets of .5-.99
        // were drawn a pixel left with a column of the atlas neighbor; here pixel centers decide, as in Skia
        // and in tiny-skia's own translated-CTM path.
        let nearest_anyway = ts.sx == 1.0 && ts.sy == 1.0 && ts.kx == 0.0 && ts.ky == 0.0 && sw == dw && sh == dh;
        if *FAST_BLIT && st.clip.is_none() && (!st.smoothing || nearest_anyway) && ts.kx == 0.0 && ts.ky == 0.0 && ts.sx != 0.0 && ts.sy != 0.0 {
            if let Some(mode) = BlitMode::of(st.blend) {
                let (kx, ky) = (ts.sx * dw / sw, ts.sy * dh / sh);
                let (l, t) = (ts.tx + dx * ts.sx, ts.ty + dy * ts.sy);
                // (A unit scale at a sub-pixel offset went to the 1:1 blit above: plan_blit.)
                stat(|| format!("image nearest {:?}", st.blend), dw * dh * ts.sx * ts.sy);
                blit_nearest(&mut self.pixmap, src, sx, sy, sw, sh, l, t, kx, ky, st.alpha, mode);
                return;
            }
        }
        // Any other invertible CTM (rotated sprites, smooth scaling): blit_affine, sampled as the pattern below.
        if *FAST_BLIT && *AFFINE_BLIT && st.clip.is_none() {
            if let Some(mode) = BlitMode::of(st.blend) {
                let fwd = ts.pre_concat(Transform::from_translate(dx, dy).pre_scale(dw / sw, dh / sh).pre_translate(-sx, -sy));
                if let Some(inv) = fwd.invert() {
                    stat(|| format!("image affine {:?}{}", st.blend, if st.smoothing { " smooth" } else { "" }), (dw * dh * (ts.sx * ts.sy - ts.kx * ts.ky)).abs());
                    blit_affine(&mut self.pixmap, src, fwd, inv, sx, sy, sw, sh, st.smoothing, st.alpha, mode);
                    return;
                }
            }
        }
        // General path: a pattern shader mapping source pixels onto the destination rect.
        stat(
            || {
                let why = if !ts.is_translate() {
                    if ts.kx == 0.0 && ts.ky == 0.0 { "ctm scale" } else { "ctm rotate" }
                } else if sw != dw || sh != dh {
                    "scaled"
                } else if st.clip.is_some() {
                    "clip"
                } else if st.blend != BlendMode::SourceOver {
                    "blend"
                } else {
                    "fractional"
                };
                // Coarse classes only: per-scale labels scatter a smooth camera zoom over hundreds of
                // entries and none reaches the top of the report.
                let class = |s: f32| {
                    let m = if s < 0.0 { "-" } else { "" };
                    let k = if (s.abs() - 1.0).abs() < 1e-3 { "1" } else if s.abs() > 1.0 { "up" } else { "down" };
                    format!("{m}{k}")
                };
                format!(
                    "image {why} {:?}{}{}{}{} ctm {} img {}",
                    st.blend,
                    if st.smoothing { " smooth" } else { "" },
                    if [sx, sy, sw, sh].iter().any(|v| v.fract() != 0.0) { " frac" } else { "" },
                    if st.alpha < 1.0 { " alpha" } else { "" },
                    if st.clip.is_some() { " clip" } else { "" },
                    class(ts.sx) + "/" + &class(ts.sy),
                    class(dw / sw) + "/" + &class(dh / sh)
                )
            },
            dw * dh * ts.sx * ts.sy,
        );
        let pat = Transform::from_translate(dx, dy)
            .pre_scale(dw / sw, dh / sh)
            .pre_translate(-sx, -sy);
        let mut paint = Paint::default();
        paint.anti_alias = false;
        paint.blend_mode = st.blend;
        paint.shader = Pattern::new(src, SpreadMode::Pad, quality, st.alpha, pat);
        let clip = st.clip.clone();
        self.pixmap.fill_rect(rect, &paint, ts, clip.as_deref());
    }
}

/// POWERBOAT_C2D_FAST=0: drawImage always through tiny-skia (to compare pictures with blit_over).
static FAST_BLIT: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_FAST").map_or(true, |v| v != "0"));

/// A CTM that is a translation, or a horizontal mirror plus translation, up to float noise (an ImpactJS game's
/// context transform reads 1.000 but is not exactly 1): (mirrored, tx, ty).
fn near_translate(t: &Transform) -> Option<(bool, f32, f32)> {
    const E: f32 = 1e-4;
    if t.kx.abs() > E || t.ky.abs() > E || (t.sy - 1.0).abs() > E {
        return None;
    }
    if (t.sx - 1.0).abs() <= E {
        Some((false, t.tx, t.ty))
    } else if (t.sx + 1.0).abs() <= E {
        Some((true, t.tx, t.ty))
    } else {
        None
    }
}
/// An integer up to float noise.
fn whole(v: f32) -> Option<i32> {
    let r = v.round();
    ((v - r).abs() < 1e-3).then_some(r as i32)
}

#[derive(Clone, Copy, PartialEq)]
enum BlitMode {
    Over,
    /// "lighter"
    Plus,
    DestOut,
}
impl BlitMode {
    fn of(b: BlendMode) -> Option<Self> {
        match b {
            BlendMode::SourceOver => Some(Self::Over),
            BlendMode::Plus => Some(Self::Plus),
            BlendMode::DestinationOut => Some(Self::DestOut),
            _ => None,
        }
    }
}

#[inline(always)]
fn mul255(x: u32, y: u32) -> u32 {
    (x * y + 127) / 255
}
/// Each byte of a packed RGBA pixel times f/255 (rounded), two channels per multiply.
#[inline(always)]
fn scale_px(p: u32, f: u32) -> u32 {
    let mut rb = (p & 0x00ff_00ff) * f + 0x0080_0080;
    rb = ((rb + ((rb >> 8) & 0x00ff_00ff)) >> 8) & 0x00ff_00ff;
    let mut ag = ((p >> 8) & 0x00ff_00ff) * f + 0x0080_0080;
    ag = (ag + ((ag >> 8) & 0x00ff_00ff)) & 0xff00_ff00;
    rb | ag
}
/// Premultiplied source-over of one packed pixel: s + d * (255 - sa) / 255 (no carries: s <= sa).
#[inline(always)]
fn over_px(s: u32, d: u32) -> u32 {
    s + scale_px(d, 255 - (s >> 24))
}
/// The pixmaps' bytes as packed pixels (tiny-skia keeps them 4-byte aligned; checked).
fn px32(b: &[u8]) -> &[u32] {
    let (pre, mid, post) = unsafe { b.align_to::<u32>() };
    assert!(pre.is_empty() && post.is_empty(), "pixmap not 4-byte aligned");
    mid
}
fn px32_mut(b: &mut [u8]) -> &mut [u32] {
    let (pre, mid, post) = unsafe { b.align_to_mut::<u32>() };
    assert!(pre.is_empty() && post.is_empty(), "pixmap not 4-byte aligned");
    mid
}
/// Plain source-over of a run with no structure to exploit (a mixed block). LLVM did not vectorize the
/// packed loop: 16 ns a pixel on the RG-34XXSP's A53s, most of a 32 px sprite's 17.7 us (h5bench's sprites:
/// 736 at 60 fps, quixjs 1408). NEON does four pixels at a time with the same rounding (over_neon).
#[inline(always)]
fn over_row(s: &[u32], d: &mut [u32]) {
    let n = s.len().min(d.len());
    #[cfg(target_arch = "aarch64")]
    let done = over_neon(&s[..n], &mut d[..n]);
    #[cfg(not(target_arch = "aarch64"))]
    let done = 0;
    for (sp, dp) in s[done..n].iter().zip(d[done..n].iter_mut()) {
        *dp = over_px(*sp, *dp);
    }
}
/// over_px on four pixels a step; returns how many it did (a multiple of 4). Per byte: s + d * (255 - sa)
/// rounded as scale_px does, ((v + ((v + 128) >> 8)) + 128) >> 8 with v = d * (255 - sa): vrsra then vrshrn.
#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn over_neon(s: &[u32], d: &mut [u32]) -> usize {
    use core::arch::aarch64::*;
    let n = s.len().min(d.len()) & !3;
    unsafe {
        // Each pixel's alpha byte (3, 7, 11, 15) into all four of its bytes.
        let idx = vld1q_u8([3u8, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15].as_ptr());
        let ff = vdupq_n_u8(255);
        let (sp, dp) = (s.as_ptr() as *const u8, d.as_mut_ptr() as *mut u8);
        let mut i = 0;
        while i < n {
            let sv = vld1q_u8(sp.add(i * 4));
            let dv = vld1q_u8(dp.add(i * 4));
            let inv = vsubq_u8(ff, vqtbl1q_u8(sv, idx));
            let lo = vmull_u8(vget_low_u8(dv), vget_low_u8(inv));
            let hi = vmull_high_u8(dv, inv);
            let lo = vrshrn_n_u16::<8>(vrsraq_n_u16::<8>(lo, lo));
            let hi = vrshrn_n_u16::<8>(vrsraq_n_u16::<8>(hi, hi));
            vst1q_u8(dp.add(i * 4), vaddq_u8(sv, vcombine_u8(lo, hi)));
            i += 4;
        }
    }
    n
}
/// One row: d[j] = blend(s[j], d[j]). Branch-free so LLVM vectorizes it (NEON on the handhelds);
/// `a` < 255 scales the source first (globalAlpha).
#[inline(always)]
fn blend_row(s: &[u32], d: &mut [u32], a: u32, mode: BlitMode) {
    match (mode, a == 255) {
        (BlitMode::Over, true) => {
            // Tile layers are runs of opaque pixels, sprites and upper layers runs of empty ones:
            // copy the first, skip the second, blend only what is in between.
            let n = s.len();
            let mut i = 0;
            while i < n {
                let a0 = s[i] >> 24;
                let mut j = i + 1;
                if a0 == 0 {
                    while j < n && s[j] >> 24 == 0 {
                        j += 1;
                    }
                } else if a0 == 255 {
                    while j < n && s[j] >> 24 == 255 {
                        j += 1;
                    }
                    d[i..j].copy_from_slice(&s[i..j]);
                } else {
                    while j < n && (s[j] >> 24).wrapping_sub(1) < 254 {
                        j += 1;
                    }
                    over_row(&s[i..j], &mut d[i..j]);
                }
                i = j;
            }
        }
        (BlitMode::Over, false) => {
            for (sp, dp) in s.iter().zip(d.iter_mut()) {
                *dp = over_px(scale_px(*sp, a), *dp);
            }
        }
        (BlitMode::Plus, _) => {
            for (sp, dp) in s.iter().zip(d.iter_mut()) {
                let sp = if a == 255 { *sp } else { scale_px(*sp, a) };
                let (sb, db) = (sp.to_le_bytes(), dp.to_le_bytes());
                *dp = u32::from_le_bytes([sb[0].saturating_add(db[0]), sb[1].saturating_add(db[1]), sb[2].saturating_add(db[2]), sb[3].saturating_add(db[3])]);
            }
        }
        (BlitMode::DestOut, _) => {
            for (sp, dp) in s.iter().zip(d.iter_mut()) {
                let sa = if a == 255 { *sp >> 24 } else { scale_px(*sp, a) >> 24 };
                *dp = scale_px(*dp, 255 - sa);
            }
        }
    }
}

/// Cache-line prefetch of [p, p + len) (at most 8 lines), for reads or for writes. The A53 is in order
/// and its hardware prefetcher does not follow a blit's short rows a stride apart: an ImpactJS game's blits
/// spent most of their time waiting on each row's first loads.
#[inline(always)]
fn prefetch(p: *const u32, len: usize, write: bool) {
    #[cfg(target_arch = "aarch64")]
    unsafe {
        // From the line holding the first pixel through the one holding the last (up to 8 lines): an
        // unaligned 32 px row spans three lines, not the two a 64-byte stride from its start reaches.
        let (mut a, end) = ((p as usize) & !63, p as usize + (len * 4).min(8 * 64));
        while a < end {
            if write {
                core::arch::asm!("prfm pstl1keep, [{0}]", in(reg) a, options(nostack, readonly, preserves_flags));
            } else {
                core::arch::asm!("prfm pldl1keep, [{0}]", in(reg) a, options(nostack, readonly, preserves_flags));
            }
            a += 64;
        }
    }
    #[cfg(not(target_arch = "aarch64"))]
    let _ = (p, len, write);
}

/// POWERBOAT_C2D_THREADS (default 4; 3 when deferred, leaving the JS thread's core alone): row bands of
/// large blits and fills run on that many threads.
static C2D_THREADS: std::sync::LazyLock<usize> = std::sync::LazyLock::new(|| {
    let default = if *DEFER_START == Defer::Off { 4 } else { 3 };
    std::env::var("POWERBOAT_C2D_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(default).clamp(1, 8)
});
static C2D_POOL: std::sync::LazyLock<Option<rayon::ThreadPool>> = std::sync::LazyLock::new(|| {
    (*C2D_THREADS > 1).then(|| rayon::ThreadPoolBuilder::new().num_threads(*C2D_THREADS).thread_name(|i| format!("c2d-{i}")).build().ok()).flatten()
});
/// Below this many pixels a blit stays on the calling thread (a hand-off costs more than it saves).
/// Rows `blit` prefetches ahead of the one it blends (POWERBOAT_C2D_PREFETCH, A/B). On the RG-34XXSP a third of
/// h5bench's sprite-test samples sat on the row loop's first loads, waiting for memory. What fixed it was asking
/// for the first rows up front and for each row's last cache line (prefetch); 2, 4, 6 and 10 rows ahead then
/// measured the same (32 px sprites 17.4 -> 12.2 us, 1408 a frame 31.5 -> 47.7 fps).
static BLIT_AHEAD: std::sync::LazyLock<usize> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_PREFETCH").ok().and_then(|v| v.parse().ok()).unwrap_or(2));
const PAR_MIN_PX: usize = 16_384;
/// Runs `band(first_row, rows)` over `rows` (whole destination rows of `stride` pixels, the first one
/// being row index `first`): split into one band per thread when the work (`width` x rows) is large.
/// Bands are disjoint rows of the destination; sources are only read. Returns the summed counters.
fn par_bands<F>(rows: &mut [u32], stride: usize, width: usize, first: i32, band: &F) -> [usize; 3]
where
    F: Fn(i32, &mut [u32]) -> [usize; 3] + Sync,
{
    let nrows = rows.len() / stride;
    match &*C2D_POOL {
        Some(pool) if width * nrows >= PAR_MIN_PX && nrows >= 2 * *C2D_THREADS => {
            use rayon::prelude::*;
            let per = nrows.div_ceil(*C2D_THREADS);
            pool.install(|| {
                rows.par_chunks_mut(per * stride)
                    .enumerate()
                    .map(|(b, r)| band(first + (b * per) as i32, r))
                    .reduce(|| [0; 3], |x, y| [x[0] + y[0], x[1] + y[1], x[2] + y[2]])
            })
        }
        _ => band(first, rows),
    }
}

/// Pixels per block of a BlockMap row.
const BLOCK: usize = 16;
const BLOCK_EMPTY: u8 = 0;
const BLOCK_OPAQUE: u8 = 1;
const BLOCK_MIXED: u8 = 2;
/// Per row, each run of BLOCK pixels of a drawing source: all transparent, all opaque or mixed.
/// Built once per image (and per canvas until it is drawn to): source-over blits then skip empty
/// blocks without reading them and copy opaque ones (an ImpactJS game's mostly empty upper map layers and
/// opaque ground chunks were read and blended pixel by pixel every frame).
pub struct BlockMap {
    bw: usize,
    cls: Vec<u8>,
}
impl BlockMap {
    pub fn build(p: tiny_skia::PixmapRef) -> BlockMap {
        let (w, h) = (p.width() as usize, p.height() as usize);
        let bw = w.div_ceil(BLOCK);
        let px = px32(p.data());
        let mut cls = Vec::with_capacity(bw * h);
        for y in 0..h {
            let row = &px[y * w..(y + 1) * w];
            for chunk in row.chunks(BLOCK) {
                let (mut any, mut all) = (0u32, 0xffu32);
                for v in chunk {
                    let a = v >> 24;
                    any |= a;
                    all &= a;
                }
                cls.push(if any == 0 { BLOCK_EMPTY } else if all == 0xff { BLOCK_OPAQUE } else { BLOCK_MIXED });
            }
        }
        BlockMap { bw, cls }
    }
}

/// src's (sx, sy, w, h) blended at (dx, dy) in dst, premultiplied RGBA8, global alpha `alpha`, mirrored
/// horizontally when `flip` (destination column j shows source column sx + w - 1 - j). Clipped to both
/// pixmaps (browsers clip drawImage's source rect to the image too).
#[allow(clippy::too_many_arguments)]
fn blit(dst: &mut Pixmap, src: tiny_skia::PixmapRef, blocks: Option<&BlockMap>, sx: i32, sy: i32, w: i32, h: i32, dx: i32, dy: i32, alpha: f32, mode: BlitMode, flip: bool) {
    let Some(g) = BlitGeom::new(dst.width() as i32, dst.height() as i32, src.width() as i32, src.height() as i32, sx, sy, w, h, dx, dy, alpha, mode, flip) else { return };
    let sdata = px32(src.data());
    let ddata = px32_mut(dst.data_mut());
    // Destination rows dy + i0 .. dy + i1, processed in bands (one band, or one per core for large
    // blits). Returns pixels by block class (POWERBOAT_C2D_STATS).
    let rows = &mut ddata[(g.dy + g.i0) as usize * g.dstride..(g.dy + g.i1) as usize * g.dstride];
    let class_px = par_bands(rows, g.dstride, g.n, g.i0, &|first_i, band: &mut [u32]| blit_rows(&g, sdata, blocks, first_i, band));
    if *C2D_STATS_ON {
        let (plain, a) = (g.plain, g.a);
        let total = (g.n * (g.i1 - g.i0) as usize) as f32;
        if blocks.is_some() && !flip {
            let kind = if plain { "" } else if a != 255 { " (global alpha)" } else { " (lighter/dest-out)" };
            for (k, name) in ["empty", "opaque", "mixed"].iter().enumerate() {
                stat(|| format!("blit px {name}{kind}"), class_px[k] as f32);
            }
        } else {
            let why = if flip { "mirrored" } else if a != 255 { "global alpha" } else if mode != BlitMode::Over { "lighter/dest-out" } else { "no block map" };
            stat(|| format!("blit px {why}"), total);
        }
    }
}

/// `blit`'s clipped geometry: destination columns j0..j1 and rows i0..i1 (relative to dx, dy) that land inside
/// both pixmaps, and how to blend.
#[derive(Clone, Copy)]
struct BlitGeom {
    sx: i32,
    sy: i32,
    w: i32,
    dx: i32,
    dy: i32,
    j0: i32,
    j1: i32,
    i0: i32,
    i1: i32,
    n: usize,
    a: u32,
    mode: BlitMode,
    flip: bool,
    plain: bool,
    sstride: usize,
    dstride: usize,
}
impl BlitGeom {
    #[allow(clippy::too_many_arguments)]
    fn new(dw_full: i32, dh_full: i32, sw_full: i32, sh_full: i32, sx: i32, sy: i32, w: i32, h: i32, dx: i32, dy: i32, alpha: f32, mode: BlitMode, flip: bool) -> Option<BlitGeom> {
        let (j0, j1) = if flip {
            (0.max(-dx).max(sx + w - sw_full), w.min(dw_full - dx).min(sx + w))
        } else {
            (0.max(-dx).max(-sx), w.min(dw_full - dx).min(sw_full - sx))
        };
        let (i0, i1) = (0.max(-dy).max(-sy), h.min(dh_full - dy).min(sh_full - sy));
        if j1 <= j0 || i1 <= i0 {
            return None;
        }
        let a = (alpha.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
        if a == 0 {
            return None;
        }
        let plain = mode == BlitMode::Over && a == 255;
        Some(BlitGeom { sx, sy, w, dx, dy, j0, j1, i0, i1, n: (j1 - j0) as usize, a, mode, flip, plain, sstride: sw_full as usize, dstride: dw_full as usize })
    }
}

/// `blit` on destination rows dy + first_i .. (whole rows of the destination in `band`, the first being that one).
fn blit_rows(g: &BlitGeom, sdata: &[u32], blocks: Option<&BlockMap>, first_i: i32, band: &mut [u32]) -> [usize; 3] {
    let BlitGeom { sx, sy, w, dx, j0, j1, n, a, mode, flip, plain, sstride, dstride, .. } = *g;
    let ahead = *BLIT_AHEAD;
    let mut tmp = Vec::new();
    let mut class_px = [0usize; 3];
    let nrows = band.len() / dstride;
    let dcol = (dx + j0) as usize;
    // The first rows are asked for up front as well: a sprite's rows are separate cache lines, mostly not
    // in the cache, and a row of work is far shorter than a DRAM fetch.
    for k in 0..ahead.min(nrows) {
        prefetch(sdata[(sy + first_i + k as i32) as usize * sstride + (sx + j0) as usize..].as_ptr(), n, false);
        prefetch(band[k * dstride + dcol..].as_ptr(), n, true);
    }
    for k in 0..nrows {
        let i = first_i + k as i32;
        if k + ahead < nrows {
            prefetch(sdata[(sy + i + ahead as i32) as usize * sstride + (sx + j0) as usize..].as_ptr(), n, false);
            prefetch(band[(k + ahead) * dstride + dcol..].as_ptr(), n, true);
        }
        let d = &mut band[k * dstride + dcol..k * dstride + dcol + n];
        let srow = (sy + i) as usize * sstride;
        if flip {
            // Source columns sx + w - 1 - j for j = j0..: the run [first, last] read backwards.
            let last = (sx + w - 1 - j0) as usize;
            let first = last + 1 - n;
            if let Some(bm) = blocks {
                let row_cls = &bm.cls[(sy + i) as usize * bm.bw..(sy + i + 1) as usize * bm.bw];
                // Source block runs from the right; destination offset of source column c is last - c.
                let mut c_end = last + 1;
                while c_end > first {
                    let b = (c_end - 1) / BLOCK;
                    let c0 = (b * BLOCK).max(first);
                    if row_cls[b] != BLOCK_EMPTY {
                        tmp.clear();
                        tmp.extend(sdata[srow + c0..srow + c_end].iter().rev());
                        let dof = last + 1 - c_end;
                        blend_row(&tmp, &mut d[dof..dof + (c_end - c0)], a, mode);
                    }
                    c_end = c0;
                }
            } else {
                tmp.clear();
                tmp.extend(sdata[srow + first..srow + last + 1].iter().rev());
                blend_row(&tmp, d, a, mode);
            }
        } else if let Some(bm) = blocks {
            // Block by block: empty blocks are not even read (no mode changes anything for them),
            // opaque ones copied under plain source-over.
            let (c0, c1) = ((sx + j0) as usize, (sx + j1) as usize);
            let row_cls = &bm.cls[(sy + i) as usize * bm.bw..(sy + i + 1) as usize * bm.bw];
            let mut c = c0;
            while c < c1 {
                let b = c / BLOCK;
                let e = ((b + 1) * BLOCK).min(c1);
                let (so, dof) = (srow + c, c - c0);
                class_px[row_cls[b] as usize] += e - c;
                match row_cls[b] {
                    BLOCK_EMPTY => {}
                    BLOCK_OPAQUE if plain => d[dof..dof + (e - c)].copy_from_slice(&sdata[so..so + (e - c)]),
                    _ if plain => over_row(&sdata[so..so + (e - c)], &mut d[dof..dof + (e - c)]),
                    _ => blend_row(&sdata[so..so + (e - c)], &mut d[dof..dof + (e - c)], a, mode),
                }
                c = e;
            }
        } else {
            let so = srow + (sx + j0) as usize;
            blend_row(&sdata[so..so + n], d, a, mode);
        }
    }
    class_px
}

/// `blit`'s arguments for a draw (Canvas2D::plan_blit); `sub`: a sub-pixel offset made whole.
#[derive(Clone, Copy)]
struct PlannedBlit {
    sx: i32,
    sy: i32,
    w: i32,
    h: i32,
    dx: i32,
    dy: i32,
    mode: BlitMode,
    flip: bool,
    sub: bool,
}

/// One planned 1:1 draw of a batch (Canvases::draw_batch).
struct BatchBlit<'a> {
    g: BlitGeom,
    sdata: &'a [u32],
    blocks: Option<&'a BlockMap>,
}
/// POWERBOAT_C2D_BANDS=0: runs of drawImage calls drawn one at a time again (A/B).
static BAND_BATCH: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_BANDS").map_or(true, |v| v != "0"));
/// POWERBOAT_C2D_BATCH_DEBUG=1: a line per batch drawn.
static BATCH_DEBUG: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var_os("POWERBOAT_C2D_BATCH_DEBUG").is_some());
/// Most drawImage calls held back at once when drawing in each op (C2d::run).
const RUN_MAX: usize = 4096;
/// Fewest draws in a run that draw_batch takes.
const BATCH_MIN: usize = 8;

/// A run of 1:1 blits into one pixmap, drawn band by band: each thread takes horizontal bands of the
/// destination and draws every blit's part inside its band, in order, so every pixel sees the same
/// blends in the same order as drawing them one by one. Small sprites are each too small to split
/// (PAR_MIN_PX), and on an in-order A53 their rows mostly wait for memory: several cores wait at once.
fn blit_batch(dst: &mut Pixmap, jobs: &[BatchBlit]) {
    let dstride = dst.width() as usize;
    let (mut ylo, mut yhi, mut work) = (i32::MAX, i32::MIN, 0usize);
    for j in jobs {
        ylo = ylo.min(j.g.dy + j.g.i0);
        yhi = yhi.max(j.g.dy + j.g.i1);
        work += j.g.n * (j.g.i1 - j.g.i0) as usize;
    }
    if jobs.is_empty() || yhi <= ylo {
        return;
    }
    let ddata = px32_mut(dst.data_mut());
    let rows = &mut ddata[ylo as usize * dstride..yhi as usize * dstride];
    let nrows = (yhi - ylo) as usize;
    let draw_band = |by0: i32, band: &mut [u32]| {
        let by1 = by0 + (band.len() / dstride) as i32;
        for j in jobs {
            let (lo, hi) = ((j.g.dy + j.g.i0).max(by0), (j.g.dy + j.g.i1).min(by1));
            if lo < hi {
                let sub = &mut band[(lo - by0) as usize * dstride..(hi - by0) as usize * dstride];
                blit_rows(&j.g, j.sdata, j.blocks, lo - j.g.dy, sub);
            }
        }
    };
    match &*C2D_POOL {
        Some(pool) if work >= PAR_MIN_PX && nrows >= 4 * *C2D_THREADS => {
            use rayon::prelude::*;
            // Twice as many bands as threads: sprites are rarely spread evenly down the screen.
            let per = nrows.div_ceil(2 * *C2D_THREADS);
            pool.install(|| rows.par_chunks_mut(per * dstride).enumerate().for_each(|(b, band)| draw_band(ylo + (b * per) as i32, band)));
        }
        _ => draw_band(ylo, rows),
    }
}

/// src's (sx, sy, w, h) magnified k times (nearest) at (dx, dy) in dst, blended as `blit` does.
#[allow(clippy::too_many_arguments)]
fn blit_scaled(dst: &mut Pixmap, src: tiny_skia::PixmapRef, blocks: Option<&BlockMap>, sx: i32, sy: i32, w: i32, h: i32, dx: i32, dy: i32, k: i32, alpha: f32, mode: BlitMode) {
    let (sw_full, sh_full) = (src.width() as i32, src.height() as i32);
    let (dw_full, dh_full) = (dst.width() as i32, dst.height() as i32);
    // The source rect clipped to the source, then destination columns/rows clipped to dst.
    let (sx0, sy0) = (sx.max(0), sy.max(0));
    let (sx1, sy1) = ((sx + w).min(sw_full), (sy + h).min(sh_full));
    if sx1 <= sx0 || sy1 <= sy0 {
        return;
    }
    let (ox, oy) = (dx + (sx0 - sx) * k, dy + (sy0 - sy) * k);
    let (x0, x1) = (ox.max(0), (ox + (sx1 - sx0) * k).min(dw_full));
    let (y0, y1) = (oy.max(0), (oy + (sy1 - sy0) * k).min(dh_full));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let a = (alpha.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
    if a == 0 {
        return;
    }
    let (sstride, dstride) = (sw_full as usize, dw_full as usize);
    let n = (x1 - x0) as usize;
    let sdata = px32(src.data());
    let ddata = px32_mut(dst.data_mut());
    let plain = mode == BlitMode::Over && a == 255;
    // Source columns c_first..=c_last cover destination x0..x1; wide[(c - c_first) * k ..][..k] holds
    // column c widened, so destination x reads wide[x - base].
    let c_first = sx0 + (x0 - ox) / k;
    let c_last = sx0 + (x1 - 1 - ox) / k;
    let base = ox + (c_first - sx0) * k;
    let (cf, cl, ku) = (c_first as usize, c_last as usize + 1, k as usize);
    let rows = &mut ddata[y0 as usize * dstride..y1 as usize * dstride];
    let class_px = par_bands(rows, dstride, n, y0, &|first_y, band: &mut [u32]| {
        let mut wide: Vec<u32> = vec![0; (cl - cf) * ku];
        let mut class_px = [0usize; 3];
        let mut last_src_row = -1;
        for (r, row) in band.chunks_exact_mut(dstride).enumerate() {
            let y = first_y + r as i32;
            let srow_i = sy0 + (y - oy) / k;
            let srow = srow_i as usize * sstride;
            let row_cls = blocks.map(|bm| &bm.cls[srow_i as usize * bm.bw..(srow_i as usize + 1) * bm.bw]);
            // Source block runs [c, e): empty ones skipped (not read, not widened), opaque ones copied
            // under plain source-over, the rest blended. Rows are widened once per k destination rows.
            let fresh = srow_i != last_src_row;
            last_src_row = srow_i;
            let mut c = cf;
            while c < cl {
                let e = match row_cls {
                    Some(_) => ((c / BLOCK + 1) * BLOCK).min(cl),
                    None => cl,
                };
                let cls = row_cls.map_or(BLOCK_MIXED, |rc| rc[c / BLOCK]);
                let (dx0, dx1) = ((base + ((c - cf) * ku) as i32).max(x0), (base + ((e - cf) * ku) as i32).min(x1));
                class_px[cls as usize] += (dx1 - dx0) as usize;
                if cls != BLOCK_EMPTY {
                    if fresh {
                        for (i, &p) in sdata[srow + c..srow + e].iter().enumerate() {
                            wide[(c - cf + i) * ku..(c - cf + i + 1) * ku].fill(p);
                        }
                    }
                    let s = &wide[(dx0 - base) as usize..(dx1 - base) as usize];
                    let d = &mut row[dx0 as usize..dx1 as usize];
                    match cls {
                        BLOCK_OPAQUE if plain => d.copy_from_slice(s),
                        _ if plain => over_row(s, d),
                        _ => blend_row(s, d, a, mode),
                    }
                }
                c = e;
            }
        }
        class_px
    });
    if blocks.is_some() {
        for (i, name) in ["empty", "opaque", "mixed"].iter().enumerate() {
            stat(|| format!("blit x{k} px {name} dst {dw_full}x{dh_full}"), class_px[i] as f32);
        }
    }
}

/// POWERBOAT_C2D_SUBPIXEL=0 (A/B): unit-scale draws at sub-pixel offsets go through blit_nearest again.
static SUBPIXEL_BLIT: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_SUBPIXEL").map_or(true, |v| v != "0"));

/// blit_nearest at a unit scale (up to float noise) and a fractional offset is a 1:1 copy: an ImpactJS game's camera
/// stops between pixels, so its full-screen layer draws (a 640x384 buffer onto the screen, 512x512 map chunks)
/// missed the 1:1 blit and blended every pixel, empty and opaque blocks alike (TrimUI Smart Pro jungle: 3-8 ms
/// each, ~20 ms of a 27 ms drawing frame). Same span and sampling as blit_nearest; when every destination
/// column X samples X + d and every row Y samples Y + e, inside the image, returns that copy as
/// (source x, y, width, height, destination x, y) for `blit`.
#[allow(clippy::too_many_arguments)]
fn nearest_as_blit(src_w: i32, src_h: i32, dst_w: i32, dst_h: i32, sx: f32, sy: f32, w: f32, h: f32, l: f32, t: f32, kx: f32, ky: f32) -> Option<(i32, i32, i32, i32, i32, i32)> {
    if (kx - 1.0).abs() > 1e-3 || (ky - 1.0).abs() > 1e-3 {
        return None;
    }
    let (sx0, sy0) = (sx.max(0.0), sy.max(0.0));
    let (sx1, sy1) = ((sx + w).min(src_w as f32), (sy + h).min(src_h as f32));
    if sx1 <= sx0 || sy1 <= sy0 {
        return None;
    }
    let (fl, fr) = (l + (sx0 - sx) * kx, l + (sx1 - sx) * kx);
    let (ft, fb) = (t + (sy0 - sy) * ky, t + (sy1 - sy) * ky);
    let (x0, x1) = (((fl - 0.5).ceil() as i32).max(0), ((fr - 0.5).ceil() as i32).min(dst_w));
    let (y0, y1) = (((ft - 0.5).ceil() as i32).max(0), ((fb - 0.5).ceil() as i32).min(dst_h));
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    // blit_nearest's sampling, column by column. At an exact unit scale the division is the identity (x / 1.0 == x
    // exactly), so it is left out there: the same results without a division per column and row (sprites at
    // fractional offsets: this check was 3.6 % of h5bench's sprite frames on the RG-34XXSP).
    let unit = kx == 1.0 && ky == 1.0;
    let col = |x: i32| if unit { (sx + (x as f32 + 0.5 - l)).floor() as i32 } else { (sx + (x as f32 + 0.5 - l) / kx).floor() as i32 };
    let row = |y: i32| if unit { (sy + (y as f32 + 0.5 - t)).floor() as i32 } else { (sy + (y as f32 + 0.5 - t) / ky).floor() as i32 };
    let (d, e) = (col(x0) - x0, row(y0) - y0);
    if (x0..x1).any(|x| col(x) - x != d) || (y0..y1).any(|y| row(y) - y != e) {
        return None;
    }
    // blit_nearest clamps to the image edge: a clamped column is not a shift.
    if x0 + d < 0 || x1 - 1 + d >= src_w || y0 + e < 0 || y1 - 1 + e >= src_h {
        return None;
    }
    Some((x0 + d, y0 + e, x1 - x0, y1 - y0, x0, y0))
}

/// src's (sx, sy, w, h) scaled by (kx, ky) (negative = mirrored) to the destination origin (l, t): source
/// point u lands at l + (u - sx) * kx. Nearest sampling at pixel centers (destination pixels whose centers
/// fall inside the scaled rect), blended as `blit` does.
#[allow(clippy::too_many_arguments)]
fn blit_nearest(dst: &mut Pixmap, src: tiny_skia::PixmapRef, sx: f32, sy: f32, w: f32, h: f32, l: f32, t: f32, kx: f32, ky: f32, alpha: f32, mode: BlitMode) {
    let (sw_full, sh_full) = (src.width() as i32, src.height() as i32);
    let (dw_full, dh_full) = (dst.width() as i32, dst.height() as i32);
    // The source rect (fractional too: screen shake offsets) clipped to the image.
    let (sx0, sy0) = (sx.max(0.0), sy.max(0.0));
    let (sx1, sy1) = ((sx + w).min(sw_full as f32), (sy + h).min(sh_full as f32));
    if sx1 <= sx0 || sy1 <= sy0 {
        return;
    }
    // The clipped source rect's destination span; pixel X is covered when fl <= X + 0.5 < fr.
    let (ex0, ex1) = (l + (sx0 - sx) * kx, l + (sx1 - sx) * kx);
    let (ey0, ey1) = (t + (sy0 - sy) * ky, t + (sy1 - sy) * ky);
    let (fl, fr, ft, fb) = (ex0.min(ex1), ex0.max(ex1), ey0.min(ey1), ey0.max(ey1));
    let (x0, x1) = (((fl - 0.5).ceil() as i32).max(0), ((fr - 0.5).ceil() as i32).min(dw_full));
    let (y0, y1) = (((ft - 0.5).ceil() as i32).max(0), ((fb - 0.5).ceil() as i32).min(dh_full));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let a = (alpha.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
    if a == 0 {
        return;
    }
    let (sstride, dstride) = (sw_full as usize, dw_full as usize);
    let n = (x1 - x0) as usize;
    // Sample at the pixel center, clamped to the image (tiny-skia's pattern pads to the image edge).
    let cols: Vec<usize> = (x0..x1).map(|x| ((sx + (x as f32 + 0.5 - l) / kx).floor() as i32).clamp(0, sw_full - 1) as usize).collect();
    let sdata = px32(src.data());
    let ddata = px32_mut(dst.data_mut());
    let plain = mode == BlitMode::Over && a == 255;
    let rows = &mut ddata[y0 as usize * dstride..y1 as usize * dstride];
    par_bands(rows, dstride, n, y0, &|first_y, band: &mut [u32]| {
        let mut wide: Vec<u32> = Vec::with_capacity(n);
        let mut last_src_row = usize::MAX;
        for (r, row) in band.chunks_exact_mut(dstride).enumerate() {
            let y = first_y + r as i32;
            let srow_i = ((sy + (y as f32 + 0.5 - t) / ky).floor() as i32).clamp(0, sh_full - 1) as usize;
            if srow_i != last_src_row {
                let srow = &sdata[srow_i * sstride..(srow_i + 1) * sstride];
                wide.clear();
                wide.extend(cols.iter().map(|&c| srow[c]));
                last_src_row = srow_i;
            }
            let d = &mut row[x0 as usize..x1 as usize];
            if plain {
                over_row(&wide, d);
            } else {
                blend_row(&wide, d, a, mode);
            }
        }
        [0; 3]
    });
}

/// POWERBOAT_C2D_AFFINE=0: rotated and smoothly scaled drawImage through tiny-skia's pattern again (A/B).
static AFFINE_BLIT: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_AFFINE").map_or(true, |v| v != "0"));

/// p * (256 - f) / 256 + q * f / 256 per byte (f in 0..=256), two channels per multiply. Premultiplied
/// pixels stay valid (no channel above its alpha), and equal inputs come back unchanged.
#[inline(always)]
fn lerp_px(p: u32, q: u32, f: u32) -> u32 {
    let g = 256 - f;
    let rb = (((p & 0x00ff_00ff) * g + (q & 0x00ff_00ff) * f) >> 8) & 0x00ff_00ff;
    let ag = (((p >> 8) & 0x00ff_00ff) * g + ((q >> 8) & 0x00ff_00ff) * f) & 0xff00_ff00;
    rb | ag
}

/// Integers k in 0..n with lo <= b + c * k < hi, as a range (empty when there are none); `rc` is 1 / c.
fn affine_span(b: f64, c: f64, rc: f64, lo: f64, hi: f64, n: i64) -> (i64, i64) {
    let (a, z) = if c > 0.0 {
        (((lo - b) * rc).ceil(), ((hi - b) * rc).ceil())
    } else if c < 0.0 {
        (((hi - b) * rc).floor() + 1.0, ((lo - b) * rc).floor() + 1.0)
    } else if lo <= b && b < hi {
        (0.0, n as f64)
    } else {
        (0.0, 0.0)
    };
    let (a, z) = (a.clamp(0.0, n as f64) as i64, z.clamp(0.0, n as f64) as i64);
    (a, z.max(a))
}

/// drawImage through a CTM the other blits do not take (rotation, smooth scaling): the destination pixels
/// whose centers map (`inv`: device -> source pixels) into the source rect, sampled as tiny-skia's pattern
/// samples them (bilinear: the four pixels around the point, weights fract(p + 0.5); nearest with smoothing
/// off; the whole image is sampled and its edge pixels padded) and blended as `blit` does. Source points
/// step along each row in 16.16 fixed point with 8-bit weights: within a level or two of tiny-skia's float
/// pipeline, which took most of the time of h5bench's rotated sprites (42 at 60 fps on the RG-34XXSP,
/// quixjs 96). The source rect is clipped to the image first, as the other blits and browsers do.
#[allow(clippy::too_many_arguments)]
fn blit_affine(dst: &mut Pixmap, src: tiny_skia::PixmapRef, fwd: Transform, inv: Transform, sx: f32, sy: f32, sw: f32, sh: f32, bilinear: bool, alpha: f32, mode: BlitMode) {
    let (iw, ih) = (src.width() as i64, src.height() as i64);
    let (pw, ph) = (dst.width() as i32, dst.height() as i32);
    let (sx0, sy0) = (sx.max(0.0), sy.max(0.0));
    let (sx1, sy1) = ((sx + sw).min(iw as f32), (sy + sh).min(ih as f32));
    if sx1 <= sx0 || sy1 <= sy0 {
        return;
    }
    let a = (alpha.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
    if a == 0 {
        return;
    }
    // Device rows and columns the clipped rect can touch.
    let mut pts = [Point::from_xy(sx0, sy0), Point::from_xy(sx1, sy0), Point::from_xy(sx0, sy1), Point::from_xy(sx1, sy1)];
    fwd.map_points(&mut pts);
    let (mut l, mut r, mut t, mut b) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for p in &pts {
        (l, r, t, b) = (l.min(p.x), r.max(p.x), t.min(p.y), b.max(p.y));
    }
    if !(l.is_finite() && r.is_finite() && t.is_finite() && b.is_finite()) {
        return;
    }
    let (x0, x1) = (((l - 1.0).floor() as i32).max(0), ((r + 1.0).ceil() as i32).min(pw));
    let (y0, y1) = (((t - 1.0).floor() as i32).max(0), ((b + 1.0).ceil() as i32).min(ph));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let n = (x1 - x0) as i64;
    let (isx, iky, ikx, isy, itx, ity) = (inv.sx as f64, inv.ky as f64, inv.kx as f64, inv.sy as f64, inv.tx as f64, inv.ty as f64);
    let (lo_x, hi_x, lo_y, hi_y) = (sx0 as f64, sx1 as f64, sy0 as f64, sy1 as f64);
    const ONE: f64 = 65536.0;
    let (dfx, dfy) = ((isx * ONE).round() as i64, (iky * ONE).round() as i64);
    let (rsx, rky) = (if isx != 0.0 { 1.0 / isx } else { 0.0 }, if iky != 0.0 { 1.0 / iky } else { 0.0 });
    let stride = iw as usize;
    let sdata = px32(src.data());
    let dstride = pw as usize;
    let ddata = px32_mut(dst.data_mut());
    let rows = &mut ddata[y0 as usize * dstride..y1 as usize * dstride];
    let area = ((r - l) * (b - t)).max(0.0) as usize;
    par_bands(rows, dstride, area / (y1 - y0) as usize, y0, &|first_y, band: &mut [u32]| {
        let mut wide: Vec<u32> = Vec::with_capacity(n as usize);
        for (ri, row) in band.chunks_exact_mut(dstride).enumerate() {
            let cy = (first_y + ri as i32) as f64 + 0.5;
            let cx = x0 as f64 + 0.5;
            // Source point of the row's first pixel center; it moves by (isx, iky) a pixel.
            let (bx, by) = (isx * cx + ikx * cy + itx, iky * cx + isy * cy + ity);
            let (ax, zx) = affine_span(bx, isx, rsx, lo_x, hi_x, n);
            let (ay, zy) = affine_span(by, iky, rky, lo_y, hi_y, n);
            let (k0, k1) = (ax.max(ay), zx.min(zy));
            if k1 <= k0 {
                continue;
            }
            let (mut fx, mut fy) = (((bx + isx * k0 as f64) * ONE).round() as i64, ((by + iky * k0 as f64) * ONE).round() as i64);
            wide.clear();
            // Source points move in a straight line along the row: when both ends' 2x2 squares lie inside the
            // image, every one between does, and the taps need no clamping (most rows of a sprite in an atlas).
            let m = k1 - k0 - 1;
            let (ex, ey) = (fx + dfx * m, fy + dfy * m);
            let interior = |a: i64, b: i64, lim: i64| (a.min(b) - 32768) >> 16 >= 0 && ((a.max(b) - 32768) >> 16) + 1 < lim;
            if bilinear && interior(fx, ex, iw) && interior(fy, ey, ih) {
                for _ in k0..k1 {
                    let (ux, uy) = (fx - 32768, fy - 32768);
                    let o = (uy >> 16) as usize * stride + (ux >> 16) as usize;
                    // In range: checked once for the row above.
                    let (p00, p10, p01, p11) = unsafe { (*sdata.get_unchecked(o), *sdata.get_unchecked(o + 1), *sdata.get_unchecked(o + stride), *sdata.get_unchecked(o + stride + 1)) };
                    wide.push(if p00 == p10 && p00 == p01 && p00 == p11 {
                        p00
                    } else {
                        let (wx, wy) = (((ux >> 8) & 0xff) as u32, ((uy >> 8) & 0xff) as u32);
                        lerp_px(lerp_px(p00, p10, wx), lerp_px(p01, p11, wx), wy)
                    });
                    fx += dfx;
                    fy += dfy;
                }
            } else if bilinear {
                for _ in k0..k1 {
                    let (ux, uy) = (fx - 32768, fy - 32768);
                    let (ix, iy) = (ux >> 16, uy >> 16);
                    let (c0, c1) = (ix.clamp(0, iw - 1) as usize, (ix + 1).clamp(0, iw - 1) as usize);
                    let (r0, r1) = (iy.clamp(0, ih - 1) as usize * stride, (iy + 1).clamp(0, ih - 1) as usize * stride);
                    let (p00, p10, p01, p11) = (sdata[r0 + c0], sdata[r0 + c1], sdata[r1 + c0], sdata[r1 + c1]);
                    wide.push(if (p00 | p10 | p01 | p11) == 0 {
                        0
                    } else {
                        let (wx, wy) = (((ux >> 8) & 0xff) as u32, ((uy >> 8) & 0xff) as u32);
                        lerp_px(lerp_px(p00, p10, wx), lerp_px(p01, p11, wx), wy)
                    });
                    fx += dfx;
                    fy += dfy;
                }
            } else {
                for _ in k0..k1 {
                    let (c, rr) = ((fx >> 16).clamp(0, iw - 1) as usize, (fy >> 16).clamp(0, ih - 1) as usize);
                    wide.push(sdata[rr * stride + c]);
                    fx += dfx;
                    fy += dfy;
                }
            }
            let d = &mut row[(x0 as i64 + k0) as usize..(x0 as i64 + k1) as usize];
            blend_row(&wide, d, a, mode);
        }
        [0; 3]
    });
}

/// fillRect with a solid color, source-over, on whole pixels: the premultiplied color over each pixel.
fn fill_rect_over(dst: &mut Pixmap, x0: i32, y0: i32, x1: i32, y1: i32, c: tiny_skia::PremultipliedColorU8) {
    let (w, h) = (dst.width() as i32, dst.height() as i32);
    let (x0, y0, x1, y1) = (x0.max(0), y0.max(0), x1.min(w), y1.min(h));
    if x1 <= x0 || y1 <= y0 || c.alpha() == 0 {
        return;
    }
    let s = u32::from_le_bytes([c.red(), c.green(), c.blue(), c.alpha()]);
    let stride = w as usize;
    let data = px32_mut(dst.data_mut());
    let rows = &mut data[y0 as usize * stride..y1 as usize * stride];
    let opaque = c.alpha() == 255;
    par_bands(rows, stride, (x1 - x0) as usize, y0, &|_, band: &mut [u32]| {
        for row in band.chunks_exact_mut(stride) {
            let row = &mut row[x0 as usize..x1 as usize];
            if opaque {
                row.fill(s);
            } else {
                over_row_const(s, row);
            }
        }
        [0; 3]
    });
}
#[inline(always)]
fn over_row_const(s: u32, d: &mut [u32]) {
    for dp in d.iter_mut() {
        *dp = over_px(s, *dp);
    }
}
/// clearRect on whole pixels: zeroed rows.
fn clear_rect_px(dst: &mut Pixmap, x0: i32, y0: i32, x1: i32, y1: i32) {
    let (w, h) = (dst.width() as i32, dst.height() as i32);
    let (x0, y0, x1, y1) = (x0.max(0), y0.max(0), x1.min(w), y1.min(h));
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let stride = w as usize;
    let data = px32_mut(dst.data_mut());
    for y in y0..y1 {
        data[y as usize * stride + x0 as usize..y as usize * stride + x1 as usize].fill(0);
    }
}

/// The drawing side: every canvas's pixels, state stack and path. Reached from outside canvas.rs only
/// through `C2d::flushed`, so nothing reads pixels that queued commands have not drawn yet.
#[derive(Default)]
pub struct Canvases {
    map: HashMap<u32, Canvas2D>,
}

/// Large canvas buffers (glibc gives each its own mapping: M_MMAP_THRESHOLD in main.rs) start on fresh
/// pages, and the first write to every page faults and zeroes it. An ImpactJS game makes ~50 new 512x512 map chunk
/// canvases on entering a map: the first touch of their 51 MB is most of a 130-250 ms frame on the handhelds.
/// (Keeping freed buffers for reuse did not help: the old map's chunks are freed by the GC only later.)
const PREFAULT_MIN_BYTES: usize = 256 * 1024;
/// POWERBOAT_C2D_PREFAULT=0 (A/B): new large canvases are not touched page by page, and clearRect on a canvas
/// known to be clear draws anyway (the behavior before 2026-11-03).
static PREFAULT: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_PREFAULT").map_or(true, |v| v != "0"));

impl Canvases {
    pub fn get(&self, id: u32) -> Option<&Canvas2D> {
        self.map.get(&id)
    }
    /// Mutable access means the pixels may change: the block map goes.
    fn get_mut(&mut self, id: u32) -> Option<&mut Canvas2D> {
        self.map.get_mut(&id).map(|c| {
            c.blocks = None;
            c
        })
    }
}

impl Canvas2D {
    /// A new transparent canvas (create, resize). A large one gets one write per page, in order: its page
    /// faults come in one sequential pass here instead of scattered through the first draws (a 32x32 tile
    /// on a 512-wide canvas touches 16 pages), and the game's clearRect of it is then skipped (clear flag).
    fn fresh(w: u32, h: u32) -> Canvas2D {
        let mut c = Canvas2D::new(w, h);
        let d = c.pixmap.data_mut();
        if *PREFAULT && d.len() >= PREFAULT_MIN_BYTES {
            for i in (0..d.len()).step_by(4096) {
                unsafe { std::ptr::write_volatile(d.as_mut_ptr().add(i), 0) };
            }
        }
        c
    }
}

/// What the main thread knows of a canvas without its pixels: size (memory count) and the font
/// stack (measureText).
struct FrontCanvas {
    w: u32,
    h: u32,
    font: FontSpec,
    fonts: Vec<FontSpec>,
}

/// Deferred Canvas 2D: draw on a drawing thread (DEFERRED_CANVAS2D.md). On by default for NW.js 2D
/// pages (POWERBOAT_WEBPAGE: ImpactJS games), off for MV and Construct; POWERBOAT_C2D_DEFER=1|0 overrides. Ops record commands; they go
/// to that thread when something reads a canvas's pixels (getImageData, a GL upload, the forms
/// overlay: the reader then waits until it is idle) and at the 2D page's present, which hands over the
/// frame and shows the previous one, so the next frame's JS runs while this one is drawn.
/// POWERBOAT_C2D_DEFER=each: through the thread, waiting after every command (checks the threaded path).
/// Auto fallback: a game that makes the main thread wait for drawing more than FALLBACK_FLUSHES times
/// per frame (reading pixels, uploading canvases mid-frame) over FALLBACK_SECS draws in each op again.
#[derive(Clone, Copy, PartialEq)]
#[repr(u8)]
enum Defer {
    Off,
    On,
    Each,
}
static DEFER_START: std::sync::LazyLock<Defer> = std::sync::LazyLock::new(|| match std::env::var("POWERBOAT_C2D_DEFER").as_deref() {
    Ok("1") => Defer::On,
    Ok("each") => Defer::Each,
    Ok("0") => Defer::Off,
    // Unset or empty (launch scripts pass every variable, empty when not chosen): the page decides.
    _ if std::env::var("POWERBOAT_WEBPAGE").is_ok_and(|v| v == "1") => Defer::On,
    _ => Defer::Off,
});
/// The current mode: DEFER_START until the fallback switches it off.
static MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(u8::MAX);
fn mode() -> Defer {
    match MODE.load(std::sync::atomic::Ordering::Relaxed) {
        0 => Defer::Off,
        1 => Defer::On,
        2 => Defer::Each,
        _ => {
            MODE.store(*DEFER_START as u8, std::sync::atomic::Ordering::Relaxed);
            *DEFER_START
        }
    }
}
const FALLBACK_FLUSHES: f64 = 2.0;
const FALLBACK_SECS: f64 = 3.0;
/// Whether the 2D page presenter shows frames one behind (op_c2d_present_upload).
pub fn pipelined() -> bool {
    mode() == Defer::On
}
/// Queue length that hands over anyway (a game drawing only offscreen would otherwise grow it forever).
const QUEUE_MAX: usize = 8192;

/// Deferred-mode counters since the last frame report: drawing-thread ns, main-thread wait ns,
/// flushes (waits for the drawing thread outside the present).
static DRAW_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static WAIT_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static FLUSHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// (drawing ns, wait ns, flushes) since the last call; None when not deferred.
pub fn take_defer_stats() -> Option<(u64, u64, u64)> {
    use std::sync::atomic::Ordering::Relaxed;
    (*DEFER_START != Defer::Off).then(|| (DRAW_NS.swap(0, Relaxed), WAIT_NS.swap(0, Relaxed), FLUSHES.swap(0, Relaxed)))
}

/// The canvases and how far the drawing thread got (batch sequence number).
#[derive(Default)]
struct Back {
    canvases: Canvases,
    applied: u64,
}
/// A copy of the presented canvas at the end of a frame (Cmd::Snapshot), for the present.
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub data: Vec<u8>,
    seq: u64,
}
#[derive(Default)]
struct Snaps {
    last: Option<Frame>,
    spare: Vec<u8>,
    /// The newest frame uploaded on the drawing thread (crate::upload), and the texture slots in use.
    gpu_last: Option<crate::upload::GpuFrame>,
    slots: crate::upload::Slots,
    /// The frame handed to the present thread (crate::present), until it takes it.
    to_present: Option<crate::upload::GpuFrame>,
    /// Ticks with nothing newer: the present thread shows its last frame again (a swap paces the JS
    /// thread, as the JS-thread present swapped the held texture again). Requested / done counts.
    repeat_req: u64,
    repeat_done: u64,
}

/// What the present thread is handed.
pub enum ToPresent {
    Frame(crate::upload::GpuFrame),
    /// The last frame again; done once `Handoff::repeated(n)` reports it.
    Repeat(u64),
}

/// What the present gets: a copy to upload, or a texture the drawing thread uploaded.
pub enum Presented {
    Cpu(Frame),
    Gpu(crate::upload::GpuFrame),
}
#[derive(Default)]
struct Shared {
    back: std::sync::Mutex<Back>,
    back_cv: std::sync::Condvar,
    snaps: std::sync::Mutex<Snaps>,
    snaps_cv: std::sync::Condvar,
    /// Frames uploaded on the drawing thread: 0 not known yet, 1 yes (GPU frames), 2 no (CPU copies).
    gpu: std::sync::atomic::AtomicU8,
}

/// The present thread's side of the frame handoff (crate::present).
#[derive(Clone)]
pub struct Handoff(std::sync::Arc<Shared>);
impl Handoff {
    /// Waits for what the main thread handed over; None once `stop` is set. `seen`: the repeats taken.
    pub fn take(&self, stop: &std::sync::atomic::AtomicBool, seen: &mut u64) -> Option<ToPresent> {
        let mut s = self.0.snaps.lock().unwrap();
        loop {
            if stop.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }
            if let Some(f) = s.to_present.take() {
                return Some(ToPresent::Frame(f));
            }
            if s.repeat_req > *seen {
                *seen = s.repeat_req;
                return Some(ToPresent::Repeat(*seen));
            }
            s = self.0.snaps_cv.wait_timeout(s, std::time::Duration::from_millis(100)).unwrap().0;
        }
    }
    /// After the swap that showed the last frame again (repeat `n`).
    pub fn repeated(&self, n: u64) {
        self.0.snaps.lock().unwrap().repeat_done = n;
        self.0.snaps_cv.notify_all();
    }
    /// After the swap that showed `slot`: it is the held one, the one shown before it is free, and the
    /// main thread may queue the next frame.
    pub fn shown(&self, slot: usize, seq: u64) {
        let mut s = self.0.snaps.lock().unwrap();
        if s.slots.queued == Some(slot) {
            s.slots.queued = None;
        }
        if let Some(old) = s.slots.held.replace(slot) {
            if old != slot {
                s.slots.freed_at[old] = seq;
            }
        }
        drop(s);
        self.0.snaps_cv.notify_all();
    }
    pub fn wake(&self) {
        self.0.snaps_cv.notify_all();
    }
    /// The present thread stopped: a frame it never took frees its slot (its fence is left to the driver).
    pub fn reset(&self) {
        let mut s = self.0.snaps.lock().unwrap();
        s.to_present = None;
        s.slots.queued = None;
        s.repeat_done = s.repeat_req;
        drop(s);
        self.0.snaps_cv.notify_all();
    }
}

/// What `C2d::queue_frame` did.
pub enum Queued {
    /// A new frame went to the present thread.
    Sent,
    /// Nothing newer finished: the present thread shows the last frame again.
    Repeat,
    /// Nothing to show yet.
    Nothing,
    /// The frame is a CPU copy (no drawing-thread upload): the present thread cannot show it.
    Cpu(Frame),
}

/// Canvas 2D for the ops (App.canvases): main-thread state, the command queue and the drawing side.
#[derive(Default)]
pub struct C2d {
    next: u32,
    front: HashMap<u32, FrontCanvas>,
    gradients: HashMap<u32, Style>,
    queue: Vec<Cmd>,
    shared: std::sync::Arc<Shared>,
    tx: Option<std::sync::mpsc::Sender<(u64, Vec<Cmd>)>>,
    /// Batches sent to the drawing thread.
    sent: u64,
    /// Frames handed over at the present, and the last one shown.
    frames: u64,
    shown: u64,
    /// Fallback window: start, flushes, presented frames.
    window: Option<(std::time::Instant, u64, u64)>,
    /// The texture the present shows (a drawing-thread upload), bound again on frames with nothing new.
    pub held_tex: Option<glow::NativeTexture>,
    /// Drawing in each op (Defer::Off): drawImage calls into one canvas held back until another command or
    /// a read (flushed), then drawn together (draw_batch).
    run: Vec<Cmd>,
}

/// The canvases with every queued command drawn (a lock on the drawing side while it lives).
pub struct Flushed<'a>(std::sync::MutexGuard<'a, Back>);
impl std::ops::Deref for Flushed<'_> {
    type Target = Canvases;
    fn deref(&self) -> &Canvases {
        &self.0.canvases
    }
}

impl C2d {
    fn alloc_id(&mut self) -> u32 {
        self.next += 1;
        self.next
    }
    fn exists(&self, id: u32) -> bool {
        self.front.contains_key(&id)
    }
    pub fn size(&self, id: u32) -> Option<(u32, u32)> {
        self.front.get(&id).map(|f| (f.w, f.h))
    }
    pub fn bytes(&self) -> usize {
        self.front.values().map(|f| f.w as usize * f.h as usize * 4).sum()
    }
    fn record(&mut self, cmd: Cmd, fonts: &mut crate::fonts::Fonts) {
        match &cmd {
            Cmd::Create { id, w, h } => {
                self.front.insert(*id, FrontCanvas { w: (*w).max(1), h: (*h).max(1), font: FontSpec::default(), fonts: Vec::new() });
            }
            Cmd::Free { id } => {
                self.front.remove(id);
            }
            Cmd::Resize { id, w, h } => {
                if let Some(f) = self.front.get_mut(id) {
                    *f = FrontCanvas { w: (*w).max(1), h: (*h).max(1), font: FontSpec::default(), fonts: Vec::new() };
                }
            }
            Cmd::Save { id } => {
                if let Some(f) = self.front.get_mut(id) {
                    f.fonts.push(f.font.clone());
                }
            }
            Cmd::Restore { id } => {
                if let Some(f) = self.front.get_mut(id) {
                    if let Some(font) = f.fonts.pop() {
                        f.font = font;
                    }
                }
            }
            Cmd::SetFont { id, spec } => {
                if let Some(f) = self.front.get_mut(id) {
                    f.font = spec.clone();
                }
            }
            _ => {}
        }
        let mode = mode();
        // Drawing in each op: a run of drawImage calls into one canvas waits for the next other command or
        // read and is drawn together, band by band on the Canvas 2D threads (as the drawing thread does).
        if mode == Defer::Off && *BAND_BATCH && !*NO_PIXELS {
            if let Some(id) = cmd.batch_target() {
                if self.run.first().and_then(|c| c.batch_target()).is_some_and(|r| r != id) {
                    self.flush_run();
                }
                self.run.push(cmd);
                if self.run.len() >= RUN_MAX {
                    self.flush_run();
                }
                return;
            }
            self.flush_run();
        }
        // Text needs the fonts, which stay on this thread: wait for the drawing thread, draw here.
        if mode == Defer::Off || matches!(cmd, Cmd::Text { .. }) {
            let mut back = if mode == Defer::Off { self.shared.back.lock().unwrap() } else { self.flushed().0 };
            cmd.apply(&mut back.canvases, Some(fonts));
            return;
        }
        self.queue.push(cmd);
        if mode == Defer::Each {
            drop(self.flushed());
        } else if self.queue.len() >= QUEUE_MAX {
            self.send();
        }
    }
    /// Hands the queue to the drawing thread (started on first use).
    fn send(&mut self) {
        if self.queue.is_empty() {
            return;
        }
        let tx = self.tx.get_or_insert_with(|| {
            eprintln!("[powerboat] Canvas 2D: drawing on its own thread (POWERBOAT_C2D_DEFER=0 draws in each op)");
            let (tx, rx) = std::sync::mpsc::channel::<(u64, Vec<Cmd>)>();
            let shared = self.shared.clone();
            // The main context is current here: its EGL handles, for the drawing thread's shared one.
            let main = if pipelined() { crate::upload::main_ctx().map_err(|e| eprintln!("[powerboat] Canvas 2D: frame upload stays on the main thread ({e})")).ok() } else { None };
            std::thread::Builder::new().name("c2d-draw".into()).spawn(move || draw_thread(shared, rx, main)).expect("c2d thread");
            tx
        });
        self.sent += 1;
        let _ = tx.send((self.sent, std::mem::take(&mut self.queue)));
    }
    /// The canvases with every queued command drawn: the only way to their pixels.
    /// Draws the held run (record, drawing in each op).
    fn flush_run(&mut self) {
        if self.run.is_empty() {
            return;
        }
        let run = std::mem::take(&mut self.run);
        let mut back = self.shared.back.lock().unwrap();
        if run.len() < BATCH_MIN || !back.canvases.draw_batch(&run) {
            for c in run {
                c.apply(&mut back.canvases, None);
            }
        }
    }
    pub fn flushed(&mut self) -> Flushed<'_> {
        self.flush_run();
        let pending = !self.queue.is_empty();
        self.send();
        let shared = &*self.shared;
        let mut back = shared.back.lock().unwrap();
        if back.applied < self.sent {
            let t0 = std::time::Instant::now();
            while back.applied < self.sent {
                back = shared.back_cv.wait(back).unwrap();
            }
            WAIT_NS.fetch_add(t0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
        }
        if pending && mode() == Defer::On {
            FLUSHES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // Everything is drawn and the thread is idle here: switching off is safe.
            let w = self.window.get_or_insert((std::time::Instant::now(), 0, 0));
            w.1 += 1;
            let (start, flushes, frames) = *w;
            let secs = start.elapsed().as_secs_f64();
            if secs >= FALLBACK_SECS {
                // Pages without the 2D presenter count no frames: assume 60 per second.
                let frames = if frames > 0 { frames as f64 } else { secs * 60.0 };
                let rate = flushes as f64 / frames;
                if rate > FALLBACK_FLUSHES {
                    eprintln!("[powerboat] Canvas 2D: {rate:.1} waits for the drawing thread per frame: drawing in each op from now on");
                    MODE.store(Defer::Off as u8, std::sync::atomic::Ordering::Relaxed);
                }
                self.window = None;
            }
        }
        Flushed(back)
    }
    /// The 2D page's present (pipelined mode): hands over this frame, ending with a copy of canvas
    /// `id`, and returns the newest finished copy if it is newer than the one shown. Waits only while
    /// the previous frame's copy is missing; None keeps the picture already uploaded (the first frame
    /// shows nothing rather than wait for itself, which would keep every later frame waiting too).
    pub fn present_frame(&mut self, id: u32) -> Option<Presented> {
        self.frames += 1;
        self.window.get_or_insert((std::time::Instant::now(), 0, 0)).2 += 1;
        self.queue.push(Cmd::Snapshot { id, seq: self.frames });
        self.send();
        let want = self.frames - 1;
        let shared = &*self.shared;
        let mut snaps = shared.snaps.lock().unwrap();
        let newest = |s: &Snaps| s.last.as_ref().map(|f| f.seq).max(s.gpu_last.as_ref().map(|f| f.seq));
        if newest(&snaps).is_none_or(|q| q <= self.shown) {
            if self.shown >= want {
                return None;
            }
            let t0 = std::time::Instant::now();
            while newest(&snaps).is_none_or(|q| q < want) {
                snaps = shared.snaps_cv.wait(snaps).unwrap();
            }
            WAIT_NS.fetch_add(t0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
        }
        let gpu_newer = snaps.gpu_last.as_ref().map(|f| f.seq) >= snaps.last.as_ref().map(|f| f.seq);
        if gpu_newer {
            let f = snaps.gpu_last.take()?;
            snaps.slots.last = None;
            if let Some(old) = snaps.slots.held.replace(f.slot) {
                snaps.slots.freed_at[old] = f.seq;
            }
            self.shown = f.seq;
            return Some(Presented::Gpu(f));
        }
        let f = snaps.last.take()?;
        self.shown = f.seq;
        (f.w > 0).then_some(Presented::Cpu(f))
    }
    /// Whether finished frames are uploaded on the drawing thread: None until it has started.
    pub fn gpu_upload(&self) -> Option<bool> {
        match self.shared.gpu.load(std::sync::atomic::Ordering::Acquire) {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }
    pub fn handoff(&self) -> Handoff {
        Handoff(self.shared.clone())
    }
    /// present_frame for the present thread: hands the drawing thread's newest upload over once the
    /// present thread has shown the previous one (that wait paces the JS thread to the swaps).
    pub fn queue_frame(&mut self, id: u32) -> Queued {
        self.frames += 1;
        self.window.get_or_insert((std::time::Instant::now(), 0, 0)).2 += 1;
        self.queue.push(Cmd::Snapshot { id, seq: self.frames });
        self.send();
        let want = self.frames - 1;
        let shared = &*self.shared;
        let mut snaps = shared.snaps.lock().unwrap();
        let newest = |s: &Snaps| s.last.as_ref().map(|f| f.seq).max(s.gpu_last.as_ref().map(|f| f.seq));
        let t0 = std::time::Instant::now();
        // The previous frame (or repeat) shown first; bounded, so a present thread that stopped cannot
        // hang the game.
        fn free<'a>(shared: &'a Shared, mut s: std::sync::MutexGuard<'a, Snaps>, t0: std::time::Instant) -> std::sync::MutexGuard<'a, Snaps> {
            while (s.slots.queued.is_some() || s.repeat_done < s.repeat_req) && t0.elapsed() < std::time::Duration::from_secs(2) {
                s = shared.snaps_cv.wait_timeout(s, std::time::Duration::from_millis(100)).unwrap().0;
            }
            s
        }
        fn repeat(shared: &Shared, s: std::sync::MutexGuard<'_, Snaps>, t0: std::time::Instant) -> Queued {
            let mut s = free(shared, s, t0);
            s.repeat_req += 1;
            drop(s);
            shared.snaps_cv.notify_all();
            WAIT_NS.fetch_add(t0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
            Queued::Repeat
        }
        if newest(&snaps).is_none_or(|q| q <= self.shown) {
            if self.shown >= want {
                // The drawing thread finished this tick's frame within the tick last time.
                return if self.shown > 0 { repeat(shared, snaps, t0) } else { Queued::Nothing };
            }
            while newest(&snaps).is_none_or(|q| q < want) {
                snaps = shared.snaps_cv.wait(snaps).unwrap();
            }
        }
        snaps = free(shared, snaps, t0);
        WAIT_NS.fetch_add(t0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
        let gpu_newer = snaps.gpu_last.as_ref().map(|f| f.seq) >= snaps.last.as_ref().map(|f| f.seq);
        if !gpu_newer {
            let Some(f) = snaps.last.take() else { return Queued::Nothing };
            self.shown = f.seq;
            return Queued::Cpu(f);
        }
        let Some(f) = snaps.gpu_last.take() else { return repeat(shared, snaps, t0) };
        snaps.slots.last = None;
        snaps.slots.queued = Some(f.slot);
        self.shown = f.seq;
        // Not taken yet (the present thread stopped): its fence and slot go with the new one.
        if let Some(old) = snaps.to_present.replace(f) {
            snaps.slots.freed_at[old.slot] = self.frames;
            drop(old);
        }
        drop(snaps);
        shared.snaps_cv.notify_all();
        Queued::Sent
    }
    /// A shown frame's buffer, for the next copy.
    pub fn recycle(&mut self, f: Frame) {
        self.shared.snaps.lock().unwrap().spare = f.data;
    }
}

/// POWERBOAT_C2D_NODRAW=1 (diagnostic): the drawing thread skips the pixel work (wrong picture), to see
/// what the drawing costs the JS thread through shared cores, cache and memory.
static NO_PIXELS: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_C2D_NODRAW").is_ok_and(|v| v == "1"));

/// POWERBOAT_C2D_SLOW=<command ms>[:<frame ms>] (diagnostic; ',' works too): the drawing thread times every command and logs
/// each one that takes longer than the first value, and each frame whose commands take longer than the
/// second (default: the first), with the frame's costliest command kinds.
static SLOW: std::sync::LazyLock<(u64, u64)> = std::sync::LazyLock::new(|| {
    let v = std::env::var("POWERBOAT_C2D_SLOW").unwrap_or_default();
    let mut ms = v.split([',', ':']).map(|p| p.trim().parse::<f64>().ok().map_or(0, |m| (m * 1e6) as u64));
    let cmd = ms.next().unwrap_or(0);
    (cmd, ms.next().filter(|&f| f > 0).unwrap_or(cmd))
});

/// What a command is, for the slow log: kind, target canvas size, source size, rect.
#[derive(Clone, Copy)]
struct Brief {
    kind: &'static str,
    dst: (u32, u32),
    src: (u32, u32),
    r: [f32; 8],
}

impl Cmd {
    /// The canvas a drawImage draws into, for runs of them (Canvases::draw_batch); not for a canvas drawn
    /// onto itself.
    fn batch_target(&self) -> Option<u32> {
        match self {
            Cmd::DrawImage { id, .. } => Some(*id),
            Cmd::DrawCanvas { id, src, .. } if src != id => Some(*id),
            _ => None,
        }
    }
    fn draws_pixels(&self) -> bool {
        matches!(self, Cmd::FillRect { .. } | Cmd::StrokeRect { .. } | Cmd::ClearRect { .. } | Cmd::Fill { .. } | Cmd::Stroke { .. } | Cmd::DrawCanvas { .. } | Cmd::DrawImage { .. } | Cmd::PutImageData { .. })
    }
    /// The canvas whose pixels this command changes (text included), for the known-clear flag.
    fn pixel_target(&self) -> Option<u32> {
        match self {
            Cmd::FillRect { id, .. } | Cmd::StrokeRect { id, .. } | Cmd::ClearRect { id, .. } | Cmd::Fill { id } | Cmd::Stroke { id } => Some(*id),
            Cmd::DrawCanvas { id, .. } | Cmd::DrawImage { id, .. } | Cmd::PutImageData { id, .. } | Cmd::Text { id, .. } => Some(*id),
            _ => None,
        }
    }
    fn brief(&self, cs: &Canvases) -> Brief {
        let size = |id: u32| cs.get(id).map_or((0, 0), |c| (c.pixmap.width(), c.pixmap.height()));
        let rect = |x: f32, y: f32, w: f32, h: f32| [x, y, w, h, 0.0, 0.0, 0.0, 0.0];
        let (kind, id, src, r) = match self {
            Cmd::Create { id, w, h } => ("create", *id, (*w, *h), [0.0; 8]),
            Cmd::Free { id } => ("free", *id, (0, 0), [0.0; 8]),
            Cmd::Resize { id, w, h } => ("resize", *id, (*w, *h), [0.0; 8]),
            Cmd::FillRect { id, x, y, w, h } => ("fillRect", *id, (0, 0), rect(*x, *y, *w, *h)),
            Cmd::StrokeRect { id, x, y, w, h } => ("strokeRect", *id, (0, 0), rect(*x, *y, *w, *h)),
            Cmd::ClearRect { id, x, y, w, h } => ("clearRect", *id, (0, 0), rect(*x, *y, *w, *h)),
            Cmd::Fill { id } => ("fill", *id, (0, 0), [0.0; 8]),
            Cmd::Stroke { id } => ("stroke", *id, (0, 0), [0.0; 8]),
            Cmd::Clip { id } => ("clip", *id, (0, 0), [0.0; 8]),
            Cmd::DrawCanvas { id, src, r } => ("drawImage(canvas)", *id, size(*src), *r),
            Cmd::DrawImage { id, pix, r, .. } => ("drawImage(image)", *id, (pix.width(), pix.height()), *r),
            Cmd::PutImageData { id, w, h, dx, dy, .. } => ("putImageData", *id, (*w, *h), rect(*dx as f32, *dy as f32, *w as f32, *h as f32)),
            Cmd::SetPattern { id, .. } => ("setPattern", *id, (0, 0), [0.0; 8]),
            Cmd::Snapshot { id, .. } => ("snapshot", *id, (0, 0), [0.0; 8]),
            Cmd::Save { id } | Cmd::Restore { id } | Cmd::BeginPath { id } | Cmd::ClosePath { id } => ("state", *id, (0, 0), [0.0; 8]),
            Cmd::SetTransform { id, .. } | Cmd::Transform { id, .. } | Cmd::Translate { id, .. } | Cmd::Scale { id, .. } | Cmd::Rotate { id, .. } => ("transform", *id, (0, 0), [0.0; 8]),
            Cmd::SetAlpha { id, .. } | Cmd::SetBlend { id, .. } | Cmd::SetStyle { id, .. } | Cmd::SetLine { id, .. } | Cmd::SetFont { id, .. } | Cmd::SetText { id, .. } | Cmd::SetSmoothing { id, .. } => ("state", *id, (0, 0), [0.0; 8]),
            Cmd::MoveTo { id, .. } | Cmd::LineTo { id, .. } | Cmd::QuadTo { id, .. } | Cmd::BezierTo { id, .. } | Cmd::Rect { id, .. } | Cmd::Arc { id, .. } => ("path", *id, (0, 0), [0.0; 8]),
            Cmd::Text { id, .. } => ("text", *id, (0, 0), [0.0; 8]),
        };
        Brief { kind, dst: size(id), src, r }
    }
}

/// The slow log's per-frame tally on the drawing thread.
#[derive(Default)]
struct SlowFrame {
    ns: u64,
    cmds: u32,
    by_kind: Vec<(&'static str, u64, u32)>,
}

impl SlowFrame {
    fn add(&mut self, kind: &'static str, ns: u64) {
        self.ns += ns;
        self.cmds += 1;
        match self.by_kind.iter_mut().find(|k| k.0 == kind) {
            Some(k) => {
                k.1 += ns;
                k.2 += 1;
            }
            None => self.by_kind.push((kind, ns, 1)),
        }
    }
    fn end(&mut self, seq: u64) {
        if self.ns > SLOW.1 {
            self.by_kind.sort_by(|a, b| b.1.cmp(&a.1));
            let top: Vec<String> = self.by_kind.iter().take(4).map(|(k, ns, n)| format!("{k} {n}x {:.1} ms", *ns as f64 / 1e6)).collect();
            eprintln!("[powerboat] c2d slow frame {seq}: {:.1} ms in {} commands: {}", self.ns as f64 / 1e6, self.cmds, top.join(", "));
        }
        *self = SlowFrame::default();
    }
}

fn draw_thread(shared: std::sync::Arc<Shared>, rx: std::sync::mpsc::Receiver<(u64, Vec<Cmd>)>, main: Option<crate::upload::MainCtx>) {
    let mut up = main.and_then(|m| match crate::upload::Uploader::new(m) {
        Ok(u) => {
            eprintln!("[powerboat] Canvas 2D: frames uploaded on the drawing thread (shared GL context; POWERBOAT_C2D_GPU_UPLOAD=0 off)");
            Some(u)
        }
        Err(e) => {
            eprintln!("[powerboat] Canvas 2D: frame upload stays on the main thread ({e})");
            None
        }
    });
    shared.gpu.store(if up.is_some() { 1 } else { 2 }, std::sync::atomic::Ordering::Release);
    if *NO_PIXELS {
        eprintln!("[powerboat] POWERBOAT_C2D_NODRAW: the drawing thread skips pixel work (diagnostic, wrong picture)");
    }
    let slow = SLOW.0 > 0;
    if slow {
        eprintln!("[powerboat] POWERBOAT_C2D_SLOW: logging drawing commands over {:.1} ms and frames over {:.1} ms", SLOW.0 as f64 / 1e6, SLOW.1 as f64 / 1e6);
    }
    let mut frame = SlowFrame::default();
    while let Ok((seq, cmds)) = rx.recv() {
        let t0 = std::time::Instant::now();
        let mut back = shared.back.lock().unwrap();
        let mut cmds = cmds.into_iter().peekable();
        while let Some(cmd) = cmds.next() {
            if slow {
                let b = cmd.brief(&back.canvases);
                let snap = match cmd {
                    Cmd::Snapshot { seq, .. } => Some(seq),
                    _ => None,
                };
                let c0 = std::time::Instant::now();
                draw_one(cmd, &shared, &mut back, &mut up);
                let ns = c0.elapsed().as_nanos() as u64;
                frame.add(b.kind, ns);
                if ns > SLOW.0 {
                    let r = b.r.map(|v| v.round() as i32);
                    eprintln!("[powerboat] c2d slow command: {} {:.1} ms, target {}x{}, source {}x{}, rect {:?}", b.kind, ns as f64 / 1e6, b.dst.0, b.dst.1, b.src.0, b.src.1, r);
                }
                if let Some(s) = snap {
                    frame.end(s);
                }
                continue;
            }
            // Runs of drawImage calls into one canvas: drawn together (draw_batch), else one by one.
            if let Some(id) = cmd.batch_target().filter(|_| *BAND_BATCH && !*NO_PIXELS) {
                if cmds.peek().and_then(|c| c.batch_target()) == Some(id) {
                    let mut run = vec![cmd];
                    while let Some(c) = cmds.next_if(|c| c.batch_target() == Some(id)) {
                        run.push(c);
                    }
                    if run.len() < BATCH_MIN || !back.canvases.draw_batch(&run) {
                        for c in run {
                            draw_one(c, &shared, &mut back, &mut up);
                        }
                    }
                    continue;
                }
            }
            draw_one(cmd, &shared, &mut back, &mut up);
        }
        back.applied = seq;
        drop(back);
        shared.back_cv.notify_all();
        DRAW_NS.fetch_add(t0.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
    }
}

/// One command on the drawing thread; a Snapshot uploads the canvas (shared GL context) or copies it.
fn draw_one(cmd: Cmd, shared: &Shared, back: &mut Back, up: &mut Option<crate::upload::Uploader>) {
    if let (Cmd::Snapshot { id, seq }, Some(u)) = (&cmd, up.as_mut()) {
        let (id, seq) = (*id, *seq);
        let slots = shared.snaps.lock().unwrap().slots;
        let f = back.canvases.get(id).filter(|c| c.pixmap.width() > 0).and_then(|c| u.upload(&slots, c.pixmap.width(), c.pixmap.height(), c.pixmap.data(), seq));
        if let Some(f) = f {
            let mut s = shared.snaps.lock().unwrap();
            // A frame nobody took yet is replaced: its slot is free again.
            if let Some(old) = s.gpu_last.take() {
                u.drop_fence(old.fence);
                s.slots.freed_at[old.slot] = seq;
            }
            s.slots.last = Some(f.slot);
            s.gpu_last = Some(f);
            drop(s);
            shared.snaps_cv.notify_all();
            return;
        }
    }
    if let Cmd::Snapshot { id, seq } = cmd {
        let mut data = std::mem::take(&mut shared.snaps.lock().unwrap().spare);
        data.clear();
        let (w, h) = match back.canvases.get(id) {
            Some(c) => {
                data.extend_from_slice(c.pixmap.data());
                (c.pixmap.width(), c.pixmap.height())
            }
            None => (0, 0),
        };
        // A frame nobody took yet is replaced: the present shows the newest one.
        shared.snaps.lock().unwrap().last = Some(Frame { w, h, data, seq });
        shared.snaps_cv.notify_all();
    } else if !(*NO_PIXELS && cmd.draws_pixels()) {
        cmd.apply(&mut back.canvases, None);
    }
}

/// CSS colors: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla(), a few names.
pub fn parse_color(s: &str) -> Option<Color> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        let v = |i: usize| u8::from_str_radix(&hex[i..i + 1], 16).ok().map(|x| x * 17);
        let vv = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        return match hex.len() {
            3 => Some(Color::from_rgba8(v(0)?, v(1)?, v(2)?, 255)),
            4 => Some(Color::from_rgba8(v(0)?, v(1)?, v(2)?, v(3)?)),
            6 => Some(Color::from_rgba8(vv(0)?, vv(2)?, vv(4)?, 255)),
            8 => Some(Color::from_rgba8(vv(0)?, vv(2)?, vv(4)?, vv(6)?)),
            _ => None,
        };
    }
    let lower = s.to_ascii_lowercase();
    if let Some(inner) = lower.strip_prefix("rgba(").or_else(|| lower.strip_prefix("rgb(")).and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split(|c| c == ',' || c == '/' || c == ' ').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
        if parts.len() < 3 {
            return None;
        }
        let chan = |p: &str| -> Option<f32> {
            if let Some(pc) = p.strip_suffix('%') {
                pc.parse::<f32>().ok().map(|v| v / 100.0)
            } else {
                p.parse::<f32>().ok().map(|v| v / 255.0)
            }
        };
        let a = if parts.len() > 3 {
            let p = parts[3];
            if let Some(pc) = p.strip_suffix('%') { pc.parse::<f32>().ok()? / 100.0 } else { p.parse::<f32>().ok()? }
        } else {
            1.0
        };
        return Color::from_rgba(chan(parts[0])?.clamp(0.0, 1.0), chan(parts[1])?.clamp(0.0, 1.0), chan(parts[2])?.clamp(0.0, 1.0), a.clamp(0.0, 1.0));
    }
    if let Some(inner) = lower.strip_prefix("hsla(").or_else(|| lower.strip_prefix("hsl(")).and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split(|c| c == ',' || c == '/' || c == ' ').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
        if parts.len() < 3 {
            return None;
        }
        let h = parts[0].trim_end_matches("deg").parse::<f32>().ok()?;
        let sat = parts[1].trim_end_matches('%').parse::<f32>().ok()? / 100.0;
        let l = parts[2].trim_end_matches('%').parse::<f32>().ok()? / 100.0;
        let a = if parts.len() > 3 { parts[3].trim_end_matches('%').parse::<f32>().ok().map(|v| if parts[3].ends_with('%') { v / 100.0 } else { v })? } else { 1.0 };
        let c = (1.0 - (2.0 * l - 1.0).abs()) * sat;
        let hp = (h.rem_euclid(360.0)) / 60.0;
        let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
        let (r, g, b) = match hp as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = l - c / 2.0;
        return Color::from_rgba((r + m).clamp(0.0, 1.0), (g + m).clamp(0.0, 1.0), (b + m).clamp(0.0, 1.0), a.clamp(0.0, 1.0));
    }
    let named = match lower.as_str() {
        "transparent" => (0, 0, 0, 0),
        "black" => (0, 0, 0, 255),
        "white" => (255, 255, 255, 255),
        "red" => (255, 0, 0, 255),
        "green" => (0, 128, 0, 255),
        "lime" => (0, 255, 0, 255),
        "blue" => (0, 0, 255, 255),
        "yellow" => (255, 255, 0, 255),
        "cyan" | "aqua" => (0, 255, 255, 255),
        "magenta" | "fuchsia" => (255, 0, 255, 255),
        "gray" | "grey" => (128, 128, 128, 255),
        "silver" => (192, 192, 192, 255),
        "orange" => (255, 165, 0, 255),
        "purple" => (128, 0, 128, 255),
        "navy" => (0, 0, 128, 255),
        "maroon" => (128, 0, 0, 255),
        "olive" => (128, 128, 0, 255),
        "teal" => (0, 128, 128, 255),
        "pink" => (255, 192, 203, 255),
        "brown" => (165, 42, 42, 255),
        _ => return None,
    };
    Some(Color::from_rgba8(named.0, named.1, named.2, named.3))
}

fn blend_mode(s: &str) -> BlendMode {
    match s {
        "source-over" => BlendMode::SourceOver,
        "source-in" => BlendMode::SourceIn,
        "source-out" => BlendMode::SourceOut,
        "source-atop" => BlendMode::SourceAtop,
        "destination-over" => BlendMode::DestinationOver,
        "destination-in" => BlendMode::DestinationIn,
        "destination-out" => BlendMode::DestinationOut,
        "destination-atop" => BlendMode::DestinationAtop,
        "lighter" => BlendMode::Plus,
        "copy" => BlendMode::Source,
        "xor" => BlendMode::Xor,
        "multiply" => BlendMode::Multiply,
        "screen" => BlendMode::Screen,
        "overlay" => BlendMode::Overlay,
        "darken" => BlendMode::Darken,
        "lighten" => BlendMode::Lighten,
        "color-dodge" => BlendMode::ColorDodge,
        "color-burn" => BlendMode::ColorBurn,
        "hard-light" => BlendMode::HardLight,
        "soft-light" => BlendMode::SoftLight,
        "difference" => BlendMode::Difference,
        "exclusion" => BlendMode::Exclusion,
        "hue" => BlendMode::Hue,
        "saturation" => BlendMode::Saturation,
        "color" => BlendMode::Color,
        "luminosity" => BlendMode::Luminosity,
        _ => BlendMode::SourceOver,
    }
}

/// Premultiplied RGBA8 pixels -> straight RGBA8 (ImageData / non-premultiplied texture upload).
pub fn demultiply(src: &[u8], out: &mut [u8]) {
    // Whole pixels as words; the division (c * 255 + a / 2) / a as a multiply by ceil(2^32 / a), exact for
    // these numerators (< 2^16). The per-byte loop with three divisions was most of a 640x480 canvas upload
    // with UNPACK_PREMULTIPLY_ALPHA_WEBGL off (h5bench: 7.2 ms of CPU a frame, quixjs 2.2).
    static RECIP: std::sync::LazyLock<[u64; 256]> = std::sync::LazyLock::new(|| {
        let mut t = [0u64; 256];
        for (a, r) in t.iter_mut().enumerate().skip(1) {
            *r = (1u64 << 32).div_ceil(a as u64);
        }
        t
    });
    let recip = &*RECIP;
    let n = src.len().min(out.len()) / 4;
    let (s4, d4) = (&src[..n * 4], &mut out[..n * 4]);
    for (s, d) in s4.chunks_exact(4).zip(d4.chunks_exact_mut(4)) {
        let p = u32::from_le_bytes([s[0], s[1], s[2], s[3]]);
        let a = p >> 24;
        let v = if a == 255 {
            p
        } else if a == 0 {
            0
        } else {
            let r = recip[a as usize];
            let ch = |c: u32| (((c * 255 + a / 2) as u64 * r) >> 32).min(255) as u32;
            ch(p & 0xff) | ch((p >> 8) & 0xff) << 8 | ch((p >> 16) & 0xff) << 16 | a << 24
        };
        d.copy_from_slice(&v.to_le_bytes());
    }
}

// ---- commands ---------------------------------------------------------------------------------

/// One Canvas 2D call that changes a canvas. Ops record a `Cmd` and apply it at once; a deferred mode
/// will apply them on a drawing thread instead (DEFERRED_CANVAS2D.md). Ops that return something
/// (ids, parse results, measureText, getImageData, bytes) stay direct.
pub enum Cmd {
    Create { id: u32, w: u32, h: u32 },
    Free { id: u32 },
    Resize { id: u32, w: u32, h: u32 },
    Save { id: u32 },
    Restore { id: u32 },
    SetTransform { id: u32, t: Transform },
    Transform { id: u32, t: Transform },
    Translate { id: u32, x: f32, y: f32 },
    Scale { id: u32, x: f32, y: f32 },
    Rotate { id: u32, rad: f32 },
    SetAlpha { id: u32, a: f32 },
    SetBlend { id: u32, blend: BlendMode },
    /// Color or gradient, already resolved by the op.
    SetStyle { id: u32, stroke: bool, style: Style },
    SetPattern { id: u32, stroke: bool, src: PatternSrc, repeat: bool },
    SetLine { id: u32, width: f32, cap: LineCap, join: LineJoin, miter: f32 },
    SetFont { id: u32, spec: FontSpec },
    SetText { id: u32, align: u8, baseline: u8 },
    SetSmoothing { id: u32, on: bool },
    FillRect { id: u32, x: f32, y: f32, w: f32, h: f32 },
    StrokeRect { id: u32, x: f32, y: f32, w: f32, h: f32 },
    ClearRect { id: u32, x: f32, y: f32, w: f32, h: f32 },
    BeginPath { id: u32 },
    ClosePath { id: u32 },
    MoveTo { id: u32, x: f32, y: f32 },
    LineTo { id: u32, x: f32, y: f32 },
    QuadTo { id: u32, cx: f32, cy: f32, x: f32, y: f32 },
    BezierTo { id: u32, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32 },
    Rect { id: u32, x: f32, y: f32, w: f32, h: f32 },
    Arc { id: u32, x: f32, y: f32, r: f32, start: f32, end: f32, ccw: bool },
    Fill { id: u32 },
    Stroke { id: u32 },
    Clip { id: u32 },
    /// Source rect then destination rect: sx, sy, sw, sh, dx, dy, dw, dh.
    DrawCanvas { id: u32, src: u32, r: [f32; 8] },
    /// An image's premultiplied pixels (one crop cell's part for cropped images), shared with the image.
    DrawImage { id: u32, pix: std::sync::Arc<Pixmap>, blocks: Option<std::sync::Arc<BlockMap>>, r: [f32; 8] },
    /// The caller's straight RGBA8 bytes, copied (JS may change them right after the call).
    PutImageData { id: u32, data: Vec<u8>, w: u32, h: u32, dx: i32, dy: i32, dirty: [i32; 4] },
    Text { id: u32, text: String, x: f32, y: f32, max_width: f32, stroke: bool },
    /// End of a presented frame: copy canvas `id` for the present (drawing thread only).
    Snapshot { id: u32, seq: u64 },
}

/// A pattern's source: a canvas (read in queue order) or an image's shared pixels.
pub enum PatternSrc {
    Canvas(u32),
    Image(std::sync::Arc<Pixmap>),
}

impl Cmd {
    /// Draws one command. `fonts` is None on the drawing thread, which never gets text.
    fn apply(self, cs: &mut Canvases, fonts: Option<&mut crate::fonts::Fonts>) {
        macro_rules! cv {
            ($id:expr) => {
                match cs.get_mut($id) {
                    Some(c) => c,
                    None => return,
                }
            };
        }
        // A canvas known to be all transparent: clearing it is a no-op. An ImpactJS game clears every new map
        // chunk canvas before drawing its tiles (entering Rookie Harbor: 54 full clears, 48 ms on the TrimUI
        // Smart Pro). Most of that was the first touch of the new pages, which the tile draws now pay
        // instead: it saves one write pass, not the page faults.
        if let Some(id) = self.pixel_target() {
            if let Some(c) = cs.map.get_mut(&id) {
                if matches!(self, Cmd::ClearRect { .. }) {
                    if c.clear && *PREFAULT {
                        return;
                    }
                } else {
                    c.clear = false;
                }
            }
        }
        match self {
            Cmd::Create { id, w, h } => {
                cs.map.insert(id, Canvas2D::fresh(w, h));
            }
            Cmd::Free { id } => {
                cs.map.remove(&id);
            }
            // Setting canvas.width/height: new transparent pixmap, state reset (as in browsers).
            Cmd::Resize { id, w, h } => *cv!(id) = Canvas2D::fresh(w, h),
            Cmd::Save { id } => {
                let c = cv!(id);
                c.stack.push(c.state.clone());
            }
            Cmd::Restore { id } => {
                let c = cv!(id);
                if let Some(s) = c.stack.pop() {
                    c.state = s;
                }
            }
            Cmd::SetTransform { id, t } => cv!(id).state.transform = t,
            Cmd::Transform { id, t } => {
                let c = cv!(id);
                c.state.transform = c.state.transform.pre_concat(t);
            }
            Cmd::Translate { id, x, y } => {
                let c = cv!(id);
                c.state.transform = c.state.transform.pre_translate(x, y);
            }
            Cmd::Scale { id, x, y } => {
                let c = cv!(id);
                c.state.transform = c.state.transform.pre_scale(x, y);
            }
            Cmd::Rotate { id, rad } => {
                let c = cv!(id);
                c.state.transform = c.state.transform.pre_concat(Transform::from_rotate(rad.to_degrees()));
            }
            Cmd::SetAlpha { id, a } => cv!(id).state.alpha = a,
            Cmd::SetBlend { id, blend } => cv!(id).state.blend = blend,
            Cmd::SetStyle { id, stroke, style } => {
                let c = cv!(id);
                if stroke {
                    c.state.stroke = style;
                } else {
                    c.state.fill = style;
                }
            }
            Cmd::SetPattern { id, stroke, src, repeat } => {
                let pixmap = match src {
                    PatternSrc::Canvas(src) => match cs.get(src) {
                        Some(c) => std::sync::Arc::new(c.pixmap.clone()),
                        None => return,
                    },
                    PatternSrc::Image(p) => p,
                };
                let c = cv!(id);
                let style = Style::Pattern { pixmap, repeat };
                if stroke {
                    c.state.stroke = style;
                } else {
                    c.state.fill = style;
                }
            }
            Cmd::SetLine { id, width, cap, join, miter } => {
                let c = cv!(id);
                c.state.line_width = width;
                c.state.line_cap = cap;
                c.state.line_join = join;
                c.state.miter_limit = miter;
            }
            Cmd::SetFont { id, spec } => cv!(id).state.font = spec,
            Cmd::SetText { id, align, baseline } => {
                let c = cv!(id);
                c.state.text_align = align;
                c.state.text_baseline = baseline;
            }
            Cmd::SetSmoothing { id, on } => cv!(id).state.smoothing = on,
            Cmd::FillRect { id, x, y, w, h } => cv!(id).fill_rect(x, y, w, h),
            Cmd::StrokeRect { id, x, y, w, h } => {
                let c = cv!(id);
                let Some(rect) = Rect::from_xywh(x.min(x + w), y.min(y + h), w.abs(), h.abs()) else { return };
                let path = PathBuilder::from_rect(rect);
                let style = c.state.stroke.clone();
                c.stroke_path_with(&path, style);
            }
            Cmd::ClearRect { id, x, y, w, h } => cv!(id).clear_rect(x, y, w, h),
            Cmd::BeginPath { id } => {
                let c = cv!(id);
                c.path = PathBuilder::new();
                c.last = None;
            }
            Cmd::ClosePath { id } => cv!(id).path.close(),
            Cmd::MoveTo { id, x, y } => {
                let c = cv!(id);
                c.path_ts = c.state.transform;
                c.path.move_to(x, y);
                c.last = Some(Point::from_xy(x, y));
            }
            Cmd::LineTo { id, x, y } => {
                let c = cv!(id);
                c.path_ts = c.state.transform;
                if c.last.is_none() {
                    c.path.move_to(x, y);
                } else {
                    c.path.line_to(x, y);
                }
                c.last = Some(Point::from_xy(x, y));
            }
            Cmd::QuadTo { id, cx, cy, x, y } => {
                let c = cv!(id);
                c.path_ts = c.state.transform;
                if c.last.is_none() {
                    c.path.move_to(cx, cy);
                }
                c.path.quad_to(cx, cy, x, y);
                c.last = Some(Point::from_xy(x, y));
            }
            Cmd::BezierTo { id, c1x, c1y, c2x, c2y, x, y } => {
                let c = cv!(id);
                c.path_ts = c.state.transform;
                if c.last.is_none() {
                    c.path.move_to(c1x, c1y);
                }
                c.path.cubic_to(c1x, c1y, c2x, c2y, x, y);
                c.last = Some(Point::from_xy(x, y));
            }
            Cmd::Rect { id, x, y, w, h } => {
                let c = cv!(id);
                c.path_ts = c.state.transform;
                c.path.move_to(x, y);
                c.path.line_to(x + w, y);
                c.path.line_to(x + w, y + h);
                c.path.line_to(x, y + h);
                c.path.close();
                c.last = Some(Point::from_xy(x, y));
            }
            Cmd::Arc { id, x, y, r, start, end, ccw } => {
                let c = cv!(id);
                c.path_ts = c.state.transform;
                c.arc(x, y, r, start, end, ccw);
            }
            Cmd::Fill { id } => {
                let c = cv!(id);
                if let Some(path) = c.take_path() {
                    let style = c.state.fill.clone();
                    c.fill_path_with(&path, style);
                }
            }
            Cmd::Stroke { id } => {
                let c = cv!(id);
                if let Some(path) = c.take_path() {
                    let style = c.state.stroke.clone();
                    c.stroke_path_with(&path, style);
                }
            }
            // clip(): intersects the clip mask with the current path (in device space).
            Cmd::Clip { id } => {
                let c = cv!(id);
                let Some(path) = c.take_path() else { return };
                let mut mask = Mask::new(c.pixmap.width(), c.pixmap.height()).expect("mask");
                mask.fill_path(&path, FillRule::Winding, true, c.state.transform);
                if let Some(old) = &c.state.clip {
                    let od = old.data();
                    for (m, o) in mask.data_mut().iter_mut().zip(od.iter()) {
                        *m = ((*m as u32 * *o as u32 + 127) / 255) as u8;
                    }
                }
                c.state.clip = Some(std::sync::Arc::new(mask));
            }
            Cmd::DrawCanvas { id, src, r } => cs.draw_canvas(id, src, r),
            Cmd::DrawImage { id, pix, blocks, r: [sx, sy, sw, sh, dx, dy, dw, dh] } => {
                cv!(id).draw_pixmap(pix.as_ref().as_ref(), blocks.as_deref(), sx, sy, sw, sh, dx, dy, dw, dh)
            }
            Cmd::PutImageData { id, data, w, h, dx, dy, dirty } => cv!(id).put_image_data(&data, w, h, dx, dy, dirty),
            Cmd::Text { id, text, x, y, max_width, stroke } => {
                if let Some(fonts) = fonts {
                    cv!(id).draw_text(fonts, &text, x, y, max_width, stroke)
                }
            }
            Cmd::Snapshot { .. } => {}
        }
    }
}

impl Canvases {
    fn draw_canvas(&mut self, id: u32, src: u32, [sx, sy, sw, sh, dx, dy, dw, dh]: [f32; 8]) {
        if id == src {
            // Phaser 2's tile layers scroll with "copy" onto themselves, per layer and frame: move the rows.
            if *FAST_BLIT && self.get_mut(id).is_some_and(|c| c.shift_in_place(sx, sy, sw, sh, dx, dy, dw, dh)) {
                return;
            }
            // Drawing a canvas onto itself: go through a copy.
            let Some(copy) = self.get(src).map(|c| c.pixmap.clone()) else { return };
            let Some(c) = self.get_mut(id) else { return };
            c.draw_pixmap(copy.as_ref(), None, sx, sy, sw, sh, dx, dy, dw, dh);
            return;
        }
        // Another canvas: read it in place (a copy of the whole source per draw was a third of
        // an ImpactJS game's frame). get_mut on the map moves no entries, so the source stays where it is.
        // The source's block map is built here once and kept until the source is drawn to; only for draws
        // that read it (1:1 and whole-number zoom blits), not the fractional zoom of an ImpactJS game's camera.
        let uses_blocks = self.map.get(&id).is_some_and(|c| {
            let (st, t) = (&c.state, c.state.transform);
            *FAST_BLIT && st.clip.is_none() && sw == dw && sh == dh
                && (near_translate(&t).is_some() || (!st.smoothing && t.kx == 0.0 && t.ky == 0.0 && whole(t.sx).is_some_and(|k| (2..=4).contains(&k))))
        });
        let Some(sc) = self.map.get_mut(&src) else { return };
        if sc.blocks.is_none() && uses_blocks {
            sc.blocks = Some(Box::new(BlockMap::build(sc.pixmap.as_ref())));
        }
        let (srcp, blocks) = (&sc.pixmap as *const Pixmap, sc.blocks.as_deref().map(|b| b as *const BlockMap));
        let Some(c) = self.get_mut(id) else { return };
        let (srcp, blocks): (&Pixmap, Option<&BlockMap>) = unsafe { (&*srcp, blocks.map(|b| &*b)) };
        c.draw_pixmap(srcp.as_ref(), blocks, sx, sy, sw, sh, dx, dy, dw, dh);
    }
    /// A run of drawImage calls into one canvas with nothing between them (so one state for all), in order:
    /// stretches of 1:1 blits (plan_blit) drawn together by blit_batch, any other draw on its own between them.
    /// False: the target is gone (nothing drawn).
    fn draw_batch(&mut self, run: &[Cmd]) -> bool {
        let Some(id) = run.first().and_then(|c| c.batch_target()) else { return false };
        if !self.map.contains_key(&id) {
            return false;
        }
        // Canvas sources get the block map draw_canvas builds for a 1:1 blit.
        for c in run {
            if let Cmd::DrawCanvas { src, .. } = c {
                if let Some(sc) = self.map.get_mut(src) {
                    if sc.blocks.is_none() {
                        sc.blocks = Some(Box::new(BlockMap::build(sc.pixmap.as_ref())));
                    }
                }
            }
        }
        let mut jobs: Vec<BatchBlit> = Vec::with_capacity(run.len());
        let (mut px, mut blits) = (0f32, 0usize);
        for c in run {
            let Some(dst) = self.map.get(&id) else { return false };
            let (alpha, pw, ph) = (dst.state.alpha, dst.pixmap.width() as i32, dst.pixmap.height() as i32);
            // The source, read in place as draw_canvas does (get_mut on the map moves no entries; the target
            // is not among the sources: batch_target ends a run at a canvas drawn onto itself).
            let (src, blocks, r): (tiny_skia::PixmapRef, Option<&BlockMap>, [f32; 8]) = match c {
                Cmd::DrawImage { pix, blocks, r, .. } => (pix.as_ref().as_ref(), blocks.as_deref(), *r),
                Cmd::DrawCanvas { src, r, .. } => match self.map.get(src) {
                    Some(sc) => {
                        let (pm, bm) = (&sc.pixmap as *const Pixmap, sc.blocks.as_deref().map(|b| b as *const BlockMap));
                        unsafe { ((*pm).as_ref(), bm.map(|b| &*b), *r) }
                    }
                    None => continue, // as draw_canvas: an unknown source draws nothing
                },
                _ => continue,
            };
            let [sx, sy, sw, sh, dx, dy, dw, dh] = r;
            match dst.plan_blit(src.width() as i32, src.height() as i32, sx, sy, sw, sh, dx, dy, dw, dh) {
                Some(p) => {
                    if let Some(g) = BlitGeom::new(pw, ph, src.width() as i32, src.height() as i32, p.sx, p.sy, p.w, p.h, p.dx, p.dy, alpha, p.mode, p.flip) {
                        px += (g.n * (g.i1 - g.i0) as usize) as f32;
                        blits += 1;
                        // The source outlives the jobs: images are held by the run, canvases by the map.
                        jobs.push(BatchBlit { g, sdata: unsafe { std::slice::from_raw_parts(px32(src.data()).as_ptr(), src.data().len() / 4) }, blocks: blocks.map(|b| unsafe { &*(b as *const BlockMap) }) });
                    }
                }
                None => {
                    // Not a 1:1 blit: the blits so far, then this draw as draw_one would.
                    self.flush_jobs(id, &mut jobs);
                    match c {
                        Cmd::DrawImage { pix, blocks, r: [sx, sy, sw, sh, dx, dy, dw, dh], .. } => {
                            if let Some(t) = self.get_mut(id) {
                                t.draw_pixmap(pix.as_ref().as_ref(), blocks.as_deref(), *sx, *sy, *sw, *sh, *dx, *dy, *dw, *dh);
                            }
                        }
                        Cmd::DrawCanvas { src, r, .. } => self.draw_canvas(id, *src, *r),
                        _ => {}
                    }
                }
            }
        }
        stat(|| "image blit batch".to_string(), px);
        if *BATCH_DEBUG {
            eprintln!("[powerboat] c2d batch: {} draws into canvas {id}, {blits} as blits", run.len());
        }
        self.flush_jobs(id, &mut jobs);
        true
    }
    /// draw_batch's planned blits into canvas `id`, drawn and cleared.
    fn flush_jobs(&mut self, id: u32, jobs: &mut Vec<BatchBlit>) {
        if jobs.is_empty() {
            return;
        }
        if let Some(t) = self.get_mut(id) {
            blit_batch(&mut t.pixmap, jobs);
        }
        jobs.clear();
    }
}

impl Canvas2D {
    /// drawImage(self) with "copy", no scale, no clip, whole pixels, inside the canvas: the pixels move in
    /// place and everything else clears, as "copy" does. False: not this case, nothing done.
    fn shift_in_place(&mut self, sx: f32, sy: f32, sw: f32, sh: f32, dx: f32, dy: f32, dw: f32, dh: f32) -> bool {
        let st = &self.state;
        if st.blend != BlendMode::Source || st.clip.is_some() || st.alpha != 1.0 || sw != dw || sh != dh {
            return false;
        }
        let Some((false, tx, ty)) = near_translate(&st.transform) else { return false };
        let (Some(ox), Some(oy)) = (whole(tx + dx), whole(ty + dy)) else { return false };
        if [sx, sy, sw, sh].iter().any(|v| v.fract() != 0.0) {
            return false;
        }
        let (sx, sy, w, h) = (sx as i32, sy as i32, sw as i32, sh as i32);
        let (pw, ph) = (self.pixmap.width() as i32, self.pixmap.height() as i32);
        if w <= 0 || h <= 0 || sx < 0 || sy < 0 || ox < 0 || oy < 0 || sx + w > pw || sy + h > ph || ox + w > pw || oy + h > ph {
            return false;
        }
        stat(|| "image shift in place".to_string(), dw * dh);
        let stride = pw as usize * 4;
        let data = self.pixmap.data_mut();
        let row = |y: i32, x: i32| y as usize * stride + x as usize * 4;
        let n = w as usize * 4;
        // Rows in the order that doesn't overwrite what's still to move.
        if oy <= sy {
            for y in 0..h {
                data.copy_within(row(sy + y, sx)..row(sy + y, sx) + n, row(oy + y, ox));
            }
        } else {
            for y in (0..h).rev() {
                data.copy_within(row(sy + y, sx)..row(sy + y, sx) + n, row(oy + y, ox));
            }
        }
        for y in 0..ph {
            if y < oy || y >= oy + h {
                data[row(y, 0)..row(y, 0) + stride].fill(0);
            } else {
                data[row(y, 0)..row(y, ox)].fill(0);
                data[row(y, ox + w)..row(y, 0) + stride].fill(0);
            }
        }
        true
    }

    fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        let c = self;
        let Some(rect) = Rect::from_xywh(x.min(x + w), y.min(y + h), w.abs(), h.abs()) else { return };
        stat(
            || {
                let kind = match &c.state.fill { Style::Color(_) => "color", Style::Linear { .. } => "gradient", Style::Pattern { .. } => "pattern" };
                format!("fillRect {kind} {:?}{} dst {}x{}", c.state.blend, if c.state.transform.is_translate() { "" } else { " ctm" }, c.pixmap.width(), c.pixmap.height())
            },
            w * h * c.state.transform.sx * c.state.transform.sy,
        );
        // Solid color, plain source-over, whole pixels after the CTM (an ImpactJS game's screen fades and tints).
        let t = c.state.transform;
        if let (true, Style::Color(col), BlendMode::SourceOver, None, true) = (*FAST_BLIT, &c.state.fill, c.state.blend, &c.state.clip, t.kx == 0.0 && t.ky == 0.0) {
            // Axis-aligned CTM (translation, mirror, zoom): the rect's corners in device pixels.
            let (ax, bx) = (t.tx + t.sx * rect.left(), t.tx + t.sx * rect.right());
            let (ay, by) = (t.ty + t.sy * rect.top(), t.ty + t.sy * rect.bottom());
            if let (Some(x0), Some(x1), Some(y0), Some(y1)) = (whole(ax.min(bx)), whole(ax.max(bx)), whole(ay.min(by)), whole(ay.max(by))) {
                let mut col = *col;
                col.set_alpha(col.alpha() * c.state.alpha);
                fill_rect_over(&mut c.pixmap, x0, y0, x1, y1, col.premultiply().to_color_u8());
                return;
            }
        }
        let paint = c.paint(&c.state.fill.clone());
        let t = c.state.transform;
        let clip = c.state.clip.clone();
        c.pixmap.fill_rect(rect, &paint, t, clip.as_deref());
    }
    fn clear_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        let c = self;
        let Some(rect) = Rect::from_xywh(x.min(x + w), y.min(y + h), w.abs(), h.abs()) else { return };
        let mut paint = Paint::default();
        paint.shader = Shader::SolidColor(Color::TRANSPARENT);
        paint.blend_mode = BlendMode::Clear;
        paint.anti_alias = false;
        stat(|| "clearRect".into(), w * h * c.state.transform.sx * c.state.transform.sy);
        // Any axis-aligned CTM (translation, mirror, camera zoom) with corners on whole pixels; fractional
        // edges are antialiased (tiny-skia, as in browsers).
        let t = c.state.transform;
        if let (true, None, true) = (*FAST_BLIT, &c.state.clip, t.kx == 0.0 && t.ky == 0.0) {
            let (ax, bx) = (t.tx + t.sx * rect.left(), t.tx + t.sx * rect.right());
            let (ay, by) = (t.ty + t.sy * rect.top(), t.ty + t.sy * rect.bottom());
            if let (Some(x0), Some(x1), Some(y0), Some(y1)) = (whole(ax.min(bx)), whole(ax.max(bx)), whole(ay.min(by)), whole(ay.max(by))) {
                clear_rect_px(&mut c.pixmap, x0, y0, x1, y1);
                return;
            }
        }
        let clip = c.state.clip.clone();
        c.pixmap.fill_rect(rect, &paint, t, clip.as_deref());
    }
    fn arc(&mut self, x: f32, y: f32, r: f32, start: f32, end: f32, ccw: bool) {
        if r < 0.0 {
            return;
        }
        let (a0, a1) = (start, end);
        let mut sweep = a1 - a0;
        if ccw {
            if sweep >= 2.0 * PI || sweep > 0.0 {
                sweep = -(2.0 * PI - (sweep.rem_euclid(2.0 * PI)));
                if sweep == -2.0 * PI && a1 - a0 >= 2.0 * PI { sweep = -2.0 * PI; }
            }
            if a1 - a0 <= -2.0 * PI { sweep = -2.0 * PI; }
        } else {
            if sweep < 0.0 {
                sweep = sweep.rem_euclid(2.0 * PI);
            }
            if a1 - a0 >= 2.0 * PI { sweep = 2.0 * PI; }
        }
        let p0 = Point::from_xy(x + r * a0.cos(), y + r * a0.sin());
        if self.last.is_none() {
            self.path.move_to(p0.x, p0.y);
        } else {
            self.path.line_to(p0.x, p0.y);
        }
        let segs = ((sweep.abs() / (PI / 2.0)).ceil() as usize).max(1);
        let step = sweep / segs as f32;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        for i in 0..segs {
            let b0 = a0 + step * i as f32;
            let b1 = b0 + step;
            let (s0, c0) = b0.sin_cos();
            let (s1, c1) = b1.sin_cos();
            self.path.cubic_to(
                x + r * (c0 - k * s0), y + r * (s0 + k * c0),
                x + r * (c1 + k * s1), y + r * (s1 - k * c1),
                x + r * c1, y + r * s1,
            );
        }
        self.last = Some(Point::from_xy(x + r * (a0 + sweep).cos(), y + r * (a0 + sweep).sin()));
    }
    /// putImageData: straight RGBA8 (w x h) written at (dx, dy), replacing pixels; dirty rect optional.
    /// Straight RGBA rows into the premultiplied pixmap, the dirty rect clipped to the data and the canvas
    /// first. Rows go through put_row (packed pixels; was a bounds-checked loop dividing by 255 three
    /// times a pixel: 13.3 ms for 640x480 on the RG-34XXSP, quixjs 5.6).
    fn put_image_data(&mut self, data: &[u8], w: u32, h: u32, dx: i32, dy: i32, [dirty_x, dirty_y, dirty_w, dirty_h]: [i32; 4]) {
        let (cw, ch) = (self.pixmap.width() as i32, self.pixmap.height() as i32);
        let (w, h) = (w as i32, h as i32);
        // Source columns x0..x1 and rows y0..y1: inside the dirty rect, the data, and (shifted by dx, dy) the canvas.
        let x0 = dirty_x.max(0).max(-dx);
        let x1 = (dirty_x + dirty_w).min(w).min(cw - dx);
        let y0 = dirty_y.max(0).max(-dy);
        let y1 = (dirty_y + dirty_h).min(h).min(ch - dy);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let n = (x1 - x0) as usize;
        let pix = px32_mut(self.pixmap.data_mut());
        for sy in y0..y1 {
            let si = ((sy * w + x0) * 4) as usize;
            let Some(src) = data.get(si..si + n * 4) else { return };
            let di = ((sy + dy) * cw + dx + x0) as usize;
            put_row(src, &mut pix[di..di + n]);
        }
    }
    fn draw_text(&mut self, fonts: &mut crate::fonts::Fonts, text: &str, x: f32, y: f32, max_width: f32, stroke: bool) {
        let spec = self.state.font.clone();
        let (glyphs, width) = fonts.layout(&spec, text);
        if glyphs.is_empty() {
            return;
        }
        let (ascent, descent) = fonts.metrics(&spec);
        let st = self.state.clone();
        let mut x0 = match st.text_align {
            1 => x - width / 2.0,
            2 => x - width,
            _ => x,
        };
        let squeeze = if max_width > 0.0 && width > max_width { max_width / width } else { 1.0 };
        if squeeze < 1.0 {
            x0 = match st.text_align {
                1 => x - max_width / 2.0,
                2 => x - max_width,
                _ => x,
            };
        }
        let baseline = match st.text_baseline {
            1 => y + ascent,
            2 => y + (ascent - descent) / 2.0,
            3 => y - descent,
            _ => y,
        };
        let style = if stroke { st.stroke.clone() } else { st.fill.clone() };
        // A solid color drawn source-over without a clip under an axis-aligned CTM (MV, Construct and
        // h5bench text): cached glyph coverage (fonts::GlyphMask), blended. Glyphs move by quarter pixels
        // across, so text at other fractions differs from the outline path by up to one supersample column.
        // Anything else fills or strokes each outline. POWERBOAT_GLYPH_CACHE=0 turns the cache off (A/B).
        let ts = st.transform;
        let cached = match &style {
            Style::Color(c) if *GLYPH_CACHE && st.blend == BlendMode::SourceOver && st.clip.is_none() && ts.kx == 0.0 && ts.ky == 0.0 && ts.sx > 0.0 && ts.sy > 0.0 => {
                let mut c = *c;
                c.set_alpha(c.alpha() * st.alpha);
                Some(c.premultiply().to_color_u8())
            }
            _ => None,
        };
        for g in &glyphs {
            let scale = spec.size / fonts.face(g.face).units_per_em;
            if let Some(pc) = cached {
                let s = if stroke {
                    let mut s = self.stroke();
                    s.width = st.line_width / scale;
                    Some(s)
                } else {
                    None
                };
                let (ix, qx) = quarter(ts.sx * (x0 + g.x * squeeze) + ts.tx);
                let oy = ts.sy * baseline + ts.ty;
                let iy = oy.floor();
                let key = crate::fonts::MaskKey {
                    face: g.face,
                    glyph: g.glyph,
                    sx: (scale * squeeze * ts.sx).to_bits(),
                    sy: (scale * ts.sy).to_bits(),
                    qx,
                    fy: (oy - iy).to_bits(),
                    stroke: s.as_ref().map_or(0, |s| s.width.to_bits()),
                    join: s.as_ref().map_or(0, |s| s.line_join as u8),
                    miter: s.as_ref().map_or(0, |s| s.miter_limit.to_bits()),
                };
                if key.stroke != 0 || !stroke {
                    let outline = match fonts.glyph_mask(key, s.as_ref()) {
                        crate::fonts::MaskLookup::Ink(m) => {
                            blend_mask(&mut self.pixmap, m, ix, iy as i32, pc);
                            false
                        }
                        crate::fonts::MaskLookup::Empty => false,
                        crate::fonts::MaskLookup::Path => true,
                    };
                    if !outline {
                        continue;
                    }
                }
            }
            let Some(path) = fonts.face(g.face).glyph_path(g.glyph) else { continue };
            let t = st.transform.pre_concat(Transform::from_row(scale * squeeze, 0.0, 0.0, -scale, x0 + g.x * squeeze, baseline));
            let paint = self.paint(&style);
            let clip = self.state.clip.clone();
            if stroke {
                let mut s = self.stroke();
                // Stroke width is in canvas units; the glyph transform scales, so compensate.
                s.width = self.state.line_width / scale;
                self.pixmap.stroke_path(path, &paint, &s, t, clip.as_deref());
            } else {
                self.pixmap.fill_path(path, &paint, FillRule::Winding, t, clip.as_deref());
            }
        }
    }
}

/// Straight RGBA bytes to premultiplied packed pixels, rounding as (c * a + 127) / 255 did (both round to
/// nearest; 255 is odd, so there are no ties).
#[inline]
fn put_row(src: &[u8], dst: &mut [u32]) {
    for (d, s) in dst.iter_mut().zip(src.chunks_exact(4)) {
        let p = u32::from_le_bytes([s[0], s[1], s[2], s[3]]);
        let a = p >> 24;
        *d = match a {
            255 => p,
            0 => 0,
            _ => (scale_px(p, a) & 0x00ff_ffff) | (a << 24),
        };
    }
}

/// POWERBOAT_GLYPH_CACHE=0: every glyph filled from its outline, as before 2026-11-17.
static GLYPH_CACHE: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_GLYPH_CACHE").map_or(true, |v| v != "0"));

/// A position in pixels as a whole pixel and a quarter-pixel step (0..=3).
fn quarter(v: f32) -> (i32, u8) {
    let q = (v * 4.0).round() as i64;
    (q.div_euclid(4) as i32, q.rem_euclid(4) as u8)
}

#[inline]
fn div255(v: u32) -> u32 {
    (v + 128 + ((v + 128) >> 8)) >> 8
}

/// Source-over of a solid premultiplied color through a glyph's coverage, its origin at whole pixel (x, y).
fn blend_mask(dst: &mut Pixmap, m: &crate::fonts::GlyphMask, x: i32, y: i32, c: tiny_skia::PremultipliedColorU8) {
    let (pw, ph) = (dst.width() as i32, dst.height() as i32);
    let (ox, oy) = (x + m.left, y + m.top);
    let (x0, x1) = (ox.max(0), (ox + m.w as i32).min(pw));
    let (y0, y1) = (oy.max(0), (oy + m.h as i32).min(ph));
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let (r, g, b, a) = (c.red() as u32, c.green() as u32, c.blue() as u32, c.alpha() as u32);
    let stride = pw as usize * 4;
    let data = dst.data_mut();
    for yy in y0..y1 {
        let mrow = &m.data[(yy - oy) as usize * m.w..][..m.w];
        let drow = &mut data[yy as usize * stride..][..stride];
        for xx in x0..x1 {
            let cov = mrow[(xx - ox) as usize] as u32;
            if cov == 0 {
                continue;
            }
            let d = &mut drow[xx as usize * 4..xx as usize * 4 + 4];
            if cov == 255 && a == 255 {
                d.copy_from_slice(&[r as u8, g as u8, b as u8, 255]);
                continue;
            }
            let inv = 255 - div255(a * cov);
            d[0] = (div255(r * cov) + div255(d[0] as u32 * inv)).min(255) as u8;
            d[1] = (div255(g * cov) + div255(d[1] as u32 * inv)).min(255) as u8;
            d[2] = (div255(b * cov) + div255(d[2] as u32 * inv)).min(255) as u8;
            d[3] = (div255(a * cov) + div255(d[3] as u32 * inv)).min(255) as u8;
        }
    }
}

/// Records one command: drawn at once, or queued for the drawing thread when deferred.
fn record(state: &mut OpState, cmd: Cmd) {
    let app = state.borrow_mut::<App>();
    app.canvases.record(cmd, &mut app.fonts);
}

// ---- lifecycle --------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_create(state: &mut OpState, w: u32, h: u32) -> u32 {
    let _t = OpTimer::start();
    let id = state.borrow_mut::<App>().canvases.alloc_id();
    record(state, Cmd::Create { id, w, h });
    id
}
#[op2(fast)]
pub fn op_c2d_free(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Free { id });
}
#[op2(fast)]
pub fn op_c2d_resize(state: &mut OpState, id: u32, w: u32, h: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Resize { id, w, h });
}
#[op2(fast)]
pub fn op_c2d_bytes(state: &mut OpState) -> f64 {
    let _t = OpTimer::start();
    state.borrow::<App>().canvases.bytes() as f64
}

// ---- state ------------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_save(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Save { id });
}
#[op2(fast)]
pub fn op_c2d_restore(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Restore { id });
}
#[op2(fast)]
pub fn op_c2d_set_transform(state: &mut OpState, id: u32, a: f32, b: f32, cc: f32, d: f32, e: f32, f: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::SetTransform { id, t: Transform::from_row(a, b, cc, d, e, f) });
}
#[op2(fast)]
pub fn op_c2d_transform(state: &mut OpState, id: u32, a: f32, b: f32, cc: f32, d: f32, e: f32, f: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Transform { id, t: Transform::from_row(a, b, cc, d, e, f) });
}
#[op2(fast)]
pub fn op_c2d_translate(state: &mut OpState, id: u32, x: f32, y: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Translate { id, x, y });
}
#[op2(fast)]
pub fn op_c2d_scale(state: &mut OpState, id: u32, x: f32, y: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Scale { id, x, y });
}
#[op2(fast)]
pub fn op_c2d_rotate(state: &mut OpState, id: u32, rad: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Rotate { id, rad });
}
#[op2(fast)]
pub fn op_c2d_set_alpha(state: &mut OpState, id: u32, a: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::SetAlpha { id, a: a.clamp(0.0, 1.0) });
}
#[op2(fast)]
pub fn op_c2d_set_composite(state: &mut OpState, id: u32, #[string] mode: &str) {
    let _t = OpTimer::start();
    record(state, Cmd::SetBlend { id, blend: blend_mode(mode) });
}
/// Returns false if the colour string is not understood (the style is then left unchanged).
#[op2(fast)]
pub fn op_c2d_set_color(state: &mut OpState, id: u32, stroke: bool, #[string] color: &str) -> bool {
    let _t = OpTimer::start();
    let Some(col) = parse_color(color) else { return false };
    if !state.borrow::<App>().canvases.exists(id) {
        return false;
    }
    record(state, Cmd::SetStyle { id, stroke, style: Style::Color(col) });
    true
}
#[op2(fast)]
pub fn op_c2d_set_gradient(state: &mut OpState, id: u32, stroke: bool, gradient: u32) {
    let _t = OpTimer::start();
    let Some(style) = state.borrow::<App>().canvases.gradients.get(&gradient).cloned() else { return };
    record(state, Cmd::SetStyle { id, stroke, style });
}
#[op2(fast)]
pub fn op_c2d_set_pattern(state: &mut OpState, id: u32, stroke: bool, src_canvas: u32, src_image: u32, repeat: bool) {
    let _t = OpTimer::start();
    let src = if src_canvas != 0 {
        PatternSrc::Canvas(src_canvas)
    } else {
        match state.borrow::<App>().images.get(src_image).and_then(|i| i.full_pixmap()) {
            Some(p) => PatternSrc::Image(p),
            None => return,
        }
    };
    record(state, Cmd::SetPattern { id, stroke, src, repeat });
}
#[op2(fast)]
pub fn op_c2d_set_line(state: &mut OpState, id: u32, width: f32, cap: u32, join: u32, miter: f32) {
    let _t = OpTimer::start();
    let cap = match cap {
        1 => LineCap::Round,
        2 => LineCap::Square,
        _ => LineCap::Butt,
    };
    let join = match join {
        1 => LineJoin::Round,
        2 => LineJoin::Bevel,
        _ => LineJoin::Miter,
    };
    record(state, Cmd::SetLine { id, width: width.max(0.0), cap, join, miter: miter.max(1.0) });
}
#[op2(fast)]
pub fn op_c2d_set_font(state: &mut OpState, id: u32, #[string] font: &str) -> bool {
    let _t = OpTimer::start();
    let Some(spec) = FontSpec::parse(font) else { return false };
    if !state.borrow::<App>().canvases.exists(id) {
        return false;
    }
    record(state, Cmd::SetFont { id, spec });
    true
}
#[op2(fast)]
pub fn op_c2d_set_text(state: &mut OpState, id: u32, align: u32, baseline: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::SetText { id, align: align as u8, baseline: baseline as u8 });
}
#[op2(fast)]
pub fn op_c2d_set_smoothing(state: &mut OpState, id: u32, on: bool) {
    let _t = OpTimer::start();
    record(state, Cmd::SetSmoothing { id, on });
}

// ---- gradients --------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_create_linear_gradient(state: &mut OpState, x0: f32, y0: f32, x1: f32, y1: f32) -> u32 {
    let _t = OpTimer::start();
    let cs = &mut state.borrow_mut::<App>().canvases;
    let id = cs.alloc_id();
    cs.gradients.insert(id, Style::Linear { x0, y0, x1, y1, stops: Vec::new() });
    id
}
#[op2(fast)]
pub fn op_c2d_gradient_add_stop(state: &mut OpState, gradient: u32, offset: f32, #[string] color: &str) -> bool {
    let _t = OpTimer::start();
    let Some(col) = parse_color(color) else { return false };
    if let Some(Style::Linear { stops, .. }) = state.borrow_mut::<App>().canvases.gradients.get_mut(&gradient) {
        stops.push((offset.clamp(0.0, 1.0), col));
        stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }
    true
}
#[op2(fast)]
pub fn op_c2d_gradient_free(state: &mut OpState, gradient: u32) {
    let _t = OpTimer::start();
    state.borrow_mut::<App>().canvases.gradients.remove(&gradient);
}

// ---- rectangles -------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_fill_rect(state: &mut OpState, id: u32, x: f32, y: f32, w: f32, h: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::FillRect { id, x, y, w, h });
}
#[op2(fast)]
pub fn op_c2d_stroke_rect(state: &mut OpState, id: u32, x: f32, y: f32, w: f32, h: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::StrokeRect { id, x, y, w, h });
}
#[op2(fast)]
pub fn op_c2d_clear_rect(state: &mut OpState, id: u32, x: f32, y: f32, w: f32, h: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::ClearRect { id, x, y, w, h });
}

// ---- paths ------------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_begin_path(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::BeginPath { id });
}
#[op2(fast)]
pub fn op_c2d_close_path(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::ClosePath { id });
}
#[op2(fast)]
pub fn op_c2d_move_to(state: &mut OpState, id: u32, x: f32, y: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::MoveTo { id, x, y });
}
#[op2(fast)]
pub fn op_c2d_line_to(state: &mut OpState, id: u32, x: f32, y: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::LineTo { id, x, y });
}
#[op2(fast)]
pub fn op_c2d_quad_to(state: &mut OpState, id: u32, cx: f32, cy: f32, x: f32, y: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::QuadTo { id, cx, cy, x, y });
}
#[op2(fast)]
pub fn op_c2d_bezier_to(state: &mut OpState, id: u32, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::BezierTo { id, c1x, c1y, c2x, c2y, x, y });
}
#[op2(fast)]
pub fn op_c2d_rect(state: &mut OpState, id: u32, x: f32, y: f32, w: f32, h: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Rect { id, x, y, w, h });
}
#[op2(fast)]
pub fn op_c2d_arc(state: &mut OpState, id: u32, x: f32, y: f32, r: f32, start: f32, end: f32, ccw: bool) {
    let _t = OpTimer::start();
    record(state, Cmd::Arc { id, x, y, r, start, end, ccw });
}
#[op2(fast)]
pub fn op_c2d_fill(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Fill { id });
}
#[op2(fast)]
pub fn op_c2d_stroke(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Stroke { id });
}
#[op2(fast)]
pub fn op_c2d_clip(state: &mut OpState, id: u32) {
    let _t = OpTimer::start();
    record(state, Cmd::Clip { id });
}

// ---- images -----------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_draw_canvas(state: &mut OpState, id: u32, src: u32, sx: f32, sy: f32, sw: f32, sh: f32, dx: f32, dy: f32, dw: f32, dh: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::DrawCanvas { id, src, r: [sx, sy, sw, sh, dx, dy, dw, dh] });
}
#[op2(fast)]
pub fn op_c2d_draw_image(state: &mut OpState, id: u32, image: u32, sx: f32, sy: f32, sw: f32, sh: f32, dx: f32, dy: f32, dw: f32, dh: f32) {
    let _t = OpTimer::start();
    let app = state.borrow_mut::<App>();
    let Some(img) = app.images.get(image) else { return };
    let Some(pix) = img.pixmap() else { return };
    let (pix, blocks) = (pix.clone(), img.blocks().cloned());
    let Some(l) = &img.layout else {
        app.canvases.record(Cmd::DrawImage { id, pix, blocks, r: [sx, sy, sw, sh, dx, dy, dw, dh] }, &mut app.fonts);
        return;
    };
    // Cropped image (crop.rs): draw the part of each cell's crop inside the source rect, from the page.
    if sw <= 0.0 || sh <= 0.0 {
        return;
    }
    let (fx, fy) = (dw / sw, dh / sh);
    for cell in &l.cells {
        let [cx, cy, cw, ch] = cell.crop.map(|v| v as f32);
        if cw == 0.0 {
            continue;
        }
        let (x0, y0) = (sx.max(cx), sy.max(cy));
        let (x1, y1) = ((sx + sw).min(cx + cw), (sy + sh).min(cy + ch));
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let (px, py) = (cell.at[0] as f32 + (x0 - cx), cell.at[1] as f32 + (y0 - cy));
        let r = [px, py, x1 - x0, y1 - y0, dx + (x0 - sx) * fx, dy + (y0 - sy) * fy, (x1 - x0) * fx, (y1 - y0) * fy];
        app.canvases.record(Cmd::DrawImage { id, pix: pix.clone(), blocks: blocks.clone(), r }, &mut app.fonts);
    }
}
/// getImageData: straight RGBA8 of the rect, transparent outside the canvas.
#[op2(fast)]
pub fn op_c2d_get_image_data(state: &mut OpState, id: u32, x: i32, y: i32, w: u32, h: u32, #[buffer] out: &mut [u8]) {
    let _t = OpTimer::start();
    let app = state.borrow_mut::<App>();
    let cs = app.canvases.flushed();
    let Some(c) = cs.get(id) else { return };
    let (cw, ch) = (c.pixmap.width() as i32, c.pixmap.height() as i32);
    let data = c.pixmap.data();
    let (w, h) = (w as i32, h as i32);
    // Outside the canvas stays transparent; a rect inside it is written in full.
    if x < 0 || y < 0 || x + w > cw || y + h > ch {
        out.fill(0);
    }
    // The part of each row inside the canvas, a row at a time (demultiply per pixel cost its setup 307200 times
    // for a 640x480 read).
    let (c0, c1) = ((-x).max(0), w.min(cw - x));
    if c1 <= c0 {
        return;
    }
    for row in (-y).max(0)..h.min(ch - y) {
        let sy = y + row;
        let si = ((sy * cw + x + c0) * 4) as usize;
        let di = ((row * w + c0) * 4) as usize;
        let n = ((c1 - c0) * 4) as usize;
        if di + n > out.len() {
            return;
        }
        demultiply(&data[si..si + n], &mut out[di..di + n]);
    }
}
#[op2(fast)]
pub fn op_c2d_put_image_data(state: &mut OpState, id: u32, #[buffer] data: &[u8], w: u32, h: u32, dx: i32, dy: i32, dirty_x: i32, dirty_y: i32, dirty_w: i32, dirty_h: i32) {
    let _t = OpTimer::start();
    record(state, Cmd::PutImageData { id, data: data.to_vec(), w, h, dx, dy, dirty: [dirty_x, dirty_y, dirty_w, dirty_h] });
}

// ---- text -------------------------------------------------------------------------------------

#[op2(fast)]
pub fn op_c2d_measure_text(state: &mut OpState, id: u32, #[string] text: &str) -> f64 {
    let _t = OpTimer::start();
    let app = state.borrow_mut::<App>();
    let Some(f) = app.canvases.front.get(&id) else { return 0.0 };
    let (_, width) = app.fonts.layout(&f.font, text);
    width as f64
}
/// Bounding boxes for TextMetrics: ink left, right, ascent, descent, then the font's ascent, descent.
#[op2]
#[serde]
pub fn op_c2d_measure_text_box(state: &mut OpState, id: u32, #[string] text: &str) -> Vec<f32> {
    let app = state.borrow_mut::<App>();
    let Some(f) = app.canvases.front.get(&id) else { return vec![0.0; 6] };
    let ink = app.fonts.ink_box(&f.font, text);
    let (asc, desc) = app.fonts.metrics(&f.font);
    vec![ink[0], ink[1], ink[2], ink[3], asc, desc]
}
#[op2(fast)]
pub fn op_c2d_fill_text(state: &mut OpState, id: u32, #[string] text: &str, x: f32, y: f32, max_width: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Text { id, text: text.to_owned(), x, y, max_width, stroke: false });
}
#[op2(fast)]
pub fn op_c2d_stroke_text(state: &mut OpState, id: u32, #[string] text: &str, x: f32, y: f32, max_width: f32) {
    let _t = OpTimer::start();
    record(state, Cmd::Text { id, text: text.to_owned(), x, y, max_width, stroke: true });
}

// ---- fonts ------------------------------------------------------------------------------------

/// Registers a font file under a family name. Returns an error string, empty on success.
#[op2]
#[string]
pub fn op_font_load(state: &mut OpState, #[string] family: String, #[string] path: String, bold: bool, italic: bool) -> String {
    let data = match crate::casepath::retry(&path, |p| std::fs::read(p)) {
        Ok(d) => d,
        Err(e) => return format!("{path}: {e}"),
    };
    match state.borrow_mut::<App>().fonts.load(&family, data, bold, italic) {
        Ok(_) => String::new(),
        Err(e) => e,
    }
}
#[op2(fast)]
pub fn op_font_count(state: &mut OpState) -> u32 {
    if state.borrow::<App>().fonts.is_empty() { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// demultiply's reciprocal multiply gives the per-byte (c * 255 + a / 2) / a (capped at 255) it replaced,
    /// for every color byte and alpha, valid premultiplied pixels or not.
    #[test]
    fn demultiply_matches_per_byte_division() {
        let mut src = Vec::with_capacity(256 * 256 * 4);
        for a in 0..=255u8 {
            for c in 0..=255u8 {
                src.extend_from_slice(&[c, 255 - c, c / 3, a]);
            }
        }
        let mut out = vec![0u8; src.len()];
        demultiply(&src, &mut out);
        for (s, d) in src.chunks_exact(4).zip(out.chunks_exact(4)) {
            let a = s[3] as u32;
            let want: [u8; 4] = match a {
                0 => [0; 4],
                255 => [s[0], s[1], s[2], s[3]],
                _ => {
                    let f = |c: u8| ((c as u32 * 255 + a / 2) / a).min(255) as u8;
                    [f(s[0]), f(s[1]), f(s[2]), s[3]]
                }
            };
            assert_eq!(d, &want, "pixel {s:?}");
        }
    }

    /// lerp_px matches the per-byte (p * (256 - f) + q * f) >> 8 for packed pixels.
    #[test]
    fn lerp_px_matches_per_byte() {
        let px = [0u32, 0xffff_ffff, 0x80ff_4020, 0x7f10_2030, 0x0101_0101, 0xff00_ff00];
        for &p in &px {
            for &q in &px {
                for f in [0u32, 1, 77, 128, 200, 255, 256] {
                    let got = lerp_px(p, q, f).to_le_bytes();
                    let (pb, qb) = (p.to_le_bytes(), q.to_le_bytes());
                    for k in 0..4 {
                        assert_eq!(got[k] as u32, (pb[k] as u32 * (256 - f) + qb[k] as u32 * f) >> 8, "p {p:08x} q {q:08x} f {f}");
                    }
                }
            }
        }
    }

    /// put_row premultiplies exactly as the per-byte (c * a + 127) / 255 it replaced, for every color and alpha.
    #[test]
    fn put_row_matches_per_byte_premultiply() {
        let mut src = Vec::with_capacity(256 * 256 * 4);
        for a in 0..=255u8 {
            for c in 0..=255u8 {
                src.extend_from_slice(&[c, 255 - c, c / 2, a]);
            }
        }
        let mut dst = vec![0u32; 256 * 256];
        put_row(&src, &mut dst);
        for (i, s) in src.chunks_exact(4).enumerate() {
            let a = s[3] as u32;
            let want = [0, 1, 2].map(|k| ((s[k] as u32 * a + 127) / 255) as u8);
            let got = dst[i].to_le_bytes();
            assert_eq!(&got[..3], &want, "rgb for {s:?}");
            assert_eq!(got[3], s[3], "alpha for {s:?}");
        }
    }
}
