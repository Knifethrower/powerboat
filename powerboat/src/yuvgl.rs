//! Video frames to RGBA on the GPU: the I420 planes go up as three R8 textures and a fullscreen
//! quad converts them (limited range BT.601/709) into the destination texture through an FBO. On
//! the RG Cube XX the CPU conversion of a 720p frame cost about as much as decoding it, and the
//! RGBA upload is 2.7x the bytes of the planes. The GL state this touches is saved and put back,
//! so the game's view of it (and 10_webgl.js's) is unchanged. POWERBOAT_VIDEO_GPU=0 keeps the CPU path.
//! Hardware decoder pictures skip the upload: their dmabuf planes are imported as R8 + GR88 textures
//! (EGL_EXT_image_dma_buf_import) and drawn with the same NV12 shader; drivers that refuse 8-bit
//! planes get each plane as an RGBA (AB24) image a quarter as wide, unpacked byte by byte in a GLSL
//! ES 3.00 shader (PowerVR GE8300 imports only RGB formats), and last the whole NV12 picture as one
//! external image (the driver converts, with BT.601/709 and limited range hints). On the R36S 2GB the
//! 1080p plane upload cost 25 ms a frame. POWERBOAT_VIDEO_ZEROCOPY=0 copies them like other frames,
//! =rgba starts at the RGBA-packed planes, =nv12 at the one NV12 image.

use glow::HasContext;
use std::ffi::{c_char, c_void, CStr};
use std::num::NonZeroU32;

const VS: &str = "attribute vec2 p;
uniform float flip;
varying vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, mix(p.y * 0.5 + 0.5, 0.5 - p.y * 0.5, flip));
  gl_Position = vec4(p, 0.0, 1.0);
}";
// NV12 (hardware decoders): Y as R8, interleaved UV as RG8.
const FS_NV12: &str = "precision mediump float;
uniform sampler2D ty, tu;
uniform vec4 k;
varying vec2 uv;
void main() {
  float y = (texture2D(ty, uv).r - 0.0627451) * 1.1643836;
  vec2 c = texture2D(tu, uv).rg - 0.5019608;
  gl_FragColor = vec4(y + k.x * c.y, y - k.y * c.x - k.z * c.y, y + k.w * c.x, 1.0);
}";
// Zero-copy fallback: the whole NV12 dmabuf as one external image, converted by the driver.
const TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
const FS_EXT: &str = "#extension GL_OES_EGL_image_external : require
precision mediump float;
uniform samplerExternalOES ty;
varying vec2 uv;
void main() {
  gl_FragColor = vec4(texture2D(ty, uv).rgb, 1.0);
}";
// The same in GLSL ES 3.00, for drivers whose ES 2 compiler lacks the extension (PowerVR GE8300 has only
// GL_OES_EGL_image_external_essl3).
const VS3: &str = "#version 300 es
in vec2 p;
uniform float flip;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, mix(p.y * 0.5 + 0.5, 0.5 - p.y * 0.5, flip));
  gl_Position = vec4(p, 0.0, 1.0);
}";
const FS_EXT3: &str = "#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision mediump float;
uniform samplerExternalOES ty;
in vec2 uv;
out vec4 color;
void main() {
  color = vec4(texture(ty, uv).rgb, 1.0);
}";
// NV12 planes imported as AB24 (bytes R, G, B, A in memory order) at a quarter of the width: four
// luma bytes, or two UV pairs, per texel. The destination is w x h, so gl_FragCoord is the pixel.
const FS_PACKED3: &str = "#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D ty, tu;
uniform vec4 k;
uniform float flip;
uniform vec2 sz;
out vec4 color;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  if (flip > 0.5) q.y = int(sz.y) - 1 - q.y;
  vec4 l = texelFetch(ty, ivec2(q.x >> 2, q.y), 0);
  int i = q.x & 3;
  float y = ((i == 0 ? l.r : i == 1 ? l.g : i == 2 ? l.b : l.a) - 0.0627451) * 1.1643836;
  vec4 u = texelFetch(tu, ivec2(q.x >> 2, q.y >> 1), 0);
  vec2 c = ((q.x & 2) == 0 ? u.rg : u.ba) - 0.5019608;
  color = vec4(y + k.x * c.y, y - k.y * c.x - k.z * c.y, y + k.w * c.x, 1.0);
}";
const FS: &str = "precision mediump float;
uniform sampler2D ty, tu, tv;
uniform vec4 k;
varying vec2 uv;
void main() {
  float y = (texture2D(ty, uv).r - 0.0627451) * 1.1643836;
  float u = texture2D(tu, uv).r - 0.5019608;
  float v = texture2D(tv, uv).r - 0.5019608;
  gl_FragColor = vec4(y + k.x * v, y - k.y * u - k.z * v, y + k.w * u, 1.0);
}";

