//! powerboat: a browser-free RPG Maker MV runtime. V8 through deno_core, an SDL2 window with a
//! GLES context, and native implementations of the web APIs MV uses (see SCOPE.md).
//!
//! Rust owns the frame loop: pump SDL events -> call `__powerboat_tick(now)` in JS -> poll the deno
//! event loop once (microtasks, async ops) -> swap. The JS environment (js/*.js) is embedded with
//! include_str! and executed before the game's scripts: deno_core's own `js = [...]` extension
//! files are read from disk at run time (they assume a startup snapshot), which is no use on a
//! handheld.

mod audio;
mod canvas;
mod casepath;
mod fonts;
mod gl;
mod crop;
mod fpsmeter;
mod upload;
mod present;
mod image;
mod mem;
mod ops;
mod c3frames;
mod progcache;
mod opus;
mod hwdec;
mod transcode;
mod video;
mod vpx;
mod glthread;
mod yuvgl;

use std::path::PathBuf;
use std::task::Poll;
use std::time::{Duration, Instant};

use deno_core::{extension, v8, JsRuntime, RuntimeOptions};
use sdl2::controller::GameController;
use sdl2::event::{Event, WindowEvent};
use sdl2::mouse::MouseButton;
use sdl2::video::GLProfile;

use ops::{App, Ev};

/// The JS environment, in load order.
const ENV_JS: &[(&str, &str)] = &[
    ("powerboat:00_env.js", include_str!("../js/00_env.js")),
    ("powerboat:10_webgl.js", include_str!("../js/10_webgl.js")),
    ("powerboat:20_dom.js", include_str!("../js/20_dom.js")),
    ("powerboat:30_canvas2d.js", include_str!("../js/30_canvas2d.js")),
    ("powerboat:40_web.js", include_str!("../js/40_web.js")),
    ("powerboat:41_crypto.js", include_str!("../js/41_crypto.js")),
    ("powerboat:50_audio.js", include_str!("../js/50_audio.js")),
    ("powerboat:60_node.js", include_str!("../js/60_node.js")),
    ("powerboat:70_video.js", include_str!("../js/70_video.js")),
    ("powerboat:79_webpage.js", include_str!("../js/79_webpage.js")),
    ("powerboat:80_construct.js", include_str!("../js/80_construct.js")),
    ("powerboat:81_storage.js", include_str!("../js/81_storage.js")),
    ("powerboat:82_forms.js", include_str!("../js/82_forms.js")),
    ("powerboat:83_phaser.js", include_str!("../js/83_phaser.js")),
    ("powerboat:84_rmmz.js", include_str!("../js/84_rmmz.js")),
    ("powerboat:85_html.js", include_str!("../js/85_html.js")),
    ("powerboat:86_layout.js", include_str!("../js/86_layout.js")),
    ("powerboat:86g_glctx.js", include_str!("../js/86g_glctx.js")),
    ("powerboat:86c_cursors.js", include_str!("../js/86c_cursors.js")),
    ("powerboat:87_paint.js", include_str!("../js/87_paint.js")),
    ("powerboat:88_media.js", include_str!("../js/88_media.js")),
];

extension!(
    powerboat,
    ops = [
        ops::op_powerboat_now,
        ops::op_powerboat_log,
        ops::op_powerboat_quit,
        ops::op_powerboat_width,
        ops::op_powerboat_height,
        ops::op_powerboat_root,
        ops::op_powerboat_read_text,
        ops::op_powerboat_read_bytes,
        ops::op_powerboat_take_io_error,
        ops::op_powerboat_write_text,
        ops::op_powerboat_mkdirs,
        ops::op_powerboat_exists,
        ops::op_powerboat_stat,
        ops::op_powerboat_readdir,
        ops::op_powerboat_write_bytes,
        ops::op_powerboat_remove,
        ops::op_powerboat_rename,
        ops::op_powerboat_env,
        ops::op_powerboat_random_bytes,
        ops::op_json_one_byte,
        ops::op_c3_strip_frames,
        ops::op_powerboat_read_range,
        ops::op_powerboat_poll_events,
        mem::op_powerboat_heap_stats,
        mem::op_powerboat_rss,
        mem::op_powerboat_bytes,
        mem::op_powerboat_rusage,
        image::op_image_load,
        image::op_png_encode,
        image::op_image_decode,
        image::op_image_load_async,
        image::op_image_decode_async,
        image::op_image_free,
        image::op_image_bytes,
        image::op_image_layout,
        image::op_image_uncrop,
        ops::op_gl_clear_color,
        ops::op_gl_clear,
        ops::op_gl_viewport,
        ops::op_gl_get_string,
        ops::op_gl_get_error,
        gl::op_gl_create_buffer,
        gl::op_gl_delete_buffer,
        gl::op_gl_bind_buffer,
        gl::op_gl_buffer_data_size,
        gl::op_gl_buffer_data,
        gl::op_gl_buffer_sub_data,
        gl::op_gl_get_buffer_parameter,
        gl::op_gl_create_shader,
        gl::op_gl_delete_shader,
        gl::op_gl_shader_source,
        gl::op_gl_compile_shader,
        gl::op_gl_get_shader_compile_status,
        gl::op_gl_get_shader_info_log,
        gl::op_gl_create_program,
        gl::op_gl_delete_program,
        gl::op_gl_attach_shader,
        gl::op_gl_detach_shader,
        gl::op_gl_link_program,
        gl::op_gl_validate_program,
        gl::op_gl_use_program,
        gl::op_gl_get_program_parameter,
        gl::op_gl_get_program_info_log,
        gl::op_gl_bind_attrib_location,
        gl::op_gl_get_attrib_location,
        gl::op_gl_get_uniform_location,
        gl::op_gl_get_active_uniform,
        gl::op_gl_get_active_attrib,
        gl::op_gl_get_shader_precision_format,
        gl::op_gl_uniform1f,
        gl::op_gl_uniform2f,
        gl::op_gl_uniform3f,
        gl::op_gl_uniform4f,
        gl::op_gl_uniform1i,
        gl::op_gl_uniform2i,
        gl::op_gl_uniform3i,
        gl::op_gl_uniform4i,
        gl::op_gl_uniform1fv,
        gl::op_gl_uniform2fv,
        gl::op_gl_uniform3fv,
        gl::op_gl_uniform4fv,
        gl::op_gl_uniform1iv,
        gl::op_gl_uniform2iv,
        gl::op_gl_uniform3iv,
        gl::op_gl_uniform4iv,
        gl::op_gl_uniform_matrix2fv,
        gl::op_gl_uniform_matrix3fv,
        gl::op_gl_uniform_matrix4fv,
        gl::op_gl_vertex_attrib_pointer,
        gl::op_gl_enable_vertex_attrib_array,
        gl::op_gl_disable_vertex_attrib_array,
        gl::op_gl_vertex_attrib4f,
        gl::op_gl_draw_arrays,
        gl::op_gl_draw_elements,
        gl::op_gl_vertex_attrib_divisor,
        gl::op_gl_draw_arrays_instanced,
        gl::op_gl_draw_elements_instanced,
        gl::op_gl_create_vertex_array,
        gl::op_gl_bind_vertex_array,
        gl::op_gl_delete_vertex_array,
        gl::op_gl_create_texture,
        gl::op_gl_delete_texture,
        gl::op_gl_bind_texture,
        gl::op_gl_active_texture,
        gl::op_gl_tex_parameteri,
        gl::op_gl_tex_parameterf,
        gl::op_gl_get_tex_parameter,
        gl::op_gl_generate_mipmap,
        gl::op_gl_pixel_storei,
        gl::op_gl_tex_image_2d_null,
        gl::op_gl_tex_image_2d_data,
        gl::op_gl_tex_image_2d_image,
        gl::op_gl_tex_image_2d_canvas,
        gl::op_gl_tex_sub_image_2d_canvas,
        gl::op_gl_tex_sub_image_2d_data,
        gl::op_gl_tex_sub_image_2d_image,
        gl::op_gl_copy_tex_sub_image_2d,
        gl::op_gl_copy_tex_image_2d,
        gl::op_gl_create_framebuffer,
        gl::op_gl_delete_framebuffer,
        gl::op_gl_bind_framebuffer,
        gl::op_gl_framebuffer_texture_2d,
        gl::op_gl_framebuffer_renderbuffer,
        gl::op_gl_check_framebuffer_status,
        gl::op_gl_get_framebuffer_attachment_parameter,
        gl::op_gl_create_renderbuffer,
        gl::op_gl_delete_renderbuffer,
        gl::op_gl_bind_renderbuffer,
        gl::op_gl_renderbuffer_storage,
        gl::op_gl_get_renderbuffer_parameter,
        gl::op_gl_enable,
        gl::op_gl_disable,
        gl::op_gl_is_enabled,
        gl::op_gl_blend_func,
        gl::op_gl_blend_func_separate,
        gl::op_gl_blend_equation,
        gl::op_gl_blend_equation_separate,
        gl::op_gl_blend_color,
        gl::op_gl_color_mask,
        gl::op_gl_depth_mask,
        gl::op_gl_depth_func,
        gl::op_gl_depth_range,
        gl::op_gl_clear_depth,
        gl::op_gl_clear_stencil,
        gl::op_gl_cull_face,
        gl::op_gl_front_face,
        gl::op_gl_scissor,
        gl::op_gl_line_width,
        gl::op_gl_polygon_offset,
        gl::op_gl_stencil_func,
        gl::op_gl_stencil_func_separate,
        gl::op_gl_stencil_op,
        gl::op_gl_stencil_op_separate,
        gl::op_gl_stencil_mask,
        gl::op_gl_stencil_mask_separate,
        gl::op_gl_sample_coverage,
        gl::op_gl_hint,
        gl::op_gl_flush,
        gl::op_gl_finish,
        gl::op_gl_get_integer,
        gl::op_gl_get_float,
        gl::op_gl_get_bool,
        gl::op_gl_get_integer_n,
        gl::op_gl_get_float_n,
        gl::op_gl_read_pixels,
        gl::op_gl_set_main_size,
        gl::op_gl_set_preserve_drawing_buffer,
        gl::op_c2d_set_main,
        gl::op_ui_overlay,
        gl::op_c2d_present_upload,
        gl::op_c2d_present_page,
        canvas::op_c2d_create,
        canvas::op_c2d_kick,
        canvas::op_c2d_free,
        canvas::op_c2d_resize,
        canvas::op_c2d_bytes,
        canvas::op_c2d_save,
        canvas::op_c2d_restore,
        canvas::op_c2d_set_transform,
        canvas::op_c2d_transform,
        canvas::op_c2d_translate,
        canvas::op_c2d_scale,
        canvas::op_c2d_rotate,
        canvas::op_c2d_set_alpha,
        canvas::op_c2d_set_composite,
        canvas::op_c2d_set_color,
        canvas::op_c2d_set_gradient,
        canvas::op_c2d_set_pattern,
        canvas::op_c2d_set_line,
        canvas::op_c2d_set_font,
        canvas::op_c2d_set_text,
        canvas::op_c2d_set_smoothing,
        canvas::op_c2d_create_linear_gradient,
        canvas::op_c2d_gradient_add_stop,
        canvas::op_c2d_gradient_free,
        canvas::op_c2d_fill_rect,
        canvas::op_c2d_stroke_rect,
        canvas::op_c2d_clear_rect,
        canvas::op_c2d_begin_path,
        canvas::op_c2d_close_path,
        canvas::op_c2d_move_to,
        canvas::op_c2d_line_to,
        canvas::op_c2d_quad_to,
        canvas::op_c2d_bezier_to,
        canvas::op_c2d_rect,
        canvas::op_c2d_arc,
        canvas::op_c2d_fill,
        canvas::op_c2d_stroke,
        canvas::op_c2d_clip,
        canvas::op_c2d_draw_canvas,
        canvas::op_c2d_draw_image,
        canvas::op_c2d_get_image_data,
        canvas::op_c2d_put_image_data,
        canvas::op_c2d_measure_text,
        canvas::op_c2d_measure_text_box,
        canvas::op_c2d_fill_text,
        canvas::op_c2d_stroke_text,
        canvas::op_font_load,
        canvas::op_font_count,
        audio::op_audio_available,
        audio::op_audio_now,
        audio::op_audio_rate,
        audio::op_audio_bytes,
        audio::op_audio_node_create,
        audio::op_audio_node_free,
        audio::op_audio_listener,
        audio::op_audio_node_set,
        audio::op_audio_connect,
        audio::op_audio_disconnect,
        audio::op_audio_connect_param,
        audio::op_audio_disconnect_param,
        audio::op_audio_param,
        audio::op_audio_param_cancel,
        audio::op_audio_param_get,
        audio::op_audio_source_buffer,
        audio::op_audio_source_loop,
        audio::op_audio_source_start,
        audio::op_audio_source_stop,
        audio::op_audio_poll_ended,
        audio::op_audio_decode,
        audio::op_audio_buffer_create,
        audio::op_audio_buffer_channel,
        audio::op_audio_buffer_free,
        video::op_video_open,
        video::op_video_advance,
        video::op_video_rewind,
        video::op_video_close,
        video::op_video_overlay,
        video::op_gl_tex_image_2d_video,
    ],
);

