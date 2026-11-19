//! Decoded images, kept on the Rust side and referenced from JS by id (HTMLImageElement, later
//! canvas/video sources): texImage2D uploads them without copying through JS.

use std::borrow::Cow;
use std::cell::{OnceCell, Ref, RefCell};
use std::collections::HashMap;
use std::sync::Arc;

use deno_core::{op2, OpState};
use tiny_skia::{IntSize, Pixmap};

use crate::crop::{Hint, Layout};
use crate::ops::App;

/// Where an image's pixels can be decoded from again.
pub enum Source {
    None,
    Path(String),
    /// Compressed bytes (a decrypted .rpgmvp, a blob): a fraction of the decoded size.
    Bytes(Vec<u8>),
}

pub struct Img {
    pub w: u32,
    pub h: u32,
    /// Straight (non-premultiplied) RGBA8, as decoded. Dropped after the first GL upload when the
    /// image has a source to decode from again (the GPU holds a copy; MV rarely needs the pixels
    /// twice), so a game's decoded images do not sit in memory twice. POWERBOAT_KEEP_IMAGES=1 keeps them.
    rgba: RefCell<Option<Vec<u8>>>,
    source: Source,
    /// Premultiplied copy for Canvas 2D drawing, built on first use. Shared: a queued Canvas 2D
    /// command keeps the pixels alive after the image is dropped or released.
    pix: OnceCell<Option<Arc<Pixmap>>>,
    /// Block map of `pix` for source-over blits (canvas.rs), built on first use.
    blocks: OnceCell<Option<Arc<crate::canvas::BlockMap>>>,
    /// Last time the pixels were used (ms since start), for the idle sweep.
    last_use: std::cell::Cell<u64>,
    /// Per-cell crop (crop.rs): when set, `rgba` and `pix` hold the page, not the full image.
    pub layout: Option<Layout>,
    /// Decoded pixels kept for a moment after a GL upload (Images::after_upload).
    held: std::cell::Cell<bool>,
}

impl Img {
    pub fn new(w: u32, h: u32, rgba: Vec<u8>, source: Source, layout: Option<Layout>) -> Img {
        Img { w, h, rgba: RefCell::new(Some(rgba)), source, pix: OnceCell::new(), blocks: OnceCell::new(), last_use: std::cell::Cell::new(now_ms()), layout, held: Default::default() }
    }
    /// Size of the stored pixels: the page when cropped, else the image.
    pub fn stored_wh(&self) -> (u32, u32) {
        self.layout.as_ref().map(|l| (l.page_w, l.page_h)).unwrap_or((self.w, self.h))
    }
    /// Back to the full image (a texture use the page cannot serve, e.g. a TilingSprite).
    pub fn uncrop(&mut self) {
        let Some(l) = self.layout.take() else { return };
        let page = self.rgba.get_mut().take();
        *self.rgba.get_mut() = page.map(|p| l.expand(&p, self.w, self.h));
        self.pix = OnceCell::new();
        self.blocks = OnceCell::new();
    }
    /// Premultiplied full-size pixmap (Canvas 2D patterns), built from the page when cropped.
    pub fn full_pixmap(&self) -> Option<Arc<Pixmap>> {
        if self.layout.is_none() {
            return self.pixmap().cloned();
        }
        let page = self.rgba()?;
        let full = self.layout.as_ref()?.expand(&page, self.w, self.h);
        let pm = convert_rgba(&full, self.w as usize, self.h as usize, false, true).into_owned();
        Pixmap::from_vec(pm, IntSize::from_wh(self.w, self.h)?).map(Arc::new)
    }
    /// The straight RGBA8 pixels, decoded again from the source if they were released.
    pub fn rgba(&self) -> Option<Ref<'_, Vec<u8>>> {
        self.last_use.set(now_ms());
        if self.rgba.borrow().is_none() {
            let t0 = std::time::Instant::now();
            let again = match &self.source {
                Source::Path(p) => image::open(p),
                Source::Bytes(b) => image::load_from_memory(b),
                Source::None => return None,
            };
            let (_, w, h, err, rgba) = decoded(again);
            if !err.is_empty() || w != self.w || h != self.h {
                eprintln!("[powerboat] image re-decode failed: {err}");
                return None;
            }
            let rgba = match &self.layout {
                Some(l) => l.extract(&rgba, w),
                None => rgba,
            };
            *self.rgba.borrow_mut() = Some(rgba);
            REDECODES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            DECODE_WINDOW.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            DECODE_WINDOW_US.fetch_add(t0.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
        }
        Ref::filter_map(self.rgba.borrow(), |o| o.as_ref()).ok()
    }
    /// After a GL upload: let the decoded pixels go if they can be had again.
    pub fn release_cpu_copy(&self) {
        if !matches!(self.source, Source::None) && !*KEEP_IMAGES {
            *self.rgba.borrow_mut() = None;
        }
    }
    pub fn blocks(&self) -> Option<&Arc<crate::canvas::BlockMap>> {
        self.blocks.get_or_init(|| self.pixmap().map(|p| Arc::new(crate::canvas::BlockMap::build(p.as_ref().as_ref())))).as_ref()
    }
    pub fn pixmap(&self) -> Option<&Arc<Pixmap>> {
        self.pix
            .get_or_init(|| {
                let rgba = self.rgba()?;
                let (w, h) = self.stored_wh();
                let pm = convert_rgba(&rgba, w as usize, h as usize, false, true).into_owned();
                Pixmap::from_vec(pm, IntSize::from_wh(w, h)?).map(Arc::new)
            })
            .as_ref()
    }
    fn bytes(&self) -> usize {
        self.rgba.borrow().as_ref().map(|v| v.len()).unwrap_or(0)
            + self.pix.get().and_then(|p| p.as_ref()).map(|p| p.data().len()).unwrap_or(0)
            + match &self.source {
                Source::Bytes(b) => b.len(),
                _ => 0,
            }
    }
}