struct Prog {
    prog: glow::NativeProgram,
    u_flip: Option<glow::NativeUniformLocation>,
    u_k: Option<glow::NativeUniformLocation>,
    u_sz: Option<glow::NativeUniformLocation>,
}

pub struct YuvGl {
    /// I420, NV12.
    progs: [Prog; 2],
    vao: glow::NativeVertexArray,
    vbo: glow::NativeBuffer,
    fbo: glow::NativeFramebuffer,
    tex: [glow::NativeTexture; 3],
    /// (width, height, internal format) of each plane texture.
    sizes: [(i32, i32, u32); 3],
    /// Zero-copy: Y and UV textures bound to dmabuf images; egl: None = not looked up, Some(None) = unavailable.
    imp: Option<[glow::NativeTexture; 2]>,
    egl: Option<Option<Egl>>,
    /// The import that works here: per-plane (8-bit, else RGBA-packed with its program), else one
    /// external NV12 image (with its program).
    packed: bool,
    packed_prog: Option<Prog>,
    ext: bool,
    ext_prog: Option<Prog>,
    ext_tex: Option<glow::NativeTexture>,
}

type CreateImage = unsafe extern "C" fn(*mut c_void, *mut c_void, u32, *mut c_void, *const i32) -> *mut c_void;
type DestroyImage = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32;
type TargetTexture = unsafe extern "C" fn(u32, *mut c_void);

struct Egl {
    _lib: libloading::Library,
    dpy: *mut c_void,
    create: CreateImage,
    destroy: DestroyImage,
    target: TargetTexture,
    error: unsafe extern "C" fn() -> i32,
    /// eglQueryDmaBufFormatsEXT's fourccs, for the refusal message.
    formats: String,
}

/// The current context's EGL display and the dmabuf import functions (the runtime's GL context is SDL's EGL one).
fn load_egl(gl: &glow::Context) -> Result<Egl, String> {
    if std::env::var("POWERBOAT_VIDEO_ZEROCOPY").is_ok_and(|v| v == "0") {
        return Err("POWERBOAT_VIDEO_ZEROCOPY=0".into());
    }
    if !gl.supported_extensions().contains("GL_OES_EGL_image") {
        return Err("no GL_OES_EGL_image".into());
    }
    let lib = ["libEGL.so.1", "libEGL.so"].iter().find_map(|n| unsafe { libloading::Library::new(n) }.ok()).ok_or("no libEGL")?;
    unsafe {
        let e = |e: libloading::Error| e.to_string();
        let current: unsafe extern "C" fn() -> *mut c_void = *lib.get(b"eglGetCurrentDisplay\0").map_err(e)?;
        let query: unsafe extern "C" fn(*mut c_void, i32) -> *const c_char = *lib.get(b"eglQueryString\0").map_err(e)?;
        let proc_addr: unsafe extern "C" fn(*const c_char) -> *mut c_void = *lib.get(b"eglGetProcAddress\0").map_err(e)?;
        let error: unsafe extern "C" fn() -> i32 = *lib.get(b"eglGetError\0").map_err(e)?;
        let dpy = current();
        if dpy.is_null() {
            return Err("no current EGL display".into());
        }
        let ext = query(dpy, 0x3055); // EGL_EXTENSIONS
        if ext.is_null() || !CStr::from_ptr(ext).to_string_lossy().contains("EGL_EXT_image_dma_buf_import") {
            return Err("no EGL_EXT_image_dma_buf_import".into());
        }
        let create = proc_addr(c"eglCreateImageKHR".as_ptr());
        let destroy = proc_addr(c"eglDestroyImageKHR".as_ptr());
        let target = proc_addr(c"glEGLImageTargetTexture2DOES".as_ptr());
        if create.is_null() || destroy.is_null() || target.is_null() {
            return Err("no eglCreateImageKHR/glEGLImageTargetTexture2DOES".into());
        }
        let mut formats = String::from("unknown");
        let qf = proc_addr(c"eglQueryDmaBufFormatsEXT".as_ptr());
        if !qf.is_null() {
            let qf = std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void, i32, *mut i32, *mut i32) -> u32>(qf);
            let mut buf = [0i32; 64];
            let mut n = 0;
            if qf(dpy, buf.len() as i32, buf.as_mut_ptr(), &mut n) != 0 {
                formats = buf[..n.clamp(0, 64) as usize].iter().map(|&f| f.to_le_bytes().iter().map(|&b| b as char).collect::<String>()).collect::<Vec<_>>().join(" ");
            }
        }
        Ok(Egl {
            formats,
            dpy,
            create: std::mem::transmute::<*mut c_void, CreateImage>(create),
            destroy: std::mem::transmute::<*mut c_void, DestroyImage>(destroy),
            target: std::mem::transmute::<*mut c_void, TargetTexture>(target),
            error,
            _lib: lib,
        })
    }
}