struct Args {
    game: Option<PathBuf>,
    scripts: Vec<PathBuf>,
    root: Option<PathBuf>,
    fonts: Vec<(String, PathBuf)>,
    window: Option<(u32, u32)>,
    secs: Option<f64>,
    shot: Option<PathBuf>,
    shot_at: f64,
    vsync: bool,
    /// Frame cap (sleep-based); for the PC without vsync and for 30 fps experiments.
    fps: Option<f64>,
}

fn usage() -> ! {
    eprintln!(
        "usage: powerboat [--game <game or www dir>] [--script <file.js>]... [--root <dir>] [--font Family=file.ttf] [--window WxH] [--secs N] [--shot out.ppm [--shot-at S]] [--no-vsync] [--fps N]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut a = Args {
        game: None,
        scripts: Vec::new(),
        root: None,
        fonts: Vec::new(),
        window: None,
        secs: None,
        shot: None,
        shot_at: 1.0,
        vsync: true,
        fps: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--game" => a.game = it.next().map(PathBuf::from),
            "--script" => a.scripts.push(it.next().map(PathBuf::from).unwrap_or_else(|| usage())),
            "--root" => a.root = it.next().map(PathBuf::from),
            "--font" => {
                let v = it.next().unwrap_or_else(|| usage());
                let (fam, path) = v.split_once('=').unwrap_or_else(|| usage());
                a.fonts.push((fam.to_string(), PathBuf::from(path)));
            }
            "--window" => {
                let v = it.next().unwrap_or_else(|| usage());
                let (w, h) = v.split_once('x').unwrap_or_else(|| usage());
                a.window = Some((w.parse().unwrap_or_else(|_| usage()), h.parse().unwrap_or_else(|_| usage())));
            }
            "--secs" => a.secs = Some(it.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| usage())),
            "--shot" => a.shot = it.next().map(PathBuf::from),
            "--shot-at" => a.shot_at = it.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| usage()),
            "--no-vsync" => a.vsync = false,
            "--fps" => a.fps = Some(it.next().and_then(|s| s.parse().ok()).filter(|f: &f64| *f > 0.0).unwrap_or_else(|| usage())),
            _ => usage(),
        }
    }
    if a.scripts.is_empty() && a.game.is_none() {
        usage();
    }
    if a.root.is_none() {
        a.root = match &a.game {
            Some(g) => Some(find_game(g)),
            None => a.scripts[0].parent().map(|p| if p.as_os_str().is_empty() { PathBuf::from(".") } else { p.to_path_buf() }),
        };
    }
    if a.game.is_some() {
        if let Some(root) = &a.root {
            mark_construct(root);
            mark_mz(root);
        }
    }
    a
}

/// A Construct 2/3 export (its index.html loads c2runtime.js or Construct 3's scripts) gets the
/// Construct layer (js/80_construct.js, 81_storage.js) and lazy image decoding: POWERBOAT_CONSTRUCT=1 and
/// POWERBOAT_LAZY_IMAGES=1, unless already set. RPG Maker games keep neither.
fn mark_construct(root: &std::path::Path) {
    let index = std::env::var("POWERBOAT_INDEX").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "index.html".into());
    let html = std::fs::read_to_string(root.join(&index)).unwrap_or_default();
    let construct = ["c2runtime.js", "scripts/c3main.js", "scripts/supportcheck.js", "Made with Construct", "Scirra Construct"].iter().any(|m| html.contains(m));
    if !construct {
        return;
    }
    // Single-threaded here: no other thread reads the environment yet.
    for (k, v) in [("POWERBOAT_CONSTRUCT", "1"), ("POWERBOAT_LAZY_IMAGES", "1")] {
        if std::env::var_os(k).is_none() {
            unsafe { std::env::set_var(k, v) };
        }
    }
    eprintln!("[powerboat] Construct export: Construct layer and lazy images on");
}

/// An RPG Maker MZ game (js/rmmz_core.js next to the page) gets the MZ layer (js/84_rmmz.js) and IndexedDB
/// (81_storage.js: MZ's browser check asks for it, though NW.js saves go through files): POWERBOAT_MZ=1.
fn mark_mz(root: &std::path::Path) {
    if !root.join("js").join("rmmz_core.js").is_file() || std::env::var_os("POWERBOAT_MZ").is_some() {
        return;
    }
    // Single-threaded here: no other thread reads the environment yet.
    unsafe { std::env::set_var("POWERBOAT_MZ", "1") };
    eprintln!("[powerboat] RPG Maker MZ game: MZ layer on");
}

fn main() {
    tune_malloc();
    // Diagnostic: powerboat --decode-test file.ogg (times the audio decoder alone).
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() == 3 && argv[1] == "--decode-test" {
        let t0 = Instant::now();
        let data = std::fs::read(&argv[2]).expect("read");
        match audio::decode(data, Some("ogg")) {
            Ok((rate, ch)) => {
                eprintln!("decoded {} Hz, {} ch, {} frames in {} ms", rate, ch.len(), ch[0].len(), t0.elapsed().as_millis());
                // POWERBOAT_DECODE_DUMP=<file>: the samples, interleaved s16le, to compare decoders or builds.
                if let Ok(out) = std::env::var("POWERBOAT_DECODE_DUMP") {
                    let n = ch[0].len();
                    let mut raw = Vec::with_capacity(n * ch.len() * 2);
                    for i in 0..n {
                        for c in &ch {
                            raw.extend_from_slice(&c.get(i).copied().unwrap_or(0).to_le_bytes());
                        }
                    }
                    let _ = std::fs::write(out, raw);
                }
            }
            Err(e) => eprintln!("decode failed after {} ms: {e}", t0.elapsed().as_millis()),
        }
        return;
    }
    if argv.len() == 3 && argv[1] == "--stream-test" {
        audio::stream_test(&argv[2]);
        return;
    }
    // Install step: powerboat --transcode-videos <dir> [--max-size WxH] [--max-fps N] [--kbps N] [--cpu-used N] [--force]
    if argv.len() >= 3 && argv[1] == "--transcode-videos" {
        let mut o = transcode::Options { max_w: 1280, max_h: 720, kbps: 600, cpu_used: 7, cq: 33, good: false, force: false, max_fps: 30.0 };
        let mut it = argv[3..].iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--max-size" => {
                    let (w, h) = it.next().and_then(|v| v.split_once('x')).unwrap_or_else(|| usage());
                    (o.max_w, o.max_h) = (w.parse().unwrap_or_else(|_| usage()), h.parse().unwrap_or_else(|_| usage()));
                }
                "--kbps" => o.kbps = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage()),
                "--cpu-used" => o.cpu_used = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage()),
                "--force" => o.force = true,
                "--max-fps" => o.max_fps = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage()),
                "--cq" => o.cq = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage()),
                "--good" => o.good = true,
                _ => usage(),
            }
        }
        std::process::exit(transcode::run(std::path::Path::new(&argv[2]), &o));
    }
    let args = parse_args();
    // deno_core posts delayed tasks to tokio: the isolate must live inside a runtime. Everything
    // runs on this one thread; the loop below polls the event loop once per frame.
    let tokio = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let code = tokio.block_on(run(args));
    std::process::exit(code);
}

