// powerboat JS environment, part 4: CanvasRenderingContext2D over the op_c2d_* ops (src/canvas.rs),
// ImageData, CanvasGradient/CanvasPattern, and canvas width/height handling. The pixmap lives on
// the Rust side under `canvas._powerboatCanvasId`; texImage2D and drawImage use that id.
"use strict";
(() => {
  const ops = Deno.core.ops;
  const g = globalThis;

  class ImageData {
    constructor(a, b, c) {
      if (a instanceof Uint8ClampedArray) { this.data = a; this.width = b | 0; this.height = c !== undefined ? c | 0 : (a.length / 4 / this.width) | 0; }
      else { this.width = a | 0; this.height = b | 0; this.data = new Uint8ClampedArray(this.width * this.height * 4); }
    }
  }
  g.ImageData = ImageData;

  const freeGradients = new FinalizationRegistry((id) => ops.op_c2d_gradient_free(id));
  class CanvasGradient {
    constructor(id) { this._id = id; freeGradients.register(this, id); }
    addColorStop(offset, color) { if (!ops.op_c2d_gradient_add_stop(this._id, +offset, String(color))) throw new Error("powerboat: bad gradient colour " + color); }
  }
  class CanvasPattern { constructor(source, repeat) { this._source = source; this._repeat = repeat !== "no-repeat"; } }
  g.CanvasGradient = CanvasGradient;
  g.CanvasPattern = CanvasPattern;

  const CAPS = { butt: 0, round: 1, square: 2 };
  const JOINS = { miter: 0, round: 1, bevel: 2 };
  const ALIGNS = { left: 0, start: 0, center: 1, right: 2, end: 2 };
  const BASELINES = { alphabetic: 0, top: 1, hanging: 1, middle: 2, bottom: 3, ideographic: 3 };

  // The boxes are worked out on first read: MV and Construct only ask for the width, often.
  // Ascents and descents count from the context's textBaseline, as in a browser: with "top" the font box's ascent is 0.
  // Construct 3 takes an alphabetic ascent minus a top ascent as the distance to the first baseline of centered BBCode text;
  // with the same value for both it drew those labels one ascent too high (Moonstone Island's buttons and name banners).
  class TextMetrics {
    constructor(id, text, width, baseline) { this.width = width; this._id = id; this._text = text; this._baseline = baseline; this._b = null; }
    _box(i) {
      let b = this._b;
      if (!b) {
        b = this._b = ops.op_c2d_measure_text_box(this._id, this._text);
        // How far the alphabetic baseline sits below the alignment point: the same sums as fillText in canvas.rs.
        const base = BASELINES[this._baseline], asc = b[4], desc = b[5];
        const k = base === 1 ? asc : base === 2 ? (asc - desc) / 2 : base === 3 ? -desc : 0;
        b[2] -= k; b[3] += k; b[4] -= k; b[5] += k;
      }
      return b[i];
    }
    get actualBoundingBoxLeft() { return this._box(0); }
    get actualBoundingBoxRight() { return this._box(1); }
    get actualBoundingBoxAscent() { return this._box(2); }
    get actualBoundingBoxDescent() { return this._box(3); }
    get fontBoundingBoxAscent() { return this._box(4); }
    get fontBoundingBoxDescent() { return this._box(5); }
  }
  g.TextMetrics = TextMetrics;

  let videoWarned = false;
  class CanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas;
      this._id = canvas._powerboatCanvasId;
      this._reset();
    }
    _reset() {
      this._fillStyle = "#000000"; this._strokeStyle = "#000000";
      this._globalAlpha = 1; this._gco = "source-over";
      this._lineWidth = 1; this._lineCap = "butt"; this._lineJoin = "miter"; this._miterLimit = 10;
      this._font = "10px sans-serif"; this._textAlign = "start"; this._textBaseline = "alphabetic";
      this._smoothing = true;
      this.shadowBlur = 0; this.shadowColor = "rgba(0, 0, 0, 0)"; this.shadowOffsetX = 0; this.shadowOffsetY = 0;
      this.lineDashOffset = 0;
      this._stack = [];
    }
    get fillStyle() { return this._fillStyle; }
    set fillStyle(v) { this._setStyle(v, false); }
    get strokeStyle() { return this._strokeStyle; }
    set strokeStyle(v) { this._setStyle(v, true); }
    _setStyle(v, stroke) {
      if (v instanceof CanvasGradient) ops.op_c2d_set_gradient(this._id, stroke, v._id);
      else if (v instanceof CanvasPattern) {
        const s = v._source;
        ops.op_c2d_set_pattern(this._id, stroke, s._powerboatCanvasId || 0, s._powerboatImageId || 0, v._repeat);
      } else {
        const str = String(v);
        if (!ops.op_c2d_set_color(this._id, stroke, str)) return; // unknown colour: ignored, as browsers do
        v = str;
      }
      if (stroke) this._strokeStyle = v; else this._fillStyle = v;
    }
    get globalAlpha() { return this._globalAlpha; }
    set globalAlpha(v) { v = +v; if (!(v >= 0 && v <= 1)) return; this._globalAlpha = v; ops.op_c2d_set_alpha(this._id, v); }
    get globalCompositeOperation() { return this._gco; }
    set globalCompositeOperation(v) { this._gco = String(v); ops.op_c2d_set_composite(this._id, this._gco); }
    get lineWidth() { return this._lineWidth; }
    set lineWidth(v) { v = +v; if (!(v > 0)) return; this._lineWidth = v; this._pushLine(); }
    get lineCap() { return this._lineCap; }
    set lineCap(v) { if (v in CAPS) { this._lineCap = v; this._pushLine(); } }
    get lineJoin() { return this._lineJoin; }
    set lineJoin(v) { if (v in JOINS) { this._lineJoin = v; this._pushLine(); } }
    get miterLimit() { return this._miterLimit; }
    set miterLimit(v) { v = +v; if (v > 0) { this._miterLimit = v; this._pushLine(); } }
    _pushLine() { ops.op_c2d_set_line(this._id, this._lineWidth, CAPS[this._lineCap], JOINS[this._lineJoin], this._miterLimit); }
    get font() { return this._font; }
    set font(v) { v = String(v); if (ops.op_c2d_set_font(this._id, v)) this._font = v; }
    get textAlign() { return this._textAlign; }
    set textAlign(v) { if (v in ALIGNS) { this._textAlign = v; ops.op_c2d_set_text(this._id, ALIGNS[v], BASELINES[this._textBaseline]); } }
    get textBaseline() { return this._textBaseline; }
    set textBaseline(v) { if (v in BASELINES) { this._textBaseline = v; ops.op_c2d_set_text(this._id, ALIGNS[this._textAlign], BASELINES[v]); } }
    get imageSmoothingEnabled() { return this._smoothing; }
    set imageSmoothingEnabled(v) { this._smoothing = !!v; ops.op_c2d_set_smoothing(this._id, this._smoothing); }
    set mozImageSmoothingEnabled(v) { this.imageSmoothingEnabled = v; }
    set webkitImageSmoothingEnabled(v) { this.imageSmoothingEnabled = v; }
    set msImageSmoothingEnabled(v) { this.imageSmoothingEnabled = v; }
    get imageSmoothingQuality() { return "low"; }
    set imageSmoothingQuality(_) {}

    save() {
      this._stack.push([this._fillStyle, this._strokeStyle, this._globalAlpha, this._gco, this._lineWidth, this._lineCap, this._lineJoin, this._miterLimit, this._font, this._textAlign, this._textBaseline, this._smoothing]);
      ops.op_c2d_save(this._id);
    }
    restore() {
      const s = this._stack.pop();
      if (!s) return;
      [this._fillStyle, this._strokeStyle, this._globalAlpha, this._gco, this._lineWidth, this._lineCap, this._lineJoin, this._miterLimit, this._font, this._textAlign, this._textBaseline, this._smoothing] = s;
      ops.op_c2d_restore(this._id);
    }
    setTransform(a, b, c, d, e, f) {
      if (typeof a === "object" && a) ({ a, b, c, d, e, f } = a);
      ops.op_c2d_set_transform(this._id, +a, +b, +c, +d, +e, +f);
    }
    resetTransform() { ops.op_c2d_set_transform(this._id, 1, 0, 0, 1, 0, 0); }
    transform(a, b, c, d, e, f) { ops.op_c2d_transform(this._id, +a, +b, +c, +d, +e, +f); }
    translate(x, y) { ops.op_c2d_translate(this._id, +x, +y); }
    scale(x, y) { ops.op_c2d_scale(this._id, +x, +y); }
    rotate(r) { ops.op_c2d_rotate(this._id, +r); }
    getTransform() { throw new Error("powerboat: getTransform not implemented"); }

    fillRect(x, y, w, h) { ops.op_c2d_fill_rect(this._id, +x, +y, +w, +h); }
    strokeRect(x, y, w, h) { ops.op_c2d_stroke_rect(this._id, +x, +y, +w, +h); }
    clearRect(x, y, w, h) { ops.op_c2d_clear_rect(this._id, +x, +y, +w, +h); }

    beginPath() { ops.op_c2d_begin_path(this._id); }
    closePath() { ops.op_c2d_close_path(this._id); }
    moveTo(x, y) { ops.op_c2d_move_to(this._id, +x, +y); }
    lineTo(x, y) { ops.op_c2d_line_to(this._id, +x, +y); }
    quadraticCurveTo(cx, cy, x, y) { ops.op_c2d_quad_to(this._id, +cx, +cy, +x, +y); }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { ops.op_c2d_bezier_to(this._id, +c1x, +c1y, +c2x, +c2y, +x, +y); }
    rect(x, y, w, h) { ops.op_c2d_rect(this._id, +x, +y, +w, +h); }
    arc(x, y, r, a0, a1, ccw) { ops.op_c2d_arc(this._id, +x, +y, +r, +a0, +a1, !!ccw); }
    arcTo() { throw new Error("powerboat: arcTo not implemented"); }
    ellipse() { throw new Error("powerboat: ellipse not implemented"); }
    fill(rule) { if (rule && typeof rule !== "string") throw new Error("powerboat: Path2D not implemented"); ops.op_c2d_fill(this._id); }
    stroke(p) { if (p) throw new Error("powerboat: Path2D not implemented"); ops.op_c2d_stroke(this._id); }
    clip() { ops.op_c2d_clip(this._id); }
    isPointInPath() { return false; }
    setLineDash() {} getLineDash() { return []; }

    drawImage(src, a, b, c, d, e, f, gg, h) {
      let sx, sy, sw, sh, dx, dy, dw, dh;
      if (src instanceof HTMLCanvasElement && !src._gl) src.getContext("2d"); // never drawn: transparent
      const srcW = src._powerboatCanvasId ? src.width : src.naturalWidth || src.width || 0;
      const srcH = src._powerboatCanvasId ? src.height : src.naturalHeight || src.height || 0;
      if (arguments.length === 3) { sx = 0; sy = 0; sw = srcW; sh = srcH; dx = +a; dy = +b; dw = sw; dh = sh; }
      else if (arguments.length === 5) { sx = 0; sy = 0; sw = srcW; sh = srcH; dx = +a; dy = +b; dw = +c; dh = +d; }
      else { sx = +a; sy = +b; sw = +c; sh = +d; dx = +e; dy = +f; dw = +gg; dh = +h; }
      if (src._powerboatCanvasId) ops.op_c2d_draw_canvas(this._id, src._powerboatCanvasId, sx, sy, sw, sh, dx, dy, dw, dh);
      else if (src._powerboatImageId) ops.op_c2d_draw_image(this._id, src._powerboatImageId, sx, sy, sw, sh, dx, dy, dw, dh);
      else if (src instanceof HTMLImageElement) { /* not loaded yet: browsers draw nothing */ }
      else if (src && src._powerboatVideoId !== undefined) { if (!videoWarned) { videoWarned = true; console.warn("powerboat: drawImage from a video is not implemented; it draws nothing"); } }
      else throw new TypeError("powerboat: drawImage: unsupported source " + (src && src.constructor && src.constructor.name));
    }
    createImageData(w, h) { if (w instanceof ImageData) return new ImageData(w.width, w.height); return new ImageData(w, h); }
    getImageData(x, y, w, h) {
      const img = new ImageData(Math.abs(w | 0) || 1, Math.abs(h | 0) || 1);
      ops.op_c2d_get_image_data(this._id, x | 0, y | 0, img.width, img.height, new Uint8Array(img.data.buffer));
      return img;
    }
    putImageData(img, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
      if (arguments.length < 7) { dirtyX = 0; dirtyY = 0; dirtyW = img.width; dirtyH = img.height; }
      ops.op_c2d_put_image_data(this._id, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, dx | 0, dy | 0, dirtyX | 0, dirtyY | 0, dirtyW | 0, dirtyH | 0);
    }
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient(ops.op_c2d_create_linear_gradient(+x0, +y0, +x1, +y1)); }
    createRadialGradient() { throw new Error("powerboat: createRadialGradient not implemented"); }
    createPattern(src, repeat) { return new CanvasPattern(src, repeat); }

    fillText(text, x, y, maxWidth) { ops.op_c2d_fill_text(this._id, String(text), +x, +y, maxWidth > 0 ? +maxWidth : 0); }
    strokeText(text, x, y, maxWidth) { ops.op_c2d_stroke_text(this._id, String(text), +x, +y, maxWidth > 0 ? +maxWidth : 0); }
    measureText(text) {
      return new TextMetrics(this._id, String(text), ops.op_c2d_measure_text(this._id, String(text)), this._textBaseline);
    }
  }
  g.CanvasRenderingContext2D = CanvasRenderingContext2D;

  // ---- canvas element: lazy pixmap, resize semantics, 2D context ----
  const freeCanvases = new FinalizationRegistry((id) => ops.op_c2d_free(id));
  const HTMLCanvasElement = g.HTMLCanvasElement;
  const proto = HTMLCanvasElement.prototype;
  Object.defineProperty(proto, "width", {
    get() { return this._width === undefined ? 300 : this._width; },
    set(v) { v = Math.max(0, v | 0); this._width = v; if (this._powerboatCanvasId) { ops.op_c2d_resize(this._powerboatCanvasId, v, this.height); if (this._ctx2d) this._ctx2d._reset(); } if (this._gl) __powerboat.webglCanvasResized(this); },
    configurable: true,
  });
  Object.defineProperty(proto, "height", {
    get() { return this._height === undefined ? 150 : this._height; },
    set(v) { v = Math.max(0, v | 0); this._height = v; if (this._powerboatCanvasId) { ops.op_c2d_resize(this._powerboatCanvasId, this.width, v); if (this._ctx2d) this._ctx2d._reset(); } if (this._gl) __powerboat.webglCanvasResized(this); },
    configurable: true,
  });
  const baseGetContext = proto.getContext;
  proto.getContext = function (type, attrs) {
    if (type === "2d") {
      if (!this._ctx2d) {
        if (this._gl) throw new Error("powerboat: canvas already has a WebGL context");
        this._powerboatCanvasId = ops.op_c2d_create(this.width, this.height);
        // MV's main canvas drawn by PIXI's CanvasRenderer: the runtime shows it in the window.
        if (this.id === "GameCanvas") ops.op_c2d_set_main(this._powerboatCanvasId);
        freeCanvases.register(this, this._powerboatCanvasId);
        this._ctx2d = new CanvasRenderingContext2D(this);
      }
      return this._ctx2d;
    }
    return baseGetContext.call(this, type, attrs);
  };
  // The canvas as PNG: 2D through getImageData, WebGL through readPixels (rows flipped to top-down).
  // Other requested types get PNG too, as browsers do for types they can't write (Construct's Mouse
  // plugin turns a sprite into a cursor image this way: SetCursorObjectClass).
  const canvasPng = (c) => {
    const w = c.width | 0, h = c.height | 0;
    if (w <= 0 || h <= 0) return null;
    let px;
    if (c._ctx2d) {
      px = new Uint8Array(c._ctx2d.getImageData(0, 0, w, h).data.buffer);
    } else if (c._gl) {
      const gl = c._gl, raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) px.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    } else {
      px = new Uint8Array(w * h * 4); // never drawn: transparent
    }
    return ops.op_png_encode(px, w, h);
  };
  proto.toBlob = function (callback) {
    const png = canvasPng(this);
    setTimeout(() => callback(png ? new Blob([png], { type: "image/png" }) : null), 0);
  };
  proto.toDataURL = function () {
    const png = canvasPng(this);
    if (!png) return "data:,";
    let s = "";
    for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(s);
  };
})();