unsafe fn program(gl: &glow::Context, fsrc: &str) -> Result<Prog, String> {
    program_with(gl, VS, fsrc)
}

unsafe fn program_with(gl: &glow::Context, vsrc: &str, fsrc: &str) -> Result<Prog, String> {
    let vs = shader(gl, glow::VERTEX_SHADER, vsrc)?;
    let fs = shader(gl, glow::FRAGMENT_SHADER, fsrc)?;
    let prog = gl.create_program()?;
    gl.attach_shader(prog, vs);
    gl.attach_shader(prog, fs);
    gl.bind_attrib_location(prog, 0, "p");
    gl.link_program(prog);
    gl.delete_shader(vs);
    gl.delete_shader(fs);
    if !gl.get_program_link_status(prog) {
        return Err(format!("yuv program: {}", gl.get_program_info_log(prog)));
    }
    gl.use_program(Some(prog));
    for (i, n) in ["ty", "tu", "tv"].iter().enumerate() {
        gl.uniform_1_i32(gl.get_uniform_location(prog, n).as_ref(), i as i32);
    }
    Ok(Prog {
        u_flip: gl.get_uniform_location(prog, "flip"),
        u_k: gl.get_uniform_location(prog, "k"),
        u_sz: gl.get_uniform_location(prog, "sz"),
        prog,
    })
}

unsafe fn plane_texture(gl: &glow::Context) -> Result<glow::NativeTexture, String> {
    let t = gl.create_texture()?;
    gl.bind_texture(glow::TEXTURE_2D, Some(t));
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
    Ok(t)
}

pub fn enabled() -> bool {
    std::env::var("POWERBOAT_VIDEO_GPU").map_or(true, |v| v != "0")
}

unsafe fn shader(gl: &glow::Context, kind: u32, src: &str) -> Result<glow::NativeShader, String> {
    let s = gl.create_shader(kind)?;
    gl.shader_source(s, src);
    gl.compile_shader(s);
    if !gl.get_shader_compile_status(s) {
        let log = gl.get_shader_info_log(s);
        gl.delete_shader(s);
        return Err(format!("yuv shader: {log}"));
    }
    Ok(s)
}