async fn run(args: Args) -> i32 {
    let start = Instant::now();

    // --- SDL window + GLES context -------------------------------------------------------------
    let sdl = match sdl2::init() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[powerboat] SDL init failed: {e}");
            return 1;
        }
    };
    let video = sdl.video().expect("SDL video");
    let gcs = sdl.game_controller().ok();
    // POWERBOAT_PAD_MAPPINGS=file: extra SDL controller mappings (gamecontrollerdb.txt format).
    if let (Some(g), Ok(f)) = (gcs.as_ref(), std::env::var("POWERBOAT_PAD_MAPPINGS")) {
        match g.load_mappings(&f) {
            Ok(n) => eprintln!("[powerboat] {n} controller mappings from {f}"),
            Err(e) => eprintln!("[powerboat] controller mappings {f}: {e}"),
        }
    }
    // POWERBOAT_PAD_DEBUG=1: every joystick SDL sees at startup, its GUID and whether it is a game
    // controller (has a mapping). A pad without a mapping never sends controller events.
    if std::env::var_os("POWERBOAT_PAD_DEBUG").is_some() {
        if let (Some(g), Ok(js)) = (gcs.as_ref(), sdl.joystick()) {
            let n = js.num_joysticks().unwrap_or(0);
            eprintln!("[powerboat] {n} joysticks");
            for i in 0..n {
                let name = js.name_for_index(i).unwrap_or_default();
                let guid = js.device_guid(i).map(|g| g.string()).unwrap_or_default();
                eprintln!("[powerboat] joystick {i}: {name:?} guid {guid} game controller {}", g.is_game_controller(i));
            }
        }
    }
    let audio = match sdl.audio().map_err(|e| e.to_string()).and_then(|a| audio::AudioSys::open(&a)) {
        Ok(a) => Some(a),
        Err(e) => {
            eprintln!("[powerboat] no audio: {e}");
            None
        }
    };
    sdl.mouse().show_cursor(false);

    let (w, h) = args.window.unwrap_or_else(|| {
        video
            .current_display_mode(0)
            .map(|m| (m.w as u32, m.h as u32))
            .unwrap_or((640, 480))
    });
    let mut wb = video.window("powerboat", w, h);
    wb.opengl();
    if args.window.is_none() {
        wb.fullscreen_desktop();
    }
    let window = match wb.build() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[powerboat] window failed: {e}");
            return 1;
        }
    };

    let mut gl_ctx = None;
    // POWERBOAT_GLES2=1: a GLES 2.0 context only (A/B against engines that ask for 2.0).
    let versions: &[(u8, u8)] = if std::env::var("POWERBOAT_GLES2").is_ok_and(|v| v == "1") { &[(2, 0)] } else { &[(3, 0), (2, 0)] };
    for &(major, minor) in versions {
        let attr = video.gl_attr();
        attr.set_context_profile(GLProfile::GLES);
        attr.set_context_version(major, minor);
        attr.set_double_buffer(true);
        attr.set_depth_size(0);
        attr.set_stencil_size(8);
        match window.gl_create_context() {
            Ok(c) => {
                eprintln!("[powerboat] GLES {major}.{minor} context");
                gl_ctx = Some(c);
                break;
            }
            Err(e) => eprintln!("[powerboat] GLES {major}.{minor} context failed: {e}"),
        }
    }
    let Some(_gl_ctx) = gl_ctx else {
        eprintln!("[powerboat] no GLES context");
        return 1;
    };
    if let Err(e) = window.gl_make_current(&_gl_ctx) {
        eprintln!("[powerboat] make current failed: {e}");
        return 1;
    }
    if let Err(e) = video.gl_set_swap_interval(if args.vsync { 1 } else { 0 }) {
        eprintln!("[powerboat] swap interval: {e}");
    }
    // POWERBOAT_SWAP_INTERVAL=2: every shown frame waits two vblanks, an even 30 fps on a 60 Hz panel,
    // for games that cannot hold 60 (36-38 fps alternates 16/33 ms frames: judder). The sdl2 crate's
    // SwapInterval knows only -1/0/1, hence the raw call.
    if let Some(n) = std::env::var("POWERBOAT_SWAP_INTERVAL").ok().and_then(|v| v.parse::<i32>().ok()).filter(|&n| n >= 2) {
        let r = unsafe { sdl2::sys::SDL_GL_SetSwapInterval(n) };
        eprintln!("[powerboat] swap interval {n}: {}", if r == 0 { "set" } else { "not supported" });
        present::SWAP_INTERVAL.store(n, std::sync::atomic::Ordering::Relaxed);
    } else {
        present::SWAP_INTERVAL.store(args.vsync as i32, std::sync::atomic::Ordering::Relaxed);
    }
    // POWERBOAT_GL_THREAD=1: the JS thread queues GL calls instead of waiting in the driver (glthread.rs).
    let threaded_gl = if std::env::var("POWERBOAT_GL_THREAD").is_ok_and(|v| v == "1") {
        match glthread::start(|s| video.gl_get_proc_address(s) as *const std::ffi::c_void, window.raw(), unsafe { _gl_ctx.raw() }) {
            Ok(g) => {
                eprintln!("[powerboat] GL calls on a thread of their own");
                Some(g)
            }
            Err(e) => {
                eprintln!("[powerboat] GL thread failed: {e}");
                None
            }
        }
    } else {
        None
    };
    let gl = threaded_gl.unwrap_or_else(|| unsafe { glow::Context::from_loader_function(|s| video.gl_get_proc_address(s) as *const _) });
    let (dw, dh) = window.drawable_size();
    unsafe {
        use glow::HasContext;
        eprintln!(
            "[powerboat] GL {} | {} | {} | drawable {}x{}",
            gl.get_parameter_string(glow::VENDOR),
            gl.get_parameter_string(glow::RENDERER),
            gl.get_parameter_string(glow::VERSION),
            dw,
            dh
        );
    }

    // --- JS runtime -------------------------------------------------------------------------------
    // V8 flags, set before the isolate exists. Default: MV code reads the same fields through base
    // class methods on many object shapes (megamorphic ICs were ~23 % of OMORI's samples); keeping
    // up to 32 shapes polymorphic cut OMORI's logic step 12.5 -> 9.8 ms on the RG353V.
    // POWERBOAT_V8_FLAGS adds to (or overrides) these, e.g. "--trace-gc" or "--prof --logfile=x".
    {
        // Games run the same frame code for hours: tier up to TurboFan 10x sooner and allow OSR out of
        // Maglev (V8 defaults suit short-lived web pages). Janosik on the RG Cube XX: JS time in Maglev
        // code 18.6 % -> 1.7 %, JS per frame ~3.5 % lower (26.7 -> 25.8 ms, alternating runs).
        // Objects stay in fast (shape) mode for up to 256 properties added by keyed stores, not V8's 12:
        // class systems that copy defaults with `this[k] = ...` (ImpactJS's ig.Class) otherwise turn every
        // instance into a hash-table object, and no property access on it is ever inlined. An ImpactJS game's
        // Rookie Harbor plaza: 663 of 758 entities and all their collision objects were in dictionary mode;
        // JS per frame 36.6 -> 24.6 ms on the TrimUI Smart Pro (25.7 -> 37.7 fps), 33.9 -> 21.7 ms on the Cube XX.
        let base = "--max-valid-polymorphic-map-count=32 --invocation-count-for-turbofan=300 --osr-from-maglev --fast-properties-soft-limit=256";
        // POWERBOAT_V8_LOWMEM=1 (per game, from its launcher): keep the heap close to its live size, a full GC once the
        // old space is 20 % over what the last one kept (V8 lets it reach 1.5-4x) and 4 MB semi-spaces. For games
        // whose V8 heap is what fills a 1 GB device. Moonstone Island's tutorial on the TrimUI Smart Pro: heap
        // committed 205 -> 163 MB, peak before a GC 252 -> 162 MB, lowest available 136 -> 182 MB, fps 18.2 ->
        // 17.8. Not a default: Janosik paid ~6 % fps for 48 MB it did not need, an ImpactJS game (memory not in the
        // V8 heap) neither gained nor lost (main session's A/B, Construct Native NOTES.md).
        let lowmem = std::env::var("POWERBOAT_V8_LOWMEM").is_ok_and(|v| v == "1");
        let defaults = if lowmem { format!("{base} --heap-growing-percent=20 --max-semi-space-size=4") } else { base.to_string() };
        if lowmem {
            eprintln!("[powerboat] POWERBOAT_V8_LOWMEM: V8 heap kept small (--heap-growing-percent=20 --max-semi-space-size=4)");
        }
        let extra = std::env::var("POWERBOAT_V8_FLAGS").unwrap_or_default();
        // V8's traces (--trace-deopt, ...) print through C stdio, fully buffered into a file and
        // lost when a bench kills the process: line-buffer stdout whenever extra flags are set.
        if !extra.is_empty() {
            extern "C" {
                static stdout: *mut std::ffi::c_void;
                fn setvbuf(stream: *mut std::ffi::c_void, buf: *mut std::ffi::c_char, mode: std::ffi::c_int, size: usize) -> std::ffi::c_int;
            }
            const IOLBF: std::ffi::c_int = 1;
            unsafe {
                setvbuf(stdout, std::ptr::null_mut(), IOLBF, 0);
            }
        }
        let mut args = vec!["powerboat".to_string()];
        args.extend(defaults.split_whitespace().map(String::from));
        args.extend(extra.split_whitespace().map(String::from));
        let rest = deno_core::v8_set_flags(args);
        if rest.len() > 1 {
            eprintln!("[powerboat] V8 did not take: {:?}", &rest[1..]);
        }
        if !extra.is_empty() {
            eprintln!("[powerboat] V8 flags: {defaults} {extra}");
        }
    }
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![powerboat::init()],
        ..Default::default()
    });
    // deno_core asks V8 for a detailed stack trace of every exception that might go uncaught; under the
    // v8::TryCatch every call into JS runs in, that is every throw, caught or not: each one built a message
    // and resolved 10 frames to script positions. EXPERIMENT (see NOTES.md before keeping).
    if !*THROW_TRACE {
        runtime.v8_isolate().set_capture_stack_trace_for_uncaught_exceptions(false, 0);
    }
    let root = args.root.clone().unwrap_or_else(|| PathBuf::from("."));
    casepath::init(&root);
    runtime.op_state().borrow_mut().put(App {
        gl,
        events: Vec::new(),
        quit: false,
        start,
        width: dw,
        height: dh,
        root,
        images: Default::default(),
        canvases: Default::default(),
        fonts: Default::default(),
        unpack_flip_y: false,
        unpack_premultiply: false,
        preserve_drawing_buffer: false,
        stats: Default::default(),
        main_fbo: None,
        last_io_error: String::new(),
        audio,
        videos: Default::default(),
        main2d: None,
        ui: None,
        fbos: Default::default(),
        progcache: Default::default(),
    });

    install_code_cache(&runtime, args.root.as_deref());
    {
        // Same folder as the V8 code cache: POWERBOAT_CACHE_DIR, else <game>/.powerboat-cache.
        let dir = std::env::var_os("POWERBOAT_CACHE_DIR").map(PathBuf::from).or_else(|| args.root.as_ref().map(|r| r.join(".powerboat-cache")));
        let op_state = runtime.op_state();
        let mut st = op_state.borrow_mut();
        let app = st.borrow_mut::<App>();
        app.progcache = progcache::ProgCache::open(&app.gl, dir.as_deref(), start);
    }
    // The runtime's own substitute fonts (Liberation, Caladea, Carlito: fonts.rs SUBSTITUTES), read on
    // first use: POWERBOAT_FONT_DIR, else fonts/ next to the binary.
    {
        let dir = std::env::var_os("POWERBOAT_FONT_DIR").map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("fonts"))));
        if let Some(dir) = dir {
            let n = runtime.op_state().borrow_mut().borrow_mut::<App>().fonts.register_dir(&dir);
            if n > 0 && std::env::var_os("POWERBOAT_BOOT_DEBUG").is_some() {
                eprintln!("[powerboat] {n} substitute fonts in {}", dir.display());
            }
        }
    }
    for (family, path) in &args.fonts {
        match std::fs::read(path) {
            Ok(data) => {
                if let Err(e) = runtime.op_state().borrow_mut().borrow_mut::<App>().fonts.load(family, data, false, false) {
                    eprintln!("[powerboat] font {family}: {e}");
                }
            }
            Err(e) => eprintln!("[powerboat] font {}: {e}", path.display()),
        }
    }
    for (name, source) in ENV_JS {
        if let Err(e) = runtime.execute_script(*name, *source) {
            eprintln!("[powerboat] environment script {name} failed:\n{e}");
            return 1;
        }
    }
    for script in &args.scripts {
        let script_name: &'static str = Box::leak(format!("file://{}", script.display()).into_boxed_str());
        let source = match std::fs::read_to_string(script) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[powerboat] cannot read {}: {e}", script.display());
                return 1;
            }
        };
        if let Err(e) = runtime.execute_script(script_name, source) {
            eprintln!("[powerboat] script error in {}:\n{e}", script.display());
            return 1;
        }
    }
    if args.game.is_some() {
        // index.html the way a browser runs it: stylesheets (fonts), scripts in order, load event.
        if let Err(e) = runtime.execute_script("<powerboat-boot>", "__powerboat.bootHtml(__powerboat.root + '/' + (Deno.core.ops.op_powerboat_env('POWERBOAT_INDEX') || 'index.html'))") {
            eprintln!("[powerboat] boot failed:\n{e}");
            return 1;
        }
    }
    eprintln!("[powerboat] scripts evaluated at {} ms", start.elapsed().as_millis());
    report_code_cache();
    let tick = match global_function(&mut runtime, "__powerboat_tick") {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[powerboat] {e}");
            return 1;
        }
    };
    let timers_fn = match global_function(&mut runtime, "__powerboat_timers") {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[powerboat] {e}");
            return 1;
        }
    };
    // Timers that fall due before the frame is shown run at their time (see the frame loop).
    // POWERBOAT_TIMER_WAIT=0: only at the tick, as before 2026-11-17.
    let timer_wait_on = std::env::var("POWERBOAT_TIMER_WAIT").map(|v| v != "0").unwrap_or(true);
    let mut present_ema = 0.002f64;

    // --- frame loop -----------------------------------------------------------------------------
    let mut pump = sdl.event_pump().expect("event pump");
    let mut controllers: Vec<GameController> = Vec::new();
    // Pads already connected at startup are opened here: on the RG Cube XX (Knulli, SDL 2.32) SDL sent
    // no CONTROLLERDEVICEADDED for them (a virtual pad SDL listed as a game controller never arrived).
    if let (Some(gcs), Ok(n)) = (gcs.as_ref(), gcs.as_ref().map(|g| g.num_joysticks()).unwrap_or(Ok(0))) {
        for i in 0..n {
            if !gcs.is_game_controller(i) {
                continue;
            }
            match gcs.open(i) {
                Ok(c) => {
                    eprintln!("[powerboat] pad {}: {} (at startup)", i, c.name());
                    let state = runtime.op_state();
                    let mut state = state.borrow_mut();
                    state.borrow_mut::<App>().events.push(Ev::PadAdded { which: c.instance_id() as i32, name: c.name() });
                    controllers.push(c);
                }
                Err(e) => eprintln!("[powerboat] pad {i} open failed: {e}"),
            }
        }
    }
    let mut shot_pending = args.shot.clone();
    // POWERBOAT_SHOT_EVERY=<s>: a screenshot every s seconds from --shot-at on, as <shot>_<t>.ppm.
    let shot_every: f64 = std::env::var("POWERBOAT_SHOT_EVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let mut next_shot = args.shot_at;
    let mut shot_keep: Option<(glow::NativeRenderbuffer, glow::NativeFramebuffer, u32, u32)> = None;
    let mut shot_keep_s = 0.0f64;
    let mut frames: u64 = 0;
    let mut exit_code = 0;
    let mut next_frame = Instant::now();
    let mut scripted = scripted_keys();
    let mut external_reported: i64 = 0;
    let mut native_low: i64 = 0;
    const NATIVE_GC_NUDGE: i64 = 64 << 20;
    let mem_debug = std::env::var_os("POWERBOAT_MEM_DEBUG").is_some();
    let mut frame_debug = std::env::var_os("POWERBOAT_FRAME_DEBUG").map(|_| [0.0f64; 6]);
    let swap_all = std::env::var("POWERBOAT_SWAP_ALL").map(|v| v == "1").unwrap_or(false);
    let finish_before_swap = std::env::var("POWERBOAT_FINISH").map(|v| !v.is_empty() && v != "0").unwrap_or(false);
    let mut fd_start = Instant::now();
    let mut drawn_count = 0u32;
    let mut t_frame;
    // POWERBOAT_FRAME_PACE=<fps> (e.g. 30): even frame times below 60 fps. Mali/KMS ignores swap interval 2
    // and on the RG Cube XX the swap does not wait for a vblank at all (unpaced Janosik: even ~24 ms
    // frames, shown for 1 or 2 panel refreshes = judder). Before a swap the loop sleeps until 1 ms short
    // of 1000/fps ms after the previous swap (a 4 ms margin let ~10 % of frames through at 20-30 ms).
    let pace = std::env::var("POWERBOAT_FRAME_PACE").ok().and_then(|v| v.parse::<f64>().ok()).filter(|f| *f > 0.0 && *f < 60.0).map(|f| Duration::from_secs_f64(1.0 / f));
    if let Some(p) = pace {
        eprintln!("[powerboat] frame pacing: {:.1} ms per frame", p.as_secs_f64() * 1000.0);
    }
    let mut last_swap: Option<Instant> = None;
    let mut swap_hist = [0u32; 5];
    let mut fps_meter = fpsmeter::FpsMeter::from_env();
    let mut heap_snaps: Vec<f64> = std::env::var("POWERBOAT_HEAP_SNAPSHOT").map(|v| v.split(',').filter_map(|s| s.trim().parse().ok()).collect()).unwrap_or_default();
    heap_snaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    loop {
        t_frame = Instant::now();
        {
            let state = runtime.op_state();
            let mut state = state.borrow_mut();
            let app = state.borrow_mut::<App>();
            for ev in pump.poll_iter() {
                match ev {
                    Event::Quit { .. } => app.events.push(Ev::Quit),
                    Event::KeyDown { scancode, keycode, repeat, keymod, .. } => app.events.push(Ev::KeyDown {
                        scancode: scancode.map(|s| s as i32).unwrap_or(0),
                        key: keycode.map(|k| k.to_string()).unwrap_or_default(),
                        repeat,
                        mods: keymod.bits(),
                    }),
                    Event::KeyUp { scancode, keycode, keymod, .. } => app.events.push(Ev::KeyUp {
                        scancode: scancode.map(|s| s as i32).unwrap_or(0),
                        key: keycode.map(|k| k.to_string()).unwrap_or_default(),
                        mods: keymod.bits(),
                    }),
                    Event::ControllerDeviceAdded { which, .. } => {
                        if let Some(gcs) = &gcs {
                            match gcs.open(which) {
                                // Already opened at startup: the event came after all.
                                Ok(c) if controllers.iter().any(|o| o.instance_id() == c.instance_id()) => {}
                                Ok(c) => {
                                    eprintln!("[powerboat] pad {}: {}", which, c.name());
                                    app.events.push(Ev::PadAdded { which: c.instance_id() as i32, name: c.name() });
                                    controllers.push(c);
                                }
                                Err(e) => eprintln!("[powerboat] pad {which} open failed: {e}"),
                            }
                        }
                    }
                    Event::ControllerDeviceRemoved { which, .. } => {
                        controllers.retain(|c| c.instance_id() != which);
                        app.events.push(Ev::PadRemoved { which: which as i32 });
                    }
                    Event::ControllerButtonDown { which, button, .. } => {
                        app.events.push(Ev::PadButton { which: which as i32, button: button.string(), down: true })
                    }
                    Event::ControllerButtonUp { which, button, .. } => {
                        app.events.push(Ev::PadButton { which: which as i32, button: button.string(), down: false })
                    }
                    Event::ControllerAxisMotion { which, axis, value, .. } => {
                        app.events.push(Ev::PadAxis { which: which as i32, axis: axis.string(), value })
                    }
                    // Mouse (also gptokeyb's stick-as-mouse on handhelds): positions in window points.
                    Event::MouseMotion { x, y, .. } => {
                        let (ww, wh) = window.size();
                        app.events.push(Ev::MouseMove { fx: x as f64 / ww.max(1) as f64, fy: y as f64 / wh.max(1) as f64 })
                    }
                    Event::MouseButtonDown { x, y, mouse_btn, .. } | Event::MouseButtonUp { x, y, mouse_btn, .. } => {
                        let button = match mouse_btn {
                            MouseButton::Left => 0,
                            MouseButton::Middle => 1,
                            MouseButton::Right => 2,
                            MouseButton::X1 => 3,
                            MouseButton::X2 => 4,
                            MouseButton::Unknown => continue,
                        };
                        let (ww, wh) = window.size();
                        let down = matches!(ev, Event::MouseButtonDown { .. });
                        app.events.push(Ev::MouseButton { fx: x as f64 / ww.max(1) as f64, fy: y as f64 / wh.max(1) as f64, button, down })
                    }
                    Event::MouseWheel { precise_x, precise_y, .. } => {
                        app.events.push(Ev::Wheel { dx: precise_x as f64, dy: precise_y as f64 })
                    }
                    Event::Window { win_event, .. } => match win_event {
                        WindowEvent::SizeChanged(_, _) | WindowEvent::Resized(_, _) => {
                            let (nw, nh) = window.drawable_size();
                            app.width = nw;
                            app.height = nh;
                            app.events.push(Ev::Resize { width: nw, height: nh });
                        }
                        WindowEvent::FocusGained => app.events.push(Ev::Focus { focused: true }),
                        WindowEvent::FocusLost => app.events.push(Ev::Focus { focused: false }),
                        _ => {}
                    },
                    _ => {}
                }
            }
            // Scripted keys (POWERBOAT_KEYS): press at the given second, release 100 ms later.
            let now_s = start.elapsed().as_secs_f64();
            while let Some((at, input)) = scripted.first() {
                if *at > now_s { break; }
                match input {
                    Scripted::Key(sc, name) if *sc < 0 => app.events.push(Ev::KeyUp { scancode: -sc, key: name.clone(), mods: 0 }),
                    Scripted::Key(sc, name) => app.events.push(Ev::KeyDown { scancode: *sc, key: name.clone(), repeat: false, mods: 0 }),
                    &Scripted::Click { fx, fy, down } => {
                        if down {
                            app.events.push(Ev::MouseMove { fx, fy });
                        }
                        app.events.push(Ev::MouseButton { fx, fy, button: 0, down });
                    }
                }
                scripted.remove(0);
            }
            if app.quit {
                break;
            }
        }

        let t_events = Instant::now();
        let now_ms = start.elapsed().as_secs_f64() * 1000.0;
        if let Err(e) = call_tick(&mut runtime, &tick, now_ms) {
            eprintln!("[powerboat] uncaught in tick:\n{e}");
            exit_code = 1;
            break;
        }
        // One pass over the deno event loop: microtasks, resolved async ops, deno timers.
        let poll = std::future::poll_fn(|cx| match runtime.poll_event_loop(cx, Default::default()) {
            Poll::Ready(Err(e)) => Poll::Ready(Err(e.to_string())),
            _ => Poll::Ready(Ok(())),
        })
        .await;
        // Let tokio run the tasks deno_core spawned (async op futures, blocking-pool results):
        // this loop never returns Pending to block_on otherwise.
        let t_tick = Instant::now();
        tokio::task::yield_now().await;
        if let Err(e) = poll {
            eprintln!("[powerboat] event loop error:\n{e}");
            exit_code = 1;
            break;
        }
        // Timers due before this frame has to be shown run at their time instead of at the next tick
        // (setInterval(10) beat once per frame, 20 beats in 353 ms instead of 200). The wait ends
        // before the frame's slot (60 Hz, or POWERBOAT_FRAME_PACE) by the present's own cost plus 3 ms, so
        // present and swap still make their vblank; the GL work queued so far is flushed first, so a
        // GPU-bound frame does not start late. Only when a timer is due in that window: frames
        // without one are as before. Not for 2D pages on the present thread (paced by its hand-over).
        let mut timer_js = Duration::ZERO;
        let mut timer_sleep = Duration::ZERO;
        if timer_wait_on && !present::active() {
            let period = pace.unwrap_or(Duration::from_micros(16_667));
            let reserve = Duration::from_secs_f64(present_ema.min(0.008)) + Duration::from_millis(3);
            let deadline = t_frame + period.saturating_sub(reserve);
            let mut flushed = false;
            let mut failed = None;
            loop {
                let t0 = Instant::now();
                if t0 >= deadline {
                    break;
                }
                let next = match call_number(&mut runtime, &timers_fn) {
                    Ok(v) => v,
                    Err(e) => {
                        failed = Some(e);
                        break;
                    }
                };
                // Promise jobs and async ops the callbacks started.
                let _ = std::future::poll_fn(|cx| {
                    let _ = runtime.poll_event_loop(cx, Default::default());
                    Poll::Ready(())
                })
                .await;
                let t1 = Instant::now();
                timer_js += t1 - t0;
                if next < 0.0 {
                    break;
                }
                let at = t1 + Duration::from_secs_f64(next / 1000.0);
                if at >= deadline {
                    break;
                }
                if at > t1 {
                    if !flushed {
                        flushed = true;
                        let state = runtime.op_state();
                        let state = state.borrow();
                        unsafe {
                            use glow::HasContext;
                            state.borrow::<App>().gl.flush();
                        }
                        glthread::flush();
                    }
                    tokio::time::sleep_until(at.into()).await;
                    timer_sleep += t1.elapsed();
                }
            }
            if let Some(e) = failed {
                eprintln!("[powerboat] uncaught in timers:\n{e}");
                exit_code = 1;
                break;
            }
        }
        let t_timers = Instant::now();

        // MV skips its render when the last one was slow (Graphics._skipCount): such a frame drew
        // nothing, and swapping would show a stale or undefined back buffer (Mali does not keep
        // them) after waiting for a vblank for nothing. POWERBOAT_SWAP_ALL=1 swaps every frame anyway.
        // A screenshot waits for a drawn frame: forcing a present would show the cleared buffer
        // (clear_drawing_buffer) when the game drew nothing (C3 skips unchanged frames).
        let drew = (gl::take_frame_draws() > 0) | gl::take_ui_changed() || swap_all || runtime.op_state().borrow().borrow::<App>().main2d.is_some();
        // A 2D page on the present thread (crate::present): the window is its, and `sent` a drawn frame.
        let sent = present::SENT.swap(false, std::sync::atomic::Ordering::Relaxed);
        let threaded = present::active();
        let drew = drew && !threaded;
        if drew {
            let state = runtime.op_state();
            let mut state = state.borrow_mut();
            gl::present(state.borrow_mut::<App>());
            // Over the finished picture, so screenshots show it too.
            if let Some(m) = fps_meter.as_mut() {
                let app = state.borrow::<App>();
                m.draw(&app.gl, app.width, app.height);
            }
        } else {
            SKIPPED_PRESENTS.with(|c| c.set(c.get() + 1));
        }
        // A game that stops drawing (C3 on a still menu) would never reach the shot: while one is
        // pending, drawn frames are also copied (GPU blit) and the shot falls back to the last copy
        // when nothing is drawn within 1 s of its time.
        let elapsed = start.elapsed().as_secs_f64();
        if threaded {
            // The present thread saves the next frame it shows.
            if let (Some(path), true) = (shot_pending.clone(), sent && elapsed >= next_shot) {
                let path = if shot_every > 0.0 {
                    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("shot");
                    path.with_file_name(format!("{stem}_{:04}.ppm", next_shot.round() as u64))
                } else {
                    path
                };
                present::request_shot(path);
                if shot_every > 0.0 {
                    next_shot += shot_every;
                } else {
                    shot_pending = None;
                }
            }
        } else if let Some(path) = shot_pending.clone() {
            let due = elapsed >= next_shot;
            let fallback = due && !drew && elapsed >= next_shot + 1.0 && shot_keep.is_some();
            let state = runtime.op_state();
            let state = state.borrow();
            let app = state.borrow::<App>();
            // What the screen shows: the window back buffer after present (letterbox + video).
            let (sw, sh) = (app.width, app.height);
            unsafe {
                use glow::HasContext;
                let gl = &app.gl;
                if drew && !due {
                    if shot_keep.map(|k| (k.2, k.3)) != Some((sw, sh)) {
                        if let Some((rb, fb, ..)) = shot_keep.take() {
                            gl.delete_framebuffer(fb);
                            gl.delete_renderbuffer(rb);
                        }
                        if let (Ok(rb), Ok(fb)) = (gl.create_renderbuffer(), gl.create_framebuffer()) {
                            gl.bind_renderbuffer(glow::RENDERBUFFER, Some(rb));
                            gl.renderbuffer_storage(glow::RENDERBUFFER, glow::RGBA8, sw as i32, sh as i32);
                            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fb));
                            gl.framebuffer_renderbuffer(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::RENDERBUFFER, Some(rb));
                            shot_keep = Some((rb, fb, sw, sh));
                        }
                    }
                    if let Some((_, fb, ..)) = shot_keep {
                        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None);
                        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(fb));
                        gl.blit_framebuffer(0, 0, sw as i32, sh as i32, 0, 0, sw as i32, sh as i32, glow::COLOR_BUFFER_BIT, glow::NEAREST);
                        shot_keep_s = elapsed;
                    }
                }
                if (due && drew) || fallback {
                    gl.bind_framebuffer(glow::FRAMEBUFFER, if fallback { shot_keep.map(|k| k.1) } else { None });
                    let path = if shot_every > 0.0 {
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("shot");
                        path.with_file_name(format!("{stem}_{:04}.ppm", next_shot.round() as u64))
                    } else {
                        path.clone()
                    };
                    match save_ppm(gl, sw, sh, &path) {
                        Ok(()) if fallback => eprintln!("[powerboat] screenshot {} (last frame drawn, at {shot_keep_s:.1} s)", path.display()),
                        Ok(()) => eprintln!("[powerboat] screenshot {}", path.display()),
                        Err(e) => eprintln!("[powerboat] screenshot failed: {e}"),
                    }
                    if shot_every > 0.0 {
                        next_shot += shot_every;
                    } else {
                        shot_pending = None;
                    }
                }
                gl.bind_framebuffer(glow::FRAMEBUFFER, app.main_fbo.as_ref().map(|f| f.fbo));
            }
        }

        // Decoded images, canvas pixmaps and audio PCM live outside V8's heap: report them, so
        // its GC runs when MV drops bitmaps (their FinalizationRegistry frees the native memory).
        if frames % 10 == 5 {
            // Pixels held after an upload (image.rs after_upload), unused for a second, go.
            let state = runtime.op_state();
            state.borrow().borrow::<App>().images.sweep_held();
        }
        if frames % 300 == 150 {
            // Decoded pixels of images idle for 20 s go (they decode again on use).
            let state = runtime.op_state();
            let state = state.borrow();
            state.borrow::<App>().images.sweep(20_000);
            drop(state);
            trim_malloc();
        }
        if frames % 30 == 0 {
            let ext = {
                let state = runtime.op_state();
                let state = state.borrow();
                mem::native_bytes(state.borrow::<App>()) as i64
            };
            runtime.v8_isolate().adjust_amount_of_external_allocated_memory(ext - external_reported);
            external_reported = ext;
            // V8 (this version) sets its next GC limit at the end of each GC, while the native memory of the objects
            // that GC found dead still counts (their FinalizationRegistry callbacks free it just after), and those
            // frees do not lower it. Games that drop canvases again then wait for V8's own heap to grow: 100 dropped
            // 512px canvases (100 MB) were still held after 6 s (examples/t_canvas_drop.js). Native memory 64 MB over
            // its lowest since the last nudge starts incremental marking, as memory pressure does in Chrome.
            native_low = native_low.min(ext);
            if ext - native_low > NATIVE_GC_NUDGE {
                let iso = runtime.v8_isolate();
                iso.memory_pressure_notification(v8::MemoryPressureLevel::Moderate);
                // Back to none at once: V8 acts on the change of level, and stays in its memory-saving mode while
                // the level is up.
                iso.memory_pressure_notification(v8::MemoryPressureLevel::None);
                native_low = ext;
                if mem_debug {
                    eprintln!("[powerboat] native memory {} MB: GC nudged", ext >> 20);
                }
            }
            if mem_debug && frames % 300 == 0 {
                let rss = std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<u64>().ok())).unwrap_or(0);
                let (im, cv, au, cs) = {
                    let state = runtime.op_state();
                    let state = state.borrow();
                    let app = state.borrow::<App>();
                    (app.images.bytes() >> 20, app.canvases.bytes() >> 20, app.audio.as_ref().map(|a| a.bytes()).unwrap_or(0) >> 20, app.images.cropped_saving() >> 20)
                };
                eprintln!("[powerboat] external {} MB (images {im}, canvases {cv}, audio {au}), rss {} MB, image re-decodes {}, cropping saves {} MB of texture", ext >> 20, rss >> 10, image::REDECODES.load(std::sync::atomic::Ordering::Relaxed), cs);
                let hs = runtime.v8_isolate().get_heap_statistics();
                eprintln!(
                    "[powerboat] v8 heap: used {} MB, total {} MB, physical {} MB, malloced {} MB, external {} MB",
                    hs.used_heap_size() >> 20,
                    hs.total_heap_size() >> 20,
                    hs.total_physical_size() >> 20,
                    hs.malloced_memory() >> 20,
                    hs.external_memory() >> 20
                );
            }
        }
        // POWERBOAT_HEAP_SNAPSHOT=<s>[,<s>...]: a V8 heap snapshot (Chrome DevTools format) at those times since start,
        // as heap_<s>.heapsnapshot in POWERBOAT_HEAP_DIR (default the working directory). Diagnostic: it stops the
        // game for seconds and needs about the heap's size again in memory.
        if let Some(due) = heap_snaps.first().copied() {
            if start.elapsed().as_secs_f64() >= due {
                heap_snaps.remove(0);
                let dir = std::env::var("POWERBOAT_HEAP_DIR").unwrap_or_else(|_| ".".into());
                let path = format!("{dir}/heap_{}.heapsnapshot", due as u64);
                let t0 = Instant::now();
                match std::fs::File::create(&path) {
                    Ok(f) => {
                        let mut w = std::io::BufWriter::new(f);
                        runtime.v8_isolate().take_heap_snapshot(|chunk| std::io::Write::write_all(&mut w, chunk).is_ok());
                        let _ = std::io::Write::flush(&mut w);
                        eprintln!("[powerboat] heap snapshot {path} in {} ms", t0.elapsed().as_millis());
                    }
                    Err(e) => eprintln!("[powerboat] heap snapshot {path}: {e}"),
                }
            }
        }
        if finish_before_swap {
            // Diagnostic (POWERBOAT_FINISH=1): GPU completion shows up in "present", the page flip in "swap".
            let state = runtime.op_state();
            let state = state.borrow();
            unsafe {
                use glow::HasContext;
                state.borrow::<App>().gl.finish();
            }
        }
        let t_present = Instant::now();
        if drew {
            present_ema = present_ema * 0.9 + (t_present - t_timers).as_secs_f64() * 0.1;
            if let (Some(p), Some(last)) = (pace, last_swap) {
                let target = p.saturating_sub(Duration::from_millis(1));
                let since = last.elapsed();
                if since < target {
                    tokio::time::sleep(target - since).await;
                }
            }
            if glthread::active() {
                glthread::swap(window.raw());
            } else {
                window.gl_swap_window();
            }
            let now = Instant::now();
            if let Some(m) = fps_meter.as_mut() {
                m.swapped(now);
            }
            if let Some(l) = last_swap {
                // Swap-to-swap intervals for the frame report: <20, 20-30, 30-37, 37-45, >=45 ms.
                let ms = (now - l).as_secs_f64() * 1000.0;
                let b = if ms < 20.0 { 0 } else if ms < 30.0 { 1 } else if ms < 37.0 { 2 } else if ms < 45.0 { 3 } else { 4 };
                swap_hist[b] += 1;
            }
            last_swap = Some(now);
            gl::schedule_clear();
        } else if sent {
            // Swapped on the present thread: the hand-over waited for the previous swap. Hand-over
            // intervals stand in for swap intervals in the frame report.
            let now = Instant::now();
            if let Some(l) = last_swap {
                let ms = (now - l).as_secs_f64() * 1000.0;
                let b = if ms < 20.0 { 0 } else if ms < 30.0 { 1 } else if ms < 37.0 { 2 } else if ms < 45.0 { 3 } else { 4 };
                swap_hist[b] += 1;
            }
            last_swap = Some(now);
        } else {
            // No swap means no vblank wait: keep a 60 Hz slot so a scene that draws nothing for a
            // while (loading) does not spin the CPU.
            let slot = Duration::from_micros(16_667);
            let spent = t_frame.elapsed();
            if spent < slot {
                tokio::time::sleep(slot - spent).await;
            }
        }
        // A frame that drew nothing can still have queued calls.
        glthread::flush();
        let t_swap = Instant::now();
        frames += 1;
        if drew || sent {
            drawn_count += 1;
        }
        // POWERBOAT_FRAME_DEBUG: where a frame's time goes, averaged over 150 frames.
        if let Some(fd) = frame_debug.as_mut() {
            fd[0] += (t_events - t_frame).as_secs_f64();
            fd[1] += (t_tick - t_events + timer_js).as_secs_f64();
            fd[2] += (t_present - t_timers).as_secs_f64();
            fd[5] += timer_sleep.as_secs_f64();
            fd[3] += (t_swap - t_present).as_secs_f64();
            fd[4] += 1.0;
            if fd[4] >= 150.0 {
                let n = fd[4] / 1000.0;
                let secs = (t_swap - fd_start).as_secs_f64();
                let dec = image::take_decode_window();
                let sh = std::mem::take(&mut swap_hist);
                eprintln!(
                    "[powerboat] frame ms: events {:.1}, js tick + event loop {:.1}, timer waits {:.1}, present {:.1}, swap {:.1}; {:.1} loops/s, {:.1} drawn fps; image decodes {} ({:.0} ms); frame ms <20/20-30/30-37/37-45/45+: {}/{}/{}/{}/{}",
                    fd[0] / n,
                    fd[1] / n,
                    fd[5] / n,
                    fd[2] / n,
                    fd[3] / n,
                    fd[4] / secs,
                    drawn_count as f64 / secs,
                    dec.0,
                    dec.1,
                    sh[0], sh[1], sh[2], sh[3], sh[4]
                );
                drawn_count = 0;
                {
                    let state = runtime.op_state();
                    let state = state.borrow();
                    let st = &state.borrow::<App>().stats;
                    let f = fd[4];
                    let c2d = canvas::take_c2d_time();
                    let glt = gl::take_gl_time();
                    eprintln!(
                        "[powerboat] gl ops per frame: {:.0} calls, {:.2} ms; slowest {} {:.2} ms; {} undrawn frames skipped",
                        glt.0 as f64 / f,
                        glt.1 as f64 / f / 1e6,
                        glt.3,
                        glt.2 as f64 / 1e6,
                        SKIPPED_PRESENTS.with(|c| c.replace(0))
                    );
                    if let Some(line) = glthread::report(f) {
                        eprintln!("{line}");
                    }
                    if c2d.0 > 0 {
                        eprintln!("[powerboat] canvas 2D ops per frame: {:.0} calls, {:.2} ms", c2d.0 as f64 / f, c2d.1 as f64 / f / 1e6);
                    }
                    let swaps = present::SWAPS.swap(0, std::sync::atomic::Ordering::Relaxed);
                    let swap_ns = present::SWAP_NS.swap(0, std::sync::atomic::Ordering::Relaxed);
                    let handed = present::HANDED.swap(0, std::sync::atomic::Ordering::Relaxed);
                    if swaps > 0 || handed > 0 {
                        eprintln!("[powerboat] present thread: {handed} frames handed over, {swaps} swaps, swap {:.2} ms", swap_ns as f64 / swaps.max(1) as f64 / 1e6);
                    }
                    if let Some((draw, wait, flushes)) = canvas::take_defer_stats() {
                        eprintln!(
                            "[powerboat] canvas 2D deferred per frame: drawing {:.2} ms (own thread), main thread waiting {:.2} ms, {:.2} flushes",
                            draw as f64 / f / 1e6,
                            wait as f64 / f / 1e6,
                            flushes as f64 / f
                        );
                    }
                    let hist = gl::take_gl_hist();
                    if !hist.is_empty() {
                        let top: Vec<String> = hist.iter().take(14).map(|(k, n, t)| format!("{} {:.1}x {:.2}ms", k.trim_start_matches("op_gl_"), *n as f64 / f, *t as f64 / f / 1e6)).collect();
                        eprintln!("[powerboat] gl ops by time per frame: {}", top.join(", "));
                    }
                    eprintln!(
                        "[powerboat] per frame: {:.0} draws, {:.1} fb binds, {:.1} clears, {:.1} texture uploads = {:.2} MB, {:.0} canvas 2D ops = {:.2} ms",
                        st.draws.take() as f64 / f,
                        st.fb_binds.take() as f64 / f,
                        st.clears.take() as f64 / f,
                        st.uploads.take() as f64 / f,
                        st.upload_bytes.take() as f64 / f / 1048576.0,
                        c2d.0 as f64 / f,
                        c2d.1 as f64 / f / 1e6
                    );
                }
                *fd = [0.0; 6];
                fd_start = t_swap;
            }
        }
        if let Some(fps) = args.fps {
            next_frame += Duration::from_secs_f64(1.0 / fps);
            let now = Instant::now();
            if next_frame > now {
                tokio::time::sleep(next_frame - now).await;
            } else {
                next_frame = now;
            }
        }
        if let Some(secs) = args.secs {
            if start.elapsed() >= Duration::from_secs_f64(secs) {
                break;
            }
        }
        if runtime.op_state().borrow().borrow::<App>().quit {
            break;
        }
    }
    // The window goes back to the main context before it is destroyed.
    present::stop();
    glthread::stop(window.raw(), unsafe { _gl_ctx.raw() });
    // Pending localStorage writes (MV saves) must not die with the process.
    let _ = runtime.execute_script("<powerboat-exit>", "__powerboat.flushStorage && __powerboat.flushStorage()");
    let secs = start.elapsed().as_secs_f64();
    eprintln!("[powerboat] exit: {frames} frames in {secs:.1} s = {:.1} fps", frames as f64 / secs.max(0.001));
    let (nt, nb) = (&gl::NULL_TEX.0, &gl::NULL_TEX.1);
    let nt = nt.load(std::sync::atomic::Ordering::Relaxed);
    if nt > 0 {
        eprintln!("[powerboat] textures made without data: {nt}, {:.1} MB of zeros uploaded", nb.load(std::sync::atomic::Ordering::Relaxed) as f64 / 1048576.0);
    }
    if let Some(line) = runtime.op_state().borrow().borrow::<App>().progcache.report() {
        eprintln!("{line}");
    }
    exit_code
}

