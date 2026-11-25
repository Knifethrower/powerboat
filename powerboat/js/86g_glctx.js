// powerboat JS environment, part 9b2: a WebGL drawing backend for HTML pages (POWERBOAT_HTML=1 with
// POWERBOAT_HTML_GL=1). 87_paint.js draws the page through a small part of Canvas 2D (rects, images, patterns,
// gradients, convex paths, text bitmaps, rectangle clips); this offers that part over WebGL, so page pixels are
// filled by the GPU instead of the CPU rasterizer. The same contexts serve the page's own canvases (H.glCanvas2D:
// a canvas in the document draws into a framebuffer of its own, which the page then samples directly).
// One engine: one program, one dynamic buffer, shared texture caches. Each context (the page, every GPU canvas)
// keeps its own state and batch; only one context has queued vertices at a time, so drawing order across
// targets holds (a canvas's drawing reaches its texture before the page samples it). Textures are
// premultiplied; blending follows globalCompositeOperation (source-over, lighter, destination-out, copy).
"use strict";
(() => {
  const ops = Deno.core.ops;
  if (ops.op_powerboat_env("POWERBOAT_HTML") !== "1") return;
  const g = globalThis, H = __powerboat.html;

  let E = null; // the engine, made with the page context
  H.flushWhy = {}; // batch flush reasons for POWERBOAT_HTML_STATS
  function engine(pageCanvas) {
    const gl = pageCanvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: true });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error("powerboat: GL page shader:", gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    // Textures one batch samples: 8 units where the GPU has them (on the R36S, 8 instead of 4 took Cookie Clicker
    // from 14 to 5.5 batches a frame).
    const TEXS = Math.max(1, Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) | 0, 8));
    const units = [...Array(TEXS).keys()];
    // u_map: device y -> clip y as u_map.x + u_map.y * y / height (the page is drawn top-down into the window,
    // canvases bottom-up into their textures, so that their row 0 is their top as for uploaded images).
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
      attribute vec2 a_p; attribute vec2 a_uv; attribute vec4 a_c; attribute float a_m;
      uniform vec2 u_size; uniform vec2 u_map; varying vec2 v_uv; varying vec4 v_c; varying float v_m;
      void main() { v_uv = a_uv; v_c = a_c; v_m = a_m; gl_Position = vec4(a_p.x / u_size.x * 2.0 - 1.0, u_map.x + u_map.y * a_p.y / u_size.y, 0.0, 1.0); }`));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
      precision mediump float;
      ${units.map((i) => "uniform sampler2D u_t" + i + ";").join(" ")}
      varying vec2 v_uv; varying vec4 v_c; varying float v_m;
      void main() {
        vec2 uv = v_uv;
        float slot = floor(v_m / 8.0 + 0.01);                         // +8 per texture unit (TEXS per batch)
        float m = v_m - slot * 8.0;
        bool tint = m > 3.5;                                          // +4: the texture's shape in v_c (shadows)
        if (tint) m -= 4.0;
        if (m > 1.5) uv = vec2(clamp(length(v_uv), 0.0, 1.0), 0.5);   // radial gradient: uv in radii
        else if (m > 0.5) uv = fract(v_uv);                            // pattern: uv in tiles
        vec4 t;                                                        // branches, not ?: (one fetch, not four)
        ${units.map((i) => (i === TEXS - 1 ? "t = " : "if (slot < " + i + ".5) t = ") + "texture2D(u_t" + i + ", uv);").join("\n        else ")}
        gl_FragColor = tint ? v_c * t.a : t * v_c;
      }`));
    for (const [i, n] of [[0, "a_p"], [1, "a_uv"], [2, "a_c"], [3, "a_m"]]) gl.bindAttribLocation(prog, i, n);
    gl.linkProgram(prog);
    const e = { gl, prog, texs: TEXS, uT: units.map((i) => gl.getUniformLocation(prog, "u_t" + i)), uSize: gl.getUniformLocation(prog, "u_size"), uMap: gl.getUniformLocation(prog, "u_map"), buf: gl.createBuffer(),
      ready: false, bound: undefined, blend: undefined, pending: null, texes: new WeakMap(), gradCache: new Map() };
    e.mkTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    e.white = e.mkTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    e.fin = typeof FinalizationRegistry === "function" ? new FinalizationRegistry((t) => gl.deleteTexture(t)) : null;
    // The program and vertex layout: once per frame (the runtime's present changes GL state between frames).
    e.setup = () => {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, e.buf);
      const B = 9 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, B, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, B, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, B, 16);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, B, 32);
      e.uT.forEach((u, i) => gl.uniform1i(u, i));
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
      e.ready = true; e.bound = undefined; e.blend = undefined;
    };
    e.reset = () => { e.ready = false; };
    // Before another context queues vertices, or a texture is read or replaced: the queued batch is drawn.
    e.flushPending = () => { if (e.pending) e.pending.flushNow(); };
    // Image and canvas textures by source; CPU canvases upload again when drawn into (_ver, set by 87_paint.js);
    // GPU canvases are their own texture. force: upload whatever the version. A latched texture (a page canvas,
    // see latch) is uploaded only by latch.
    e.texOf = (src, force) => {
      if (src._glc) { if (e.pending === src._glc.ctx._batch) e.flushPending(); return src._glc.entry(); }
      let t = e.texes.get(src);
      const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
      const ver = src._ver | 0;
      if (t && t.w === w && t.h === h && !force && (t.ver === ver || t.latched)) return t;
      e.flushPending();
      if (!t) { t = { t: e.mkTex(), w: 0, h: 0, ver: -1 }; e.texes.set(src, t); if (e.fin) e.fin.register(src, t.t); }
      gl.bindTexture(gl.TEXTURE_2D, t.t);
      const t0 = performance.now();
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch (x) { return null; }
      H.uploadMs = (H.uploadMs || 0) + performance.now() - t0; H.uploads = (H.uploads || 0) + 1;
      t.w = w; t.h = h; t.ver = ver;
      return t;
    };
    // Gradients as 256x1 textures, shared by every gradient with the same stops (pages make new gradient objects
    // every paint).
    e.gradTex = (gr) => {
      if (gr._tex) return gr._tex;
      const key = gr.stops.map((q) => q[0] + ":" + q[1].join()).join("|");
      const hit = e.gradCache.get(key);
      if (hit) { gr._tex = hit; return hit; }
      e.flushPending();
      const px = new Uint8Array(256 * 4), st = gr.stops.slice().sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let a = st[0], b = st[st.length - 1];
        for (let k = 0; k < st.length - 1; k++) if (t >= st[k][0] && t <= st[k + 1][0]) { a = st[k]; b = st[k + 1]; break; }
        const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
        const c = a[1].map((v, j) => v + (b[1][j] - v) * f), al = c[3];
        px.set([c[0] * al, c[1] * al, c[2] * al, al * 255], i * 4);
      }
      const t = e.mkTex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gr._tex = t;
      e.gradCache.set(key, t);
      if (e.gradCache.size > 128) { const [k0, t0] = e.gradCache.entries().next().value; e.gradCache.delete(k0); gl.deleteTexture(t0); }
      return t;
    };
    return e;
  }

  const BLEND = { "source-over": [1, 0x0303], lighter: [1, 1], "destination-out": [0, 0x0303], copy: [1, 0] }; // ONE, ONE_MINUS_SRC_ALPHA, ZERO
  // A drawing context over a target: { fbo, w(), h(), page }.
  function makeCtx(target, owner) {
    const gl = E.gl;
    const FL = 9, MAXV = 6 * 2048;
    const verts = new Float32Array(MAXV * FL);
    // A batch samples up to TEXS textures (one unit each; the vertex mode carries the unit as +8 per unit), so
    // switching between a few images does not end it.
    const TEXS = E.texs;
    let nv = 0, texs = [], slot = 0, scissor = null, batchBlend = "source-over";
    const flushNow = () => {
      if (!nv) { if (E.pending === me) E.pending = null; return; }
      const tf = performance.now(); H.flushN = (H.flushN || 0) + 1;
      if (!E.ready) E.setup();
      if (E.bound !== target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.w(), target.h());
        gl.uniform2f(E.uSize, target.w(), target.h());
        if (target.page) gl.uniform2f(E.uMap, 1, -2); else gl.uniform2f(E.uMap, -1, 2);
        E.bound = target;
      }
      if (E.blend !== batchBlend) { const b = BLEND[batchBlend] || BLEND["source-over"]; gl.blendFunc(b[0], b[1]); E.blend = batchBlend; }
      gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, nv * FL), gl.STREAM_DRAW);
      for (let i = texs.length - 1; i >= 0; i--) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, texs[i]); }
      gl.drawArrays(gl.TRIANGLES, 0, nv);
      nv = 0; texs = [];
      if (E.pending === me) E.pending = null;
      H.flushMs = (H.flushMs || 0) + performance.now() - tf;
    };
    const me = { flushNow };
    const useTex = (t) => {
      if (!nv) texs = [];
      let i = texs.indexOf(t);
      if (i < 0) {
        if (texs.length >= TEXS) { H.flushWhy.tex = (H.flushWhy.tex || 0) + 1; flushNow(); }
        i = texs.push(t) - 1;
      }
      slot = i * 8;
    };
    const useBlend = () => { if (st.gco !== batchBlend) { if (nv) H.flushWhy.bl = (H.flushWhy.bl || 0) + 1; flushNow(); batchBlend = st.gco; } };
    const vert = (x, y, u, v, c, mode) => {
      if (E.pending !== me) { if (E.pending) H.flushWhy.ctx = (H.flushWhy.ctx || 0) + 1; E.flushPending(); E.pending = me; }
      if (nv >= MAXV) { flushNow(); E.pending = me; }
      const o = nv * FL;
      verts[o] = x; verts[o + 1] = y; verts[o + 2] = u; verts[o + 3] = v;
      verts[o + 4] = c[0]; verts[o + 5] = c[1]; verts[o + 6] = c[2]; verts[o + 7] = c[3]; verts[o + 8] = mode + slot;
      nv++;
    };
    // A triangle of device points [x, y, u, v], cut to the clip rectangle (scissor) here on the CPU: a GL scissor
    // would end the batch at every clip change. Cut at whole pixels, it covers the pixels the scissor would keep.
    const cut = (P, k, lim, sgn) => {
      const out = [];
      for (let i = 0; i < P.length; i++) {
        const p = P[i], q = P[(i + 1) % P.length], dp = (p[k] - lim) * sgn, dq = (q[k] - lim) * sgn;
        if (dp >= 0) out.push(p);
        if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t]); }
      }
      return out;
    };
    const tri = (a, b, d, c, mode) => {
      const s = scissor;
      if (s) {
        const minx = Math.min(a[0], b[0], d[0]), maxx = Math.max(a[0], b[0], d[0]), miny = Math.min(a[1], b[1], d[1]), maxy = Math.max(a[1], b[1], d[1]);
        if (maxx <= s[0] || minx >= s[2] || maxy <= s[1] || miny >= s[3]) return;
        if (minx < s[0] || maxx > s[2] || miny < s[1] || maxy > s[3]) {
          const P = cut(cut(cut(cut([a, b, d], 0, s[0], 1), 0, s[2], -1), 1, s[1], 1), 1, s[3], -1);
          for (let i = 1; i + 1 < P.length; i++) { vert(P[0][0], P[0][1], P[0][2], P[0][3], c, mode); vert(P[i][0], P[i][1], P[i][2], P[i][3], c, mode); vert(P[i + 1][0], P[i + 1][1], P[i + 1][2], P[i + 1][3], c, mode); }
          return;
        }
      }
      vert(a[0], a[1], a[2], a[3], c, mode); vert(b[0], b[1], b[2], b[3], c, mode); vert(d[0], d[1], d[2], d[3], c, mode);
    };
    const drew = () => { if (owner) owner._painted = true; };

    // ---- state ----
    // K: device pixels per canvas pixel (a page canvas drawn smaller than its size renders at the size it shows).
    const K = target.scale || 1;
    let m = [K, 0, 0, K, 0, 0];
    const stack = [];
    const st = { fillSrc: "#000", strokeSrc: "#000", alpha: 1, lineWidth: 1, font: "10px sans-serif", tint: null, gco: "source-over", align: "start", baseline: "alphabetic" };
    // With a tint ([r, g, b, a], straight), images and patterns draw as their shape in that color.
    const tintC = () => { const t = st.tint, a = t[3] * st.alpha; return [t[0] * a, t[1] * a, t[2] * a, a]; };
    const mul = (n) => { const [a, b, c, d, e, f] = m; m = [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f]; };
    const X = (x, y) => m[0] * x + m[2] * y + m[4], Y = (x, y) => m[1] * x + m[3] * y + m[5];
    const paint = (s) => {
      if (typeof s === "string") { const c = H.parseColor(s) || [0, 0, 0, 1]; return { kind: "color", c: [c[0] / 255 * c[3], c[1] / 255 * c[3], c[2] / 255 * c[3], c[3]] }; }
      return s && s.kind ? s : paint("#000");
    };
    let fillP = paint("#000"), strokeP = paint("#000");
    const scaled = (c) => [c[0] * st.alpha, c[1] * st.alpha, c[2] * st.alpha, c[3] * st.alpha];
    const A1 = [1, 1, 1, 1];
    // A filled polygon (device points, convex) in a paint; uv comes from the user-space point.
    function polyFill(pts, p) {
      if (pts.length < 3) return;
      useBlend();
      let mode = 0, c = A1, uvOf;
      if (p.kind === "color") { useTex(E.white); c = scaled(p.c); uvOf = () => [0.5, 0.5]; }
      else if (p.kind === "pattern") {
        const e = E.texOf(p.src); if (!e) return;
        useTex(e.t); mode = 1; c = [st.alpha, st.alpha, st.alpha, st.alpha];
        if (st.tint) { mode += 4; c = tintC(); }
        uvOf = p.tw ? (ux, uy) => [(ux - p.ox) / p.tw, (uy - p.oy) / p.th] : (ux, uy) => [ux / e.w, uy / e.h];
      } else if (p.kind === "linear") {
        useTex(E.gradTex(p)); c = [st.alpha, st.alpha, st.alpha, st.alpha];
        const dx = p.x1 - p.x0, dy = p.y1 - p.y0, l2 = dx * dx + dy * dy || 1;
        uvOf = (ux, uy) => [((ux - p.x0) * dx + (uy - p.y0) * dy) / l2, 0.5];
      } else if (p.kind === "radial") {
        useTex(E.gradTex(p)); mode = 2; c = [st.alpha, st.alpha, st.alpha, st.alpha];
        uvOf = (ux, uy) => [(ux - p.x1) / (p.r1 || 1), (uy - p.y1) / (p.r1 || 1)];
      } else return;
      const T = pts.map((p) => { const t = uvOf(p[2], p[3]); return [p[0], p[1], t[0], t[1]]; });
      for (let i = 1; i < T.length - 1; i++) tri(T[0], T[i], T[i + 1], c, mode);
      drew();
    }
    const rectPts = (x, y, w, h) => [[X(x, y), Y(x, y), x, y], [X(x + w, y), Y(x + w, y), x + w, y], [X(x + w, y + h), Y(x + w, y + h), x + w, y + h], [X(x, y + h), Y(x, y + h), x, y + h]];
    // Paths: subpaths of device points (with their user-space points for paints).
    let subs = [], cur = null, lastU = [0, 0];
    const ptAdd = (x, y) => { if (!cur) { cur = { pts: [], closed: false }; subs.push(cur); } cur.pts.push([X(x, y), Y(x, y), x, y]); lastU = [x, y]; };
    const textCanvas = new Map();
    const W = () => target.w(), Hh = () => target.h();

    const ctx = {
      get canvas() { return owner || target.canvas; },
      get fillStyle() { return st.fillSrc; }, set fillStyle(v) { st.fillSrc = v; fillP = paint(v); },
      get strokeStyle() { return st.strokeSrc; }, set strokeStyle(v) { st.strokeSrc = v; strokeP = paint(v); },
      get globalAlpha() { return st.alpha; }, set globalAlpha(v) { v = +v; if (v >= 0 && v <= 1) st.alpha = v; },
      get globalCompositeOperation() { return st.gco; }, set globalCompositeOperation(v) { if (BLEND[v]) st.gco = v; },
      get lineWidth() { return st.lineWidth; }, set lineWidth(v) { if (+v > 0) st.lineWidth = +v; },
      get font() { return st.font; }, set font(v) { st.font = String(v); },
      get textAlign() { return st.align; }, set textAlign(v) { st.align = String(v); },
      get textBaseline() { return st.baseline; }, set textBaseline(v) { st.baseline = String(v); },
      get tint() { return st.tint; }, set tint(v) { st.tint = v || null; },
      imageSmoothingEnabled: true, lineCap: "butt", lineJoin: "miter", miterLimit: 10,
      shadowBlur: 0, shadowColor: "rgba(0, 0, 0, 0)", shadowOffsetX: 0, shadowOffsetY: 0,
      save() { stack.push([m, st.alpha, st.fillSrc, fillP, st.strokeSrc, strokeP, st.lineWidth, st.font, scissor, st.tint, st.gco, st.align, st.baseline]); },
      restore() { const s = stack.pop(); if (!s) return; [m, st.alpha, st.fillSrc, fillP, st.strokeSrc, strokeP, st.lineWidth, st.font, scissor] = s; st.tint = s[9]; st.gco = s[10]; st.align = s[11]; st.baseline = s[12]; },
      translate(x, y) { mul([1, 0, 0, 1, x, y]); }, scale(x, y) { mul([x, 0, 0, y, 0, 0]); },
      rotate(r) { mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]); },
      transform(a, b, c, d, e, f) { mul([a, b, c, d, e, f]); },
      setTransform(a, b, c, d, e, f) { if (typeof a === "object" && a) ({ a, b, c, d, e, f } = a); m = [K * a, K * b, K * c, K * d, K * e, K * f]; },
      resetTransform() { m = [K, 0, 0, K, 0, 0]; },
      getTransform() { return { a: m[0] / K, b: m[1] / K, c: m[2] / K, d: m[3] / K, e: m[4] / K, f: m[5] / K }; },
      createPattern(src) { return { kind: "pattern", src }; },
      // A pattern with its tile origin and drawn tile size in user space (no translate/scale around the fill).
      patternAt(src, ox, oy, tw, th) { return { kind: "pattern", src, ox, oy, tw, th }; },
      createLinearGradient(x0, y0, x1, y1) { return { kind: "linear", x0, y0, x1, y1, stops: [], addColorStop(o, c) { const p = H.parseColor(c); if (p) this.stops.push([+o, p]); } }; },
      createRadialGradient(x0, y0, r0, x1, y1, r1) { return { kind: "radial", x0, y0, r0, x1, y1, r1, stops: [], addColorStop(o, c) { const p = H.parseColor(c); if (p) this.stops.push([+o, p]); } }; },
      fillRect(x, y, w, h) { if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; } if (w > 0 && h > 0) polyFill(rectPts(x, y, w, h), fillP); },
      strokeRect(x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.stroke(); },
      clearRect(x, y, w, h) {
        // Axis-aligned: a scissored clear; under rotation, a "copy" fill of transparent black.
        if (m[1] !== 0 || m[2] !== 0) { const s = [st.gco, fillP]; st.gco = "copy"; fillP = { kind: "color", c: [0, 0, 0, 0] }; const a = st.alpha; st.alpha = 1; polyFill(rectPts(x, y, w, h), fillP); st.alpha = a; [st.gco, fillP] = s; return; }
        E.flushPending(); flushNow();
        if (!E.ready) E.setup();
        const xs = [X(x, y), X(x + w, y + h)], ys = [Y(x, y), Y(x + w, y + h)];
        let r = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))), Math.min(W(), Math.ceil(Math.max(...xs))), Math.min(Hh(), Math.ceil(Math.max(...ys)))];
        if (scissor) r = [Math.max(r[0], scissor[0]), Math.max(r[1], scissor[1]), Math.min(r[2], scissor[2]), Math.min(r[3], scissor[3])];
        if (r[2] <= r[0] || r[3] <= r[1]) return;
        if (E.bound !== target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, W(), Hh()); gl.uniform2f(E.uSize, W(), Hh()); gl.uniform2f(E.uMap, target.page ? 1 : -1, target.page ? -2 : 2); E.bound = target; }
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(r[0], target.page ? Hh() - r[3] : r[1], r[2] - r[0], r[3] - r[1]);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
        drew();
      },
      drawImage(img, ...a) {
        if (!img || img.alt === "blank") return; // a placeholder until its image loads (Cookie Clicker)
        const e = E.texOf(img); if (!e || !e.w || !e.h) return;
        let sx = 0, sy = 0, sw = e.w, sh = e.h, dx, dy, dw, dh;
        if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; } else if (a.length === 4) [dx, dy, dw, dh] = a; else [sx, sy, sw, sh, dx, dy, dw, dh] = a;
        if (sw < 0) { sx += sw; sw = -sw; } if (sh < 0) { sy += sh; sh = -sh; } if (dw < 0) { dx += dw; dw = -dw; } if (dh < 0) { dy += dh; dh = -dh; }
        if (!(dw > 0 && dh > 0 && sw > 0 && sh > 0)) return;
        useBlend(); useTex(e.t);
        const c = st.tint ? tintC() : [st.alpha, st.alpha, st.alpha, st.alpha], mode = st.tint ? 4 : 0;
        const u0 = sx / e.w, v0 = sy / e.h, u1 = (sx + sw) / e.w, v1 = (sy + sh) / e.h;
        const p = [[X(dx, dy), Y(dx, dy), u0, v0], [X(dx + dw, dy), Y(dx + dw, dy), u1, v0], [X(dx + dw, dy + dh), Y(dx + dw, dy + dh), u1, v1], [X(dx, dy + dh), Y(dx, dy + dh), u0, v1]];
        tri(p[0], p[1], p[2], c, mode); tri(p[0], p[2], p[3], c, mode);
        drew();
      },
      beginPath() { subs = []; cur = null; },
      moveTo(x, y) { cur = null; ptAdd(x, y); },
      lineTo(x, y) { ptAdd(x, y); },
      rect(x, y, w, h) { cur = null; ptAdd(x, y); ptAdd(x + w, y); ptAdd(x + w, y + h); ptAdd(x, y + h); cur.closed = true; cur = null; },
      quadraticCurveTo(cx, cy, x, y) { const [x0, y0] = lastU; for (let i = 1; i <= 6; i++) { const t = i / 6, k = 1 - t; ptAdd(k * k * x0 + 2 * k * t * cx + t * t * x, k * k * y0 + 2 * k * t * cy + t * t * y); } },
      bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { const [x0, y0] = lastU; for (let i = 1; i <= 8; i++) { const t = i / 8, k = 1 - t; ptAdd(k * k * k * x0 + 3 * k * k * t * c1x + 3 * k * t * t * c2x + t * t * t * x, k * k * k * y0 + 3 * k * k * t * c1y + 3 * k * t * t * c2y + t * t * t * y); } },
      arc(x, y, r, a0, a1, ccw) { const n = Math.max(8, Math.min(64, Math.ceil(Math.abs(a1 - a0) * r / 4))); let d = a1 - a0; if (ccw && d > 0) d -= Math.PI * 2; if (!ccw && d < 0) d += Math.PI * 2; if (Math.abs(a1 - a0) >= Math.PI * 2) d = ccw ? -Math.PI * 2 : Math.PI * 2; for (let i = 0; i <= n; i++) { const t = a0 + (d * i) / n; ptAdd(x + Math.cos(t) * r, y + Math.sin(t) * r); } },
      ellipse(x, y, rx, ry, rot, a0, a1, ccw) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot || 0); ctx.scale(rx || 1e-6, ry || 1e-6); ctx.arc(0, 0, 1, a0, a1, ccw); ctx.restore(); },
      closePath() { if (cur) { cur.closed = true; const f = cur.pts[0]; cur = null; if (f) lastU = [f[2], f[3]]; } },
      fill() { for (const s of subs) polyFill(s.pts, fillP); },
      stroke() {
        const w = st.lineWidth * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) / 2;
        if (strokeP.kind !== "color") return;
        useBlend(); useTex(E.white);
        const c = scaled(strokeP.c);
        for (const s of subs) {
          const P = s.closed ? s.pts.concat([s.pts[0]]) : s.pts;
          for (let i = 0; i + 1 < P.length; i++) {
            const [ax, ay] = P[i], [bx, by] = P[i + 1], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * w, ny = (dx / l) * w, ex = (dx / l) * w * 0.5, ey = (dy / l) * w * 0.5;
            const q = [[ax - nx - ex, ay - ny - ey, 0.5, 0.5], [bx - nx + ex, by - ny + ey, 0.5, 0.5], [bx + nx + ex, by + ny + ey, 0.5, 0.5], [ax + nx - ex, ay + ny - ey, 0.5, 0.5]];
            tri(q[0], q[1], q[2], c, 0); tri(q[0], q[2], q[3], c, 0);
          }
        }
        drew();
      },
      // A clip here (the painter keeps rectangle clips itself): the clip rectangle to the current path's bounds.
      clip() {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of subs) for (const p of s.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        if (!(x1 > x0)) return;
        let r = [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(W(), Math.ceil(x1)), Math.min(Hh(), Math.ceil(y1))];
        if (scissor) r = [Math.max(r[0], scissor[0]), Math.max(r[1], scissor[1]), Math.min(r[2], scissor[2]), Math.min(r[3], scissor[3])];
        if (r[2] < r[0]) r[2] = r[0]; if (r[3] < r[1]) r[3] = r[1];
        scissor = r;
      },
      isPointInPath() { return false; },
      // Text: a bitmap of its own (CPU Canvas 2D), then a quad under the current transform. Plain colors: one white
      // bitmap per font and text, colored on the GPU (tint), so fading particles do not make a bitmap per frame.
      fillText(text, x, y) {
        text = String(text);
        const col = fillP.kind === "color" && typeof st.fillSrc === "string" ? H.parseColor(st.fillSrc) : null;
        const key = st.font + "|" + (col ? "#fff" : st.fillSrc) + "|" + text;
        let c = textCanvas.get(key);
        if (!c) {
          const fs = parseFloat(/(\d+(?:\.\d+)?)px/.exec(st.font)?.[1] || 10);
          const [a, d] = H.fontMetrics(st.font, fs);
          const w = Math.ceil(H.measure(st.font, text)) + 4;
          c = g.document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, Math.ceil(a + d) + 4);
          if (ops.op_c2d_kick) ops.op_c2d_kick();
          const t2 = c.getContext("2d"); t2.font = st.font; t2.fillStyle = col ? "#fff" : typeof st.fillSrc === "string" ? st.fillSrc : "#000"; t2.textBaseline = "alphabetic"; t2.fillText(text, 2, 2 + a);
          c._asc = a + 2; c._desc = d; c._w = w - 4;
          textCanvas.set(key, c);
          if (textCanvas.size > 300) { const [k0, c0] = textCanvas.entries().next().value; textCanvas.delete(k0); c0.width = c0.height = 0; }
        }
        const al = st.align;
        const ox = al === "center" ? -c._w / 2 : al === "right" || al === "end" ? -c._w : 0;
        const b = st.baseline, a = c._asc - 2;
        const oy = b === "top" || b === "hanging" ? a : b === "middle" ? (a - c._desc) / 2 : b === "bottom" || b === "ideographic" ? -c._desc : 0;
        if (col) {
          const t0 = st.tint;
          st.tint = [col[0] / 255, col[1] / 255, col[2] / 255, col[3]];
          ctx.drawImage(c, x + ox - 2, y + oy - c._asc);
          st.tint = t0;
        } else ctx.drawImage(c, x + ox - 2, y + oy - c._asc);
      },
      strokeText() {},
      measureText(t) { return { width: H.measure(st.font, String(t)), actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }; },
      setLineDash() {}, getLineDash() { return []; },
      // An immutable bitmap (text): uploaded now, at a moment chosen by the caller. True when it went up.
      upload(src) { return !!E.texOf(src); },
      // A CPU page canvas the page draws into every frame: uploaded here, at the start of the next frame, so the upload
      // finds its drawing finished (Canvas 2D draws on its own threads) instead of waiting for it; paints of that
      // frame use this copy. True when new contents went up.
      latch(src) {
        if (src._glc) return false;
        const e0 = E.texes.get(src), ver = src._ver | 0;
        const w = src.width, h = src.height;
        if (!w || !h || (e0 && e0.latched && e0.ver === ver && e0.w === w && e0.h === h)) return false;
        const e = E.texOf(src, true);
        if (e) e.latched = true;
        return !!e;
      },
      // Frame bookends for the page (87_paint.js): state set again, and the batch out to the GPU.
      begin() { E.flushPending(); E.reset(); scissor = null; },
      end() { flushNow(); scissor = null; },
      flush: flushNow,
    };
    Object.defineProperty(ctx, "_batch", { value: me });
    return ctx;
  }

  // The page context, drawing into the page's WebGL canvas (presented by the runtime).
  H.makeGL = (canvas) => {
    E = engine(canvas);
    if (!E) return null;
    return makeCtx({ fbo: null, page: true, canvas, w: () => canvas.width, h: () => canvas.height }, null);
  };
  H.glReset = () => { if (E) E.reset(); };

  // A page canvas with a GPU 2D context: a texture of its size and a framebuffer on it. Setting width or height
  // reallocates and clears it, as for Canvas 2D. getImageData / putImageData read and write the texture.
  H.glCanvas2D = (el) => {
    if (!E) return null;
    const gl = E.gl;
    let w = Math.max(1, el.width | 0), h = Math.max(1, el.height | 0);
    // Below zoom 1 the canvas renders at its on-screen size (the page shows it scaled by the zoom): fewer pixels for
    // the GPU to fill. Its context scales the page's coordinates; image data reads and writes resample.
    const K = H.pageScale < 1 ? H.pageScale : 1, tw = () => Math.max(1, Math.ceil(w * K)), th = () => Math.max(1, Math.ceil(h * K));
    const tex = E.mkTex(), fbo = gl.createFramebuffer();
    const alloc = () => {
      E.flushPending();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw(), th(), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      E.bound = undefined;
      el._painted = true;
    };
    alloc();
    const target = { fbo, page: false, canvas: el, w: tw, h: th, scale: K };
    const ctx = makeCtx(target, el);
    const entry = { t: tex, w, h, ver: 0 };
    // width / height: as Canvas 2D, setting either (even to the same value) clears the canvas and resets its state.
    for (const k of ["width", "height"]) {
      Object.defineProperty(el, k, {
        get() { return k === "width" ? w : h; },
        set(v) { v = Math.max(1, v | 0); if (k === "width") w = v; else h = v; entry.w = w; entry.h = h; alloc(); ctx.resetTransform(); },
        configurable: true,
      });
    }
    // Canvas pixels <-> texture pixels (nearest) when K < 1.
    const resample = (src, sw, sh, dw, dh) => {
      const out = new Uint8Array(dw * dh * 4);
      for (let y = 0; y < dh; y++) { const sy = Math.min(sh - 1, Math.floor((y * sh) / dh)); for (let x = 0; x < dw; x++) { const sx = Math.min(sw - 1, Math.floor((x * sw) / dw)), o = (y * dw + x) * 4, i = (sy * sw + sx) * 4; out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3]; } }
      return out;
    };
    ctx.getImageData = (x, y, cw, ch) => {
      E.flushPending(); ctx.flush();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); E.bound = undefined;
      cw |= 0; ch |= 0;
      let px;
      if (K === 1) { px = new Uint8Array(cw * ch * 4); gl.readPixels(x | 0, y | 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      else {
        const rx = Math.floor(x * K), ry = Math.floor(y * K), rw = Math.max(1, Math.round(cw * K)), rh = Math.max(1, Math.round(ch * K));
        const raw = new Uint8Array(rw * rh * 4); gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        px = resample(raw, rw, rh, cw, ch);
      }
      for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; if (a && a < 255) { px[i] = Math.min(255, (px[i] * 255) / a); px[i + 1] = Math.min(255, (px[i + 1] * 255) / a); px[i + 2] = Math.min(255, (px[i + 2] * 255) / a); } }
      const d = new g.ImageData(cw, ch); d.data.set(px); return d;
    };
    ctx.putImageData = (d, x, y) => {
      E.flushPending(); ctx.flush();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const src = new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength);
      if (K === 1) gl.texSubImage2D(gl.TEXTURE_2D, 0, x | 0, y | 0, d.width, d.height, gl.RGBA, gl.UNSIGNED_BYTE, src);
      else {
        const rw = Math.max(1, Math.round(d.width * K)), rh = Math.max(1, Math.round(d.height * K));
        gl.texSubImage2D(gl.TEXTURE_2D, 0, Math.floor(x * K), Math.floor(y * K), rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, resample(src, d.width, d.height, rw, rh));
      }
      el._painted = true;
    };
    ctx.createImageData = (cw, ch) => new g.ImageData(typeof cw === "object" ? cw.width : cw, typeof cw === "object" ? cw.height : ch);
    el._glc = { ctx, entry: () => { entry.w = w; entry.h = h; return entry; } };
    // Pages add helpers to CanvasRenderingContext2D.prototype (Cookie Clicker: fillPattern) and test instanceof:
    // the prototype goes under this context (its own methods win).
    if (g.CanvasRenderingContext2D) Object.setPrototypeOf(ctx, g.CanvasRenderingContext2D.prototype);
    return ctx;
  };
})();
