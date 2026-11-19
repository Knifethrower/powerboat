//! Core ops: the Rust side the JS environment calls. Everything shares one `App` in the OpState.

use std::path::PathBuf;
use std::time::Instant;

use deno_core::{op2, OpState};
use glow::HasContext;
use serde::Serialize;

use crate::audio::AudioSys;
use crate::canvas::C2d;
use crate::casepath;
use crate::fonts::Fonts;
use crate::image::Images;

pub struct App {
    pub gl: glow::Context,
    pub events: Vec<Ev>,
    pub quit: bool,
    pub start: Instant,
    pub width: u32,
    pub height: u32,
    /// The game folder (MV's `www`): relative URLs resolve against it.
    pub root: PathBuf,
    pub images: Images,
    pub canvases: C2d,
    pub fonts: Fonts,
    pub unpack_flip_y: bool,
    pub unpack_premultiply: bool,
    /// WebGL context attribute of the game canvas; false = clear after each shown frame.
    pub preserve_drawing_buffer: bool,
    /// Per-frame GL counters for POWERBOAT_FRAME_DEBUG.
    pub stats: GlStats,
    /// The game canvas when it is not the window's size: rendered to this FBO, blitted at present.
    pub main_fbo: Option<crate::gl::MainFbo>,
    pub last_io_error: String,
    /// None when SDL could not open an audio device (the JS AudioContext then stays silent).
    pub audio: Option<AudioSys>,
    pub videos: crate::video::Videos,
    /// The game canvas when PIXI draws it with Canvas 2D (MV's canvas renderer): presented by
    /// uploading its pixmap each frame.
    pub main2d: Option<crate::gl::Main2d>,
    /// HTML form elements (Construct Button/TextBox/List) drawn over the game picture.
    pub ui: Option<crate::gl::UiOverlay>,
    /// The game's framebuffers as one real framebuffer per color texture (crate::gl::FboCache).
    pub fbos: crate::gl::FboCache,
    /// Linked shader programs kept as driver binaries across boots (crate::progcache).
    pub progcache: crate::progcache::ProgCache,
}

#[derive(Default)]
pub struct GlStats {
    pub draws: std::cell::Cell<u64>,
    pub fb_binds: std::cell::Cell<u64>,
    pub uploads: std::cell::Cell<u64>,
    pub upload_bytes: std::cell::Cell<u64>,
    pub clears: std::cell::Cell<u64>,
}

impl GlStats {
    pub fn add(c: &std::cell::Cell<u64>, n: u64) {
        c.set(c.get() + n);
    }
}

/// Input/window events, handed to JS once per frame (see `__powerboat_tick` in js/00_env.js).
#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Ev {
    #[serde(rename = "quit")]
    Quit,
    #[serde(rename = "keydown")]
    KeyDown { scancode: i32, key: String, repeat: bool, mods: u16 },
    #[serde(rename = "keyup")]
    KeyUp { scancode: i32, key: String, mods: u16 },
    #[serde(rename = "padadded")]
    PadAdded { which: i32, name: String },
    #[serde(rename = "padremoved")]
    PadRemoved { which: i32 },
    #[serde(rename = "padbutton")]
    PadButton { which: i32, button: String, down: bool },
    #[serde(rename = "padaxis")]
    PadAxis { which: i32, axis: String, value: i16 },
    /// Mouse position as a 0..1 fraction of the window; button 0 left, 1 middle, 2 right (DOM order).
    #[serde(rename = "mousemove")]
    MouseMove { fx: f64, fy: f64 },
    #[serde(rename = "mousebutton")]
    MouseButton { fx: f64, fy: f64, button: u8, down: bool },
    #[serde(rename = "wheel")]
    Wheel { dx: f64, dy: f64 },
    #[serde(rename = "resize")]
    Resize { width: u32, height: u32 },
    #[serde(rename = "focus")]
    Focus { focused: bool },
}

#[op2(fast)]
pub fn op_powerboat_now(state: &mut OpState) -> f64 {
    state.borrow::<App>().start.elapsed().as_secs_f64() * 1000.0
}