/// Looks a global function up by name (evaluated as an expression) and keeps a handle to it.
fn global_function(runtime: &mut JsRuntime, name: &str) -> Result<v8::Global<v8::Function>, String> {
    let value = runtime
        .execute_script("<powerboat>", name.to_string())
        .map_err(|e| format!("{name}: {e}"))?;
    deno_core::scope!(scope, runtime);
    let local = v8::Local::new(scope, &value);
    let func = v8::Local::<v8::Function>::try_from(local).map_err(|_| format!("{name} is not a function"))?;
    Ok(v8::Global::new(scope, func))
}

/// POWERBOAT_V8_THROW_TRACE=1: deno_core's detailed traces of uncaught exceptions and message objects under the
/// frame loop's TryCatch, as before (A/B; error reports come from the exception's stack either way).
static THROW_TRACE: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| std::env::var("POWERBOAT_V8_THROW_TRACE").is_ok_and(|v| v == "1"));

/// Calls a JS function with no arguments that returns a number.
fn call_number(runtime: &mut JsRuntime, func: &v8::Global<v8::Function>) -> Result<f64, String> {
    deno_core::scope!(scope, runtime);
    v8::tc_scope!(let tc, scope);
    // No message objects: V8 built one (with the throw's script location) for every throw under a TryCatch
    // that captures messages, even one JS catches itself. Errors that reach here are reported from their stack.
    tc.set_capture_message(*THROW_TRACE);
    let f = func.open(tc);
    let recv: v8::Local<v8::Value> = v8::undefined(tc).into();
    let result = f.call(tc, recv, &[]);
    match result {
        Some(v) if !tc.has_caught() => Ok(v.number_value(tc).unwrap_or(-1.0)),
        _ => {
            let msg = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_else(|| "unknown exception".into());
            let stack = tc.stack_trace().map(|s| s.to_rust_string_lossy(tc)).unwrap_or_default();
            Err(if stack.is_empty() { msg } else { stack })
        }
    }
}