/// Images decoded a second time after their CPU copy was released (memory debug line).
pub static REDECODES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Main-thread decodes (lazy or after release) and their time since the last frame report.
pub static DECODE_WINDOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static DECODE_WINDOW_US: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// (decodes, ms) since the last call.
pub fn take_decode_window() -> (u64, f64) {
    let n = DECODE_WINDOW.swap(0, std::sync::atomic::Ordering::Relaxed);
    let us = DECODE_WINDOW_US.swap(0, std::sync::atomic::Ordering::Relaxed);
    (n, us as f64 / 1000.0)
}

fn now_ms() -> u64 {
    static START: std::sync::LazyLock<std::time::Instant> = std::sync::LazyLock::new(std::time::Instant::now);
    START.elapsed().as_millis() as u64
}

static KEEP_IMAGES: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_KEEP_IMAGES").map(|v| v == "1").unwrap_or(false));

#[derive(Default)]
pub struct Images {
    next: u32,
    map: HashMap<u32, Img>,
    /// Bytes of decoded pixels kept after their upload (after_upload), at most HOLD_BYTES.
    held_bytes: std::cell::Cell<usize>,
}

/// After a GL upload an image's decoded pixels go, but the last few (up to HOLD_BYTES, POWERBOAT_IMAGE_HOLD_MB,
/// default 8; 0 = release at once as before) stay until unused for HOLD_MS: an image uploaded again soon,
/// or drawn into a canvas right after (MV's Bitmap blt from a loaded picture), would otherwise be decoded
/// a second time. h5bench's repeated 1024 px upload: 49.0 -> 23.9 ms on the RG-34XXSP, all of it that decode.
static HOLD_BYTES: std::sync::LazyLock<usize> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_IMAGE_HOLD_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(8) << 20);
const HOLD_MS: u64 = 1000;