#[op2(fast)]
pub fn op_powerboat_log(#[string] line: &str, is_err: bool) {
    if is_err {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}

#[op2(fast)]
pub fn op_powerboat_quit(state: &mut OpState) {
    state.borrow_mut::<App>().quit = true;
}

#[op2(fast)]
pub fn op_powerboat_width(state: &mut OpState) -> u32 {
    state.borrow::<App>().width
}

#[op2(fast)]
pub fn op_powerboat_height(state: &mut OpState) -> u32 {
    state.borrow::<App>().height
}

#[op2]
#[string]
pub fn op_powerboat_root(state: &mut OpState) -> String {
    state.borrow::<App>().root.to_string_lossy().into_owned()
}

/// Reads a UTF-8 text file (scripts, JSON data). Returns [text, error]; error empty on success.
#[op2]
#[serde]
pub fn op_powerboat_read_text(#[string] path: String) -> (String, String) {
    match casepath::retry(&path, |p| std::fs::read_to_string(p)) {
        Ok(s) => (s, String::new()),
        Err(e) => (String::new(), format!("{path}: {e}")),
    }
}

/// Reads a whole file; empty + `op_powerboat_take_io_error` set on failure.
#[op2]
#[buffer]
pub fn op_powerboat_read_bytes(state: &mut OpState, #[string] path: String) -> Vec<u8> {
    match casepath::retry(&path, |p| std::fs::read(p)) {
        Ok(b) => b,
        Err(e) => {
            state.borrow_mut::<App>().last_io_error = format!("{} {path}: {e}", io_code(&e));
            Vec::new()
        }
    }
}

#[op2]
#[string]
pub fn op_powerboat_take_io_error(state: &mut OpState) -> String {
    std::mem::take(&mut state.borrow_mut::<App>().last_io_error)
}

#[op2]
#[string]
pub fn op_powerboat_write_text(#[string] path: String, #[string] text: String) -> String {
    let path = casepath::for_write(path);
    let r = std::fs::write(&path, text);
    casepath::forget(&path);
    match r {
        Ok(()) => String::new(),
        Err(e) => format!("{path}: {e}"),
    }
}

#[op2]
#[string]
pub fn op_powerboat_mkdirs(#[string] path: String) -> String {
    let path = casepath::for_write(path);
    let r = std::fs::create_dir_all(&path);
    casepath::forget(&path);
    match r {
        Ok(()) => String::new(),
        Err(e) => format!("{path}: {e}"),
    }
}

#[op2(fast)]
pub fn op_powerboat_exists(#[string] path: &str) -> bool {
    casepath::retry(path, |p| std::fs::metadata(p)).is_ok()
}

fn io_code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        AlreadyExists => "EEXIST",
        PermissionDenied => "EACCES",
        NotADirectory => "ENOTDIR",
        IsADirectory => "EISDIR",
        DirectoryNotEmpty => "ENOTEMPTY",
        _ => "EIO",
    }
}

/// [exists, is_dir, size, mtime_ms]
#[op2]
#[serde]
pub fn op_powerboat_stat(#[string] path: String) -> (bool, bool, f64, f64) {
    match casepath::retry(&path, |p| std::fs::metadata(p)) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            (true, m.is_dir(), m.len() as f64, mtime)
        }
        Err(_) => (false, false, 0.0, 0.0),
    }
}

/// [names (sorted), error]
#[op2]
#[serde]
pub fn op_powerboat_readdir(#[string] path: String) -> (Vec<String>, String) {
    match casepath::retry(&path, |p| std::fs::read_dir(p)) {
        Ok(rd) => {
            let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            (names, String::new())
        }
        Err(e) => (Vec::new(), format!("{} {path}: {e}", io_code(&e))),
    }
}

/// Writes (or appends) bytes, creating parent folders. Returns an error string, empty on success.
#[op2]
#[string]
pub fn op_powerboat_write_bytes(#[string] path: String, #[buffer] data: &[u8], append: bool) -> String {
    use std::io::Write;
    let path = casepath::for_write(path);
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let r = if append {
        std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(data))
    } else {
        // Write to a temp file and rename: a kill mid-save must not leave half a save file.
        let tmp = format!("{path}.powerboat-tmp");
        std::fs::write(&tmp, data).and_then(|_| std::fs::rename(&tmp, &path))
    };
    casepath::forget(&path);
    match r {
        Ok(()) => String::new(),
        Err(e) => format!("{} {path}: {e}", io_code(&e)),
    }
}

