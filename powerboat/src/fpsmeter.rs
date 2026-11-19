//! On-screen frame counter (POWERBOAT_SHOW_FPS): frames shown in the last second and the slowest
//! swap-to-swap interval in it, in a screen corner. The text is drawn into a small texture once a
//! second; each frame costs one framebuffer blit. POWERBOAT_SHOW_FPS=1 or tr = top right, tl / bl / br.

use glow::HasContext;
use std::time::{Duration, Instant};

// 5x7 glyphs, one byte per row, bit 4 = left column.
fn glyph(c: char) -> [u8; 7] {
    match c {
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        _ => [0; 7],
    }
}

const COLS: usize = 10; // characters per line ("MAX 999 MS")
const LINES: usize = 2;
const TW: usize = COLS * 6 + 3; // 1 px margin + 6 px per character + 2 px
const TH: usize = LINES * 9 + 1;

pub struct FpsMeter {
    corner: (bool, bool), // (right, bottom)
    start: Instant,
    last: Option<Instant>,
    frames: u32,
    worst: Duration,
    text: [String; 2],
    dirty: bool,
    tex: Option<(glow::NativeTexture, glow::NativeFramebuffer)>,
}

impl FpsMeter {
    pub fn from_env() -> Option<FpsMeter> {
        let v = std::env::var("POWERBOAT_SHOW_FPS").ok()?;
        let corner = match v.trim() {
            "" | "0" => return None,
            "tl" => (false, false),
            "bl" => (false, true),
            "br" => (true, true),
            _ => (true, false),
        };
        Some(FpsMeter { corner, start: Instant::now(), last: None, frames: 0, worst: Duration::ZERO, text: ["-- FPS".into(), String::new()], dirty: true, tex: None })
    }

    /// Call right after each buffer swap.
    pub fn swapped(&mut self, now: Instant) {
        if let Some(l) = self.last {
            self.worst = self.worst.max(now - l);
        }
        self.last = Some(now);
        self.frames += 1;
        let span = now - self.start;
        if span >= Duration::from_secs(1) {
            let fps = self.frames as f64 / span.as_secs_f64();
            let ms = (self.worst.as_secs_f64() * 1000.0).round().min(999.0) as u32;
            self.text = [format!("{:.0} FPS", fps), format!("MAX {ms} MS")];
            self.dirty = true;
            self.start = now;
            self.frames = 0;
            self.worst = Duration::ZERO;
        }
    }

    fn render(&self) -> Vec<u8> {
        // Dark box, white text with a black shadow.
        let mut px = vec![0u8; TW * TH * 4];
        for p in px.chunks_exact_mut(4) {
            p.copy_from_slice(&[16, 16, 16, 255]);
        }
        let mut put = |x: usize, y: usize, c: [u8; 4]| {
            if x < TW && y < TH {
                px[(y * TW + x) * 4..][..4].copy_from_slice(&c);
            }
        };
        for (line, s) in self.text.iter().enumerate() {
            for (i, ch) in s.chars().take(COLS).enumerate() {
                let g = glyph(ch);
                for (row, bits) in g.iter().enumerate() {
                    for col in 0..5 {
                        if bits & (0x10 >> col) != 0 {
                            let (x, y) = (2 + i * 6 + col, 1 + line * 9 + row);
                            put(x + 1, y + 1, [0, 0, 0, 255]);
                            put(x, y, [255, 255, 255, 255]);
                        }
                    }
                }
            }
        }
        px
    }

    /// Blits the counter into the window (default framebuffer) just before the swap.
    pub fn draw(&mut self, gl: &glow::Context, win_w: u32, win_h: u32) {
        unsafe {
            let read = gl.get_parameter_framebuffer(glow::READ_FRAMEBUFFER_BINDING);
            let draw = gl.get_parameter_framebuffer(glow::DRAW_FRAMEBUFFER_BINDING);
            if self.tex.is_none() {
                let (Ok(tex), Ok(fbo)) = (gl.create_texture(), gl.create_framebuffer()) else { return };
                let bound = gl.get_parameter_texture(glow::TEXTURE_BINDING_2D);
                gl.bind_texture(glow::TEXTURE_2D, Some(tex));
                gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, TW as i32, TH as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
                gl.bind_texture(glow::TEXTURE_2D, bound);
                gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
                gl.framebuffer_texture_2d(glow::READ_FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
                self.tex = Some((tex, fbo));
            }
            let (tex, fbo) = self.tex.unwrap();
            if self.dirty {
                let px = self.render();
                let bound = gl.get_parameter_texture(glow::TEXTURE_BINDING_2D);
                gl.bind_texture(glow::TEXTURE_2D, Some(tex));
                gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
                gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, TW as i32, TH as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&px)));
                gl.bind_texture(glow::TEXTURE_2D, bound);
                self.dirty = false;
            }
            // About 1/50 of the screen height per text line, whole pixels.
            let s = ((win_h as usize + 225) / 450).max(1);
            let (w, h) = ((TW * s) as i32, (TH * s) as i32);
            let m = (4 * s) as i32;
            let x = if self.corner.0 { win_w as i32 - w - m } else { m };
            let y = if self.corner.1 { m } else { win_h as i32 - h - m }; // GL's y runs up
            let scissor = gl.is_enabled(glow::SCISSOR_TEST);
            if scissor {
                gl.disable(glow::SCISSOR_TEST);
            }
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(fbo));
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
            // Row 0 of the texture is the top line: flip into the bottom-up window.
            gl.blit_framebuffer(0, 0, TW as i32, TH as i32, x, y + h, x + w, y, glow::COLOR_BUFFER_BIT, glow::NEAREST);
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, read);
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, draw);
            if scissor {
                gl.enable(glow::SCISSOR_TEST);
            }
        }
    }
}