impl Images {
    pub fn insert(&mut self, img: Img) -> u32 {
        self.next += 1;
        self.map.insert(self.next, img);
        self.next
    }
    pub fn get(&self, id: u32) -> Option<&Img> {
        self.map.get(&id)
    }
    pub fn get_mut(&mut self, id: u32) -> Option<&mut Img> {
        self.map.get_mut(&id)
    }
    /// Pixels saved by per-cell cropping, over all images (memory debug line).
    pub fn cropped_saving(&self) -> usize {
        self.map.values().filter_map(|i| i.layout.as_ref().map(|l| (i.w * i.h - l.page_w * l.page_h) as usize * 4)).sum()
    }
    pub fn remove(&mut self, id: u32) -> Option<Img> {
        let img = self.map.remove(&id);
        if let Some(i) = img.as_ref().filter(|i| i.held.get()) {
            let n = i.rgba.borrow().as_ref().map_or(0, |v| v.len());
            self.held_bytes.set(self.held_bytes.get().saturating_sub(n));
        }
        img
    }
    /// After a GL upload of `id`: its decoded pixels are released, or held for HOLD_MS while there is room.
    pub fn after_upload(&self, id: u32) {
        let Some(img) = self.map.get(&id) else { return };
        if img.held.get() {
            return;
        }
        let n = img.rgba.borrow().as_ref().map_or(0, |v| v.len());
        if n > 0 && !matches!(img.source, Source::None) && !*KEEP_IMAGES && self.held_bytes.get() + n <= *HOLD_BYTES {
            img.held.set(true);
            self.held_bytes.set(self.held_bytes.get() + n);
        } else {
            img.release_cpu_copy();
        }
    }
    /// Releases held pixels unused for HOLD_MS (every few frames; nothing to do while none are held).
    pub fn sweep_held(&self) {
        if self.held_bytes.get() == 0 {
            return;
        }
        let now = now_ms();
        let mut held = 0;
        for img in self.map.values().filter(|i| i.held.get()) {
            if now.saturating_sub(img.last_use.get()) >= HOLD_MS {
                img.held.set(false);
                img.release_cpu_copy();
            } else {
                held += img.rgba.borrow().as_ref().map_or(0, |v| v.len());
            }
        }
        self.held_bytes.set(held);
    }
    pub fn bytes(&self) -> usize {
        self.map.values().map(|i| i.bytes()).sum()
    }
    /// Releases the decoded pixels of images not used for `idle_ms` (preloaded, never shown yet:
    /// OMORI preloads at boot). They decode again on use. Returns the bytes released.
    pub fn sweep(&self, idle_ms: u64) -> usize {
        let now = now_ms();
        let mut freed = 0;
        for img in self.map.values() {
            if now.saturating_sub(img.last_use.get()) >= idle_ms {
                let n = img.rgba.borrow().as_ref().map(|v| v.len()).unwrap_or(0);
                if n > 0 {
                    img.release_cpu_copy();
                    if img.rgba.borrow().is_none() {
                        freed += n;
                    }
                }
            }
        }
        freed
    }
}

/// WebGL's UNPACK_FLIP_Y_WEBGL / UNPACK_PREMULTIPLY_ALPHA_WEBGL on RGBA8 pixels.
/// RGBA pixels (straight alpha, top row first) as a PNG file: canvas.toBlob / toDataURL.
#[op2]
#[buffer]
pub fn op_png_encode(#[buffer] rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    let n = (w as usize) * (h as usize) * 4;
    if rgba.len() >= n && n > 0 {
        let enc = image::codecs::png::PngEncoder::new(&mut out);
        if let Err(e) = image::ImageEncoder::write_image(enc, &rgba[..n], w, h, image::ExtendedColorType::Rgba8) {
            eprintln!("[powerboat] png encode {w}x{h}: {e}");
            out.clear();
        }
    }
    out
}

pub fn convert_rgba(src: &[u8], w: usize, h: usize, flip_y: bool, premultiply: bool) -> Cow<'_, [u8]> {
    if !flip_y && !premultiply {
        return Cow::Borrowed(src);
    }
    let row = w * 4;
    let mut out = vec![0u8; row * h];
    let rows = |y0: usize, d: &mut [u8]| {
        for (i, d) in d.chunks_exact_mut(row).enumerate() {
            let y = y0 + i;
            let sy = if flip_y { h - 1 - y } else { y };
            let s = &src[sy * row..sy * row + row];
            if premultiply {
                for (sp, dp) in s.chunks_exact(4).zip(d.chunks_exact_mut(4)) {
                    // Sprite sheets are mostly opaque or empty pixels: no multiply for those
                    // (out starts zeroed, so empty ones need no write).
                    match sp[3] {
                        255 => dp.copy_from_slice(sp),
                        0 => {}
                        a => {
                            let a = a as u32;
                            dp[0] = ((sp[0] as u32 * a + 127) / 255) as u8;
                            dp[1] = ((sp[1] as u32 * a + 127) / 255) as u8;
                            dp[2] = ((sp[2] as u32 * a + 127) / 255) as u8;
                            dp[3] = a as u8;
                        }
                    }
                }
            } else {
                d.copy_from_slice(s);
            }
        }
    };
    // Big images (layout restarts upload many 2048x2048 sheets in one frame): rows split over 4
    // threads; the main thread waits anyway, the other cores are idle then.
    if w * h >= 512 * 1024 && h >= 4 {
        let per = h.div_ceil(4);
        std::thread::scope(|sc| {
            for (k, part) in out.chunks_mut(per * row).enumerate() {
                let rows = &rows;
                sc.spawn(move || rows(k * per, part));
            }
        });
    } else {
        rows(0, &mut out);
    }
    Cow::Owned(out)
}