#[op2]
#[string]
pub fn op_powerboat_remove(#[string] path: String, recursive: bool) -> String {
    let path = casepath::existing(path);
    let p = std::path::Path::new(&path);
    let r = match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => {
            if recursive {
                std::fs::remove_dir_all(p)
            } else {
                std::fs::remove_dir(p)
            }
        }
        Ok(_) => std::fs::remove_file(p),
        Err(e) => Err(e),
    };
    casepath::forget(&path);
    match r {
        Ok(()) => String::new(),
        Err(e) => format!("{} {path}: {e}", io_code(&e)),
    }
}

#[op2]
#[string]
pub fn op_powerboat_rename(#[string] from: String, #[string] to: String) -> String {
    let from = casepath::existing(from);
    let to = casepath::for_write(to);
    let r = std::fs::rename(&from, &to);
    casepath::forget(&from);
    casepath::forget(&to);
    match r {
        Ok(()) => String::new(),
        Err(e) => format!("{} {from}: {e}", io_code(&e)),
    }
}

/// An environment variable, empty if unset (runtime switches for JS).
#[op2]
#[string]
pub fn op_powerboat_env(#[string] name: String) -> String {
    std::env::var(&name).unwrap_or_default()
}

/// UTF-8 JSON text for JSON.parse with every character above U+00FF written as a \uXXXX escape (characters
/// beyond U+FFFF as a surrogate pair), or None when there is none (decode it as usual). One such character makes
/// V8 hold the whole text as a two-byte string and parse it with the slower two-byte parser: Moonstone Island's
/// 37 MB data.json has 17 (curly quotes), so it took 74 MB during the parse. Characters above U+007F can only
/// appear inside JSON strings, where an escape stands for the same character: the parsed value is the same.
pub fn json_one_byte(bytes: &[u8]) -> Option<String> {
    // A UTF-8 byte-order mark is not JSON. core.decode drops it, so this path must too: Construct 2 exports' data.js
    // starts with one, and escaped it made JSON.parse fail (Hypnospace Outlaw and Topzerah stopped at boot).
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    // UTF-8 lead bytes of code points >= U+0100 are 0xC4..0xF4. Only worth it when such characters are rare: a
    // text full of them (translated dialogue: 54,000 in 0.6 MB) gets bigger and parses slower escaped.
    let wide = bytes.iter().filter(|&&b| (0xC4..=0xF4).contains(&b)).count();
    if wide == 0 || wide > bytes.len() / 1000 {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len() + 64);
    for ch in text.chars() {
        let c = ch as u32;
        if c <= 0xFF {
            out.push(ch);
        } else if c <= 0xFFFF {
            out.push_str(&format!("\\u{c:04x}"));
        } else {
            let v = c - 0x10000;
            out.push_str(&format!("\\u{:04x}\\u{:04x}", 0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF)));
        }
    }
    Some(out)
}

#[op2]
#[string]
pub fn op_json_one_byte(#[buffer] bytes: &[u8]) -> Option<String> {
    json_one_byte(bytes)
}

/// data.json without its animation frames (src/c3frames.rs), or None when it does not have the expected shape or
/// `path` is not the file these bytes came from (the frames are read back from there).
#[op2]
#[buffer]
pub fn op_c3_strip_frames(#[string] path: String, #[buffer] bytes: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut head = vec![0u8; bytes.len().min(4096)];
    let mut f = std::fs::File::open(&path).ok()?;
    if f.metadata().ok()?.len() != bytes.len() as u64 || f.read_exact(&mut head).is_err() || head != bytes[..head.len()] {
        return None;
    }
    let s = crate::c3frames::strip(bytes)?;
    println!(
        "[powerboat] c3 lazy frames: {} frames in {} animations stay in {path}; project text {} -> {} KB",
        s.frames,
        s.animations,
        bytes.len() / 1024,
        s.text.len() / 1024
    );
    Some(s.text)
}