fn call_tick(runtime: &mut JsRuntime, func: &v8::Global<v8::Function>, now_ms: f64) -> Result<(), String> {
    deno_core::scope!(scope, runtime);
    v8::tc_scope!(let tc, scope);
    tc.set_capture_message(*THROW_TRACE); // as in call_number
    let f = func.open(tc);
    let recv: v8::Local<v8::Value> = v8::undefined(tc).into();
    let arg: v8::Local<v8::Value> = v8::Number::new(tc, now_ms).into();
    let result = f.call(tc, recv, &[arg]);
    if result.is_none() || tc.has_caught() {
        let msg = tc
            .exception()
            .map(|e| e.to_rust_string_lossy(tc))
            .unwrap_or_else(|| "unknown exception".into());
        let stack = tc.stack_trace().map(|s| s.to_rust_string_lossy(tc)).unwrap_or_default();
        return Err(if stack.is_empty() { msg } else { stack });
    }
    Ok(())
}

/// The current framebuffer as a binary PPM (no image dependency; convert on the PC).
fn save_ppm(gl: &glow::Context, w: u32, h: u32, path: &std::path::Path) -> Result<(), String> {
    use glow::HasContext;
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    unsafe {
        gl.read_pixels(
            0,
            0,
            w as i32,
            h as i32,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelPackData::Slice(Some(&mut rgba)),
        );
    }
    let mut out = format!("P6\n{w} {h}\n255\n").into_bytes();
    for row in (0..h as usize).rev() {
        let line = &rgba[row * w as usize * 4..(row + 1) * w as usize * 4];
        for px in line.chunks(4) {
            out.extend_from_slice(&px[..3]);
        }
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

/// A scripted input for unattended runs: a key press or release (negative scancode), or a left button
/// at a 0..1 fraction of the window (the pointer moves there first).
enum Scripted {
    Key(i32, String),
    Click { fx: f64, fy: f64, down: bool },
}

/// POWERBOAT_KEYS="16:z 18.5:enter 20:down 25:click@0.49,0.21": (second, input), each press released 100 ms
/// later. Keys by name (USB HID usage codes, as SDL's); click@x,y clicks at that window fraction (mouse-only
/// games such as Hypnospace Outlaw).
fn scripted_keys() -> Vec<(f64, Scripted)> {
    let Ok(spec) = std::env::var("POWERBOAT_KEYS") else { return Vec::new() };
    let mut out = Vec::new();
    for item in spec.split_whitespace() {
        let Some((t, k)) = item.split_once(':') else { continue };
        let Ok(t) = t.parse::<f64>() else { continue };
        let k = k.to_ascii_lowercase();
        if let Some(xy) = k.strip_prefix("click@") {
            match xy.split_once(',').map(|(x, y)| (x.parse::<f64>(), y.parse::<f64>())) {
                Some((Ok(fx), Ok(fy))) => {
                    out.push((t, Scripted::Click { fx, fy, down: true }));
                    out.push((t + 0.1, Scripted::Click { fx, fy, down: false }));
                }
                _ => eprintln!("[powerboat] POWERBOAT_KEYS: bad click {k} (click@x,y in 0..1 window fractions)"),
            }
            continue;
        }
        let sc = match k.as_str() {
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_lowercase() => 4 + (s.as_bytes()[0] - b'a') as i32,
            "enter" | "return" => 40,
            "escape" | "esc" => 41,
            "space" => 44,
            "tab" => 43,
            "shift" => 225,
            "right" => 79,
            "left" => 80,
            "down" => 81,
            "up" => 82,
            "pageup" => 75,
            "pagedown" => 78,
            _ => {
                eprintln!("[powerboat] POWERBOAT_KEYS: unknown key {k}");
                continue;
            }
        };
        out.push((t, Scripted::Key(sc, k.clone())));
        out.push((t + 0.1, Scripted::Key(-sc, k)));
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// V8 code cache for every script the game evaluates (index.html scripts, plugins, require()d
/// modules: all go through Deno.core.evalContext). Keyed by a hash of the source, so a changed
/// script simply gets a new entry; V8 itself rejects a cache from another V8 build or flag set
/// (deno_core then recompiles and hands us a fresh one). Folder: POWERBOAT_CACHE_DIR, default
/// <game>/.powerboat-cache; POWERBOAT_CODE_CACHE=0 turns it off.
fn install_code_cache(runtime: &JsRuntime, root: Option<&std::path::Path>) {
    if std::env::var("POWERBOAT_CODE_CACHE").map(|v| v == "0").unwrap_or(false) {
        return;
    }
    let dir = match std::env::var_os("POWERBOAT_CACHE_DIR") {
        Some(d) => PathBuf::from(d),
        None => match root {
            Some(r) => r.join(".powerboat-cache"),
            None => return,
        },
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[powerboat] code cache off: {}: {e}", dir.display());
        return;
    }
    let stats = std::rc::Rc::new(std::cell::Cell::new((0u32, 0u32, 0u64)));
    let dir_get = dir.clone();
    let stats_get = stats.clone();
    #[allow(clippy::type_complexity)]
    let get: Box<dyn Fn(&deno_core::url::Url, &[u16]) -> Result<deno_core::SourceCodeCacheInfo, deno_error::JsErrorBox>> = Box::new(move |_url, source| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        source.hash(&mut h);
        let hash = h.finish();
        let file = dir_get.join(format!("{hash:016x}.v8c"));
        let data = std::fs::read(&file).ok();
        let (hits, misses, bytes) = stats_get.get();
        match &data {
            Some(d) => stats_get.set((hits + 1, misses, bytes + d.len() as u64)),
            None => stats_get.set((hits, misses + 1, bytes)),
        }
        Ok(deno_core::SourceCodeCacheInfo { hash, data: data.map(std::borrow::Cow::Owned) })
    });
    let dir_put = dir.clone();
    let ready: Box<dyn Fn(deno_core::url::Url, u64, &[u8])> = Box::new(move |_url, hash, data| {
        let file = dir_put.join(format!("{hash:016x}.v8c"));
        let tmp = dir_put.join(format!("{hash:016x}.tmp"));
        if std::fs::write(&tmp, data).and_then(|_| std::fs::rename(&tmp, &file)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    });
    runtime.set_eval_context_code_cache_cbs(Some((get, ready)));
    if std::env::var_os("POWERBOAT_CACHE_DEBUG").is_some() {
        // Reported once the game is booted (a timer in JS would need an op; a thread can't touch Rc).
        CODE_CACHE_STATS.with(|s| *s.borrow_mut() = Some(stats));
    }
}

thread_local! {
    static CODE_CACHE_STATS: std::cell::RefCell<Option<std::rc::Rc<std::cell::Cell<(u32, u32, u64)>>>> = const { std::cell::RefCell::new(None) };
}

fn report_code_cache() {
    CODE_CACHE_STATS.with(|s| {
        if let Some(st) = s.borrow().as_ref() {
            let (hits, misses, bytes) = st.get();
            eprintln!("[powerboat] code cache: {hits} hits ({} KB read), {misses} compiled", bytes >> 10);
        }
    });
}

// glibc malloc tuning (every target CFW is glibc). Decoded images, canvases and audio are large
// buffers that come and go; glibc's adaptive mmap threshold rises after the first large free, and
// later large buffers then land in the heap, where freed space is rarely returned. A fixed
// threshold keeps them in their own mappings (returned on free); malloc_trim hands back the rest.
extern "C" {
    fn mallopt(param: std::ffi::c_int, value: std::ffi::c_int) -> std::ffi::c_int;
    fn malloc_trim(pad: usize) -> std::ffi::c_int;
}
const M_MMAP_THRESHOLD: std::ffi::c_int = -3;

fn tune_malloc() {
    if std::env::var("POWERBOAT_MALLOC_TUNE").map(|v| v == "0").unwrap_or(false) {
        return;
    }
    unsafe {
        mallopt(M_MMAP_THRESHOLD, 256 * 1024);
    }
}

fn trim_malloc() {
    if std::env::var("POWERBOAT_MALLOC_TUNE").map(|v| v == "0").unwrap_or(false) {
        return;
    }
    unsafe {
        malloc_trim(0);
    }
}

thread_local! {
    static SKIPPED_PRESENTS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

// glibc floor 2.28 (docker/build.sh links against Debian 10's glibc): V8 calls gettid(), which
// glibc only exports from 2.30. This definition satisfies it at link time on every glibc.
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
#[no_mangle]
pub extern "C" fn gettid() -> std::ffi::c_int {
    extern "C" {
        fn syscall(num: std::ffi::c_long, ...) -> std::ffi::c_long;
    }
    const SYS_GETTID: std::ffi::c_long = 178; // aarch64
    unsafe { syscall(SYS_GETTID) as std::ffi::c_int }
}

/// `--game` may name the www folder, the game folder holding it, or a folder with one game folder
/// in it (what a player copies into a port's gamedata/). Exits with a message when there is no game
/// or more than one.
fn find_game(dir: &std::path::Path) -> PathBuf {
    // Empty counts as unset (scripts pass POWERBOAT_INDEX='' through), as in the JS boot.
    let index = std::env::var("POWERBOAT_INDEX").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "index.html".into());
    let is_game = |d: &std::path::Path| d.join(&index).is_file();
    // An NW.js app whose package.json "main" is a page in a subfolder (e.g. assets/node-webkit.html):
    // the page's folder is the web root (its relative URLs resolve there) and the page is the index.
    let nw_main = |d: &std::path::Path| -> Option<(PathBuf, String)> {
        let text = std::fs::read_to_string(d.join("package.json")).ok()?;
        let v: deno_core::serde_json::Value = deno_core::serde_json::from_str(&text).ok()?;
        let main = v.get("main")?.as_str()?.trim_start_matches("./").replace('\\', "/");
        if !main.ends_with(".html") && !main.ends_with(".htm") {
            return None;
        }
        let page = d.join(&main);
        let name = page.file_name()?.to_string_lossy().into_owned();
        page.is_file().then(|| (page.parent().unwrap_or(d).to_path_buf(), name))
    };
    let here = |d: &std::path::Path| -> Option<PathBuf> {
        if is_game(d) {
            Some(d.to_path_buf())
        } else if is_game(&d.join("www")) {
            Some(d.join("www"))
        } else if let Some((root, page)) = nw_main(d).filter(|(_, p)| std::env::var("POWERBOAT_INDEX").map_or(true, |i| i.is_empty() || i == *p)) {
            // Single-threaded here: no other thread reads the environment yet. POWERBOAT_WEBPAGE: the full
            // page DOM (js/79_webpage.js) that such apps' jQuery and markup need.
            std::env::set_var("POWERBOAT_INDEX", &page);
            if std::env::var_os("POWERBOAT_WEBPAGE").is_none() {
                std::env::set_var("POWERBOAT_WEBPAGE", "1");
            }
            Some(root)
        } else {
            None
        }
    };
    if let Some(g) = here(dir) {
        return g;
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).filter_map(|p| here(&p)).collect())
        .unwrap_or_default();
    found.sort();
    match found.len() {
        1 => {
            let g = found.remove(0);
            println!("[powerboat] game: {}", g.display());
            g
        }
        0 => {
            eprintln!("powerboat: no game in {}: copy the game folder (or its www folder) there", dir.display());
            std::process::exit(1);
        }
        _ => {
            eprintln!("powerboat: more than one game in {}; keep one:", dir.display());
            for g in &found {
                eprintln!("  {}", g.display());
            }
            std::process::exit(1);
        }
    }
}