fn decoded(result: image::ImageResult<image::DynamicImage>) -> (u32, u32, u32, String, Vec<u8>) {
    match result {
        Ok(img) => {
            let rgba = img.into_rgba8();
            let (w, h) = rgba.dimensions();
            (0, w, h, String::new(), rgba.into_raw())
        }
        Err(e) => (0, 0, 0, e.to_string(), Vec::new()),
    }
}

static NO_CROP: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_CROP").map(|v| v == "0").unwrap_or(false));

/// The stored pixels and layout for a decoded image: the page when cropping pays.
fn crop_planned(w: u32, h: u32, rgba: Vec<u8>, hint: Hint) -> (Vec<u8>, Option<Layout>) {
    if *NO_CROP {
        return (rgba, None);
    }
    match crate::crop::plan(&rgba, w, h, hint) {
        Some(l) => (l.extract(&rgba, w), Some(l)),
        None => (rgba, None),
    }
}

/// image::open with the case fallback. The path that worked comes back with the result: an image whose pixels
/// are released is read from it again later.
fn open_image(path: String) -> (image::ImageResult<image::DynamicImage>, String) {
    let first = image::open(&path);
    match &first {
        Err(image::ImageError::IoError(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            let real = crate::casepath::existing(path);
            (image::open(&real), real)
        }
        _ => (first, path),
    }
}

fn hint(cols: u32, rows: u32, cell_w: u32, cell_h: u32) -> Hint {
    Hint { cols, rows, cell_w, cell_h }
}

/// Decodes an image file. Returns [id, width, height, error]; id 0 = failed. The hint (cols, rows,
/// cell size; all 0 = none) lets the image be stored cropped (crop.rs).
#[op2]
#[serde]
pub fn op_image_load(state: &mut OpState, #[string] path: String, cols: u32, rows: u32, cell_w: u32, cell_h: u32) -> (u32, u32, u32, String) {
    let (opened, path) = open_image(path);
    let (_, w, h, err, rgba) = decoded(opened);
    if !err.is_empty() {
        return (0, 0, 0, format!("{path}: {err}"));
    }
    let (rgba, layout) = crop_planned(w, h, rgba, hint(cols, rows, cell_w, cell_h));
    let id = state.borrow_mut::<App>().images.insert(Img::new(w, h, rgba, Source::Path(path), layout));
    (id, w, h, String::new())
}

/// Decodes an in-memory image (PNG/JPEG bytes, e.g. MV's decrypted .rpgmvp).
#[op2]
#[serde]
pub fn op_image_decode(state: &mut OpState, #[buffer] data: &[u8], cols: u32, rows: u32, cell_w: u32, cell_h: u32) -> (u32, u32, u32, String) {
    let (_, w, h, err, rgba) = decoded(image::load_from_memory(data));
    if !err.is_empty() {
        return (0, 0, 0, err);
    }
    let (rgba, layout) = crop_planned(w, h, rgba, hint(cols, rows, cell_w, cell_h));
    let id = state.borrow_mut::<App>().images.insert(Img::new(w, h, rgba, Source::Bytes(data.to_vec()), layout));
    (id, w, h, String::new())
}

/// The crop layout of an image for JS (crop.rs Layout::to_js), empty when it is stored whole.
#[op2]
#[serde]
pub fn op_image_layout(state: &mut OpState, id: u32) -> Vec<u32> {
    state.borrow::<App>().images.get(id).and_then(|i| i.layout.as_ref()).map(|l| l.to_js()).unwrap_or_default()
}

/// Stores the image whole again (see Img::uncrop); its next texture upload is full size.
#[op2(fast)]
pub fn op_image_uncrop(state: &mut OpState, id: u32) {
    if let Some(i) = state.borrow_mut::<App>().images.get_mut(id) {
        i.uncrop();
    }
}

#[op2(fast)]
pub fn op_image_free(state: &mut OpState, id: u32) {
    state.borrow_mut::<App>().images.remove(id);
}

/// Total bytes of decoded images held (for memory reports).
#[op2(fast)]
pub fn op_image_bytes(state: &mut OpState) -> f64 {
    state.borrow::<App>().images.bytes() as f64
}

/// Decodes on tokio's blocking pool (other cores), then registers the image. Browsers decode
/// images off the main thread too; OMORI preloads hundreds at boot.
async fn decode_async(state: std::rc::Rc<std::cell::RefCell<OpState>>, hint: Hint, job: impl FnOnce() -> (image::ImageResult<image::DynamicImage>, Source) + Send + 'static) -> (u32, u32, u32, String) {
    let ((w, h, err, rgba, layout), source) = match tokio::task::spawn_blocking(move || {
        let (r, source) = job();
        let (_, w, h, err, rgba) = decoded(r);
        let (rgba, layout) = if err.is_empty() { crop_planned(w, h, rgba, hint) } else { (rgba, None) };
        ((w, h, err, rgba, layout), source)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => return (0, 0, 0, e.to_string()),
    };
    if !err.is_empty() {
        return (0, 0, 0, err);
    }
    let id = state.borrow_mut().borrow_mut::<App>().images.insert(Img::new(w, h, rgba, source, layout));
    (id, w, h, String::new())
}

/// Image files load lazily with POWERBOAT_LAZY_IMAGES=1 (set for Construct exports, main.rs): only the header is read
/// for the size, the pixels are decoded on first use (texture upload, canvas draw) and released
/// again after the upload. Construct 2 creates an Image for every picture in the project at boot
/// (The Next Penelope: 1,063 PNGs = 2 GB as RGBA) but uploads only the running layout's.
static LAZY_IMAGES: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_LAZY_IMAGES").map(|v| v == "1").unwrap_or(false));

impl Img {
    fn lazy(w: u32, h: u32, path: String) -> Img {
        Img { w, h, rgba: RefCell::new(None), source: Source::Path(path), pix: OnceCell::new(), blocks: OnceCell::new(), last_use: std::cell::Cell::new(now_ms()), layout: None, held: Default::default() }
    }
}

#[op2]
#[serde]
pub async fn op_image_load_async(state: std::rc::Rc<std::cell::RefCell<OpState>>, #[string] path: String, cols: u32, rows: u32, cell_w: u32, cell_h: u32) -> (u32, u32, u32, String) {
    if *LAZY_IMAGES {
        let p = path.clone();
        let dims = tokio::task::spawn_blocking(move || {
            let (reader, real) = crate::casepath::retry(&p, |q| Ok((image::ImageReader::open(q)?, q.to_owned()))).map_err(|e| e.to_string())?;
            let size = reader.with_guessed_format().map_err(|e| e.to_string())?.into_dimensions().map_err(|e| e.to_string())?;
            Ok::<_, String>((size, real))
        })
        .await;
        return match dims {
            Ok(Ok(((w, h), real))) => {
                let id = state.borrow_mut().borrow_mut::<App>().images.insert(Img::lazy(w, h, real));
                (id, w, h, String::new())
            }
            Ok(Err(e)) => (0, 0, 0, format!("{path}: {e}")),
            Err(e) => (0, 0, 0, format!("{path}: {e}")),
        };
    }
    let p = path.clone();
    let r = decode_async(state, hint(cols, rows, cell_w, cell_h), move || {
        let (opened, real) = open_image(p);
        (opened, Source::Path(real))
    })
    .await;
    if r.0 == 0 { (0, 0, 0, format!("{path}: {}", r.3)) } else { r }
}

#[op2]
#[serde]
pub async fn op_image_decode_async(state: std::rc::Rc<std::cell::RefCell<OpState>>, #[buffer(copy)] data: Vec<u8>, cols: u32, rows: u32, cell_w: u32, cell_h: u32) -> (u32, u32, u32, String) {
    decode_async(state, hint(cols, rows, cell_w, cell_h), move || (image::load_from_memory(&data), Source::Bytes(data))).await
}