/// `len` bytes of a file from `off` as text; empty on failure. The file stays open between calls to the same path:
/// a game reads many short ranges of one file.
#[op2]
#[string]
pub fn op_powerboat_read_range(#[string] path: String, off: u32, len: u32) -> String {
    use std::cell::RefCell;
    use std::io::{Read, Seek, SeekFrom};
    thread_local! { static OPEN: RefCell<Option<(String, std::fs::File)>> = const { RefCell::new(None) }; }
    OPEN.with(|o| {
        let mut o = o.borrow_mut();
        if o.as_ref().is_none_or(|x| x.0 != path) {
            *o = std::fs::File::open(&path).ok().map(|f| (path.clone(), f));
        }
        let Some((_, f)) = o.as_mut() else { return String::new() };
        let mut buf = vec![0u8; len as usize];
        if f.seek(SeekFrom::Start(off as u64)).is_err() || f.read_exact(&mut buf).is_err() {
            return String::new();
        }
        String::from_utf8(buf).unwrap_or_default()
    })
}

#[op2]
#[serde]
pub fn op_powerboat_poll_events(state: &mut OpState) -> Vec<Ev> {
    std::mem::take(&mut state.borrow_mut::<App>().events)
}

// --- the WebGL clear path (M0); the rest of WebGL lives in gl.rs -----------------------------------

#[op2(fast)]
pub fn op_gl_clear_color(state: &mut OpState, r: f32, g: f32, b: f32, a: f32) {
    unsafe { state.borrow::<App>().gl.clear_color(r, g, b, a) }
}

#[op2(fast)]
pub fn op_gl_clear(state: &mut OpState, mask: u32) {
    let _t = crate::gl::GlTimer::start("op_gl_clear");
    crate::gl::mark_drawn();
    crate::gl::before_draw(state.borrow::<App>());
    GlStats::add(&state.borrow::<App>().stats.clears, 1);
    unsafe { state.borrow::<App>().gl.clear(mask) }
}

#[op2(fast)]
pub fn op_gl_viewport(state: &mut OpState, x: i32, y: i32, w: i32, h: i32) {
    let _t = crate::gl::GlTimer::start("op_gl_viewport");
    unsafe { state.borrow::<App>().gl.viewport(x, y, w, h) }
}

#[op2]
#[string]
pub fn op_gl_get_string(state: &mut OpState, name: u32) -> String {
    unsafe { state.borrow::<App>().gl.get_parameter_string(name) }
}

#[op2(fast)]
pub fn op_gl_get_error(state: &mut OpState) -> u32 {
    unsafe { state.borrow::<App>().gl.get_error() }
}

#[cfg(test)]
mod tests {
    use super::json_one_byte;

    /// A JSON object long enough for one wide character to count as rare.
    fn doc(prefix: &str, wide: &str) -> Vec<u8> {
        format!("{prefix}{{\"a\":\"{}{wide}\"}}", "x".repeat(2000)).into_bytes()
    }

    #[test]
    fn wide_characters_are_escaped() {
        let out = json_one_byte(&doc("", "\u{201C}")).unwrap();
        assert!(out.starts_with("{\"a\":\"xx"));
        assert!(out.ends_with("\\u201c\"}"));
        let out = json_one_byte(&doc("", "\u{1F600}")).unwrap();
        assert!(out.ends_with("\\ud83d\\ude00\"}"));
    }

    #[test]
    fn byte_order_mark_is_dropped_not_escaped() {
        let out = json_one_byte(&doc("\u{FEFF}", "\u{201C}")).unwrap();
        assert!(out.starts_with('{'), "starts with {:?}", &out[..8]);
        assert_eq!(out, json_one_byte(&doc("", "\u{201C}")).unwrap());
    }

    #[test]
    fn byte_order_mark_alone_needs_no_escaped_text() {
        assert_eq!(json_one_byte(&doc("\u{FEFF}", "")), None);
    }

    #[test]
    fn text_full_of_wide_characters_is_left_alone() {
        assert_eq!(json_one_byte("\u{201C}".repeat(100).as_bytes()), None);
    }
}
