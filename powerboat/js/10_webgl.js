// powerboat JS environment, part 2: WebGLRenderingContext over the op_gl_* ops (src/gl.rs).
// Wrapper objects (WebGLBuffer, WebGLTexture, ...) hold the raw GL name in `_id`; the ops take
// names. Binding state WebGL can be asked for (current program, bound buffers/textures/...) is
// tracked here instead of queried. OES_vertex_array_object maps to GLES 3 VAOs.
"use strict";
(() => {
  const ops = Deno.core.ops;

  // WebGL 1.0 constants (same values as GLES 2).
  const C = {
    DEPTH_BUFFER_BIT: 0x00000100, STENCIL_BUFFER_BIT: 0x00000400, COLOR_BUFFER_BIT: 0x00004000,
    POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    ZERO: 0, ONE: 1, SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305, DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307, SRC_ALPHA_SATURATE: 0x0308,
    FUNC_ADD: 0x8006, BLEND_EQUATION: 0x8009, BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883d,
    FUNC_SUBTRACT: 0x800a, FUNC_REVERSE_SUBTRACT: 0x800b,
    BLEND_DST_RGB: 0x80c8, BLEND_SRC_RGB: 0x80c9, BLEND_DST_ALPHA: 0x80ca, BLEND_SRC_ALPHA: 0x80cb,
    CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002, CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004, BLEND_COLOR: 0x8005,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
    STREAM_DRAW: 0x88e0, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8, BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765,
    CURRENT_VERTEX_ATTRIB: 0x8626, FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
    CULL_FACE: 0x0b44, BLEND: 0x0be2, DITHER: 0x0bd0, STENCIL_TEST: 0x0b90, DEPTH_TEST: 0x0b71, SCISSOR_TEST: 0x0c11,
    POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809e, SAMPLE_COVERAGE: 0x80a0,
    NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502, OUT_OF_MEMORY: 0x0505,
    CW: 0x0900, CCW: 0x0901, LINE_WIDTH: 0x0b21, ALIASED_POINT_SIZE_RANGE: 0x846d, ALIASED_LINE_WIDTH_RANGE: 0x846e,
    CULL_FACE_MODE: 0x0b45, FRONT_FACE: 0x0b46, DEPTH_RANGE: 0x0b70, DEPTH_WRITEMASK: 0x0b72, DEPTH_CLEAR_VALUE: 0x0b73, DEPTH_FUNC: 0x0b74,
    STENCIL_CLEAR_VALUE: 0x0b91, STENCIL_FUNC: 0x0b92, STENCIL_FAIL: 0x0b94, STENCIL_PASS_DEPTH_FAIL: 0x0b95, STENCIL_PASS_DEPTH_PASS: 0x0b96,
    STENCIL_REF: 0x0b97, STENCIL_VALUE_MASK: 0x0b93, STENCIL_WRITEMASK: 0x0b98, STENCIL_BACK_FUNC: 0x8800, STENCIL_BACK_FAIL: 0x8801,
    STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802, STENCIL_BACK_PASS_DEPTH_PASS: 0x8803, STENCIL_BACK_REF: 0x8ca3, STENCIL_BACK_VALUE_MASK: 0x8ca4, STENCIL_BACK_WRITEMASK: 0x8ca5,
    VIEWPORT: 0x0ba2, SCISSOR_BOX: 0x0c10, COLOR_CLEAR_VALUE: 0x0c22, COLOR_WRITEMASK: 0x0c23,
    UNPACK_ALIGNMENT: 0x0cf5, PACK_ALIGNMENT: 0x0d05, MAX_TEXTURE_SIZE: 0x0d33, MAX_VIEWPORT_DIMS: 0x0d3a,
    SUBPIXEL_BITS: 0x0d50, RED_BITS: 0x0d52, GREEN_BITS: 0x0d53, BLUE_BITS: 0x0d54, ALPHA_BITS: 0x0d55, DEPTH_BITS: 0x0d56, STENCIL_BITS: 0x0d57,
    POLYGON_OFFSET_UNITS: 0x2a00, POLYGON_OFFSET_FACTOR: 0x8038, TEXTURE_BINDING_2D: 0x8069,
    SAMPLE_BUFFERS: 0x80a8, SAMPLES: 0x80a9, SAMPLE_COVERAGE_VALUE: 0x80aa, SAMPLE_COVERAGE_INVERT: 0x80ab,
    COMPRESSED_TEXTURE_FORMATS: 0x86a3, DONT_CARE: 0x1100, FASTEST: 0x1101, NICEST: 0x1102, GENERATE_MIPMAP_HINT: 0x8192,
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
    DEPTH_COMPONENT: 0x1902, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190a,
    UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
    FRAGMENT_SHADER: 0x8b30, VERTEX_SHADER: 0x8b31, MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
    MAX_VARYING_VECTORS: 0x8dfc, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd, SHADER_TYPE: 0x8b4f, DELETE_STATUS: 0x8b80,
    LINK_STATUS: 0x8b82, VALIDATE_STATUS: 0x8b83, ATTACHED_SHADERS: 0x8b85, ACTIVE_UNIFORMS: 0x8b86, ACTIVE_ATTRIBUTES: 0x8b89,
    SHADING_LANGUAGE_VERSION: 0x8b8c, CURRENT_PROGRAM: 0x8b8d,
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
    KEEP: 0x1e00, REPLACE: 0x1e01, INCR: 0x1e02, DECR: 0x1e03, INVERT: 0x150a, INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
    VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02,
    NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701, NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
    TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    TEXTURE_2D: 0x0de1, TEXTURE: 0x1702, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_BINDING_CUBE_MAP: 0x8514,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516, TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517,
    TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518, TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851a, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
    ACTIVE_TEXTURE: 0x84e0, REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812f, MIRRORED_REPEAT: 0x8370,
    FLOAT_VEC2: 0x8b50, FLOAT_VEC3: 0x8b51, FLOAT_VEC4: 0x8b52, INT_VEC2: 0x8b53, INT_VEC3: 0x8b54, INT_VEC4: 0x8b55,
    BOOL: 0x8b56, BOOL_VEC2: 0x8b57, BOOL_VEC3: 0x8b58, BOOL_VEC4: 0x8b59, FLOAT_MAT2: 0x8b5a, FLOAT_MAT3: 0x8b5b, FLOAT_MAT4: 0x8b5c,
    SAMPLER_2D: 0x8b5e, SAMPLER_CUBE: 0x8b60,
    VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623, VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624, VERTEX_ATTRIB_ARRAY_TYPE: 0x8625,
    VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886a, VERTEX_ATTRIB_ARRAY_POINTER: 0x8645, VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889f,
    IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b, COMPILE_STATUS: 0x8b81,
    LOW_FLOAT: 0x8df0, MEDIUM_FLOAT: 0x8df1, HIGH_FLOAT: 0x8df2, LOW_INT: 0x8df3, MEDIUM_INT: 0x8df4, HIGH_INT: 0x8df5,
    FRAMEBUFFER: 0x8d40, RENDERBUFFER: 0x8d41, RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8d62, DEPTH_COMPONENT16: 0x81a5,
    STENCIL_INDEX8: 0x8d48, DEPTH_STENCIL: 0x84f9, RENDERBUFFER_WIDTH: 0x8d42, RENDERBUFFER_HEIGHT: 0x8d43, RENDERBUFFER_INTERNAL_FORMAT: 0x8d44,
    RENDERBUFFER_RED_SIZE: 0x8d50, RENDERBUFFER_GREEN_SIZE: 0x8d51, RENDERBUFFER_BLUE_SIZE: 0x8d52, RENDERBUFFER_ALPHA_SIZE: 0x8d53,
    RENDERBUFFER_DEPTH_SIZE: 0x8d54, RENDERBUFFER_STENCIL_SIZE: 0x8d55,
    FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8cd0, FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8cd1, FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8cd2,
    FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8cd3, COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00, STENCIL_ATTACHMENT: 0x8d20,
    DEPTH_STENCIL_ATTACHMENT: 0x821a, NONE: 0, FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
    FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8cd7, FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8cd9, FRAMEBUFFER_UNSUPPORTED: 0x8cdd,
    FRAMEBUFFER_BINDING: 0x8ca6, RENDERBUFFER_BINDING: 0x8ca7, MAX_RENDERBUFFER_SIZE: 0x84e8, INVALID_FRAMEBUFFER_OPERATION: 0x0506,
    UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, CONTEXT_LOST_WEBGL: 0x9242,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244,
  };
  for (let i = 0; i < 32; i++) C["TEXTURE" + i] = 0x84c0 + i;
  const VERTEX_ARRAY_BINDING_OES = 0x85b5;

  // ---- wrapper objects -------------------------------------------------------------------------
  class WebGLObject { constructor(id) { this._id = id; this._deleted = false; } }
  class WebGLBuffer extends WebGLObject {}
  class WebGLShader extends WebGLObject { constructor(id, type) { super(id); this._type = type; } }
  class WebGLProgram extends WebGLObject {}
  class WebGLTexture extends WebGLObject {}
  class WebGLFramebuffer extends WebGLObject {}
  class WebGLRenderbuffer extends WebGLObject {}
  class WebGLVertexArrayObjectOES extends WebGLObject {}
  class WebGLUniformLocation { constructor(loc, program) { this._loc = loc; this._program = program; } }
  class WebGLActiveInfo { constructor(size, type, name) { this.size = size; this.type = type; this.name = name; } }
  class WebGLShaderPrecisionFormat { constructor(rangeMin, rangeMax, precision) { this.rangeMin = rangeMin; this.rangeMax = rangeMax; this.precision = precision; } }
  const id = (o) => (o ? o._id : 0);
  const loc = (l) => (l ? l._loc : -1);
  // Typed-array views the ops want: bytes for buffer/texture data, Float32/Int32 for uniforms.
  const bytes = (d) => {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    throw new TypeError("powerboat: expected an ArrayBuffer or typed array");
  };
  const f32 = (v) => (v instanceof Float32Array ? v : new Float32Array(v));
  // An array an op writes into must live outside V8's heap. With in-heap typed arrays (a V8 built with
  // v8_typed_array_max_size_in_heap > 0, as Chrome and Node 22 are) a small one reaches a fast op as a copy on
  // the stack and the op's writes are lost; reading .buffer moves the array out of the heap for good.
  const out = (a) => (void a.buffer, a);
  // Int32 data travels as a Uint32Array view over the same bytes (the op macro has no i32 slices).
  const i32 = (v) => { const a = v instanceof Int32Array ? v : new Int32Array(v); return new Uint32Array(a.buffer, a.byteOffset, a.length); };
  // A canvas nothing has drawn on yet is a valid, transparent source (Phaser's texture manager does this).
  const isImageSource = (s) => {
    if (s instanceof HTMLCanvasElement && !s._gl) s.getContext("2d");
    return s && (s._powerboatImageId !== undefined || s._powerboatCanvasId !== undefined || s._powerboatVideoId !== undefined);
  };
  // ImageData (C3 DrawingCanvas loadImagePixelData: Moonstone Island's minimap) uploads as plain pixel data.
  const isPixelData = (s) => s && !isImageSource(s) && s.data instanceof Uint8ClampedArray && s.width > 0 && s.height > 0;

  const INT_PARAMS = new Set([
    C.ACTIVE_TEXTURE, C.ALPHA_BITS, C.BLUE_BITS, C.GREEN_BITS, C.RED_BITS, C.DEPTH_BITS, C.STENCIL_BITS, C.SUBPIXEL_BITS,
    C.BLEND_DST_ALPHA, C.BLEND_DST_RGB, C.BLEND_SRC_ALPHA, C.BLEND_SRC_RGB, C.BLEND_EQUATION_RGB, C.BLEND_EQUATION_ALPHA,
    C.CULL_FACE_MODE, C.DEPTH_FUNC, C.FRONT_FACE, C.GENERATE_MIPMAP_HINT, C.IMPLEMENTATION_COLOR_READ_FORMAT, C.IMPLEMENTATION_COLOR_READ_TYPE,
    C.MAX_COMBINED_TEXTURE_IMAGE_UNITS, C.MAX_CUBE_MAP_TEXTURE_SIZE, C.MAX_FRAGMENT_UNIFORM_VECTORS, C.MAX_RENDERBUFFER_SIZE,
    C.MAX_TEXTURE_IMAGE_UNITS, C.MAX_TEXTURE_SIZE, C.MAX_VARYING_VECTORS, C.MAX_VERTEX_ATTRIBS, C.MAX_VERTEX_TEXTURE_IMAGE_UNITS,
    C.MAX_VERTEX_UNIFORM_VECTORS, C.PACK_ALIGNMENT, C.UNPACK_ALIGNMENT, C.SAMPLE_BUFFERS, C.SAMPLES, C.STENCIL_BACK_FAIL,
    C.STENCIL_BACK_FUNC, C.STENCIL_BACK_PASS_DEPTH_FAIL, C.STENCIL_BACK_PASS_DEPTH_PASS, C.STENCIL_BACK_REF, C.STENCIL_BACK_VALUE_MASK,
    C.STENCIL_BACK_WRITEMASK, C.STENCIL_CLEAR_VALUE, C.STENCIL_FAIL, C.STENCIL_FUNC, C.STENCIL_PASS_DEPTH_FAIL, C.STENCIL_PASS_DEPTH_PASS,
    C.STENCIL_REF, C.STENCIL_VALUE_MASK, C.STENCIL_WRITEMASK,
  ]);
  const FLOAT_PARAMS = new Set([C.DEPTH_CLEAR_VALUE, C.LINE_WIDTH, C.POLYGON_OFFSET_FACTOR, C.POLYGON_OFFSET_UNITS, C.SAMPLE_COVERAGE_VALUE]);
  const BOOL_PARAMS = new Set([C.BLEND, C.CULL_FACE, C.DEPTH_TEST, C.DEPTH_WRITEMASK, C.DITHER, C.POLYGON_OFFSET_FILL, C.SAMPLE_COVERAGE_INVERT,
    C.SCISSOR_TEST, C.STENCIL_TEST, C.SAMPLE_ALPHA_TO_COVERAGE, C.SAMPLE_COVERAGE]);

  class WebGLRenderingContext {
    constructor(canvas, attrs) {
      this.canvas = canvas;
      this._attrs = Object.assign({
        alpha: true, depth: false, stencil: true, antialias: false, premultipliedAlpha: true,
        preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false, powerPreference: "default",
      }, attrs);
      // What this context reports is the real GLES setup: no depth buffer, 8-bit stencil.
      this._attrs.depth = false; this._attrs.stencil = true; this._attrs.antialias = false;
      this._lost = false;
      this._renderer = ops.op_gl_get_string(C.RENDERER);
      this._version = ops.op_gl_get_string(C.VERSION);
      this._glsl = ops.op_gl_get_string(C.SHADING_LANGUAGE_VERSION);
      this._program = null;
      this._buffers = { [C.ARRAY_BUFFER]: null, [C.ELEMENT_ARRAY_BUFFER]: null };
      this._activeUnit = 0;
      this._textures = []; // per unit: {2d, cube}
      this._framebuffer = null;
      this._renderbuffer = null;
      this._vao = null;
      this._extensions = {};
    }
    get drawingBufferWidth() { return this.canvas.width | 0; }
    get drawingBufferHeight() { return this.canvas.height | 0; }
    getContextAttributes() { return Object.assign({}, this._attrs); }
    isContextLost() { return this._lost; }
    getError() { return ops.op_gl_get_error(); }
    getSupportedExtensions() { return ["ANGLE_instanced_arrays", "OES_vertex_array_object", "WEBGL_lose_context", "OES_element_index_uint", "OES_standard_derivatives"]; }
    getExtension(name) {
      if (name in this._extensions) return this._extensions[name];
      let ext = null;
      switch (name) {
        case "WEBGL_lose_context":
          ext = {
            loseContext: () => { this._lost = true; const i = contexts.indexOf(this); if (i >= 0) contexts.splice(i, 1); applyMainSize(); },
            restoreContext: () => { this._lost = false; },
          };
          break;
        case "OES_vertex_array_object": case "MOZ_OES_vertex_array_object": case "WEBKIT_OES_vertex_array_object":
          ext = {
            VERTEX_ARRAY_BINDING_OES,
            createVertexArrayOES: () => new WebGLVertexArrayObjectOES(ops.op_gl_create_vertex_array()),
            deleteVertexArrayOES: (v) => { if (v && !v._deleted) { ops.op_gl_delete_vertex_array(v._id); v._deleted = true; if (this._vao === v) this._vao = null; } },
            isVertexArrayOES: (v) => v instanceof WebGLVertexArrayObjectOES && !v._deleted,
            bindVertexArrayOES: (v) => { this._vao = v || null; ops.op_gl_bind_vertex_array(id(v)); },
          };
          break;
        case "ANGLE_instanced_arrays":
          // Core in GLES 3. Phaser 4 refuses to start without it.
          ext = {
            VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88fe,
            vertexAttribDivisorANGLE: (i, d) => ops.op_gl_vertex_attrib_divisor(i >>> 0, d >>> 0),
            drawArraysInstancedANGLE: (mode, first, count, n) => ops.op_gl_draw_arrays_instanced(mode >>> 0, first | 0, count | 0, n | 0),
            drawElementsInstancedANGLE: (mode, count, type, offset, n) => ops.op_gl_draw_elements_instanced(mode >>> 0, count | 0, type >>> 0, offset | 0, n | 0),
          };
          break;
        case "OES_element_index_uint": case "OES_standard_derivatives":
          ext = {};
          break;
        // OES_texture_float: GLES 3 needs sized float formats; PIXI copes without it.
        default: ext = null;
      }
      this._extensions[name] = ext;
      return ext;
    }
    getParameter(p) {
      switch (p) {
        case C.VENDOR: return "powerboat";
        case C.RENDERER: return this._renderer;
        case C.VERSION: return "WebGL 1.0 (powerboat; " + this._version + ")";
        case C.SHADING_LANGUAGE_VERSION: return "WebGL GLSL ES 1.0 (" + this._glsl + ")";
        case C.CURRENT_PROGRAM: return this._program;
        case C.ARRAY_BUFFER_BINDING: return this._buffers[C.ARRAY_BUFFER];
        case C.ELEMENT_ARRAY_BUFFER_BINDING: return this._buffers[C.ELEMENT_ARRAY_BUFFER];
        case C.TEXTURE_BINDING_2D: return (this._textures[this._activeUnit] || {})["2d"] || null;
        case C.TEXTURE_BINDING_CUBE_MAP: return (this._textures[this._activeUnit] || {}).cube || null;
        case C.FRAMEBUFFER_BINDING: return this._framebuffer;
        case C.RENDERBUFFER_BINDING: return this._renderbuffer;
        case VERTEX_ARRAY_BINDING_OES: return this._vao;
        case C.VIEWPORT: case C.SCISSOR_BOX: { const a = new Int32Array(4); ops.op_gl_get_integer_n(p, new Uint32Array(a.buffer)); return a; }
        case C.MAX_VIEWPORT_DIMS: { const a = new Int32Array(2); ops.op_gl_get_integer_n(p, new Uint32Array(a.buffer)); return a; }
        case C.COLOR_CLEAR_VALUE: case C.BLEND_COLOR: { const a = out(new Float32Array(4)); ops.op_gl_get_float_n(p, a); return a; }
        case C.DEPTH_RANGE: case C.ALIASED_LINE_WIDTH_RANGE: case C.ALIASED_POINT_SIZE_RANGE: { const a = out(new Float32Array(2)); ops.op_gl_get_float_n(p, a); return a; }
        case C.COLOR_WRITEMASK: { const a = new Int32Array(4); ops.op_gl_get_integer_n(p, new Uint32Array(a.buffer)); return [!!a[0], !!a[1], !!a[2], !!a[3]]; }
        case C.COMPRESSED_TEXTURE_FORMATS: return new Uint32Array(0);
        case C.UNPACK_FLIP_Y_WEBGL: case C.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return !!this["_ps" + p];
        case C.UNPACK_COLORSPACE_CONVERSION_WEBGL: return C.BROWSER_DEFAULT_WEBGL;
        default:
          if (INT_PARAMS.has(p)) return ops.op_gl_get_integer(p);
          if (FLOAT_PARAMS.has(p)) return ops.op_gl_get_float(p);
          if (BOOL_PARAMS.has(p)) return ops.op_gl_get_bool(p);
          throw new Error("powerboat: gl.getParameter(0x" + p.toString(16) + ") not implemented");
      }
    }

    // ---- clear / viewport / state ----
    clearColor(r, g, b, a) { ops.op_gl_clear_color(+r, +g, +b, +a); }
    clear(mask) { ops.op_gl_clear(mask >>> 0); }
    clearDepth(d) { ops.op_gl_clear_depth(+d); }
    clearStencil(s) { ops.op_gl_clear_stencil(s | 0); }
    viewport(x, y, w, h) { ops.op_gl_viewport(x | 0, y | 0, w | 0, h | 0); }
    scissor(x, y, w, h) { ops.op_gl_scissor(x | 0, y | 0, w | 0, h | 0); }
    enable(cap) { ops.op_gl_enable(cap >>> 0); }
    disable(cap) { ops.op_gl_disable(cap >>> 0); }
    isEnabled(cap) { return ops.op_gl_is_enabled(cap >>> 0); }
    blendFunc(s, d) { ops.op_gl_blend_func(s >>> 0, d >>> 0); }
    blendFuncSeparate(sr, dr, sa, da) { ops.op_gl_blend_func_separate(sr >>> 0, dr >>> 0, sa >>> 0, da >>> 0); }
    blendEquation(m) { ops.op_gl_blend_equation(m >>> 0); }
    blendEquationSeparate(rgb, a) { ops.op_gl_blend_equation_separate(rgb >>> 0, a >>> 0); }
    blendColor(r, g, b, a) { ops.op_gl_blend_color(+r, +g, +b, +a); }
    colorMask(r, g, b, a) { ops.op_gl_color_mask(!!r, !!g, !!b, !!a); }
    depthMask(f) { ops.op_gl_depth_mask(!!f); }
    depthFunc(f) { ops.op_gl_depth_func(f >>> 0); }
    depthRange(n, f) { ops.op_gl_depth_range(+n, +f); }
    cullFace(m) { ops.op_gl_cull_face(m >>> 0); }
    frontFace(m) { ops.op_gl_front_face(m >>> 0); }
    lineWidth(w) { ops.op_gl_line_width(+w); }
    polygonOffset(f, u) { ops.op_gl_polygon_offset(+f, +u); }
    stencilFunc(f, r, m) { ops.op_gl_stencil_func(f >>> 0, r | 0, m >>> 0); }
    stencilFuncSeparate(face, f, r, m) { ops.op_gl_stencil_func_separate(face >>> 0, f >>> 0, r | 0, m >>> 0); }
    stencilOp(f, zf, zp) { ops.op_gl_stencil_op(f >>> 0, zf >>> 0, zp >>> 0); }
    stencilOpSeparate(face, f, zf, zp) { ops.op_gl_stencil_op_separate(face >>> 0, f >>> 0, zf >>> 0, zp >>> 0); }
    stencilMask(m) { ops.op_gl_stencil_mask(m >>> 0); }
    stencilMaskSeparate(face, m) { ops.op_gl_stencil_mask_separate(face >>> 0, m >>> 0); }
    sampleCoverage(v, i) { ops.op_gl_sample_coverage(+v, !!i); }
    hint(t, m) { ops.op_gl_hint(t >>> 0, m >>> 0); }
    flush() { ops.op_gl_flush(); }
    finish() { ops.op_gl_finish(); }
    pixelStorei(p, v) { this["_ps" + p] = v; ops.op_gl_pixel_storei(p >>> 0, typeof v === "boolean" ? (v ? 1 : 0) : v | 0); }

    // ---- buffers ----
    createBuffer() { const n = ops.op_gl_create_buffer(); return n ? new WebGLBuffer(n) : null; }
    deleteBuffer(b) { if (b && !b._deleted) { ops.op_gl_delete_buffer(b._id); b._deleted = true; for (const t in this._buffers) if (this._buffers[t] === b) this._buffers[t] = null; } }
    isBuffer(b) { return b instanceof WebGLBuffer && !b._deleted; }
    bindBuffer(target, b) { this._buffers[target] = b || null; ops.op_gl_bind_buffer(target >>> 0, id(b)); }
    bufferData(target, data, usage) {
      if (typeof data === "number") ops.op_gl_buffer_data_size(target >>> 0, data >>> 0, usage >>> 0);
      else if (data == null) ops.op_gl_buffer_data_size(target >>> 0, 0, usage >>> 0);
      else ops.op_gl_buffer_data(target >>> 0, bytes(data), usage >>> 0);
    }
    bufferSubData(target, offset, data) { ops.op_gl_buffer_sub_data(target >>> 0, offset >>> 0, bytes(data)); }
    getBufferParameter(target, p) { return ops.op_gl_get_buffer_parameter(target >>> 0, p >>> 0); }

    // ---- shaders / programs ----
    createShader(type) { const n = ops.op_gl_create_shader(type >>> 0); return n ? new WebGLShader(n, type) : null; }
    deleteShader(s) { if (s && !s._deleted) { ops.op_gl_delete_shader(s._id); s._deleted = true; } }
    isShader(s) { return s instanceof WebGLShader && !s._deleted; }
    shaderSource(s, src) { s._source = String(src); ops.op_gl_shader_source(id(s), s._source); }
    getShaderSource(s) { return s._source || ""; }
    compileShader(s) { ops.op_gl_compile_shader(id(s)); }
    getShaderParameter(s, p) {
      switch (p) {
        case C.COMPILE_STATUS: return ops.op_gl_get_shader_compile_status(id(s));
        case C.DELETE_STATUS: return !!(s && s._deleted);
        case C.SHADER_TYPE: return s ? s._type : 0;
        default: throw new Error("powerboat: getShaderParameter(0x" + p.toString(16) + ")");
      }
    }
    getShaderInfoLog(s) { return ops.op_gl_get_shader_info_log(id(s)); }
    getShaderPrecisionFormat(st, pt) { const r = ops.op_gl_get_shader_precision_format(st >>> 0, pt >>> 0); return r ? new WebGLShaderPrecisionFormat(r[0], r[1], r[2]) : null; }
    createProgram() { const n = ops.op_gl_create_program(); return n ? new WebGLProgram(n) : null; }
    deleteProgram(p) { if (p && !p._deleted) { ops.op_gl_delete_program(p._id); p._deleted = true; } }
    isProgram(p) { return p instanceof WebGLProgram && !p._deleted; }
    attachShader(p, s) { ops.op_gl_attach_shader(id(p), id(s)); }
    detachShader(p, s) { ops.op_gl_detach_shader(id(p), id(s)); }
    linkProgram(p) { ops.op_gl_link_program(id(p)); }
    validateProgram(p) { ops.op_gl_validate_program(id(p)); }
    useProgram(p) { this._program = p || null; ops.op_gl_use_program(id(p)); }
    getProgramParameter(p, pname) {
      switch (pname) {
        case C.LINK_STATUS: case C.VALIDATE_STATUS: return ops.op_gl_get_program_parameter(id(p), pname) !== 0;
        case C.DELETE_STATUS: return !!(p && p._deleted);
        default: return ops.op_gl_get_program_parameter(id(p), pname >>> 0);
      }
    }
    getProgramInfoLog(p) { return ops.op_gl_get_program_info_log(id(p)); }
    bindAttribLocation(p, index, name) { ops.op_gl_bind_attrib_location(id(p), index >>> 0, String(name)); }
    getAttribLocation(p, name) { return ops.op_gl_get_attrib_location(id(p), String(name)); }
    getUniformLocation(p, name) { const l = ops.op_gl_get_uniform_location(id(p), String(name)); return l < 0 ? null : new WebGLUniformLocation(l, p); }
    getActiveUniform(p, i) { const r = ops.op_gl_get_active_uniform(id(p), i >>> 0); return r ? new WebGLActiveInfo(r[0], r[1], r[2]) : null; }
    getActiveAttrib(p, i) { const r = ops.op_gl_get_active_attrib(id(p), i >>> 0); return r ? new WebGLActiveInfo(r[0], r[1], r[2]) : null; }
    getAttachedShaders() { throw new Error("powerboat: getAttachedShaders not implemented"); }
    getUniform() { throw new Error("powerboat: getUniform not implemented"); }

    // ---- uniforms ----
    uniform1f(l, x) { ops.op_gl_uniform1f(loc(l), +x); }
    uniform2f(l, x, y) { ops.op_gl_uniform2f(loc(l), +x, +y); }
    uniform3f(l, x, y, z) { ops.op_gl_uniform3f(loc(l), +x, +y, +z); }
    uniform4f(l, x, y, z, w) { ops.op_gl_uniform4f(loc(l), +x, +y, +z, +w); }
    uniform1i(l, x) { ops.op_gl_uniform1i(loc(l), x | 0); }
    uniform2i(l, x, y) { ops.op_gl_uniform2i(loc(l), x | 0, y | 0); }
    uniform3i(l, x, y, z) { ops.op_gl_uniform3i(loc(l), x | 0, y | 0, z | 0); }
    uniform4i(l, x, y, z, w) { ops.op_gl_uniform4i(loc(l), x | 0, y | 0, z | 0, w | 0); }
    uniform1fv(l, v) { ops.op_gl_uniform1fv(loc(l), f32(v)); }
    uniform2fv(l, v) { ops.op_gl_uniform2fv(loc(l), f32(v)); }
    uniform3fv(l, v) { ops.op_gl_uniform3fv(loc(l), f32(v)); }
    uniform4fv(l, v) { ops.op_gl_uniform4fv(loc(l), f32(v)); }
    uniform1iv(l, v) { ops.op_gl_uniform1iv(loc(l), i32(v)); }
    uniform2iv(l, v) { ops.op_gl_uniform2iv(loc(l), i32(v)); }
    uniform3iv(l, v) { ops.op_gl_uniform3iv(loc(l), i32(v)); }
    uniform4iv(l, v) { ops.op_gl_uniform4iv(loc(l), i32(v)); }
    uniformMatrix2fv(l, t, v) { ops.op_gl_uniform_matrix2fv(loc(l), !!t, f32(v)); }
    uniformMatrix3fv(l, t, v) { ops.op_gl_uniform_matrix3fv(loc(l), !!t, f32(v)); }
    uniformMatrix4fv(l, t, v) { ops.op_gl_uniform_matrix4fv(loc(l), !!t, f32(v)); }

    // ---- vertex attributes / draws ----
    vertexAttribPointer(i, size, type, norm, stride, offset) { ops.op_gl_vertex_attrib_pointer(i >>> 0, size | 0, type >>> 0, !!norm, stride | 0, offset | 0); }
    enableVertexAttribArray(i) { ops.op_gl_enable_vertex_attrib_array(i >>> 0); }
    disableVertexAttribArray(i) { ops.op_gl_disable_vertex_attrib_array(i >>> 0); }
    vertexAttrib1f(i, x) { ops.op_gl_vertex_attrib4f(i >>> 0, +x, 0, 0, 1); }
    vertexAttrib2f(i, x, y) { ops.op_gl_vertex_attrib4f(i >>> 0, +x, +y, 0, 1); }
    vertexAttrib3f(i, x, y, z) { ops.op_gl_vertex_attrib4f(i >>> 0, +x, +y, +z, 1); }
    vertexAttrib4f(i, x, y, z, w) { ops.op_gl_vertex_attrib4f(i >>> 0, +x, +y, +z, +w); }
    vertexAttrib4fv(i, v) { ops.op_gl_vertex_attrib4f(i >>> 0, +v[0], +v[1], +v[2], +v[3]); }
    getVertexAttrib() { throw new Error("powerboat: getVertexAttrib not implemented"); }
    getVertexAttribOffset() { throw new Error("powerboat: getVertexAttribOffset not implemented"); }
    drawArrays(mode, first, count) { ops.op_gl_draw_arrays(mode >>> 0, first | 0, count | 0); }
    drawElements(mode, count, type, offset) { ops.op_gl_draw_elements(mode >>> 0, count | 0, type >>> 0, offset | 0); }

    // ---- textures ----
    createTexture() { const n = ops.op_gl_create_texture(); return n ? new WebGLTexture(n) : null; }
    deleteTexture(t) {
      if (t && !t._deleted) {
        ops.op_gl_delete_texture(t._id); t._deleted = true;
        for (const u of this._textures) if (u) { if (u["2d"] === t) u["2d"] = null; if (u.cube === t) u.cube = null; }
      }
    }
    isTexture(t) { return t instanceof WebGLTexture && !t._deleted; }
    activeTexture(unit) { this._activeUnit = (unit - C.TEXTURE0) | 0; ops.op_gl_active_texture(unit >>> 0); }
    bindTexture(target, t) {
      const u = this._textures[this._activeUnit] || (this._textures[this._activeUnit] = { "2d": null, cube: null });
      if (target === C.TEXTURE_2D) u["2d"] = t || null; else u.cube = t || null;
      ops.op_gl_bind_texture(target >>> 0, id(t));
    }
    texParameteri(target, p, v) { ops.op_gl_tex_parameteri(target >>> 0, p >>> 0, v | 0); }
    texParameterf(target, p, v) { ops.op_gl_tex_parameterf(target >>> 0, p >>> 0, +v); }
    getTexParameter(target, p) { return ops.op_gl_get_tex_parameter(target >>> 0, p >>> 0); }
    generateMipmap(target) { ops.op_gl_generate_mipmap(target >>> 0); }
    texImage2D(target, level, internalformat, a3, a4, a5, a6, a7, a8) {
      if (arguments.length === 6) {
        // (target, level, internalformat, format, type, source)
        const src = a5;
        if (isPixelData(src)) return this.texImage2D(target, level, internalformat, src.width, src.height, 0, a3, a4, src.data);
        if (!isImageSource(src)) throw new TypeError("powerboat: texImage2D: unsupported source " + (src && src.constructor && src.constructor.name));
        // A finished, released video keeps its last uploaded frame.
        if (src._powerboatVideoId === 0) return;
        const ok = src._powerboatVideoId !== undefined
          ? ops.op_gl_tex_image_2d_video(target >>> 0, level | 0, src._powerboatVideoId >>> 0)
          : src._powerboatCanvasId
          ? ops.op_gl_tex_image_2d_canvas(target >>> 0, level | 0, src._powerboatCanvasId >>> 0)
          : ops.op_gl_tex_image_2d_image(target >>> 0, level | 0, src._powerboatImageId >>> 0);
        if (!ok) throw new Error("powerboat: texImage2D: source has no pixels (image not loaded, or a canvas without a 2D context)");
        return;
      }
      const data = a8;
      if (data == null) ops.op_gl_tex_image_2d_null(target >>> 0, level | 0, internalformat | 0, a3 | 0, a4 | 0, a5 | 0, a6 >>> 0, a7 >>> 0);
      else ops.op_gl_tex_image_2d_data(target >>> 0, level | 0, internalformat | 0, a3 | 0, a4 | 0, a5 | 0, a6 >>> 0, a7 >>> 0, bytes(data));
    }
    texSubImage2D(target, level, x, y, a4, a5, a6, a7, a8) {
      if (arguments.length === 7) {
        // (target, level, x, y, format, type, source)
        const src = a6;
        if (isPixelData(src)) return this.texSubImage2D(target, level, x, y, src.width, src.height, a4, a5, src.data);
        if (!isImageSource(src)) throw new TypeError("powerboat: texSubImage2D: unsupported source " + (src && src.constructor && src.constructor.name));
        if (src._powerboatVideoId === 0) return;
        if (src._powerboatVideoId !== undefined) { ops.op_gl_tex_image_2d_video(target >>> 0, level | 0, src._powerboatVideoId >>> 0); return; }
        const ok = src._powerboatCanvasId
          ? ops.op_gl_tex_sub_image_2d_canvas(target >>> 0, level | 0, x | 0, y | 0, src._powerboatCanvasId >>> 0)
          : ops.op_gl_tex_sub_image_2d_image(target >>> 0, level | 0, x | 0, y | 0, src._powerboatImageId >>> 0);
        if (!ok) throw new Error("powerboat: texSubImage2D: source has no pixels");
        return;
      }
      ops.op_gl_tex_sub_image_2d_data(target >>> 0, level | 0, x | 0, y | 0, a4 | 0, a5 | 0, a6 >>> 0, a7 >>> 0, bytes(a8));
    }
    copyTexImage2D(target, level, ifmt, x, y, w, h, border) { ops.op_gl_copy_tex_image_2d(target >>> 0, level | 0, ifmt >>> 0, x | 0, y | 0, w | 0, h | 0, border | 0); }
    copyTexSubImage2D(target, level, xo, yo, x, y, w, h) { ops.op_gl_copy_tex_sub_image_2d(target >>> 0, level | 0, xo | 0, yo | 0, x | 0, y | 0, w | 0, h | 0); }
    compressedTexImage2D() { throw new Error("powerboat: compressedTexImage2D not implemented"); }
    compressedTexSubImage2D() { throw new Error("powerboat: compressedTexSubImage2D not implemented"); }

    // ---- framebuffers / renderbuffers ----
    createFramebuffer() { const n = ops.op_gl_create_framebuffer(); return n ? new WebGLFramebuffer(n) : null; }
    deleteFramebuffer(f) {
      if (f && !f._deleted) {
        ops.op_gl_delete_framebuffer(f._id); f._deleted = true;
        if (this._framebuffer === f) this._framebuffer = null;
      }
    }
    isFramebuffer(f) { return f instanceof WebGLFramebuffer && !f._deleted; }
    // (A JS-side cache of the bound framebuffer was tried: it skipped 14 of 32 binds a frame on
    // OMORI but saved no time; the driver already makes redundant binds cheap.)
    bindFramebuffer(target, f) { this._framebuffer = f || null; ops.op_gl_bind_framebuffer(target >>> 0, id(f)); }
    // Attachments are kept for getFramebufferAttachmentParameter, which answers with the object.
    _attach(att, obj) { const f = this._framebuffer; if (f) (f._attachments || (f._attachments = {}))[att] = obj || null; }
    framebufferTexture2D(target, att, tt, tex, level) { this._attach(att, tex); ops.op_gl_framebuffer_texture_2d(target >>> 0, att >>> 0, tt >>> 0, id(tex), level | 0); }
    framebufferRenderbuffer(target, att, rt, rb) { this._attach(att, rb); ops.op_gl_framebuffer_renderbuffer(target >>> 0, att >>> 0, rt >>> 0, id(rb)); }
    checkFramebufferStatus(target) { return ops.op_gl_check_framebuffer_status(target >>> 0); }
    getFramebufferAttachmentParameter(target, att, p) {
      if (p === C.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) { const f = this._framebuffer; return (f && f._attachments && f._attachments[att]) || null; }
      return ops.op_gl_get_framebuffer_attachment_parameter(target >>> 0, att >>> 0, p >>> 0);
    }
    createRenderbuffer() { const n = ops.op_gl_create_renderbuffer(); return n ? new WebGLRenderbuffer(n) : null; }
    deleteRenderbuffer(r) { if (r && !r._deleted) { ops.op_gl_delete_renderbuffer(r._id); r._deleted = true; if (this._renderbuffer === r) this._renderbuffer = null; } }
    isRenderbuffer(r) { return r instanceof WebGLRenderbuffer && !r._deleted; }
    bindRenderbuffer(target, r) { this._renderbuffer = r || null; ops.op_gl_bind_renderbuffer(target >>> 0, id(r)); }
    renderbufferStorage(target, fmt, w, h) { ops.op_gl_renderbuffer_storage(target >>> 0, fmt >>> 0, w | 0, h | 0); }
    getRenderbufferParameter(target, p) { return ops.op_gl_get_renderbuffer_parameter(target >>> 0, p >>> 0); }

    // ---- read back ----
    readPixels(x, y, w, h, format, type, pixels) { ops.op_gl_read_pixels(x | 0, y | 0, w | 0, h | 0, format >>> 0, type >>> 0, out(bytes(pixels))); }
  }
  Object.assign(WebGLRenderingContext, C);
  Object.assign(WebGLRenderingContext.prototype, C);
  Object.assign(globalThis, {
    WebGLRenderingContext, WebGLBuffer, WebGLShader, WebGLProgram, WebGLTexture, WebGLFramebuffer, WebGLRenderbuffer,
    WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat, WebGLVertexArrayObjectOES,
  });

  // One real GL context (the window). Every canvas that asks gets a wrapper over it: PIXI probes
  // support with a throwaway canvas and loses that context at once; MV then creates the one that
  // renders. A second live wrapper is a warning, not an error.
  // Which context's canvas the window shows (its size sets the main FBO): MV's GameCanvas, else a
  // canvas that is in the document, else the newest. Never just "the newest": a detached test
  // canvas (300x150) created after the game's own took the window once and the game was drawn
  // into a 300x150 buffer (OMORI on the RG353V, 2026-10-13: zoomed into the lower-left corner).
  const contexts = [];
  const inDocument = (el) => { for (let n = el; n; n = n.parentNode) if (n === document.body) return true; return false; };
  const owner = () => {
    let best = null;
    for (const c of contexts) {
      if (c.canvas.id === "GameCanvas") return c;
      if (inDocument(c.canvas)) best = c;
    }
    return best || contexts[contexts.length - 1] || null;
  };
  let lastOwner = null;
  const applyMainSize = () => {
    const c = owner();
    if (!c) return;
    if (c !== lastOwner) {
      lastOwner = c;
      globalThis.__powerboat.mainCanvas = c.canvas; // target of mouse/pointer events (00_env.js)
      console.log("powerboat: window shows canvas " + (c.canvas.id || "(no id)") + " " + (c.canvas.width | 0) + "x" + (c.canvas.height | 0));
    }
    ops.op_gl_set_main_size(c.canvas.width | 0, c.canvas.height | 0);
  };
  globalThis.__powerboat.createWebGLContext = (canvas, attrs) => {
    const ctx = new WebGLRenderingContext(canvas, attrs);
    contexts.push(ctx);
    // The latest context is the game's (support checks make throwaway ones first).
    ops.op_gl_set_preserve_drawing_buffer(!!(attrs && attrs.preserveDrawingBuffer));
    if (contexts.length > 1) console.warn("powerboat: " + contexts.length + " live WebGL contexts");
    applyMainSize();
    return ctx;
  };
  globalThis.__powerboat.mainCanvas = () => { const c = owner(); return c ? c.canvas : null; };
  // Size changes, and a canvas joining the document (it may take the window over).
  globalThis.__powerboat.webglCanvasResized = () => applyMainSize();
  globalThis.__powerboat.canvasConnected = (canvas) => { if (canvas._gl) applyMainSize(); };
})();