impl YuvGl {
    pub fn new(gl: &glow::Context) -> Result<Self, String> {
        unsafe {
            let saved = Saved::take(gl);
            let r = (|| {
                let mut progs = Vec::new();
                for fsrc in [FS, FS_NV12] {
                    progs.push(program(gl, fsrc)?);
                }
                let nv12 = progs.pop().unwrap();
                let i420 = progs.pop().unwrap();
                let vao = gl.create_vertex_array()?;
                let vbo = gl.create_buffer()?;
                gl.bind_vertex_array(Some(vao));
                gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));
                let quad: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
                let bytes: Vec<u8> = quad.iter().flat_map(|f| f.to_ne_bytes()).collect();
                gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, &bytes, glow::STATIC_DRAW);
                gl.enable_vertex_attrib_array(0);
                gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 8, 0);
                let mut tex = Vec::new();
                for _ in 0..3 {
                    tex.push(plane_texture(gl)?);
                }
                let fbo = gl.create_framebuffer()?;
                Ok(Self {
                    progs: [i420, nv12],
                    vao,
                    vbo,
                    fbo,
                    tex: [tex[0], tex[1], tex[2]],
                    sizes: [(0, 0, 0); 3],
                    imp: None,
                    egl: None,
                    packed: std::env::var("POWERBOAT_VIDEO_ZEROCOPY").is_ok_and(|v| v == "rgba"),
                    packed_prog: None,
                    ext: std::env::var("POWERBOAT_VIDEO_ZEROCOPY").is_ok_and(|v| v == "nv12"),
                    ext_prog: None,
                    ext_tex: None,
                })
            })();
            saved.restore(gl);
            r
        }
    }

    /// Converts one I420 frame (tightly packed planes, w x h luma) into level 0 of `dst`, which is
    /// (re)allocated as RGBA w x h. `flip`: the picture's top row at the texture's top (WebGL's
    /// UNPACK_FLIP_Y); without it the top row lands at t = 0, as texImage2D of pixel rows does.
    /// nv12: planes[0] = Y, planes[1] = interleaved UV (planes[2] unused).
    #[allow(clippy::too_many_arguments)]
    pub fn convert(&mut self, gl: &glow::Context, planes: &[Vec<u8>; 3], w: usize, h: usize, bt709: bool, nv12: bool, flip: bool, dst: glow::NativeTexture) {
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        let layout: &[(usize, usize, u32, u32, usize)] = if nv12 {
            &[(w, h, glow::R8, glow::RED, 1), (cw, ch, glow::RG8, glow::RG, 2)]
        } else {
            &[(w, h, glow::R8, glow::RED, 1), (cw, ch, glow::R8, glow::RED, 1), (cw, ch, glow::R8, glow::RED, 1)]
        };
        unsafe {
            let saved = Saved::take(gl);
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            for (i, &(pw, ph, ifmt, fmt, bpp)) in layout.iter().enumerate() {
                gl.active_texture(glow::TEXTURE0 + i as u32);
                gl.bind_texture(glow::TEXTURE_2D, Some(self.tex[i]));
                let data = glow::PixelUnpackData::Slice(Some(&planes[i][..pw * ph * bpp]));
                if self.sizes[i] != (pw as i32, ph as i32, ifmt) {
                    gl.tex_image_2d(glow::TEXTURE_2D, 0, ifmt as i32, pw as i32, ph as i32, 0, fmt, glow::UNSIGNED_BYTE, data);
                    self.sizes[i] = (pw as i32, ph as i32, ifmt);
                } else {
                    gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, 0, 0, pw as i32, ph as i32, fmt, glow::UNSIGNED_BYTE, data);
                }
            }
            self.draw(gl, &self.progs[nv12 as usize], w, h, bt709, flip, dst);
            saved.restore(gl);
        }
    }

    /// A hardware decoder's NV12 picture straight from its dmabuf (no upload); false = not possible here
    /// (no dmabuf, tiled/compressed layout, no EGL import): the caller copies the planes instead.
    #[allow(clippy::too_many_arguments)]
    pub fn convert_dmabuf(&mut self, gl: &glow::Context, p: &crate::hwdec::Picture, w: usize, h: usize, bt709: bool, flip: bool, dst: glow::NativeTexture) -> bool {
        if p.dmabuf_fd < 0 || p.drm_modifier != 0 || p.left != 0 || p.top != 0 {
            return false;
        }
        if self.egl.is_none() {
            let e = load_egl(gl);
            if std::env::var_os("POWERBOAT_VIDEO_DEBUG").is_some() {
                match &e {
                    Ok(_) => eprintln!("[powerboat] video: zero-copy dmabuf import"),
                    Err(m) => eprintln!("[powerboat] video: no zero-copy ({m}): frames are copied"),
                }
            }
            self.egl = Some(e.ok());
        }
        if !self.ext {
            if !self.packed {
                if unsafe { self.import_planes(gl, p, w, h, bt709, flip, dst, false) } {
                    return true;
                }
                if !matches!(self.egl, Some(Some(_))) {
                    return false;
                }
                self.packed = true;
            }
            if unsafe { self.import_planes(gl, p, w, h, bt709, flip, dst, true) } {
                return true;
            }
            if !matches!(self.egl, Some(Some(_))) {
                return false;
            }
            self.ext = true;
        }
        if unsafe { self.import_nv12(gl, p, w, h, bt709, flip, dst) } {
            return true;
        }
        self.egl = Some(None);
        false
    }

    /// Y as R8 and UV as GR88 images, our NV12 shader (exact colors); `packed`: both as AB24 images a
    /// quarter as wide and the unpacking shader. false: refused (EGL kept for the next try).
    #[allow(clippy::too_many_arguments)]
    unsafe fn import_planes(&mut self, gl: &glow::Context, p: &crate::hwdec::Picture, w: usize, h: usize, bt709: bool, flip: bool, dst: glow::NativeTexture, packed: bool) -> bool {
        let Some(Some(e)) = &self.egl else { return false };
        let (dpy, create, destroy, target, error) = (e.dpy, e.create, e.destroy, e.target, e.error);
        const DRM_R8: i32 = 0x20203852;
        const DRM_GR88: i32 = 0x38385247;
        const DRM_AB24: i32 = 0x34324241;
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        let next = if packed { "trying one NV12 image" } else { "trying RGBA-packed planes" };
        let planes = if packed {
            if w % 4 != 0 || p.stride[0] % 4 != 0 || p.stride[1] % 4 != 0 || p.offset[1] % 4 != 0 {
                eprintln!("[powerboat] video: {w}x{h} (pitches {} {}) can't be imported as RGBA-packed planes: {next}", p.stride[0], p.stride[1]);
                return false;
            }
            if self.packed_prog.is_none() {
                let saved = Saved::take(gl);
                let r = program_with(gl, VS3, FS_PACKED3);
                saved.restore(gl);
                match r {
                    Ok(pr) => self.packed_prog = Some(pr),
                    Err(m) => {
                        eprintln!("[powerboat] video: RGBA-packed plane shader: {}: {next}", m.trim());
                        return false;
                    }
                }
            }
            [(DRM_AB24, w / 4, h, p.offset[0], p.stride[0]), (DRM_AB24, w / 4, ch, p.offset[1], p.stride[1])]
        } else {
            [(DRM_R8, w, h, p.offset[0], p.stride[0]), (DRM_GR88, cw, ch, p.offset[1], p.stride[1])]
        };
        let mut imgs = [std::ptr::null_mut(); 2];
        for (i, &(fourcc, pw, ph, off, pitch)) in planes.iter().enumerate() {
            // EGL_WIDTH, EGL_HEIGHT, EGL_LINUX_DRM_FOURCC_EXT, EGL_DMA_BUF_PLANE0_FD/OFFSET/PITCH_EXT, EGL_NONE
            let a: [i32; 13] = [0x3057, pw as i32, 0x3056, ph as i32, 0x3271, fourcc, 0x3272, p.dmabuf_fd, 0x3273, off as i32, 0x3274, pitch, 0x3038];
            imgs[i] = create(dpy, std::ptr::null_mut(), 0x3270, std::ptr::null_mut(), a.as_ptr()); // EGL_LINUX_DMA_BUF_EXT
            if imgs[i].is_null() {
                let err = error();
                for im in &imgs[..i] {
                    destroy(dpy, *im);
                }
                let kind = if packed { "RGBA-packed plane" } else { "per-plane" };
                eprintln!("[powerboat] video: {kind} dmabuf import refused (plane {i}, {pw}x{ph}, pitch {pitch}, EGL 0x{err:x}): {next}");
                return false;
            }
        }
        let saved = Saved::take(gl);
        let imp = match self.imp {
            Some(t) => t,
            None => {
                let (Ok(a), Ok(b)) = (plane_texture(gl), plane_texture(gl)) else {
                    saved.restore(gl);
                    return false;
                };
                self.imp = Some([a, b]);
                [a, b]
            }
        };
        while gl.get_error() != glow::NO_ERROR {}
        for i in 0..2 {
            gl.active_texture(glow::TEXTURE0 + i as u32);
            gl.bind_texture(glow::TEXTURE_2D, Some(imp[i]));
            target(glow::TEXTURE_2D, imgs[i]);
        }
        // The textures keep the buffers: the images themselves can go.
        for im in imgs {
            destroy(dpy, im);
        }
        let err = gl.get_error();
        if err != glow::NO_ERROR {
            eprintln!("[powerboat] video: glEGLImageTargetTexture2DOES refused the planes (0x{err:x}): {next}");
            saved.restore(gl);
            return false;
        }
        let prog = if packed { self.packed_prog.as_ref().unwrap() } else { &self.progs[1] };
        if packed {
            gl.use_program(Some(prog.prog));
            gl.uniform_2_f32(prog.u_sz.as_ref(), w as f32, h as f32);
        }
        self.draw(gl, prog, w, h, bt709, flip, dst);
        saved.restore(gl);
        true
    }

    /// The whole picture as one NV12 external image; the driver converts (BT.601/709, limited range hints).
    #[allow(clippy::too_many_arguments)]
    unsafe fn import_nv12(&mut self, gl: &glow::Context, p: &crate::hwdec::Picture, w: usize, h: usize, bt709: bool, flip: bool, dst: glow::NativeTexture) -> bool {
        let Some(Some(e)) = &self.egl else { return false };
        let (dpy, create, destroy, target, error) = (e.dpy, e.create, e.destroy, e.target, e.error);
        if self.ext_prog.is_none() {
            // Not decisive: the shader compile below is. (PowerVR GE8300 ships the extension but did not
            // list it in this check.)
            let exts = gl.supported_extensions();
            if !exts.contains("GL_OES_EGL_image_external") {
                let mut near: Vec<&String> = exts.iter().filter(|e| e.contains("EGL_image") || e.contains("YUV")).collect();
                near.sort();
                eprintln!("[powerboat] video: GL_OES_EGL_image_external not listed ({} extensions; related: {near:?}): trying the shader anyway", exts.len());
            }
            let saved = Saved::take(gl);
            let r = program(gl, FS_EXT).or_else(|m| {
                program_with(gl, VS3, FS_EXT3).map_err(|m3| format!("{} / ES 3.00: {}", m.trim(), m3.trim()))
            });
            saved.restore(gl);
            match r {
                Ok(pr) => self.ext_prog = Some(pr),
                Err(m) => {
                    eprintln!("[powerboat] video: external image shader: {m}: frames are copied");
                    return false;
                }
            }
        }
        const DRM_NV12: i32 = 0x3231564E;
        let space = if bt709 { 0x3280 } else { 0x327F }; // EGL_ITU_REC709_EXT / EGL_ITU_REC601_EXT
        // ... PLANE0 fd/offset/pitch, PLANE1 fd/offset/pitch, EGL_YUV_COLOR_SPACE_HINT_EXT, EGL_SAMPLE_RANGE_HINT_EXT (narrow)
        let a: [i32; 23] = [
            0x3057, w as i32, 0x3056, h as i32, 0x3271, DRM_NV12,
            0x3272, p.dmabuf_fd, 0x3273, p.offset[0] as i32, 0x3274, p.stride[0],
            0x3275, p.dmabuf_fd, 0x3276, p.offset[1] as i32, 0x3277, p.stride[1],
            0x327B, space, 0x327C, 0x3283, 0x3038,
        ];
        let mut img = create(dpy, std::ptr::null_mut(), 0x3270, std::ptr::null_mut(), a.as_ptr());
        if img.is_null() {
            let first = error();
            // Some drivers refuse the color hints: once more without them.
            let mut b = a;
            b[18] = 0x3038;
            img = create(dpy, std::ptr::null_mut(), 0x3270, std::ptr::null_mut(), b.as_ptr());
            if img.is_null() {
                let formats = &self.egl.as_ref().and_then(|e| e.as_ref()).map_or("", |e| e.formats.as_str()).to_owned();
                eprintln!(
                    "[powerboat] video: NV12 dmabuf import refused ({w}x{h}, offsets {} {}, pitches {} {}, EGL 0x{first:x}, without hints 0x{:x}; driver formats: {formats}): frames are copied",
                    p.offset[0], p.offset[1], p.stride[0], p.stride[1], error()
                );
                return false;
            }
            eprintln!("[powerboat] video: NV12 dmabuf import needs no color hints here");
        }
        let saved = Saved::take(gl);
        // A texture of its own: one first bound as TEXTURE_2D can't become an external one.
        let tex = match self.ext_tex {
            Some(t) => t,
            None => {
                let Ok(t) = gl.create_texture() else {
                    destroy(dpy, img);
                    saved.restore(gl);
                    return false;
                };
                gl.active_texture(glow::TEXTURE0);
                gl.bind_texture(TEXTURE_EXTERNAL_OES, Some(t));
                gl.tex_parameter_i32(TEXTURE_EXTERNAL_OES, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
                gl.tex_parameter_i32(TEXTURE_EXTERNAL_OES, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
                gl.tex_parameter_i32(TEXTURE_EXTERNAL_OES, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
                gl.tex_parameter_i32(TEXTURE_EXTERNAL_OES, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
                self.ext_tex = Some(t);
                t
            }
        };
        while gl.get_error() != glow::NO_ERROR {}
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(TEXTURE_EXTERNAL_OES, Some(tex));
        target(TEXTURE_EXTERNAL_OES, img);
        destroy(dpy, img);
        let err = gl.get_error();
        if err != glow::NO_ERROR {
            gl.bind_texture(TEXTURE_EXTERNAL_OES, None);
            eprintln!("[powerboat] video: glEGLImageTargetTexture2DOES refused the NV12 image (0x{err:x}): frames are copied");
            saved.restore(gl);
            return false;
        }
        let prog = self.ext_prog.as_ref().unwrap();
        self.draw(gl, prog, w, h, bt709, flip, dst);
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(TEXTURE_EXTERNAL_OES, None);
        saved.restore(gl);
        true
    }

    /// The conversion draw: plane textures bound on units 0.. (2 for NV12, 3 for I420), `dst` gets RGBA w x h.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw(&self, gl: &glow::Context, p: &Prog, w: usize, h: usize, bt709: bool, flip: bool, dst: glow::NativeTexture) {
        {
            // The destination: storage of the frame's size, attached to our FBO.
            gl.active_texture(glow::TEXTURE3);
            gl.bind_texture(glow::TEXTURE_2D, Some(dst));
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w as i32, h as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
            gl.bind_texture(glow::TEXTURE_2D, None);
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(dst), 0);
            gl.viewport(0, 0, w as i32, h as i32);
            for cap in [glow::SCISSOR_TEST, glow::BLEND, glow::DEPTH_TEST, glow::STENCIL_TEST, glow::CULL_FACE] {
                gl.disable(cap);
            }
            gl.color_mask(true, true, true, true);
            gl.use_program(Some(p.prog));
            gl.uniform_1_f32(p.u_flip.as_ref(), if flip { 1.0 } else { 0.0 });
            let k = if bt709 { [1.7927411, 0.2132486, 0.5329093, 2.1124018] } else { [1.5960268, 0.3917623, 0.8129676, 2.0172321] };
            gl.uniform_4_f32(p.u_k.as_ref(), k[0], k[1], k[2], k[3]);
            gl.bind_vertex_array(Some(self.vao));
            gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
            gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, None, 0);
        }
    }

    pub fn delete(&self, gl: &glow::Context) {
        unsafe {
            for p in self.progs.iter().chain(self.packed_prog.as_ref()).chain(self.ext_prog.as_ref()) {
                gl.delete_program(p.prog);
            }
            gl.delete_vertex_array(self.vao);
            gl.delete_buffer(self.vbo);
            gl.delete_framebuffer(self.fbo);
            for t in self.tex.into_iter().chain(self.imp.into_iter().flatten()).chain(self.ext_tex) {
                gl.delete_texture(t);
            }
        }
    }
}

