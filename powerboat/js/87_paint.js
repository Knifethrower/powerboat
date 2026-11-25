// powerboat JS environment, part 9c: painting HTML pages (POWERBOAT_HTML=1) and their pointer input.
// After each frame the laid-out page (86_layout.js) is drawn into one window-sized Canvas 2D that
// 79_webpage.js presents. Paint order follows CSS stacking: an element's background and border, its
// normal-flow content in tree order, then positioned descendants by z-index (each painted with its whole
// subtree). Overflow clips, scroll offsets, transforms and opacity apply to everything below them.
// Hit testing walks the same order backwards; hover drives :hover and mouseover/mouseout.
"use strict";
(() => {
  const ops = Deno.core.ops;
  if (ops.op_powerboat_env("POWERBOAT_HTML") !== "1") return;
  const g = globalThis, H = __powerboat.html, kidsOf = H.kidsOf, len = H.len;

  // ---- viewport: CSS pixels = window pixels / zoom -------------------------------------------
  const zoom = +(ops.op_powerboat_env("POWERBOAT_HTML_ZOOM") || 1) || 1;
  const baseW = Object.getOwnPropertyDescriptor(g, "innerWidth").get, baseH = Object.getOwnPropertyDescriptor(g, "innerHeight").get;
  Object.defineProperty(g, "innerWidth", { get: () => Math.round(baseW() / zoom), configurable: true });
  Object.defineProperty(g, "innerHeight", { get: () => Math.round(baseH() / zoom), configurable: true });
  // The page canvas is painted at pz device pixels per CSS pixel: the window scale when zooming in (crisp text) and,
  // with WebGL, when zooming out (window-size passes: on the R36S at zoom 0.8, 0.64x the pixels to fill). Canvas 2D
  // (CPU) zooming out paints at CSS size and the GPU scales the finished page down when presenting (no CPU
  // resampling of every image).
  const pz = zoom >= 1 || (ops.op_powerboat_env("POWERBOAT_HTML_GL") === "1" && !!H.makeGL) ? zoom : 1;
  H.pageScale = pz;
  const pageW = () => Math.round(g.innerWidth * pz), pageH = () => Math.round(g.innerHeight * pz);
  __powerboat.pagePoint = (fx, fy) => [fx * g.innerWidth, fy * g.innerHeight];
  g.addEventListener("resize", () => H.touch());

  // ---- the page canvas ------------------------------------------------------------------------
  // POWERBOAT_HTML_GL=1: the page is drawn with WebGL (86g_glctx.js) into a canvas the runtime presents as the
  // game canvas; otherwise with Canvas 2D (CPU) into one 79_webpage.js presents.
  const page = g.document.createElement("canvas");
  page.width = pageW(); page.height = pageH();
  const useGL = ops.op_powerboat_env("POWERBOAT_HTML_GL") === "1" && !!H.makeGL;
  let ctx = useGL ? H.makeGL(page) : null;
  if (ctx) { __powerboat.htmlGL = true; console.log("powerboat: HTML page drawn with WebGL"); }
  else { ctx = page.getContext("2d"); __powerboat.htmlPageCanvas = page; }
  // POWERBOAT_HTML_STATS=2: time per Canvas 2D call kind while painting.
  const opStats = ops.op_powerboat_env("POWERBOAT_HTML_STATS") === "2" ? new Map() : null;
  if (opStats) {
    for (const name of ["drawImage", "fillText", "fillRect", "fill", "stroke", "clip", "save", "restore"]) {
      const base = ctx[name].bind(ctx);
      ctx[name] = (...a) => { const t = performance.now(); const r = base(...a); const s = opStats.get(name) || [0, 0]; s[0]++; s[1] += performance.now() - t; opStats.set(name, s); return r; };
    }
    H.opStats = opStats;
  }
  // ---- the drawing layer: transform tracking and rectangle clips kept in JS ----------------------
  // A Canvas 2D clip costs a full-canvas mask in the runtime, and masked drawing is slower; boxes are
  // rectangles, so clips stay a device-space rectangle here and images, rects and paths are trimmed or
  // skipped against it. Only a path that straddles the clip, or a clip under rotation, uses a real clip.
  {
    let m = [1, 0, 0, 1, 0, 0], clip = null, noDraw = false;
    // Draw-less mode (hit boxes only): transforms and clips are tracked, nothing reaches the canvas.
    ctx.setNoDraw = (v) => { noDraw = !!v; };
    ctx.noDraw = () => noDraw;
    const stack = [];
    const mul = (n) => { const [a, b, c, d, e, f] = m; m = [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f]; };
    const base = {};
    for (const k of ["save", "restore", "translate", "scale", "rotate", "transform", "setTransform", "fillRect", "drawImage", "fill", "stroke", "clip", "beginPath", "rect", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "closePath"]) base[k] = ctx[k].bind(ctx);
    const wrap = (name, fn) => { ctx[name] = (...a) => { fn(...a); if (!noDraw) return base[name](...a); }; };
    wrap("save", () => stack.push([m, clip]));
    wrap("restore", () => { if (stack.length) [m, clip] = stack.pop(); });
    wrap("translate", (x, y) => mul([1, 0, 0, 1, x, y]));
    wrap("scale", (x, y) => mul([x, 0, 0, y, 0, 0]));
    wrap("rotate", (r) => mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]));
    wrap("transform", (a, b, c, d, e, f) => mul([a, b, c, d, e, f]));
    wrap("setTransform", (a, b, c, d, e, f) => { m = [a, b, c, d, e, f]; });
    ctx.getTransform = () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
    const axis = () => m[1] === 0 && m[2] === 0;
    const dev = (x, y, w, h) => { let x0 = m[0] * x + m[4], x1 = m[0] * (x + w) + m[4], y0 = m[3] * y + m[5], y1 = m[3] * (y + h) + m[5]; if (x1 < x0) [x0, x1] = [x1, x0]; if (y1 < y0) [y0, y1] = [y1, y0]; return [x0, y0, x1, y1]; };
    const meet = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    const empty = (r) => r[2] <= r[0] || r[3] <= r[1];
    ctx.clipRect = (x, y, w, h) => {
      if (axis()) { const r = dev(x, y, w, h); clip = clip ? meet(clip, r) : r; return; }
      if (!noDraw) { base.beginPath(); base.rect(x, y, w, h); base.clip(); }
    };
    ctx.clipBox = () => clip;
    ctx.isClippedOut = (x, y, w, h) => !!clip && axis() && empty(meet(clip, dev(x, y, w, h)));
    ctx.fillRect = (x, y, w, h) => {
      if (noDraw) return;
      if (!clip || !axis()) return base.fillRect(x, y, w, h);
      const d = dev(x, y, w, h), i = meet(clip, d);
      if (empty(i)) return;
      if (i[0] === d[0] && i[1] === d[1] && i[2] === d[2] && i[3] === d[3]) return base.fillRect(x, y, w, h);
      base.fillRect((i[0] - m[4]) / m[0], (i[1] - m[5]) / m[3], (i[2] - i[0]) / m[0], (i[3] - i[1]) / m[3]);
    };
    ctx.drawImage = (img, ...a) => {
      if (noDraw) return;
      if (!clip || !axis()) return base.drawImage(img, ...a);
      let sx = 0, sy = 0, sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height, dx, dy, dw, dh;
      if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; } else if (a.length === 4) [dx, dy, dw, dh] = a; else [sx, sy, sw, sh, dx, dy, dw, dh] = a;
      if (!(dw > 0 && dh > 0 && sw > 0 && sh > 0)) return;
      const d = dev(dx, dy, dw, dh), i = meet(clip, d);
      if (empty(i)) return;
      if (i[0] === d[0] && i[1] === d[1] && i[2] === d[2] && i[3] === d[3]) return base.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      // Trim the source by the same fractions (axis-aligned: d spans dw*|m0| by dh*|m3|).
      const fx0 = (i[0] - d[0]) / (d[2] - d[0]), fx1 = (i[2] - d[0]) / (d[2] - d[0]), fy0 = (i[1] - d[1]) / (d[3] - d[1]), fy1 = (i[3] - d[1]) / (d[3] - d[1]);
      const flipX = m[0] < 0, flipY = m[3] < 0;
      const ax0 = flipX ? 1 - fx1 : fx0, ax1 = flipX ? 1 - fx0 : fx1, ay0 = flipY ? 1 - fy1 : fy0, ay1 = flipY ? 1 - fy0 : fy1;
      base.drawImage(img, sx + sw * ax0, sy + sh * ay0, sw * (ax1 - ax0), sh * (ay1 - ay0), dx + dw * ax0, dy + dh * ay0, dw * (ax1 - ax0), dh * (ay1 - ay0));
    };
    // Paths: bounds and commands are kept so a fill can be skipped, drawn as is, or replayed under a real clip.
    let pb = null, cmds = [];
    const ext = (x, y) => { const px = m[0] * x + m[2] * y + m[4], py = m[1] * x + m[3] * y + m[5]; if (!pb) pb = [px, py, px, py]; else { if (px < pb[0]) pb[0] = px; if (py < pb[1]) pb[1] = py; if (px > pb[2]) pb[2] = px; if (py > pb[3]) pb[3] = py; } };
    ctx.beginPath = () => { pb = null; cmds = []; base.beginPath(); };
    ctx.rect = (x, y, w, h) => { ext(x, y); ext(x + w, y + h); cmds.push(["rect", x, y, w, h]); base.rect(x, y, w, h); };
    ctx.moveTo = (x, y) => { ext(x, y); cmds.push(["moveTo", x, y]); base.moveTo(x, y); };
    ctx.lineTo = (x, y) => { ext(x, y); cmds.push(["lineTo", x, y]); base.lineTo(x, y); };
    ctx.quadraticCurveTo = (a, b, x, y) => { ext(a, b); ext(x, y); cmds.push(["quadraticCurveTo", a, b, x, y]); base.quadraticCurveTo(a, b, x, y); };
    ctx.bezierCurveTo = (a, b, c, d, x, y) => { ext(a, b); ext(c, d); ext(x, y); cmds.push(["bezierCurveTo", a, b, c, d, x, y]); base.bezierCurveTo(a, b, c, d, x, y); };
    ctx.closePath = () => { cmds.push(["closePath"]); base.closePath(); };
    const drawPath = (kind, pad) => {
      if (noDraw) return;
      if (!clip || !pb) return base[kind]();
      const b = [pb[0] - pad, pb[1] - pad, pb[2] + pad, pb[3] + pad], i = meet(clip, b);
      if (empty(i)) return;
      if (i[0] === b[0] && i[1] === b[1] && i[2] === b[2] && i[3] === b[3]) return base[kind]();
      const saved = cmds, mm = m;
      base.save();
      base.setTransform(1, 0, 0, 1, 0, 0); base.beginPath(); base.rect(clip[0], clip[1], clip[2] - clip[0], clip[3] - clip[1]); base.clip();
      base.setTransform(mm[0], mm[1], mm[2], mm[3], mm[4], mm[5]); base.beginPath();
      for (const c of saved) base[c[0]](...c.slice(1));
      base[kind]();
      base.restore();
    };
    ctx.fill = () => drawPath("fill", 0);
    ctx.stroke = () => drawPath("stroke", (ctx.lineWidth || 1) / 2 * Math.max(Math.abs(m[0]), Math.abs(m[3])));
  }

  // ---- images by URL ----------------------------------------------------------------------------
  const images = new Map();
  function image(url) {
    let im = images.get(url);
    if (!im) { im = new g.Image(); im.onload = () => { H.dirtyPaint = true; }; im.src = url; images.set(url, im); }
    return im.complete && im.naturalWidth ? im : null;
  }
  const patterns = new Map();
  const patternOf = (im) => { let p = patterns.get(im); if (!p) patterns.set(im, p = ctx.createPattern(im, "repeat")); return p; };
  const urlOf = (v) => { const m = /url\(\s*(['"]?)([^'")]*)\1\s*\)/.exec(v); return m ? m[2] : null; };

  // ---- transforms -------------------------------------------------------------------------------
  // CSS transform list -> 2D matrix [a, b, c, d, e, f] around the transform origin.
  // Results by (text, box size, font size): elements with transforms are parsed every paint and for bounds.
  // The matrices are shared: callers only read them.
  const tfCache = new Map();
  function parseTransform(v, w, h, fs) {
    const key = v + "|" + w + "|" + h + "|" + fs;
    let r = tfCache.get(key);
    if (!r) {
      if (tfCache.size > 512) tfCache.clear();
      tfCache.set(key, r = parseTransform0(v, w, h, fs));
    }
    return r;
  }
  function parseTransform0(v, w, h, fs) {
    let m = [1, 0, 0, 1, 0, 0];
    const mul = (n) => { const [a, b, c, d, e, f] = m; m = [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f]; };
    const ang = (s) => { const n = parseFloat(s); return s.endsWith("turn") ? n * 2 * Math.PI : s.endsWith("rad") ? n : s.endsWith("grad") ? (n * Math.PI) / 200 : (n * Math.PI) / 180; };
    for (const t of v.matchAll(/([\w-]+)\(([^)]*)\)/g)) {
      const fn = t[1].toLowerCase(), a = t[2].split(/\s*,\s*|\s+/).filter(Boolean);
      switch (fn) {
        case "translate": mul([1, 0, 0, 1, len(a[0], w, fs) || 0, len(a[1] || "0", h, fs) || 0]); break;
        case "translatex": mul([1, 0, 0, 1, len(a[0], w, fs) || 0, 0]); break;
        case "translatey": mul([1, 0, 0, 1, 0, len(a[0], h, fs) || 0]); break;
        case "translate3d": mul([1, 0, 0, 1, len(a[0], w, fs) || 0, len(a[1], h, fs) || 0]); break;
        case "scale": { const sx = parseFloat(a[0]), sy = a[1] !== undefined ? parseFloat(a[1]) : sx; mul([sx, 0, 0, sy, 0, 0]); break; }
        case "scalex": mul([parseFloat(a[0]), 0, 0, 1, 0, 0]); break;
        case "scaley": mul([1, 0, 0, parseFloat(a[0]), 0, 0]); break;
        case "scale3d": mul([parseFloat(a[0]), 0, 0, parseFloat(a[1]), 0, 0]); break;
        case "rotate": case "rotatez": { const r = ang(a[0]), c = Math.cos(r), s = Math.sin(r); mul([c, s, -s, c, 0, 0]); break; }
        case "skewx": mul([1, 0, Math.tan(ang(a[0])), 1, 0, 0]); break;
        case "skewy": mul([1, Math.tan(ang(a[0])), 0, 1, 0, 0]); break;
        case "matrix": mul(a.map(Number)); break;
      }
    }
    return m;
  }
  const originOf = (cs, L) => {
    const p = cs["transform-origin"].split(/\s+/);
    const pos = (s, size) => (s === "left" || s === "top" ? 0 : s === "right" || s === "bottom" ? size : s === "center" || s === undefined ? size / 2 : len(s, size, cs._fs) ?? size / 2);
    return [L.x + pos(p[0], L.w), L.y + pos(p[1] ?? "center", L.h)];
  };

  // ---- CSS animations (keyframes on transform and opacity) -------------------------------------
  const t0 = performance.now();
  function animated(el, cs) {
    const name = cs["animation-name"];
    if (!name || name === "none") return null;
    const kf = H.keyframes.get(name.split(",")[0].trim());
    if (!kf || !kf.length) return null;
    const dur = parseFloat(cs["animation-duration"]) * (cs["animation-duration"].endsWith("ms") ? 1 : 1000);
    if (!(dur > 0)) return null;
    if (!el._animStart) el._animStart = performance.now();
    const iters = cs["animation-iteration-count"] === "infinite" ? Infinity : parseFloat(cs["animation-iteration-count"]) || 1;
    let t = (performance.now() - el._animStart) / dur;
    if (t >= iters) { if (!/forwards|both/.test(cs["animation-fill-mode"])) return null; t = 1; } else t = t % 1;
    let a = kf[0], b = kf[kf.length - 1];
    for (let i = 0; i < kf.length - 1; i++) if (t >= kf[i].at && t <= kf[i + 1].at) { a = kf[i]; b = kf[i + 1]; break; }
    const f = b.at > a.at ? (t - a.at) / (b.at - a.at) : 0;
    const get = (fr, k) => { for (const [kk, v] of fr.decls) if (kk === k) return v; return null; };
    const out = {};
    const oa = get(a, "opacity"), ob = get(b, "opacity");
    if (oa != null || ob != null) out.opacity = (+(oa ?? cs.opacity)) * (1 - f) + (+(ob ?? cs.opacity)) * f;
    const ta = get(a, "transform"), tb = get(b, "transform");
    if (ta || tb) out.transform = f < 0.5 ? ta || tb : tb || ta; // nearest keyframe (no matrix interpolation)
    H.animating = true;
    void t0;
    return out;
  }

  // Values derived from a computed style (colors, shadows, radii), worked out once per style object: a restyle
  // makes a new one.
  const der = (cs, key, fn) => { let d = cs._d; if (!d) d = cs._d = {}; let v = d[key]; if (v === undefined) v = d[key] = fn(); return v; };

  // ---- painting ---------------------------------------------------------------------------------
  let hits; // [el, x0, y0, x1, y1, clip] in paint order (page coordinates)
  const isPositioned = (cs) => cs.position !== "static";
  const zOf = (cs) => (cs["z-index"] === "auto" ? 0 : parseInt(cs["z-index"], 10) || 0);
  // A state: page-space offset of the current scroll, clip (page rect or null), alpha, transform stack.
  // The page, or the part of it inside `area` (device pixels [x0, y0, x1, y1]). Hit boxes are collected only by a
  // whole pass (`collect`), which can also run without drawing (hit testing after changes).
  let collecting = false;
  function paintRoot(area, collect, draw = true) {
    collecting = !!collect;
    if (collecting) hits = [];
    ctx.setNoDraw(!draw);
    if (draw && ctx.begin) ctx.begin();
    const W = page.width, Hh = page.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (area) ctx.clipRect(area[0], area[1], area[2] - area[0], area[3] - area[1]);
    ctx.globalAlpha = 1;
    const root = g.document.documentElement, body = g.document.body;
    // The canvas background: the root's, else the body's.
    let bg = root._cs && H.parseColor(root._cs["background-color"]);
    let bgSrc = root;
    if (!bg || !bg[3]) { bg = body && body._cs && H.parseColor(body._cs["background-color"]); bgSrc = body; }
    if (draw) { ctx.fillStyle = bg && bg[3] ? H.css(bg) : "#fff"; ctx.fillRect(0, 0, W, Hh); }
    ctx.setTransform(pz, 0, 0, pz, 0, 0);
    if (draw && bgSrc && bgSrc._cs && bgSrc._cs["background-image"] !== "none") paintBgImage(bgSrc, bgSrc._cs, { x: 0, y: 0, w: g.innerWidth, h: Math.max(g.innerHeight, root._L ? root._L.h : 0) });
    bgDone = bgSrc;
    paintStacking(root, { alpha: 1 });
    bgDone = null;
    ctx.restore();
    if (draw && ctx.end) ctx.end();
    ctx.setNoDraw(false);
    collecting = false;
  }
  let bgDone = null;
  // Stacking as CSS has it: an element with a z-index (positioned), opacity < 1 or a transform makes a stacking
  // context; positioned boxes with z-index auto paint at layer 0 in tree order, and their own positioned
  // descendants join the enclosing context's list (a z-index: 10000 button inside one beats a z-index: 5
  // sibling canvas).
  const hasAnim = (cs) => cs["animation-name"] && cs["animation-name"] !== "none" && H.keyframes.has(cs["animation-name"].split(",")[0].trim());
  const createsSC = (cs) => der(cs, "sc", () => (isPositioned(cs) && cs["z-index"] !== "auto") || +cs.opacity < 1 || cs.transform !== "none" || hasAnim(cs));
  const isLayer = (cs) => der(cs, "layer", () => isPositioned(cs) || createsSC(cs));
  // Clip and scroll an element puts on its content, as ops relative to its stacking context.
  function contentOps(el, ops) {
    const cs = el._cs, L = el._L;
    const clips = cs["overflow-x"] !== "visible" || cs["overflow-y"] !== "visible";
    const sx = el._scrollLeft || 0, sy = el._scrollTop || 0;
    if (!clips && !sx && !sy) return ops;
    const out = ops.slice();
    if (clips) out.push({ t: "clip", x: L.x + L.b[3], y: L.y + L.b[0], w: L.w - L.b[1] - L.b[3], h: L.h - L.b[0] - L.b[2] });
    if (sx || sy) out.push({ t: "scroll", x: sx, y: sy });
    return out;
  }
  // Layer entries under el (not inside nested stacking contexts), in tree order, with the ops above them.
  function collectLayers(el, ops, list) {
    for (const c of kidsOf(el)) {
      if (c.nodeType !== 1) continue;
      const ccs = c._cs;
      if (!ccs || ccs.display === "none" || !c._L) continue;
      // Outside the area being drawn: nothing below it paints there (bounds are in this context's space unless
      // a scrolled box lies between).
      if (cullOn && !ops.some((o) => o.t === "scroll") && culled(c)) continue;
      if (isLayer(ccs)) {
        const sc = createsSC(ccs);
        list.push({ el: c, z: sc ? zOf(ccs) : 0, i: list.length, ops, sc });
        if (sc) continue;
      }
      collectLayers(c, contentOps(c, ops), list);
    }
  }
  // Paint el as a stacking context: background, negative layers, flow content, then the other layers by z.
  function paintStacking(el, st) {
    const cs = el._cs;
    if (!cs || !el._L) return;
    if (culled(el)) return;
    const anim = animated(el, cs);
    if (anim && H.animEls) H.animEls.add(el);
    const opacity = anim && anim.opacity != null ? anim.opacity : +cs.opacity;
    if (!(opacity > 0.002)) return;
    const tf = anim && anim.transform ? anim.transform : cs.transform;
    ctx.save();
    const alpha = st.alpha * (Number.isFinite(opacity) ? opacity : 1);
    if (tf && tf !== "none") {
      const L = el._L, [ox, oy] = originOf(cs, L), t = parseTransform(tf, L.w, L.h, cs._fs);
      ctx.translate(ox, oy); ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]); ctx.translate(-ox, -oy);
    }
    const s = { alpha };
    const list = [];
    collectLayers(el, contentOps(el, []), list);
    list.sort((a, b) => a.z - b.z || a.i - b.i);
    paintFlow(el, s, true, false);
    const paintLayer = (ly) => {
      ctx.save();
      for (const op of ly.ops) applyOp(op);
      if (ly.sc) paintStacking(ly.el, s); else paintFlow(ly.el, s, true, true);
      ctx.restore();
    };
    let k = 0;
    for (; k < list.length && list[k].z < 0; k++) paintLayer(list[k]);
    paintFlow(el, s, false, true);
    for (; k < list.length; k++) paintLayer(list[k]);
    ctx.restore();
  }
  function applyOp(op) {
    if (op.t === "clip") ctx.clipRect(op.x, op.y, op.w, op.h);
    else if (op.t === "scroll") ctx.translate(-op.x, -op.y);
  }
  // One box's own painting (background, border, replaced content) and/or its normal-flow content (text and
  // descendants that are not layers).
  function paintFlow(el, st, own, content) {
    const cs = el._cs, L = el._L;
    if (!cs || !L) return;
    H.nFlow = (H.nFlow | 0) + 1;
    if (own && content && culled(el)) return;
    const visible = cs.visibility !== "hidden" && cs.visibility !== "collapse";
    if (own) {
      if (visible && el !== bgDone && !ctx.noDraw()) {
        ctx.globalAlpha = st.alpha;
        if (L.frags) { for (const f of L.frags) paintBackgroundBorder(el, cs, { x: f.x, y: f.y, w: f.w, h: f.h, b: L.b, p: L.p }); }
        else paintBackgroundBorder(el, cs, L);
        if (el.tagName === "IMG" || el.tagName === "CANVAS") withDropShadows(cs, () => paintReplaced(el, cs, L, st));
      }
      if (cs["pointer-events"] !== "none") {
        if (L.frags) for (const f of L.frags) recordHit(el, f.x, f.y, f.w, f.h);
        else recordHit(el, L.x, L.y, L.w, L.h);
      }
    }
    if (!content) return;
    const ops = contentOps(el, []);
    if (ops.length) {
      if (ops[0].t === "clip" && ctx.isClippedOut(L.x, L.y, L.w, L.h)) { if (L.sb && visible) paintScrollbar(el, cs, L, st); return; }
      ctx.save();
      for (const op of ops) applyOp(op);
    }
    for (const c of kidsOf(el)) {
      if (c.nodeType === 3) { paintText(c, el, st); continue; }
      if (c.nodeType !== 1) continue;
      const ccs = c._cs;
      if (!ccs || ccs.display === "none" || !c._L || isLayer(ccs)) continue;
      paintFlow(c, st, true, true);
    }
    if (ops.length) ctx.restore();
    if (L.sb && visible) paintScrollbar(el, cs, L, st);
  }
  // A vertical scrollbar in the gutter: track and thumb in scrollbar-color (thumb track).
  function paintScrollbar(el, cs, L, st) {
    const x = L.x + L.w - L.b[1] - L.sb, y = L.y + L.b[0], h = L.h - L.b[0] - L.b[2];
    if (h <= 0) return;
    const colors = (inheritedProp(el, "scrollbar-color") || "#c1c1c1 #f1f1f1").split(/\s+(?![^(]*\))/);
    const thumb = H.parseColor(colors[0]) || [193, 193, 193, 1], track = H.parseColor(colors[1] || "#f1f1f1") || [241, 241, 241, 1];
    ctx.globalAlpha = st.alpha;
    if (ctx.noDraw()) { recordHit(el, x, y, L.sb, h); return; }
    ctx.fillStyle = H.css(track); ctx.fillRect(x, y, L.sb, h);
    const total = Math.max(h, H.contentExtent(el)[1]);
    if (total > h + 0.5) {
      const th = Math.max(20, (h * h) / total), ty = y + ((el._scrollTop || 0) / (total - h)) * (h - th);
      ctx.fillStyle = H.css(thumb); roundRect(x + 3, ty + 2, L.sb - 6, th - 4, [4, 4, 4, 4]); ctx.fill();
    }
    recordHit(el, x, y, L.sb, h);
  }
  // scrollbar-color is inherited but not in the computed set: read the nearest specified one.
  function inheritedProp(el, k) { for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (n._cs && n._cs[k]) return n._cs[k]; return null; }
  const intersect = (a, b) => { if (!a) return b; if (!b) return a; const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y); return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }; };
  // Page rect -> viewport rect under the state's scrolling (transforms: translation part only).
  const toScreen = (r, st) => ({ x: r.x - (st.sx || 0), y: r.y - (st.sy || 0), w: r.w, h: r.h });
  // Hit boxes in CSS pixels of the window: the box under the current transform, and the current clip.
  function recordHit(el, x, y, w, h) {
    if (!collecting || w <= 0 || h <= 0) return;
    const t = ctx.getTransform();
    let x0, y0, x1, y1;
    if (t.b === 0 && t.c === 0) { x0 = (t.a * x + t.e) / pz; x1 = (t.a * (x + w) + t.e) / pz; y0 = (t.d * y + t.f) / pz; y1 = (t.d * (y + h) + t.f) / pz; if (x1 < x0) [x0, x1] = [x1, x0]; if (y1 < y0) [y0, y1] = [y1, y0]; }
    else {
      const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [(t.a * px + t.c * py + t.e) / pz, (t.b * px + t.d * py + t.f) / pz]);
      x0 = Math.min(...pts.map((p) => p[0])); y0 = Math.min(...pts.map((p) => p[1])); x1 = Math.max(...pts.map((p) => p[0])); y1 = Math.max(...pts.map((p) => p[1]));
    }
    const c = ctx.clipBox();
    hits.push([el, x0, y0, x1, y1, c ? { x: c[0] / pz, y: c[1] / pz, w: (c[2] - c[0]) / pz, h: (c[3] - c[1]) / pz } : null]);
  }

  // ---- backgrounds and borders ------------------------------------------------------------------
  const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];
  function radii(cs, L) {
    if (!der(cs, "hasRad", () => CORNERS.some((c) => { const v = cs["border-" + c + "-radius"]; return v && v !== "0" && v !== "0px"; }))) return null;
    const r = CORNERS.map((c) => { const v = cs["border-" + c + "-radius"]; return v && v !== "0" && v !== "0px" ? len(v.split(" ")[0], Math.min(L.w, L.h), cs._fs) || 0 : 0; });
    if (!r[0] && !r[1] && !r[2] && !r[3]) return null;
    const k = Math.min(1, L.w / Math.max(1e-6, r[0] + r[1]), L.w / Math.max(1e-6, r[3] + r[2]), L.h / Math.max(1e-6, r[0] + r[3]), L.h / Math.max(1e-6, r[1] + r[2]));
    return r.map((x) => x * k);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (!r) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + r[0], y);
    ctx.lineTo(x + w - r[1], y); if (r[1]) ctx.quadraticCurveTo(x + w, y, x + w, y + r[1]);
    ctx.lineTo(x + w, y + h - r[2]); if (r[2]) ctx.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
    ctx.lineTo(x + r[3], y + h); if (r[3]) ctx.quadraticCurveTo(x, y + h, x, y + h - r[3]);
    ctx.lineTo(x, y + r[0]); if (r[0]) ctx.quadraticCurveTo(x, y, x + r[0], y);
    ctx.closePath();
  }
  function paintBackgroundBorder(el, cs, L) {
    const a0 = ctx.globalAlpha;
    const rad = radii(cs, L);
    if (cs["box-shadow"] !== "none") paintBoxShadow(cs, L, rad);
    const bgc = der(cs, "bgColor", () => { const bg = H.parseColor(cs["background-color"], cs.color); return bg && bg[3] > 0 ? H.css(bg) : null; });
    if (bgc) { ctx.fillStyle = bgc; roundRect(L.x, L.y, L.w, L.h, rad); ctx.fill(); }
    if (cs["background-image"] !== "none") {
      // Rounded corners do not clip background images (a mask per box costs too much).
      withDropShadows(cs, () => paintBgImage(el, cs, L));
    }
    if (cs["border-image"] && cs["border-image"] !== "none" && urlOf(cs["border-image"])) paintBorderImage(cs, L);
    else paintBorder(cs, L, rad);
    ctx.globalAlpha = a0;
  }
  // Rounded border with differing sides: each side stroked along its part of the outline, from the middle of
  // one corner curve to the middle of the next (quadratic corners, as roundRect draws them).
  function roundedSides(L, b, col, rad) {
    const { x, y, w, h } = L;
    for (let i = 0; i < 4; i++) {
      const c = col[i]; if (!c || !c[3] || !b[i]) continue;
      const k = b[i] / 2, X0 = x + k, Y0 = y + k, X1 = x + w - k, Y1 = y + h - k;
      const r = rad.map((v) => Math.max(0, v - k));
      // Corners clockwise: [start, control, end].
      const C = [[[X0, Y0 + r[0]], [X0, Y0], [X0 + r[0], Y0]], [[X1 - r[1], Y0], [X1, Y0], [X1, Y0 + r[1]]],
        [[X1, Y1 - r[2]], [X1, Y1], [X1 - r[2], Y1]], [[X0 + r[3], Y1], [X0, Y1], [X0, Y1 - r[3]]]];
      const mid = (q) => [0.25 * q[0][0] + 0.5 * q[1][0] + 0.25 * q[2][0], 0.25 * q[0][1] + 0.5 * q[1][1] + 0.25 * q[2][1]];
      const a = C[i], z = C[(i + 1) % 4], ma = mid(a), mz = mid(z);
      ctx.beginPath();
      ctx.moveTo(ma[0], ma[1]);
      ctx.quadraticCurveTo((a[1][0] + a[2][0]) / 2, (a[1][1] + a[2][1]) / 2, a[2][0], a[2][1]);
      ctx.lineTo(z[0][0], z[0][1]);
      ctx.quadraticCurveTo((z[0][0] + z[1][0]) / 2, (z[0][1] + z[1][1]) / 2, mz[0], mz[1]);
      ctx.strokeStyle = H.css(c); ctx.lineWidth = b[i];
      ctx.stroke();
    }
  }
  // filter: drop-shadow(dx dy blur color): the shadow of the element's images (background sprites, <img>,
  // <canvas>) as tinted copies under them; a blur as a ring of faint copies. Needs a backend with tint (WebGL).
  function dropShadows(cs) { return der(cs, "dropShadows", () => dropShadows0(cs)); }
  function dropShadows0(cs) {
    const f = cs.filter;
    if (!f || f === "none" || !f.includes("drop-shadow") || !("tint" in ctx)) return null;
    const out = [];
    for (const m of f.matchAll(/drop-shadow\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      const toks = H.splitTop(m[1]), nums = [], ct = [];
      for (const t of toks) { if (/^-?[\d.]+(px)?$/.test(t)) nums.push(parseFloat(t)); else ct.push(t); }
      const c = H.parseColor(ct.join(" ") || "black", cs.color);
      if (c && c[3]) out.push({ dx: nums[0] || 0, dy: nums[1] || 0, blur: nums[2] || 0, c });
    }
    return out.length ? out : null;
  }
  function withDropShadows(cs, draw) {
    const sh = dropShadows(cs);
    if (sh) {
      const a0 = ctx.globalAlpha;
      for (const s of sh) {
        const offs = s.blur > 0 ? [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]].map(([u, v]) => [u * s.blur * 0.5, v * s.blur * 0.5]) : [[0, 0]];
        ctx.tint = [s.c[0] / 255, s.c[1] / 255, s.c[2] / 255, s.c[3] * (s.blur > 0 ? 0.35 : 1)];
        for (const [ox, oy] of offs) { ctx.save(); ctx.translate(s.dx + ox, s.dy + oy); draw(); ctx.restore(); }
        ctx.tint = null;
      }
      ctx.globalAlpha = a0;
    }
    draw();
  }
  function paintBorder(cs, L, rad) {
    const b = L.b;
    if (!b[0] && !b[1] && !b[2] && !b[3]) return;
    const col = der(cs, "borderColors", () => ["top", "right", "bottom", "left"].map((s) => H.parseColor(cs["border-" + s + "-color"], cs.color)));
    if (rad && b[0] === b[1] && b[1] === b[2] && b[2] === b[3] && col.every((c) => c && col[0] && c.join() === col[0].join())) {
      if (!col[0] || !col[0][3]) return;
      ctx.strokeStyle = H.css(col[0]); ctx.lineWidth = b[0];
      const h2 = b[0] / 2;
      roundRect(L.x + h2, L.y + h2, L.w - b[0], L.h - b[0], rad.map((r) => Math.max(0, r - h2)));
      ctx.stroke();
      return;
    }
    if (rad) { roundedSides(L, b, col, rad); return; }
    const style = (s) => cs["border-" + s + "-style"];
    const side = (i, x, y, w, h, s) => {
      const c = col[i]; if (!c || !c[3] || !b[i]) return;
      let cc = c;
      if (s === "inset" || s === "outset" || s === "groove" || s === "ridge") { const dark = (s === "inset" || s === "groove") === (i === 0 || i === 3); cc = dark ? [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, c[3]] : c; }
      ctx.fillStyle = H.css(cc);
      if (s === "dashed" || s === "dotted") {
        const step = s === "dotted" ? b[i] : b[i] * 3, horiz = i === 0 || i === 2;
        for (let p = 0; p < (horiz ? w : h); p += step * 2) { if (horiz) ctx.fillRect(x + p, y, Math.min(step, w - p), h); else ctx.fillRect(x, y + p, w, Math.min(step, h - p)); }
      } else ctx.fillRect(x, y, w, h);
    };
    side(0, L.x, L.y, L.w, b[0], style("top"));
    side(2, L.x, L.y + L.h - b[2], L.w, b[2], style("bottom"));
    side(3, L.x, L.y + b[0], b[3], L.h - b[0] - b[2], style("left"));
    side(1, L.x + L.w - b[1], L.y + b[0], b[1], L.h - b[0] - b[2], style("right"));
  }
  // border-image: url(...) slice [fill] [/ width] [repeat]: nine pieces over the border area. Drawn once per box
  // size into a bitmap ("round" edges are many small pieces), then copied.
  const borderCache = new Map();
  function paintBorderImage(cs, L) {
    const v = cs["border-image"], im = image(urlOf(v));
    if (!im) return;
    const k = Math.abs(ctx.getTransform().a) || 1, cw = Math.max(1, Math.round(L.w * k)), ch = Math.max(1, Math.round(L.h * k));
    const key = v + "|" + L.b.join() + "|" + cw + "x" + ch;
    let c = borderCache.get(key);
    if (!c) {
      c = g.document.createElement("canvas"); c.width = cw; c.height = ch;
      const tc = c.getContext("2d");
      tc.setTransform(cw / L.w, 0, 0, ch / L.h, 0, 0);
      drawBorderImage(tc, im, v, { x: 0, y: 0, w: L.w, h: L.h, b: L.b });
      borderCache.set(key, c);
      if (borderCache.size > 48) { const [k0, c0] = borderCache.entries().next().value; borderCache.delete(k0); c0.width = c0.height = 0; }
    }
    ctx.drawImage(c, L.x, L.y, L.w, L.h);
  }
  function drawBorderImage(tc, im, v, L) {
    const rest = v.replace(/url\([^)]*\)/, "").trim().split(/\s+/);
    const nums = rest.filter((t) => /^[\d.]+%?$/.test(t)).map((t) => (t.endsWith("%") ? (parseFloat(t) / 100) : +t));
    const sl = [nums[0] ?? 0, nums[1] ?? nums[0] ?? 0, nums[2] ?? nums[0] ?? 0, nums[3] ?? nums[1] ?? nums[0] ?? 0];
    const iw = im.naturalWidth, ih = im.naturalHeight;
    const s = sl.map((x, i) => (x < 1 && x > 0 && rest.some((t) => t.endsWith("%")) ? x * (i % 2 ? iw : ih) : x));
    const b = L.b.map((x, i) => x || s[i]);
    const fill = rest.includes("fill");
    const piece = (sx, sy, sw, sh, dx, dy, dw, dh) => { if (sw > 0 && sh > 0 && dw > 0 && dh > 0) tc.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh); };
    const { x, y, w, h } = L;
    piece(0, 0, s[3], s[0], x, y, b[3], b[0]);
    piece(iw - s[1], 0, s[1], s[0], x + w - b[1], y, b[1], b[0]);
    piece(0, ih - s[2], s[3], s[2], x, y + h - b[2], b[3], b[2]);
    piece(iw - s[1], ih - s[2], s[1], s[2], x + w - b[1], y + h - b[2], b[1], b[2]);
    const mw = iw - s[1] - s[3], mh = ih - s[0] - s[2];
    const round = rest.includes("round") || rest.includes("repeat");
    const edge = (sx, sy, sw, sh, dx, dy, dw, dh, horiz) => {
      if (!round) { piece(sx, sy, sw, sh, dx, dy, dw, dh); return; }
      const unit = horiz ? (sw * dh) / sh : (sh * dw) / sw;
      const n = Math.max(1, Math.round((horiz ? dw : dh) / Math.max(1, unit))), step = (horiz ? dw : dh) / n;
      for (let i = 0; i < n; i++) horiz ? piece(sx, sy, sw, sh, dx + i * step, dy, step, dh) : piece(sx, sy, sw, sh, dx, dy + i * step, dw, step);
    };
    edge(s[3], 0, mw, s[0], x + b[3], y, w - b[1] - b[3], b[0], true);
    edge(s[3], ih - s[2], mw, s[2], x + b[3], y + h - b[2], w - b[1] - b[3], b[2], true);
    edge(0, s[0], s[3], mh, x, y + b[0], b[3], h - b[0] - b[2], false);
    edge(iw - s[1], s[0], s[1], mh, x + w - b[1], y + b[0], b[1], h - b[0] - b[2], false);
    if (fill) piece(s[3], s[0], mw, mh, x + b[3], y + b[0], w - b[1] - b[3], h - b[0] - b[2]);
  }
  function paintBoxShadow(cs, L, rad) {
    const list = der(cs, "boxShadow", () => {
      const out = [];
      for (const sh of H.splitTop(cs["box-shadow"], ",").reverse()) {
        const toks = H.splitTop(sh);
        if (toks.includes("inset")) continue;
        const nums = [], colT = [];
        for (const t of toks) { if (/^-?[\d.]+(px|em)?$/.test(t)) nums.push(len(t, null, cs._fs) || 0); else colT.push(t); }
        const c = H.parseColor(colT.join(" ") || "black", cs.color);
        if (c && c[3]) out.push({ c, n: nums });
      }
      return out;
    });
    for (const { c, n: nums } of list) {
      const [dx = 0, dy = 0, blur = 0, spread = 0] = nums;
      const steps = blur > 0 ? Math.min(6, Math.ceil(blur / 2)) : 1;
      for (let i = steps; i >= 1; i--) {
        const grow = spread + (blur * i) / steps / 2;
        ctx.fillStyle = H.css(c, blur > 0 ? 1 / (steps + 1) : 1);
        roundRect(L.x + dx - grow, L.y + dy - grow, L.w + grow * 2, L.h + grow * 2, rad ? rad.map((r) => r + grow) : grow > 0 ? [grow, grow, grow, grow] : null);
        ctx.fill();
      }
    }
  }
  // Background layers, bottom (last listed) first; position / size / repeat lists repeat as needed.
  // Background layers, bottom (last listed) first. Their geometry (image, tile size, origin, repeat) is worked
  // out once per computed style and box, then drawn from that plan every repaint.
  function paintBgImage(el, cs, L) {
    let plan = el && el._bgPlan;
    if (!plan || plan.cs !== cs || plan.x !== L.x || plan.y !== L.y || plan.w !== L.w || plan.h !== L.h || plan.pending) {
      plan = bgPlan(cs, L);
      if (el) el._bgPlan = plan;
    }
    for (const p of plan.layers) drawBgLayer(p, L);
  }
  function bgPlan(cs, L) {
    const plan = { cs, x: L.x, y: L.y, w: L.w, h: L.h, layers: [], pending: false };
    const imgs = H.splitTop(cs["background-image"], ",");
    const pos = H.splitTop(cs["background-position"], ","), size = H.splitTop(cs["background-size"], ","), rep = H.splitTop(cs["background-repeat"], ",");
    for (let i = imgs.length - 1; i >= 0; i--) {
      const v = imgs[i].trim();
      if (v === "none") continue;
      const p = bgLayerPlan(cs, L, v, pos[i % pos.length] || "0% 0%", size[i % size.length] || "auto", rep[i % rep.length] || "repeat");
      if (p === "pending") plan.pending = true; else if (p) plan.layers.push(p);
    }
    return plan;
  }
  // One layer: url() with position / size / repeat over the padding box, or a gradient ("pending" while the
  // image loads).
  function bgLayerPlan(cs, L, v, posV, sizeV, repV) {
    const px = L.x + (L.b ? L.b[3] : 0), py = L.y + (L.b ? L.b[0] : 0);
    const pw = L.w - (L.b ? L.b[1] + L.b[3] : 0), ph = L.h - (L.b ? L.b[0] + L.b[2] : 0);
    if (pw <= 0 || ph <= 0) return null;
    if (/gradient\(/i.test(v)) return { grad: v, cs };
    const url = urlOf(v);
    if (!url) return null;
    const im = image(url);
    if (!im) return "pending";
    const iw = im.naturalWidth, ih = im.naturalHeight;
    let tw = iw, th = ih;
    const sz = sizeV.trim().split(/\s+/);
    if (sz[0] === "cover" || sz[0] === "contain") { const k = sz[0] === "cover" ? Math.max(pw / iw, ph / ih) : Math.min(pw / iw, ph / ih); tw = iw * k; th = ih * k; }
    else if (sz[0] !== "auto" || (sz[1] && sz[1] !== "auto")) {
      const w2 = sz[0] === "auto" ? null : len(sz[0], pw, cs._fs), h2 = !sz[1] || sz[1] === "auto" ? null : len(sz[1], ph, cs._fs);
      if (w2 != null && h2 != null) { tw = w2; th = h2; } else if (w2 != null) { tw = w2; th = (ih * w2) / iw; } else if (h2 != null) { th = h2; tw = (iw * h2) / ih; }
    }
    if (tw <= 0 || th <= 0) return null;
    const p = posV.trim().split(/\s+/);
    const kw = { left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" };
    let xs = p[0] || "0%", ys = p[1] || "50%";
    if (p.length === 1 && (xs === "top" || xs === "bottom")) { ys = xs; xs = "50%"; }
    if (xs === "top" || xs === "bottom" || ys === "left" || ys === "right") { const t = xs; xs = ys; ys = t; }
    const posOf = (s, free) => { s = kw[s] || s; return s.endsWith("%") ? (parseFloat(s) / 100) * free : len(s, free, cs._fs) || 0; };
    const ox = px + posOf(xs, pw - tw), oy = py + posOf(ys, ph - th);
    const rep = repV.trim();
    const rx = rep === "repeat" || rep === "repeat-x" || rep === "round" || rep === "space" || rep.startsWith("repeat repeat") || rep === "repeat no-repeat";
    const ry = rep === "repeat" || rep === "repeat-y" || rep === "round" || rep === "space" || rep === "no-repeat repeat";
    return { im, iw, ih, tw, th, ox, oy, rx, ry };
  }
  function drawBgLayer(q, L) {
    if (q.grad) { paintGradient(q.grad, q.cs, L.x, L.y, L.w, L.h); return; }
    const { im, iw, ih, tw, th, ox, oy, rx, ry } = q;
    if (ctx.isClippedOut(L.x, L.y, L.w, L.h)) return;
    // Tiled both ways over the whole box: one fill with the tile placed in the pattern (WebGL backend).
    if (rx && ry && ctx.patternAt) { ctx.fillStyle = ctx.patternAt(im, ox, oy, tw, th); ctx.fillRect(L.x, L.y, L.w, L.h); return; }
    ctx.save();
    ctx.clipRect(L.x, L.y, L.w, L.h);
    if (rx || ry) {
      // Repeating: one pattern fill anchored at the tile origin (scaled when background-size scales it).
      const x0 = rx ? L.x : ox, x1 = rx ? L.x + L.w : ox + tw, y0 = ry ? L.y : oy, y1 = ry ? L.y + L.h : oy + th;
      ctx.translate(ox, oy);
      if (tw !== iw || th !== ih) ctx.scale(tw / iw, th / ih);
      ctx.fillStyle = patternOf(im);
      const kx = iw / tw, ky = ih / th;
      ctx.fillRect((x0 - ox) * kx, (y0 - oy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
    } else ctx.drawImage(im, ox, oy, tw, th);
    ctx.restore();
  }
  function paintGradient(v, cs, x, y, w, h) {
    const m = /(repeating-)?(?:-webkit-)?(linear|radial)-gradient\((.*)\)\s*$/i.exec(v.trim());
    if (!m) return;
    const args = H.splitTop(m[3], ",");
    let gr, first = args[0].trim();
    if (m[2].toLowerCase() === "linear") {
      let ang = 180;
      if (/^to\s/.test(first)) { const d = first.slice(3).trim(); ang = { top: 0, right: 90, bottom: 180, left: 270, "top right": 45, "right top": 45, "bottom right": 135, "right bottom": 135, "bottom left": 225, "left bottom": 225, "top left": 315, "left top": 315 }[d] ?? 180; args.shift(); }
      else if (/deg|turn|rad$/.test(first)) { ang = parseFloat(first) * (first.endsWith("turn") ? 360 : first.endsWith("rad") ? 180 / Math.PI : 1); args.shift(); }
      else if (/^(top|bottom|left|right)/.test(first)) { ang = { top: 180, bottom: 0, left: 90, right: 270 }[first.split(/\s+/)[0]]; args.shift(); } // -webkit- "from" syntax
      const r = (ang * Math.PI) / 180, dx = Math.sin(r), dy = -Math.cos(r);
      const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2, cx = x + w / 2, cy = y + h / 2;
      gr = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    } else {
      if (!H.parseColor(H.splitTop(first)[0])) args.shift();
      const rr = Math.hypot(w, h) / 2;
      gr = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2 || rr);
    }
    const stops = args.map((a) => { const t = H.splitTop(a.trim()); const c = H.parseColor(t[0], cs.color); const pos = t[1] ? (t[1].endsWith("%") ? parseFloat(t[1]) / 100 : null) : null; return [c, pos]; }).filter((s) => s[0]);
    stops.forEach((s, i) => { if (s[1] == null) s[1] = stops.length > 1 ? i / (stops.length - 1) : 0; });
    for (const [c, p] of stops) gr.addColorStop(Math.max(0, Math.min(1, p)), H.css(c));
    ctx.fillStyle = gr;
    ctx.fillRect(x, y, w, h);
  }
  // <canvas>, <img>, <video> in their content box.
  function paintReplaced(el, cs, L, st) {
    const t = el.tagName;
    if (t !== "CANVAS" && t !== "IMG" && t !== "VIDEO") return;
    const x = L.cx, y = L.cy, w = L.cw, h = L.ch;
    if (w <= 0 || h <= 0) return;
    try {
      if (t === "CANVAS") { if (el.width && el.height && (el._powerboatCanvasId || el._glc)) ctx.drawImage(el, x, y, w, h); }
      else if (t === "IMG") { if (el.complete && el.naturalWidth) ctx.drawImage(el, x, y, w, h); }
    } catch (e) { /* a canvas without 2D content */ }
    void st;
  }

  // ---- text -------------------------------------------------------------------------------------
  function paintText(t, parent, st) {
    if (ctx.noDraw()) return;
    const runs = t._runs;
    if (!runs || !runs.length) return;
    const cs = runs[0].cs;
    if (cs.visibility === "hidden") return;
    const T = der(cs, "text", () => ({
      col: H.parseColor(cs.color),
      shadows: cs["text-shadow"] !== "none" ? H.splitTop(cs["text-shadow"], ",").map((s) => {
        const toks = H.splitTop(s), nums = [], ct = [];
        for (const k of toks) { if (/^-?[\d.]+(px|em)?$/.test(k)) nums.push(len(k, null, cs._fs) || 0); else ct.push(k); }
        return { c: H.parseColor(ct.join(" ") || cs.color, cs.color), dx: nums[0] || 0, dy: nums[1] || 0, blur: nums[2] || 0 };
      }).filter((s) => s.c && s.c[3]) : null,
      deco: cs["text-decoration"] || "none",
      spacing: cs["letter-spacing"] !== "normal" ? len(cs["letter-spacing"], null, cs._fs) || 0 : 0,
    }));
    const col = T.col;
    if (!col || !col[3]) return;
    ctx.globalAlpha = st.alpha;
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    const shadows = T.shadows, deco = T.deco, spacing = T.spacing;
    const tm = ctx.getTransform();
    if (tm.b === 0 && tm.c === 0 && tm.a > 0 && tm.d > 0) {
      // Whole words joined into one string per line, each drawn from the bitmap cache.
      for (let i = 0, line = 0; i < runs.length; line++) {
        const r0 = runs[i];
        let text = r0.text, j = i + 1, xEnd = r0.x + r0.w;
        while (j < runs.length && runs[j].y === r0.y && Math.abs(runs[j].x - xEnd) < 0.5 && runs[j].font === r0.font) { text += runs[j].text; xEnd = runs[j].x + runs[j].w; j++; }
        i = j;
        if (!text.trim()) continue;
        if (ctx.isClippedOut(r0.x - 8, r0.y - cs._fs * 1.3, xEnd - r0.x + 16, cs._fs * 1.8)) continue;
        drawCachedText(text, r0.x, r0.y, r0.font, cs, col, shadows, spacing, deco, tm, t, line, parent);
      }
      return;
    }
    for (const r of runs) {
      if (r.text === " ") continue;
      ctx.font = r.font;
      if (shadows) for (let i = shadows.length - 1; i >= 0; i--) {
        const s = shadows[i];
        if (s.blur > 0) {
          // A blurred shadow as a soft ring of offset copies.
          const n = 8, rad = Math.min(s.blur, 6) / 2;
          ctx.fillStyle = H.css(s.c, Math.min(1, 1.6 / n * (s.c[3] || 1)));
          for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; drawRun(r, r.x + s.dx + Math.cos(a) * rad, r.y + s.dy + Math.sin(a) * rad, spacing); }
        } else { ctx.fillStyle = H.css(s.c); drawRun(r, r.x + s.dx, r.y + s.dy, spacing); }
      }
      ctx.fillStyle = H.css(col);
      drawRun(r, r.x, r.y, spacing);
      if (deco.includes("underline")) ctx.fillRect(r.x, r.y + Math.max(1, cs._fs * 0.08), r.w, Math.max(1, cs._fs / 14));
      if (deco.includes("line-through")) ctx.fillRect(r.x, r.y - cs._fs * 0.3, r.w, Math.max(1, cs._fs / 14));
    }
    void parent;
  }
  // Text bitmaps: a line of one style, with its shadows and decorations, drawn once at device scale and then
  // copied pixel-aligned. Keys hold everything that changes the pixels; least recently used ones go first.
  const textCache = new Map();
  const TEXT_CACHE_MAX = 1200;
  // A text bitmap: the line with its shadows and decorations at device scale k.
  function renderText(e, text, font, cs, col, shadows, spacing, deco, k) {
    const [a, d] = H.fontMetrics(font, cs._fs);
    const w = spacing ? [...text].reduce((s, ch) => s + H.measure(font, ch) + spacing, 0) : H.measure(font, text);
    let padL = 1, padR = 1, padT = 1, padB = 1;
    if (shadows) for (const s of shadows) { const r = s.blur > 0 ? Math.min(s.blur, 6) / 2 + 1 : 0; padL = Math.max(padL, r - s.dx); padR = Math.max(padR, r + s.dx); padT = Math.max(padT, r - s.dy); padB = Math.max(padB, r + s.dy); }
    padL = Math.ceil(padL * k) + 1; padR = Math.ceil(padR * k) + 1; padT = Math.ceil(padT * k) + 1; padB = Math.ceil(padB * k) + 1;
    const cw = Math.max(1, Math.ceil(w * k) + padL + padR), ch = Math.max(1, Math.ceil((a + d) * k) + padT + padB);
    const c = g.document.createElement("canvas");
    c.width = cw; c.height = ch;
    const tc = c.getContext("2d");
    tc.setTransform(k, 0, 0, k, padL, padT + Math.round(a * k));
    tc.font = font; tc.textBaseline = "alphabetic"; tc.textAlign = "left";
    const run = { text, font };
    const put = (dx, dy) => drawRunOn(tc, run, dx, dy, spacing);
    if (shadows) for (let i = shadows.length - 1; i >= 0; i--) {
      const s = shadows[i];
      if (s.blur > 0) {
        const n = 8, rad = Math.min(s.blur, 6) / 2;
        tc.fillStyle = H.css(s.c, Math.min(1, (1.6 / n) * (s.c[3] || 1)));
        for (let q = 0; q < n; q++) { const ang = (q / n) * Math.PI * 2; put(s.dx + Math.cos(ang) * rad, s.dy + Math.sin(ang) * rad); }
      } else { tc.fillStyle = H.css(s.c); put(s.dx, s.dy); }
    }
    tc.fillStyle = H.css(col);
    put(0, 0);
    if (deco.includes("underline")) tc.fillRect(0, Math.max(1, cs._fs * 0.08), w, Math.max(1, cs._fs / 14));
    if (deco.includes("line-through")) tc.fillRect(0, -cs._fs * 0.3, w, Math.max(1, cs._fs / 14));
    e.c = c; e.ox = padL; e.oy = padT + Math.round(a * k);
  }
  // WebGL backend: a new bitmap is drawn and uploaded at the start of the next frame (drawing text now would wait for
  // every Canvas 2D command queued this frame, the page's own drawing included); until then the text node's line
  // shows the bitmap it had before (a counter shows its previous value for one frame).
  const textPending = [];
  H.uploadPendingText = () => {
    if (!textPending.length) return;
    const list = textPending.splice(0);
    for (const p of list) {
      if (!p.e.c) p.make(); // drawing text waits for queued Canvas 2D drawing: here the queue is empty
      if (p.e.c.width && ctx.upload(p.e.c)) p.e.ready = true;
      if (p.el && p.el.isConnected) addDamage(screenRect(p.el), "text", p.el);
    }
  };
  function drawCachedText(text, x, y, font, cs, col, shadows, spacing, deco, tm, node, line, el) {
    const k = tm.a;
    const key = font + "|" + col.join() + "|" + (shadows ? cs["text-shadow"] : "") + "|" + spacing + "|" + deco + "|" + k + "|" + text;
    let e = textCache.get(key);
    if (e) { textCache.delete(key); textCache.set(key, e); }
    else {
      e = { c: null, ox: 0, oy: 0, ready: false };
      const ent = e, make = () => renderText(ent, text, font, cs, col, shadows, spacing, deco, k);
      // Canvas 2D backend: drawn now. WebGL: drawn and uploaded at the start of the next frame (uploadPendingText).
      if (!ctx.upload) { make(); e.ready = true; } else textPending.push({ e: ent, el, make });
      textCache.set(key, e);
      if (textCache.size > TEXT_CACHE_MAX) {
        let drop = 100;
        for (const [kk, v] of textCache) { if (!drop--) break; textCache.delete(kk); if (v.c) v.c.width = v.c.height = 0; }
      }
    }
    if (node) {
      const last = node._lastText || (node._lastText = []);
      if (e.ready) last[line] = e;
      else { e = last[line]; if (!e || !e.ready || !e.c || !e.c.width) return; }
    } else if (!e.ready) return;
    const dx = Math.round(tm.a * x + tm.e) - e.ox, dy = Math.round(tm.d * y + tm.f) - e.oy;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(e.c, dx, dy);
    ctx.restore();
  }
  function drawRunOn(c, r, x, y, spacing) {
    // Text waits for queued Canvas 2D drawing: sent first, the wait is on an empty queue (not counted as one).
    if (ops.op_c2d_kick) ops.op_c2d_kick();
    if (!spacing) { c.fillText(r.text, x, y); return; }
    for (const ch of r.text) { c.fillText(ch, x, y); x += H.measure(r.font, ch) + spacing; }
  }
  function drawRun(r, x, y, spacing) {
    if (!spacing) { ctx.fillText(r.text, x, y); return; }
    for (const ch of r.text) { ctx.fillText(ch, x, y); x += H.measure(r.font, ch) + spacing; }
  }

  // Culling: a subtree whose painted bounds (memoized per paint) miss the current clip is skipped. Only when
  // drawing part of the page; whole passes collect hit boxes for everything.
  let boundsGen = 0;
  const UNKNOWN = "unknown";
  function boundsOf(el) {
    if (el._bGen === boundsGen) return el._bR;
    H.nBounds = (H.nBounds | 0) + 1;
    // null: paints nothing; UNKNOWN: bounds not known (rotation, skew): never culled, nor its ancestors.
    let r = null;
    const cs = el._cs, L = el._L;
    if (cs && L && cs.display !== "none") {
      const own = elMatrix(el, cs);
      if (!own) r = UNKNOWN;
      else {
        const p = shadowPad(cs);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const add = (q) => { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[2] > x1) x1 = q[2]; if (q[3] > y1) y1 = q[3]; };
        let ok = true;
        if (L.frags) for (const f of L.frags) add([f.x - p, f.y - p, f.x + f.w + p, f.y + f.h + p]);
        else add([L.x - p, L.y - p, L.x + L.w + p, L.y + L.h + p]);
        if (cs["overflow-x"] === "visible" && cs["overflow-y"] === "visible") {
          for (const c of kidsOf(el)) {
            if (c.nodeType === 3) { if (c._runs) for (const q of c._runs) add([q.x - 6, q.y - q.cs._fs * 1.3, q.x + q.w + 6, q.y + q.cs._fs * 0.5]); continue; }
            if (c.nodeType !== 1 || !c._cs || c._cs.display === "none") continue;
            const b = boundsOf(c);
            if (b === UNKNOWN) { ok = false; break; }
            if (b) add(b);
          }
        }
        if (!ok) r = UNKNOWN;
        else if (x1 > x0) r = own === I ? [x0, y0, x1, y1] : mapRect(own, x0, y0, x1 - x0, y1 - y0);
      }
    }
    el._bGen = boundsGen; el._bR = r;
    return r;
  }
  let cullOn = false;
  const culled = (el) => { if (!cullOn) return false; const b = boundsOf(el); return b === null || (b !== UNKNOWN && ctx.isClippedOut(b[0], b[1], b[2] - b[0], b[3] - b[1])); };

  // ---- damage: what needs painting this frame ---------------------------------------------------
  // Areas in device pixels [x0, y0, x1, y1]. Sources: boxes laid out again (where they were and where they
  // are), restyled ones that kept their layout, removed ones, canvases the page drew into, scrolled boxes and
  // running CSS animations. A transform other than a translation anywhere on the way means the whole page.
  let damage = [], fullPaint = true, hitsStale = true, geomChanged = true;
  const FULL = "full";
  // POWERBOAT_HTML_DAMAGE_LOG=1: one frame's damage sources every 5 s.
  const dmgLog = ops.op_powerboat_env("POWERBOAT_HTML_DAMAGE_LOG") === "1";
  let dmgNote = null, dmgLast = 0;
  const name = (el) => (el ? (el.id ? "#" + el.id : el.tagName + (el.className ? "." + String(el.className).split(" ")[0] : "")) : "?");
  const addDamage = (r, why, el) => {
    if (dmgNote) dmgNote.push(why + " " + name(el) + " " + (r === FULL ? "FULL" : r ? (r[2] - r[0]) + "x" + (r[3] - r[1]) : "-"));
    if (r === FULL) fullPaint = true; else if (r) damage.push(r);
    if (why !== "canvas") hitsStale = true;
    // Painted bounds (culling) stay valid across frames where only canvas contents changed.
    if (why !== "canvas") geomChanged = true;
  };
  // Affine maps [a, b, c, d, e, f]; damage needs axis-aligned ones (scale + translate) to stay rectangles.
  const I = [1, 0, 0, 1, 0, 0];
  const mulM = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
  const axisAligned = (m) => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
  // An element's own transform about its origin (I when none); null when it rotates, skews or is animated.
  function elMatrix(el, cs) {
    const an = cs["animation-name"];
    if (an && an !== "none") {
      const kf = H.keyframes.get(an.split(",")[0].trim());
      if (kf && kf.some((f) => f.decls.some(([k]) => k === "transform"))) return null;
    }
    const tf = cs.transform;
    if (!tf || tf === "none") return I;
    const L = el._L, t = parseTransform(tf, L.w, L.h, cs._fs);
    if (!axisAligned(t)) return null;
    const [ox, oy] = originOf(cs, L);
    return mulM(mulM([1, 0, 0, 1, ox, oy], t), [1, 0, 0, 1, -ox, -oy]);
  }
  const mapRect = (m, x, y, w, h) => { let x0 = m[0] * x + m[4], x1 = m[0] * (x + w) + m[4], y0 = m[3] * y + m[5], y1 = m[3] * (y + h) + m[5]; if (x1 < x0) [x0, x1] = [x1, x0]; if (y1 < y0) [y0, y1] = [y1, y0]; return [x0, y0, x1, y1]; };
  const shadowPad = (cs) => der(cs, "pad", () => (cs["box-shadow"] !== "none" ? 24 : 0) + (cs["text-shadow"] !== "none" ? 8 : 0) + (cs.filter !== "none" ? 8 : 0) + 2);
  // What el paints, in the coordinates of its parent's content (its own and its descendants' transforms
  // applied); content of clipping boxes stays inside them.
  function subtreeRect(el) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, full = false;
    const add = (m, x, y, w, h) => { const r = mapRect(m, x, y, w, h); if (r[0] < x0) x0 = r[0]; if (r[1] < y0) y0 = r[1]; if (r[2] > x1) x1 = r[2]; if (r[3] > y1) y1 = r[3]; };
    const visit = (n, m) => {
      if (full) return;
      if (n.nodeType === 3) { if (n._runs) for (const r of n._runs) add(m, r.x - 6, r.y - r.cs._fs * 1.3, r.w + 12, r.cs._fs * 1.8); return; }
      if (n.nodeType !== 1 || !n._cs || !n._L || n._cs.display === "none") return;
      const cs = n._cs, L = n._L, own = elMatrix(n, cs);
      if (!own) { full = true; return; }
      const mm = own === I ? m : mulM(m, own);
      const p = shadowPad(cs);
      if (L.frags) for (const f of L.frags) add(mm, f.x - p, f.y - p, f.w + 2 * p, f.h + 2 * p);
      else add(mm, L.x - p, L.y - p, L.w + 2 * p, L.h + 2 * p);
      if (cs["overflow-x"] !== "visible" || cs["overflow-y"] !== "visible") return;
      for (const c of kidsOf(n)) visit(c, mm);
    };
    visit(el, I);
    if (full) return FULL;
    return x1 > x0 ? [x0, y0, x1, y1] : null;
  }
  // Device-space damage for el: through every ancestor's scrolling and transform, then the page scale.
  function screenRect(el) {
    if (!el || el.nodeType !== 1 || !el._L) return null;
    const r = subtreeRect(el);
    if (!r || r === FULL) return r;
    let m = I;
    for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
      if (!n._cs) return null; // not displayed
      const sx = n._scrollLeft || 0, sy = n._scrollTop || 0;
      if (sx || sy) m = mulM([1, 0, 0, 1, -sx, -sy], m);
      if (n._L) { const t = elMatrix(n, n._cs); if (!t) return FULL; if (t !== I) m = mulM(t, m); }
    }
    const q0 = mapRect(m, r[0], r[1], r[2] - r[0], r[3] - r[1]);
    const W = page.width, Hh = page.height;
    const q = [Math.max(0, Math.floor(q0[0] * pz) - 1), Math.max(0, Math.floor(q0[1] * pz) - 1), Math.min(W, Math.ceil(q0[2] * pz) + 1), Math.min(Hh, Math.ceil(q0[3] * pz) + 1)];
    return q[2] > q[0] && q[3] > q[1] ? q : null;
  }
  H.screenRect = screenRect;
  const root = () => g.document.documentElement;
  H.onRelayout = (b) => { geomChanged = true; if (b === root()) { if (dmgNote) dmgNote.push("full layout"); fullPaint = true; hitsStale = true; } else addDamage(screenRect(b), "layout", b); };
  H.onRemove = (c) => addDamage(screenRect(c), "removed", c);
  H.onScroll = (el) => addDamage(screenRect(el), "scroll", el);
  const baseTouch = H.touch;
  H.touch = () => { baseTouch(); fullPaint = true; hitsStale = true; };
  // Canvases mark themselves when drawn into.
  {
    const proto = Object.getPrototypeOf(g.document.createElement("canvas").getContext("2d"));
    for (const k of ["fillRect", "clearRect", "strokeRect", "drawImage", "putImageData", "fill", "stroke", "fillText", "strokeText"]) {
      const f = proto[k];
      if (typeof f !== "function") continue;
      proto[k] = function (...a) { const c = this.canvas; if (c) { c._painted = true; c._ver = (c._ver | 0) + 1; } return f.apply(this, a); };
    }
  }
  let canvasList = [], canvasGen = -1;
  function domCanvases() {
    // Every canvas in the tree (shown or not: screenRect skips hidden ones), rebuilt after tree changes only.
    const gen = H.mutGen;
    if (canvasGen === gen) return canvasList;
    canvasGen = gen;
    canvasList = [];
    const w = (n) => { for (const c of n.children) { if (c.nodeType !== 1) continue; if (c.tagName === "CANVAS") canvasList.push(c); w(c); } };
    w(root());
    return canvasList;
  }
  // Damage areas merged: overlapping or close ones join; many, or most of the screen, become one.
  function merged(list) {
    const W = page.width, Hh = page.height;
    let rs = list.map((r) => r.slice());
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < rs.length && !changed; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        if (a[0] <= b[2] + 16 && b[0] <= a[2] + 16 && a[1] <= b[3] + 16 && b[1] <= a[3] + 16) {
          rs[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; rs.splice(j, 1); changed = true; break;
        }
      }
    }
    const area = rs.reduce((s, r) => s + (r[2] - r[0]) * (r[3] - r[1]), 0);
    if (rs.length > 6 || area > W * Hh * 0.7) return [[0, 0, W, Hh]];
    return rs;
  }

  // ---- the pointer -------------------------------------------------------------------------------
  // Handhelds have no visible mouse pointer (the runtime hides SDL's; the pad moves an invisible one through
  // gptokeyb), so HTML pages get one drawn over the page, its shape from the CSS cursor under it: images from
  // CSS (cursor: url(x.png) 4 4, pointer), else the runtime's (86c_cursors.js: Adwaita), which a game can replace:
  //   POWERBOAT_HTML_CURSOR=0                         no pointer (a desktop with its own)
  //   POWERBOAT_HTML_CURSOR_<SHAPE>=file.png:hotX:hotY  shapes ARROW, HAND, TEXT, WAIT, GRAB, NOT_ALLOWED; the file
  //                                                   relative to the game folder (or absolute), drawn at its size
  //   POWERBOAT_HTML_CURSOR_SCALE=1.5                 every pointer that much larger (small or large screens)
  const cursorOn = ops.op_powerboat_env("POWERBOAT_HTML_CURSOR") !== "0";
  const cursorScale = +(ops.op_powerboat_env("POWERBOAT_HTML_CURSOR_SCALE") || 1) || 1;
  let cursorRect = null, cursorKey = "";
  H.mouse = null;
  const loadImg = (src) => { const im = new g.Image(); im.src = src; return im; };
  const shapes = {};
  for (const [k, d] of Object.entries(__powerboat.defaultCursors || {})) {
    const env = ops.op_powerboat_env("POWERBOAT_HTML_CURSOR_" + k.toUpperCase().replace(/-/g, "_"));
    if (env) {
      const [file, hx, hy] = env.split(":");
      shapes[k] = { img: loadImg(file), hot: [+hx || 0, +hy || 0] };
    } else shapes[k] = { img: loadImg(d.src), hot: d.hot };
  }
  const KEYWORDS = { pointer: "hand", text: "text", "vertical-text": "text", wait: "wait", progress: "wait", grab: "grab", grabbing: "grab",
    move: "grab", "all-scroll": "grab", "not-allowed": "not-allowed", "no-drop": "not-allowed" };
  const cssCursors = new Map(); // CSS cursor value -> shape (url images loaded once)
  function shapeOf(v) {
    let sh = cssCursors.get(v);
    if (sh !== undefined) return sh;
    sh = null;
    for (const part of H.splitTop(v, ",")) {
      const t = part.trim();
      const u = /^url\(\s*(['"]?)([^'")]*)\1\s*\)\s*(-?[\d.]+)?\s*(-?[\d.]+)?$/.exec(t);
      if (u) { sh = { img: loadImg(u[2]), hot: [+u[3] || 0, +u[4] || 0], css: true }; break; }
      if (t === "none") { sh = "none"; break; }
      sh = shapes[KEYWORDS[t] || "arrow"] || null; break;
    }
    cssCursors.set(v, sh);
    return sh;
  }
  function cursorState() {
    const m = H.mouse;
    if (!cursorOn || !m) return { show: false, moved: false };
    let v = "auto";
    for (let n = H.hover; n && n.nodeType === 1; n = n.parentNode) { const c = n._cs && n._cs.cursor; if (c && c !== "auto") { v = c; break; } }
    let sh = shapeOf(v);
    // An image still loading (or failed): the default arrow meanwhile.
    if (sh && sh !== "none" && !(sh.img.complete && sh.img.naturalWidth)) sh = shapes.arrow;
    const key = v + "|" + Math.round(m[0] * pz) + "|" + Math.round(m[1] * pz);
    return { show: !!sh && sh !== "none", moved: key !== cursorKey, sh, key, x: m[0] * pz, y: m[1] * pz };
  }
  function drawCursor(cur) {
    const im = cur.sh.img;
    if (!(im.complete && im.naturalWidth)) return;
    // Window pixels at the image's size: the page is pz / zoom of the window's scale (smaller when painted at CSS
    // size below zoom 1, then shrunk on present).
    const k = (cursorScale * pz) / zoom;
    const w = im.naturalWidth * k, h = im.naturalHeight * k, x = Math.round(cur.x - cur.sh.hot[0] * k), y = Math.round(cur.y - cur.sh.hot[1] * k);
    if (ctx.begin) ctx.begin();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(im, x, y, w, h);
    ctx.restore();
    if (ctx.end) ctx.end();
    cursorRect = [Math.max(0, x - 1), Math.max(0, y - 1), Math.min(page.width, Math.ceil(x + w) + 1), Math.min(page.height, Math.ceil(y + h) + 1)];
    cursorKey = cur.key;
  }

  // ---- per frame --------------------------------------------------------------------------------
  let frames = 0, paintMs = 0, layoutMs = 0, lastReport = performance.now(), paintedPx = 0, skipped = 0;
  const report = !!ops.op_powerboat_env("POWERBOAT_HTML_STATS");
  const noDamage = ops.op_powerboat_env("POWERBOAT_HTML_DAMAGE") === "0";
  H.frame = () => {
    if (page.width !== pageW() || page.height !== pageH()) { page.width = pageW(); page.height = pageH(); H.touch(); }
    const a = performance.now();
    H.flush(true);
    const a0 = performance.now();
    for (const el of H.paintOnly) if (el.isConnected) addDamage(screenRect(el), "style", el);
    H.paintOnly.clear();
    // Canvas 2D backend: a canvas drawn into is damaged at once (drawImage reads its live pixels). WebGL backend:
    // when its new contents are uploaded (latchCanvases).
    // GPU canvases (glCanvas2D) likewise, when drawn into.
    for (const c of domCanvases()) if (c._painted && (!ctx.latch || c._glc)) { c._painted = false; addDamage(screenRect(c), "canvas", c); }
    if (H.animEls) for (const el of H.animEls) if (el.isConnected) addDamage(screenRect(el), "anim", el);
    if (dmgNote) { console.log("[damage] " + (dmgNote.length ? dmgNote.slice(0, 40).join("; ") : "none")); dmgNote = null; }
    if (dmgLog && a - dmgLast > 5000) { dmgLast = a; dmgNote = []; }
    H.animEls = new Set();
    // The pointer: where it was is painted again when it moves, changes shape, or anything else repaints there.
    const cur = cursorState();
    if (cursorRect && (cur.moved || damage.length || fullPaint)) addDamage(cursorRect, "cursor", null);
    const b = performance.now();
    H.damageMs = (H.damageMs || 0) + (b - a0);
    let painted = fullPaint || noDamage || damage.length > 0;
    if (fullPaint || noDamage) { paintRoot(null, true); fullPaint = false; damage = []; hitsStale = false; geomChanged = true; paintedPx += page.width * page.height; }
    else if (damage.length) {
      if (geomChanged) { boundsGen++; geomChanged = false; }
      cullOn = true;
      for (const r of merged(damage)) { paintRoot(r, false); paintedPx += (r[2] - r[0]) * (r[3] - r[1]); }
      cullOn = false;
      damage = [];
    } else skipped++;
    if (cur.show && (cur.moved || painted || !cursorRect)) drawCursor(cur);
    const c = performance.now();
    H.dirtyPaint = false;
    if (report) {
      frames++; layoutMs += b - a; paintMs += c - b;
      if (c - lastReport > 5000) {
        const fs = H.fstats;
        console.log("[html] " + frames + " frames (" + skipped + " without changes): style+layout " + (layoutMs / frames).toFixed(1) + " ms, paint " + (paintMs / frames).toFixed(1) + " ms, painted " + (paintedPx / frames / 1e6).toFixed(2) + " Mpx/frame");
        if (opStats) { console.log("[html] per frame: " + [...opStats].map(([k, [n, ms]]) => k + " " + (n / frames).toFixed(0) + "x " + (ms / frames).toFixed(1) + "ms").join(", ")); opStats.clear(); }
        console.log("[html] all passes per frame: style " + (fs.style / frames).toFixed(1) + "x " + (fs.styleMs / frames).toFixed(1) + " ms, layout " + (fs.layout / frames).toFixed(1) + "x " + (fs.layoutMs / frames).toFixed(1) + " ms (" + (H.fullLayouts || 0) + " full, " + (H.partialLayouts || 0) + " partial), loop " + ((c - lastReport) / frames).toFixed(0) + " ms/frame");
        console.log("[html] per frame: damage " + ((H.damageMs || 0) / frames).toFixed(1) + " ms, texture uploads " + ((H.uploads || 0) / frames).toFixed(1) + "x " + ((H.uploadMs || 0) / frames).toFixed(1) + " ms" +
          (H.flushN ? ", GL batches " + (H.flushN / frames).toFixed(1) + "x " + (H.flushMs / frames).toFixed(2) + " ms (" + Object.entries(H.flushWhy || {}).map(([k, n]) => k + " " + (n / frames).toFixed(1)).join(", ") + ")" : ""));
        console.log("[html] per frame: paintFlow " + ((H.nFlow | 0) / frames).toFixed(0) + ", bounds computed " + ((H.nBounds | 0) / frames).toFixed(0) + ", unknown-bounds elements " + [...document.getElementsByTagName("*")].filter((e) => e._bR === UNKNOWN).length);
        H.nFlow = 0; H.nBounds = 0;
        H.flushN = 0; H.flushMs = 0; H.flushWhy = {};
        H.damageMs = H.uploadMs = H.uploads = 0;
        H.fullLayouts = H.partialLayouts = 0; fs.style = fs.styleMs = fs.layout = fs.layoutMs = 0; frames = 0; paintMs = layoutMs = 0; paintedPx = 0; skipped = 0; lastReport = c;
      }
    }
  };
  // 79_webpage.js calls this right before it presents the page canvas.
  // WebGL backend: page canvases are uploaded at the start of each frame (one frame late, no waiting for their
  // drawing threads, which keeps Canvas 2D deferred).
  if (ctx.latch) {
    // The page's own canvases draw on the GPU too (POWERBOAT_HTML_GLCANVAS=0: Canvas 2D on the CPU): a canvas in the
    // document, shown, gets a GPU 2D context at its first getContext("2d"); hidden ones (scratch canvases read back
    // with getImageData) and canvases made off the page keep Canvas 2D.
    if (ops.op_powerboat_env("POWERBOAT_HTML_GLCANVAS") !== "0") {
      const baseGet = g.HTMLCanvasElement.prototype.getContext;
      const eligible = (el) => el !== page && el.isConnected && !el.hidden && !/display\s*:\s*none/i.test(el.getAttribute("style") || "") && !(el._cs && el._cs.display === "none");
      g.HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === "2d") {
          if (this._glc) return this._glc.ctx;
          if (eligible(this)) { const c = H.glCanvas2D(this); if (c) return c; }
        }
        return baseGet.call(this, type, attrs);
      };
    }
    const baseTick2 = g.__powerboat_tick;
    g.__powerboat_tick = (now) => {
      H.glReset(); // the runtime's present changed GL state since the last frame
      try {
        if (g.document.readyState !== "loading") for (const c of domCanvases()) {
          if (c._powerboatCanvasId && c._cs && c._L && ctx.latch(c)) addDamage(screenRect(c), "canvas", c);
        }
        if (g.document.readyState !== "loading") H.uploadPendingText();
      } catch (e) { console.error("powerboat: canvas upload:", e && e.stack ? e.stack : e); }
      return baseTick2(now);
    };
  }
  __powerboat.beforePresent = () => {
    try { if (g.document.readyState !== "loading") H.frame(); } catch (e) { console.error("powerboat: HTML paint:", e && e.stack ? e.stack : e); }
    // WebGL backend: this frame's Canvas 2D drawing goes to the drawing threads now; next frame's uploads find it done.
    if (ctx.latch && ops.op_c2d_kick) ops.op_c2d_kick();
  };

  // ---- hit testing and pointer events -----------------------------------------------------------
  // Hit boxes come from a whole paint pass; after changes, one without drawing rebuilds them.
  const inClip = (c, x, y) => !c || (x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h);
  H.hitTest = (x, y) => {
    H.flush(false);
    if (hitsStale || !hits) { paintRoot(null, true, false); hitsStale = false; }
    for (let i = hits.length - 1; i >= 0; i--) {
      const [el, x0, y0, x1, y1, clip] = hits[i];
      if (x >= x0 && y >= y0 && x < x1 && y < y1 && inClip(clip, x, y)) return el._pseudo ? el.parentNode : el;
    }
    return g.document.body;
  };
  const chain = (n) => { const a = []; for (; n && n.nodeType === 1; n = n.parentNode) a.push(n); return a; };
  const send = (el, type, init, bubbles) => {
    const ev = new g.MouseEvent(type, { ...init, bubbles });
    ev.target = el;
    if (bubbles) { for (let n = el; n && n !== g.document && !ev._stop; n = n.parentNode) n.dispatchEvent(ev); if (!ev._stop) g.document.dispatchEvent(ev); }
    else el.dispatchEvent(ev);
  };
  const baseHandle = __powerboat.handleEvent;
  // The element under the pointer gets every pointer event; moving it fires mouseout/over (bubbling)
  // and mouseleave/enter (per element) and restyles :hover.
  __powerboat.hitTarget = (x, y, type) => {
    H.mouse = [x, y];
    const el = H.hitTest(x, y);
    if (type === "mousemove") {
      if (el !== H.hover) {
        const old = H.hover, init = { clientX: x, clientY: y };
        H.hover = el;
        if (old && type === "mousemove") send(old, "mouseout", { ...init, relatedTarget: el }, true);
        const oc = chain(old), nc = chain(el);
        for (const n of oc) if (!nc.includes(n)) send(n, "mouseleave", init, false);
        if (el) send(el, "mouseover", { ...init, relatedTarget: old }, true);
        for (const n of nc.slice().reverse()) if (!oc.includes(n)) send(n, "mouseenter", init, false);
        // :hover changes only for the elements that entered or left the hovered chain.
        for (const n of oc) if (!nc.includes(n) && H.stateSensitive(n, "hover")) H.restyle(n);
        for (const n of nc) if (!oc.includes(n) && H.stateSensitive(n, "hover")) H.restyle(n);
      }
    }
    if (type === "mousedown") { H.active = el; for (const n of chain(el)) if (H.stateSensitive(n, "active")) H.restyle(n); }
    if (type === "mouseup") { const a = H.active; H.active = null; for (const n of chain(a)) if (H.stateSensitive(n, "active")) H.restyle(n); }
    return el;
  };
  __powerboat.handleEvent = (e) => baseHandle(e);
  // pageX/pageY (the page never scrolls as a whole).
  for (const k of ["pageX", "pageY", "x", "y", "offsetX", "offsetY", "screenX", "screenY"]) {
    if (!(k in g.MouseEvent.prototype)) Object.defineProperty(g.MouseEvent.prototype, k, { get() { return this["_" + k] ?? (k.endsWith("X") ? this.clientX : this.clientY); }, set(v) { this["_" + k] = v; }, configurable: true });
  }
  // Wheel: unless the page cancels it, scroll the nearest scrollable box under the pointer.
  g.addEventListener("wheel", (ev) => {
    if (ev.defaultPrevented) return;
    for (let n = ev.target; n && n.nodeType === 1; n = n.parentNode) {
      const cs = n._cs;
      if (!cs || !n._L) continue;
      if ((cs["overflow-y"] === "auto" || cs["overflow-y"] === "scroll") && n.scrollHeight > n.clientHeight) {
        const before = n.scrollTop; n.scrollTop = before + ev.deltaY;
        if (n.scrollTop !== before) { n.dispatchEvent(new g.Event("scroll")); return; }
      }
    }
  });
})();