/// The GL state convert() changes.
struct Saved {
    program: u32,
    vao: u32,
    array_buffer: u32,
    draw_fbo: u32,
    read_fbo: u32,
    viewport: [i32; 4],
    active: u32,
    tex: [u32; 4],
    caps: [bool; 5],
    mask: [bool; 4],
    align: i32,
}

fn nz(v: i32) -> Option<NonZeroU32> {
    NonZeroU32::new(v as u32)
}

impl Saved {
    unsafe fn take(gl: &glow::Context) -> Self {
        let active = gl.get_parameter_i32(glow::ACTIVE_TEXTURE) as u32;
        let mut tex = [0u32; 4];
        for (i, t) in tex.iter_mut().enumerate() {
            gl.active_texture(glow::TEXTURE0 + i as u32);
            *t = gl.get_parameter_i32(glow::TEXTURE_BINDING_2D) as u32;
        }
        gl.active_texture(active);
        let mut viewport = [0i32; 4];
        gl.get_parameter_i32_slice(glow::VIEWPORT, &mut viewport);
        let mut m = [0i32; 4];
        gl.get_parameter_i32_slice(glow::COLOR_WRITEMASK, &mut m);
        Self {
            program: gl.get_parameter_i32(glow::CURRENT_PROGRAM) as u32,
            vao: gl.get_parameter_i32(glow::VERTEX_ARRAY_BINDING) as u32,
            array_buffer: gl.get_parameter_i32(glow::ARRAY_BUFFER_BINDING) as u32,
            draw_fbo: gl.get_parameter_i32(glow::DRAW_FRAMEBUFFER_BINDING) as u32,
            read_fbo: gl.get_parameter_i32(glow::READ_FRAMEBUFFER_BINDING) as u32,
            viewport,
            active,
            tex,
            caps: [glow::SCISSOR_TEST, glow::BLEND, glow::DEPTH_TEST, glow::STENCIL_TEST, glow::CULL_FACE].map(|c| gl.is_enabled(c)),
            mask: m.map(|v| v != 0),
            align: gl.get_parameter_i32(glow::UNPACK_ALIGNMENT),
        }
    }
    unsafe fn restore(&self, gl: &glow::Context) {
        gl.use_program(nz(self.program as i32).map(glow::NativeProgram));
        gl.bind_vertex_array(nz(self.vao as i32).map(glow::NativeVertexArray));
        gl.bind_buffer(glow::ARRAY_BUFFER, nz(self.array_buffer as i32).map(glow::NativeBuffer));
        gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, nz(self.draw_fbo as i32).map(glow::NativeFramebuffer));
        gl.bind_framebuffer(glow::READ_FRAMEBUFFER, nz(self.read_fbo as i32).map(glow::NativeFramebuffer));
        gl.viewport(self.viewport[0], self.viewport[1], self.viewport[2], self.viewport[3]);
        for (i, t) in self.tex.iter().enumerate() {
            gl.active_texture(glow::TEXTURE0 + i as u32);
            gl.bind_texture(glow::TEXTURE_2D, nz(*t as i32).map(glow::NativeTexture));
        }
        gl.active_texture(self.active);
        for (c, on) in [glow::SCISSOR_TEST, glow::BLEND, glow::DEPTH_TEST, glow::STENCIL_TEST, glow::CULL_FACE].into_iter().zip(self.caps) {
            if on {
                gl.enable(c);
            } else {
                gl.disable(c);
            }
        }
        gl.color_mask(self.mask[0], self.mask[1], self.mask[2], self.mask[3]);
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, self.align);
    }
}
