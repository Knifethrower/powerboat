// powerboat JS environment, part 9b: layout for HTML pages (POWERBOAT_HTML=1).
// Every displayed element gets el._L, its border box in page pixels (before transforms and scrolling),
// plus padding/border widths; text nodes get line runs (t._runs) to draw. Supported: block flow with
// sibling margin collapsing, inline formatting (word wrap, inline boxes, inline-block, images, canvases,
// <br>, text-align, vertical-align basics), floats and clear, relative / absolute / fixed positioning,
// overflow clipping and scrolling, min/max sizes, box-sizing. Tables lay out as blocks of inline-block cells.
"use strict";
(() => {
  const ops = Deno.core.ops;
  if (ops.op_powerboat_env("POWERBOAT_HTML") !== "1") return;
  const g = globalThis, H = __powerboat.html, EP = g.HTMLElement.prototype;

  // ---- lengths -------------------------------------------------------------------------------
  // Resolve a computed length against base (for %) and the element's font size; null = auto/none.
  function len(v, base, fs) {
    if (v === undefined || v === null) return null;
    if (typeof v === "number") return v;
    if (v === "auto" || v === "none" || v === "" || v === "normal") return null;
    const n = parseFloat(v);
    if (v.startsWith("calc(")) return calc(v.slice(5, -1), base, fs);
    if (!Number.isFinite(n)) return v === "thin" ? 1 : v === "medium" ? 3 : v === "thick" ? 5 : null;
    if (v.endsWith("%")) return base == null ? null : (n / 100) * base;
    if (v.endsWith("rem")) return n * 16;
    if (v.endsWith("em")) return n * fs;
    if (v.endsWith("vw")) return (n / 100) * g.innerWidth;
    if (v.endsWith("vh")) return (n / 100) * g.innerHeight;
    if (v.endsWith("pt")) return (n * 4) / 3;
    return n;
  }
  function calc(expr, base, fs) {
    // a (+|-) b (+|-) c ... ; * and / with plain numbers.
    const toks = expr.match(/-?[\d.]+[a-z%]*|[+\-*/]/gi) || [];
    let total = 0, op = "+", acc = null, mul = null;
    const val = (t) => (/^-?[\d.]+$/.test(t) ? +t : len(t, base, fs) || 0);
    for (const t of toks) {
      if (t === "+" || t === "-") { total = op === "+" ? total + acc : total - acc; op = t; acc = null; }
      else if (t === "*" || t === "/") mul = t;
      else { const x = val(t); acc = acc == null ? x : mul === "*" ? acc * x : acc / x; mul = null; }
    }
    return op === "+" ? total + (acc || 0) : total - (acc || 0);
  }
  H.len = len;

  // Children with generated ::before / ::after boxes (85_html.js computes their styles).
  const kidsOf = (el) => el._kids || el.children;
  H.kidsOf = kidsOf;
  function makePseudo(el, cs, which) {
    let text = "";
    const c = cs.content;
    for (const m of c.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(([\w-]+)\)/g)) {
      if (m[3]) text += el.getAttribute(m[3]) || "";
      else text += (m[1] ?? m[2]).replace(/\\([0-9a-f]{1,6})\s?/gi, (q, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");
    }
    const p = { nodeType: 1, tagName: "::" + which, _cs: cs, parentNode: el, _pseudo: which, children: [], getAttribute: () => null, id: "", className: "" };
    if (text) p.children.push({ nodeType: 3, textContent: text, children: [], parentNode: p, _runs: null });
    return p;
  }
  H.buildKids = (el) => {
    if (el._before || el._after) {
      const k = el.children.slice();
      if (el._before) k.unshift(el._beforeBox = makePseudo(el, el._before, "before")); else el._beforeBox = null;
      if (el._after) k.push(el._afterBox = makePseudo(el, el._after, "after")); else el._afterBox = null;
      el._kids = k;
    } else el._kids = null;
  };

  // ---- text measuring ------------------------------------------------------------------------
  const mc = g.document.createElement("canvas").getContext("2d");
  const fontOf = (cs) => {
    if (cs._font) return cs._font;
    const w = cs["font-weight"] === "bold" || cs["font-weight"] === "bolder" ? "bold" : /^\d+$/.test(cs["font-weight"]) && +cs["font-weight"] >= 600 ? "bold" : "normal";
    const st = /italic|oblique/.test(cs["font-style"]) ? "italic " : "";
    cs._font = st + w + " " + cs._fs + "px " + cs["font-family"];
    return cs._font;
  };
  H.fontOf = fontOf;
  const widthCache = new Map();
  let curFont = "";
  function measure(font, text) {
    let m = widthCache.get(font);
    if (!m) { m = new Map(); widthCache.set(font, m); }
    let w = m.get(text);
    if (w === undefined) {
      if (curFont !== font) { mc.font = font; curFont = font; }
      w = mc.measureText(text).width;
      if (m.size > 4000) m.clear();
      m.set(text, w);
    }
    return w;
  }
  H.measure = measure;
  const metricsCache = new Map();
  // [ascent, descent] of the font's box.
  function fontMetrics(font, fs) {
    let r = metricsCache.get(font);
    if (!r) {
      mc.font = font; curFont = font;
      mc.textBaseline = "alphabetic";
      const t = mc.measureText("Hg");
      const a = t.fontBoundingBoxAscent, d = t.fontBoundingBoxDescent;
      r = a > 0 ? [a, d] : [fs * 0.8, fs * 0.2];
      metricsCache.set(font, r);
    }
    return r;
  }
  H.fontMetrics = fontMetrics;
  const lineHeightOf = (cs) => {
    const v = cs["line-height"];
    if (v === "normal") { const [a, d] = fontMetrics(fontOf(cs), cs._fs); return a + d; }
    if (/^[\d.]+$/.test(v)) return +v * cs._fs;
    return len(v, cs._fs, cs._fs) ?? cs._fs * 1.2;
  };
  const transformText = (s, cs) => {
    const t = cs["text-transform"];
    if (t === "uppercase") return s.toUpperCase();
    if (t === "lowercase") return s.toLowerCase();
    if (t === "capitalize") return s.replace(/\b\w/g, (c) => c.toUpperCase());
    if (cs["font-variant"] === "small-caps") return s.toUpperCase();
    return s;
  };

  // Classic scrollbars take room from the content box (Chromium's standard width).
  const SB = 15;
  H.SB = SB;
  // ---- box helpers ---------------------------------------------------------------------------
  const SIDES = ["top", "right", "bottom", "left"];
  function edges(el, cs, cbW) {
    const fs = cs._fs;
    const m = SIDES.map((s) => len(cs["margin-" + s], cbW, fs));
    const p = SIDES.map((s) => len(cs["padding-" + s], cbW, fs) || 0);
    const b = SIDES.map((s) => (cs["border-" + s + "-style"] === "none" || cs["border-" + s + "-style"] === "hidden" ? 0 : len(cs["border-" + s + "-width"], null, fs) || 0));
    // border-image without a border width draws nothing; with one it replaces the border.
    return { m, p, b };
  }
  const isBlockLevel = (cs) => cs.display === "block" || cs.display === "list-item" || cs.display === "table" || cs.display === "table-row" || cs.display === "table-row-group" || cs.display === "flex" || cs.display === "grid" || cs.display === "flow-root";
  const isOutOfFlow = (cs) => cs.position === "absolute" || cs.position === "fixed";
  const establishesBFC = (el, cs) => cs.float !== "none" || isOutOfFlow(cs) || cs["overflow-x"] !== "visible" || cs["overflow-y"] !== "visible" ||
    cs.display === "inline-block" || cs.display === "table-cell" || cs.display === "flow-root" || cs.display === "table" || el === g.document.documentElement;
  const isReplaced = (el) => el.tagName === "IMG" || el.tagName === "CANVAS" || el.tagName === "VIDEO" || el.tagName === "INPUT" || el.tagName === "IFRAME" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" && false;
  function replacedSize(el, cs, cbW) {
    const fs = cs._fs;
    let w = len(cs.width, cbW, fs), h = len(cs.height, null, fs);
    let nw = 0, nh = 0;
    if (el.tagName === "IMG") { nw = el.naturalWidth || el.width || 0; nh = el.naturalHeight || el.height || 0; }
    else if (el.tagName === "CANVAS") { nw = el.width; nh = el.height; }
    else if (el.tagName === "VIDEO") { nw = el.videoWidth || 300; nh = el.videoHeight || 150; }
    else if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") { nw = el.tagName === "TEXTAREA" ? 180 : 150; nh = el.tagName === "TEXTAREA" ? 36 : fs * 1.3; if (el.type === "checkbox" || el.type === "radio") nw = nh = 13; if (el.type === "hidden") nw = nh = 0; }
    else { nw = 300; nh = 150; }
    if (w == null && h == null) { w = nw; h = nh; }
    else if (w == null) w = nh ? (h * nw) / nh : nw;
    else if (h == null) h = nw ? (w * nh) / nw : nh;
    if (cs["box-sizing"] === "border-box") { const e = edges(el, cs, cbW); w -= e.p[1] + e.p[3] + e.b[1] + e.b[3]; h -= e.p[0] + e.p[2] + e.b[0] + e.b[2]; }
    return [Math.max(0, w), Math.max(0, h)];
  }
  const clampW = (w, cs, cbW, extra) => {
    const fs = cs._fs, bb = cs["box-sizing"] === "border-box";
    let mx = len(cs["max-width"], cbW, fs), mn = len(cs["min-width"], cbW, fs) || 0;
    if (mx != null) { if (bb) mx -= extra; if (w > mx) w = mx; }
    if (bb) mn -= extra;
    if (w < mn) w = mn;
    return Math.max(0, w);
  };
  const clampH = (h, cs, cbH, extra) => {
    const fs = cs._fs, bb = cs["box-sizing"] === "border-box";
    let mx = len(cs["max-height"], cbH, fs), mn = len(cs["min-height"], cbH, fs) || 0;
    if (mx != null) { if (bb) mx -= extra; if (h > mx) h = mx; }
    if (bb) mn -= extra;
    if (h < mn) h = mn;
    return Math.max(0, h);
  };

  // ---- intrinsic widths (shrink-to-fit) ------------------------------------------------------
  // [min-content, max-content] of el's content box.
  function intrinsic(el) {
    const cs = el._cs;
    if (!cs) return [0, 0];
    if (isReplaced(el)) { const [w] = replacedSize(el, cs, null); return [w, w]; }
    let mn = 0, mx = 0, line = 0;
    const visit = (n, pcs) => {
      for (const c of kidsOf(n)) {
        if (c.nodeType === 3) {
          const text = transformText(collapse(c.textContent, pcs), pcs);
          if (!text) continue;
          const font = fontOf(pcs), ws = pcs["white-space"];
          if (ws === "nowrap" || ws === "pre") { const w = measure(font, text); line += w; mn = Math.max(mn, w); continue; }
          const words = text.split(" ");
          words.forEach((wd, i) => {
            const w = measure(font, wd);
            mn = Math.max(mn, w);
            line += w + (i < words.length - 1 ? measure(font, " ") : 0);
          });
          continue;
        }
        if (c.nodeType !== 1 || !c._cs || c._cs.display === "none") continue;
        const ccs = c._cs;
        if (isOutOfFlow(ccs)) continue;
        if (c.tagName === "BR") { mx = Math.max(mx, line); line = 0; continue; }
        const e = edges(c, ccs, null), hor = (e.m[1] || 0) + (e.m[3] || 0) + e.p[1] + e.p[3] + e.b[1] + e.b[3];
        if (ccs.display === "inline") { line += hor; visit(c, ccs); continue; }
        const fixed = len(ccs.width, null, ccs._fs);
        let cmn, cmx;
        if (fixed != null) { const bb = ccs["box-sizing"] === "border-box"; cmn = cmx = fixed + (bb ? (e.m[1] || 0) + (e.m[3] || 0) : hor); }
        else { const [a, b] = intrinsic(c); cmn = a + hor; cmx = b + hor; }
        const mxw = len(ccs["max-width"], null, ccs._fs); if (mxw != null) { cmx = Math.min(cmx, mxw + hor); cmn = Math.min(cmn, cmx); }
        const mnw = len(ccs["min-width"], null, ccs._fs);
        if (mnw) { const v = mnw + (ccs["box-sizing"] === "border-box" ? (e.m[1] || 0) + (e.m[3] || 0) : hor); cmn = Math.max(cmn, v); cmx = Math.max(cmx, v); }
        if (ccs.float !== "none" || ccs.display === "inline-block" || ccs.display === "table-cell" || isReplaced(c)) { line += cmx; mn = Math.max(mn, cmn); }
        else { mx = Math.max(mx, line, cmx); mn = Math.max(mn, cmn); line = 0; }
      }
    };
    visit(el, cs);
    mx = Math.max(mx, line);
    const sb = cs["overflow-y"] === "scroll" ? SB : 0;
    return [mn + sb, Math.max(mn, mx) + sb];
  }
  const collapse = (s, cs) => {
    const ws = cs["white-space"];
    if (ws === "pre" || ws === "pre-wrap") return s;
    return s.replace(/[\t\n\r ]+/g, " ");
  };

  // ---- floats --------------------------------------------------------------------------------
  class FloatCtx {
    constructor(left, right) { this.left = left; this.right = right; this.list = []; }
    // Free [l, r] for a band from y to y+h.
    avail(y, h) {
      let l = this.left, r = this.right;
      for (const f of this.list) {
        if (f.y < y + Math.max(h, 0.01) && f.y + f.h > y) {
          if (f.side === "left") l = Math.max(l, f.x + f.w); else r = Math.min(r, f.x);
        }
      }
      return [l, r];
    }
    // Lowest y clearing floats of the side ("left", "right", "both").
    clearY(side) { let y = -Infinity; for (const f of this.list) if (side === "both" || f.side === side) y = Math.max(y, f.y + f.h); return y; }
    // Next y where the band at y changes (a float ends).
    nextY(y) { let n = Infinity; for (const f of this.list) { const e = f.y + f.h; if (e > y && e < n) n = e; } return n; }
    bottom() { let b = -Infinity; for (const f of this.list) b = Math.max(b, f.y + f.h); return b; }
  }

  // ---- layout --------------------------------------------------------------------------------
  let absPending; // [el, containing block element]
  // Block-level box el at (x, y) (its margin edge) in a containing block cbW wide. fc: the float context of
  // the block formatting context el sits in. Returns the margin-box height (bottom margin not collapsed).
  function layoutBlock(el, x, y, cbW, cbH, fc, shrink) {
    const cs = el._cs;
    el._rel = null;
    // For laying out this box alone later (H.layout): where it was laid out, before ancestors moved it.
    el._args = [x, y, cbW, cbH, shrink];
    const e = edges(el, cs, cbW);
    const fs = cs._fs;
    const hp = e.p[1] + e.p[3] + e.b[1] + e.b[3], vp = e.p[0] + e.p[2] + e.b[0] + e.b[2];
    let ml = e.m[3], mr = e.m[1];
    let w = len(cs.width, cbW, fs);
    if (w != null && cs["box-sizing"] === "border-box") w -= hp;
    if (isReplaced(el)) w = replacedSize(el, cs, cbW)[0];
    if (w == null) {
      const avail = cbW - (ml || 0) - (mr || 0) - hp;
      if (shrink) { const [mn, mx] = intrinsic(el); w = Math.min(Math.max(mn, avail), mx); }
      else w = avail;
    }
    w = clampW(w, cs, cbW, hp);
    if (!shrink && ml == null && mr == null) { ml = mr = Math.max(0, (cbW - w - hp) / 2); }
    else if (!shrink && ml == null) ml = cbW - w - hp - (mr || 0);
    ml = ml || 0; mr = mr || 0;
    const mt = e.m[0] || 0, mb = e.m[2] || 0;
    const L = el._L = { x: x + ml, y: y + mt, w: w + hp, h: 0, m: [mt, mr, mb, ml], p: e.p, b: e.b, cx: 0, cy: 0, cw: w, ch: 0 };
    L.cx = L.x + e.b[3] + e.p[3]; L.cy = L.y + e.b[0] + e.p[0];
    let hSpec = len(cs.height, cbH, fs);
    if (hSpec != null && cs["box-sizing"] === "border-box") hSpec -= vp;
    if (isReplaced(el)) hSpec = replacedSize(el, cs, cbW)[1];
    const ownBFC = establishesBFC(el, cs);
    const myFc = ownBFC ? new FloatCtx(L.cx, L.cx + w) : fc;
    let contentH = 0;
    L.sb = cs["overflow-y"] === "scroll" ? SB : 0;
    if (!isReplaced(el)) {
      contentH = layoutChildren(el, L.cx, L.cy, w - L.sb, hSpec, myFc);
      // overflow-y: auto gets its scrollbar once the content is taller than the box.
      if (!L.sb && cs["overflow-y"] === "auto" && hSpec != null && contentH > hSpec + 0.5) {
        L.sb = SB;
        const fc2 = ownBFC ? new FloatCtx(L.cx, L.cx + w - SB) : fc;
        contentH = layoutChildren(el, L.cx, L.cy, w - SB, hSpec, fc2);
      }
    }
    if (ownBFC && myFc.list.length) contentH = Math.max(contentH, myFc.bottom() - L.cy);
    let h = hSpec != null ? hSpec : contentH;
    h = clampH(h, cs, cbH, vp);
    L.ch = h; L.h = h + vp; L.contentH = contentH;
    if (cs.position === "relative" || cs.position === "sticky") relOffset(el, cs, cbW, cbH);
    if (cs.position !== "static") flushAbs(el);
    el._pre = [L.x, L.y];
    return mt + L.h + mb;
  }
  // Children of a block container at (cx, cy), w wide. Returns the content height.
  function layoutChildren(el, cx, cy, w, h, fc) {
    let y = cy, prevMb = 0, inline = [];
    const flushInline = () => {
      if (!inline.length) return;
      const hh = layoutInline(el, inline, cx, y + prevMb, w, fc);
      if (hh > 0) { y += prevMb + hh; prevMb = 0; }
      inline = [];
    };
    const kids = kidsOf(el);
    const pcs = el._cs;
    for (const c of kids) {
      if (c.nodeType === 3) { inline.push(c); continue; }
      if (c.nodeType !== 1) continue;
      const cs = c._cs;
      if (!cs || cs.display === "none") { if (c._L) c._L = null; continue; }
      if (isOutOfFlow(cs)) {
        // Static position: where it would sit now.
        c._static = [cx, y + prevMb];
        absPending.push(c);
        continue;
      }
      if (cs.float !== "none") {
        flushInline();
        placeFloat(c, cs, cx, y + prevMb, w, h, fc);
        continue;
      }
      if (!isBlockLevel(cs)) { inline.push(c); continue; }
      flushInline();
      // clear
      let yy = y;
      if (cs.clear !== "none") { const cy2 = fc.clearY(cs.clear); if (cy2 > yy + prevMb) { yy = cy2; prevMb = 0; } }
      const e = edges(c, cs, w), mt = e.m[0] || 0;
      // Sibling margins collapse.
      const collapsed = Math.max(prevMb, mt) + Math.min(0, Math.min(prevMb, mt)) * (prevMb < 0 && mt < 0 ? 0 : 1);
      const top = yy + collapsed - mt;
      // A block that makes its own formatting context sits beside floats.
      let bx = cx, bw = w;
      if (establishesBFC(c, cs) && fc.list.length) { const [l, r] = fc.avail(top + mt, 1); bx = l; bw = r - l; }
      layoutBlock(c, bx, top, bw, h, fc, false);
      y = c._L.y + c._L.h;
      prevMb = c._L.m[2];
    }
    flushInline();
    y += prevMb > 0 && pcs && (el === g.document.documentElement || establishesBFC(el, pcs) || (pcs["padding-bottom"] !== "0" && pcs["padding-bottom"] !== "0px") || pcs["border-bottom-style"] !== "none") ? prevMb : prevMb;
    return y - cy;
  }
  function placeFloat(c, cs, cx, y, w, cbH, fc) {
    if (cs.clear !== "none") y = Math.max(y, fc.clearY(cs.clear));
    // Lay out at origin to know its size, then move.
    layoutBlock(c, 0, 0, w, cbH, new FloatCtx(0, w), true);
    const L = c._L, mw = L.w + L.m[1] + L.m[3], mh = L.h + L.m[0] + L.m[2];
    let yy = y;
    for (let guard = 0; guard < 200; guard++) {
      const [l, r] = fc.avail(yy, mh);
      if (r - l >= mw - 0.01 || (l === fc.left && r === fc.right)) {
        const x = cs.float === "left" ? l : r - mw;
        shift(c, x, yy);
        fc.list.push({ x, y: yy, w: mw, h: mh, side: cs.float });
        return;
      }
      const n = fc.nextY(yy);
      if (!Number.isFinite(n)) break;
      yy = n;
    }
    const x = cs.float === "left" ? fc.left : fc.right - mw;
    shift(c, x, yy);
    fc.list.push({ x, y: yy, w: mw, h: mh, side: cs.float });
  }
  // Move a laid-out subtree by (dx, dy) (descendants and text runs too).
  function shift(el, dx, dy) {
    if (!dx && !dy) return;
    const L = el._L;
    if (L) { L.x += dx; L.y += dy; L.cx += dx; L.cy += dy; if (L.frags) for (const f of L.frags) { f.x += dx; f.y += dy; } }
    if (el._runs) for (const r of el._runs) { r.x += dx; r.y += dy; }
    if (el._pb) for (const r of el._pb) { r.x += dx; r.y += dy; }
    if (el._static) { el._static[0] += dx; el._static[1] += dy; }
    for (const c of kidsOf(el)) if (c._L || c._runs || c.nodeType === 1) shift(c, dx, dy);
  }
  // shift() for a subtree placed at origin then moved to (x, y): L.x - margin = 0 at the time.
  // Place a subtree laid out at the origin so its margin edge is at (x, y); a relative offset stays on top.
  const moveTo = (el, x, y) => { const r = el._rel; shift(el, x + el._L.m[3] - (el._L.x - (r ? r[0] : 0)), y + el._L.m[0] - (el._L.y - (r ? r[1] : 0))); };
  const shiftAt = (el, x, y) => moveTo(el, x, y);
  void shiftAt;
  function relOffset(el, cs, cbW, cbH) {
    const fs = cs._fs;
    let dx = len(cs.left, cbW, fs), dy = len(cs.top, cbH, fs);
    if (dx == null) { const r = len(cs.right, cbW, fs); dx = r != null ? -r : 0; }
    if (dy == null) { const b = len(cs.bottom, cbH, fs); dy = b != null ? -b : 0; }
    el._rel = dx || dy ? [dx, dy] : null;
    if (dx || dy) shift(el, dx, dy);
  }

  // ---- absolute / fixed ----------------------------------------------------------------------
  // Absolutely positioned boxes wait in absPending until their containing block (nearest positioned
  // ancestor) is laid out; fixed ones and those under no positioned ancestor go against the viewport.
  function containingBlock(el) {
    if (el._cs.position === "fixed") return null;
    for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n._cs && n._cs.position !== "static") return n;
    return null;
  }
  function flushAbs(cb) {
    for (let i = 0; i < absPending.length; i++) {
      const c = absPending[i];
      if (containingBlock(c) !== cb) continue;
      absPending.splice(i--, 1);
      layoutAbs(c, cb);
    }
  }
  function layoutAbs(el, cbEl) {
    const cs = el._cs, fs = cs._fs;
    let ox, oy, cw, ch;
    if (cbEl && cbEl._L) { const L = cbEl._L; ox = L.x + L.b[3]; oy = L.y + L.b[0]; cw = L.w - L.b[1] - L.b[3]; ch = L.h - L.b[0] - L.b[2]; }
    else { ox = 0; oy = 0; cw = g.innerWidth; ch = g.innerHeight; }
    const e = edges(el, cs, cw);
    const hp = e.p[1] + e.p[3] + e.b[1] + e.b[3], vp = e.p[0] + e.p[2] + e.b[0] + e.b[2];
    const ml = e.m[3] || 0, mr = e.m[1] || 0, mt = e.m[0] || 0, mb = e.m[2] || 0;
    let left = len(cs.left, cw, fs), right = len(cs.right, cw, fs), top = len(cs.top, ch, fs), bottom = len(cs.bottom, ch, fs);
    let w = len(cs.width, cw, fs);
    if (w != null && cs["box-sizing"] === "border-box") w -= hp;
    if (isReplaced(el)) w = replacedSize(el, cs, cw)[0];
    if (w == null) {
      if (left != null && right != null) w = cw - left - right - ml - mr - hp;
      else { const [mn, mx] = intrinsic(el); const avail = cw - (left || 0) - (right || 0) - ml - mr - hp; w = Math.min(Math.max(mn, avail), mx); }
    }
    w = clampW(w, cs, cw, hp);
    let x;
    if (left != null) x = ox + left;
    else if (right != null) x = ox + cw - right - mr - (w + hp) - ml;
    else x = el._static ? el._static[0] : ox;
    // Lay out at origin with the resolved width.
    const saveW = cs.width, saveBS = cs["box-sizing"];
    cs.width = w + "px"; cs["box-sizing"] = "content-box";
    let hSpec = len(cs.height, ch, fs);
    const saveH = cs.height;
    if (hSpec == null && top != null && bottom != null && !isReplaced(el)) { cs.height = Math.max(0, ch - top - bottom - mt - mb - vp) + "px"; }
    else if (hSpec != null && saveBS === "border-box") cs.height = Math.max(0, hSpec - vp) + "px";
    layoutBlock(el, 0, 0, cw, ch, new FloatCtx(0, cw), true);
    cs.width = saveW; cs["box-sizing"] = saveBS; cs.height = saveH;
    const L = el._L;
    let y;
    if (top != null) y = oy + top;
    else if (bottom != null) y = oy + ch - bottom - mb - L.h - mt;
    else y = el._static ? el._static[1] : oy;
    // layoutBlock applied the relative/positioned offsets for its own children; move the whole subtree.
    shift(el, x + ml - L.x, y + mt - L.y);
  }

  // ---- inline formatting ---------------------------------------------------------------------
  // Items: words (text with a style), atoms (inline-block / replaced), open/close of inline elements, breaks.
  function layoutInline(container, nodes, cx, cy, w, fc) {
    const pcs = container._cs;
    const items = [];
    const pushText = (t, cs) => {
      let s = t.textContent;
      t._runs = [];
      if (!s) return;
      const ws = cs["white-space"];
      s = transformText(collapse(s, cs), cs);
      const font = fontOf(cs);
      if (ws === "pre" || ws === "pre-wrap" || ws === "pre-line") {
        const lines = s.split("\n");
        lines.forEach((ln, i) => {
          if (ws === "pre") items.push({ k: "w", t, cs, font, text: ln, w: measure(font, ln), nowrap: true });
          else for (const wd of ln.split(/( )/)) if (wd) items.push({ k: "w", t, cs, font, text: wd, w: measure(font, wd), space: wd === " " });
          if (i < lines.length - 1) items.push({ k: "br" });
        });
        return;
      }
      const nowrap = ws === "nowrap";
      const parts = s.split(" ");
      const sp = measure(font, " ");
      parts.forEach((wd, i) => {
        if (wd) items.push({ k: "w", t, cs, font, text: wd, w: measure(font, wd), nowrap });
        if (i < parts.length - 1) items.push({ k: "w", t, cs, font, text: " ", w: sp, space: true, nowrap });
      });
    };
    const visit = (n, cs) => {
      if (n.nodeType === 3) { pushText(n, cs); return; }
      if (n.nodeType !== 1) return;
      const ccs = n._cs;
      if (!ccs || ccs.display === "none") { n._L = null; return; }
      if (isOutOfFlow(ccs)) { n._static = null; absPending.push(n); n._staticItem = items.length; items.push({ k: "abs", el: n }); return; }
      if (ccs.float !== "none") { items.push({ k: "float", el: n, cs: ccs }); return; }
      if (n.tagName === "BR") { items.push({ k: "br", el: n }); n._L = null; return; }
      if (ccs.display === "inline" && !isReplaced(n)) {
        const e = edges(n, ccs, w);
        n._L = { x: 0, y: 0, w: 0, h: 0, m: [0, e.m[1] || 0, 0, e.m[3] || 0], p: e.p, b: e.b, cx: 0, cy: 0, cw: 0, ch: 0, frags: [], inline: true };
        items.push({ k: "open", el: n, cs: ccs, w: (e.m[3] || 0) + e.p[3] + e.b[3] });
        for (const c of kidsOf(n)) visit(c, ccs);
        items.push({ k: "close", el: n, cs: ccs, w: (e.m[1] || 0) + e.p[1] + e.b[1] });
        return;
      }
      // Atomic inline: inline-block, replaced, table-cell (tables lay out as rows of cells).
      layoutBlock(n, 0, 0, w, null, new FloatCtx(0, w), !isBlockLevel(ccs) || ccs.display === "table-cell");
      const L = n._L;
      items.push({ k: "atom", el: n, cs: ccs, w: L.w + L.m[1] + L.m[3], h: L.h + L.m[0] + L.m[2] });
    };
    for (const n of nodes) visit(n, pcs);
    if (!items.some((it) => it.k !== "abs" && !(it.k === "w" && it.space))) {
      // Only collapsible space (and out-of-flow boxes): no line box.
      for (const it of items) if (it.k === "abs") it.el._static = [cx, cy];
      return 0;
    }
    // Break into lines.
    const align = pcs["text-align"];
    const indent = len(pcs["text-indent"], w, pcs._fs) || 0;
    const strutLH = lineHeightOf(pcs);
    const [sa, sd] = fontMetrics(fontOf(pcs), pcs._fs);
    let y = cy, i = 0, first = true;
    const open = []; // inline elements open across lines
    while (i < items.length) {
      // Skip leading spaces on a line.
      while (i < items.length && items[i].k === "w" && items[i].space && !/^pre/.test(items[i].cs["white-space"])) { i++; }
      if (i >= items.length) break;
      const guessH = strutLH;
      let [l, r] = fc.avail(y, guessH);
      // A line needs room for at least its first item; move below floats if not.
      let lw = r - l - (first ? indent : 0);
      const line = [];
      let x = 0, j = i;
      for (; j < items.length; j++) {
        const it = items[j];
        if (it.k === "br") { j++; line.push(it); break; }
        if (it.k === "float") {
          // Float placed at the current line top.
          placeFloat(it.el, it.cs, cx, y, w, null, fc);
          [l, r] = fc.avail(y, guessH);
          lw = r - l - (first ? indent : 0);
          continue;
        }
        if (it.k === "abs") { line.push(it); continue; }
        const iw = it.w || 0;
        const canBreak = it.k === "w" ? !it.nowrap : it.k === "atom";
        if (x + iw > lw + 0.01 && line.some((q) => q.k === "w" || q.k === "atom") && canBreak && !(it.k === "w" && it.space)) {
          // No room: if nothing fits next to floats, drop below them.
          break;
        }
        if (it.k === "w" && it.space && x + iw > lw + 0.01 && canBreak) { j++; break; }
        line.push(it);
        x += iw;
      }
      if (!line.some((q) => q.k === "w" || q.k === "atom" || q.k === "br" || q.k === "open" || q.k === "close") && fc.list.length) {
        const n = fc.nextY(y);
        if (Number.isFinite(n) && j === i) { y = n; continue; }
      }
      if (j === i) j = i + 1; // always progress
      // Trim trailing collapsible spaces.
      while (line.length && line[line.length - 1].k === "w" && line[line.length - 1].space && !/^pre/.test(line[line.length - 1].cs["white-space"])) { x -= line[line.length - 1].w; line.pop(); }
      // Vertical metrics: strut plus every item's box, relative to the baseline.
      let asc = sa + (strutLH - (sa + sd)) / 2, desc = sd + (strutLH - (sa + sd)) / 2;
      const inlineStack = [...open];
      const vaShift = (cs) => { const v = cs["vertical-align"]; if (v === "super") return -cs._fs * 0.4; if (v === "sub") return cs._fs * 0.25; const n = len(v, lineHeightOf(cs), cs._fs); return n != null && /\d/.test(v) ? -n : 0; };
      for (const it of line) {
        if (it.k === "w") {
          const lh = lineHeightOf(it.cs), [a, d] = fontMetrics(it.font, it.cs._fs), half = (lh - (a + d)) / 2;
          const s = vaShift(it.cs);
          asc = Math.max(asc, a + half - s); desc = Math.max(desc, d + half + s);
        } else if (it.k === "atom") {
          const va = it.cs["vertical-align"];
          if (va === "middle") { const mid = sa * 0.3; asc = Math.max(asc, it.h / 2 + mid); desc = Math.max(desc, it.h / 2 - mid); }
          else if (va === "top" || va === "bottom" || va === "text-top" || va === "text-bottom") { /* placed after */ }
          else { const base = atomBaseline(it.el); asc = Math.max(asc, base); desc = Math.max(desc, it.h - base); }
        }
      }
      for (const it of line) if (it.k === "atom" && /^(top|bottom|text-top|text-bottom)$/.test(it.cs["vertical-align"])) { if (it.h > asc + desc) desc = it.h - asc; }
      const lineH = asc + desc;
      // Horizontal start by text-align.
      [l, r] = fc.avail(y, lineH);
      lw = r - l - (first ? indent : 0);
      let x0 = l + (first ? indent : 0);
      const free = lw - x;
      if (align === "center" || align === "-webkit-center") x0 += free / 2;
      else if (align === "right" || align === "end" || align === "-webkit-right") x0 += free;
      const base = y + asc;
      // Place.
      let xx = x0;
      const fragStart = new Map();
      for (const el of inlineStack) fragStart.set(el, xx);
      for (const it of line) {
        switch (it.k) {
          case "w":
            it.t._runs.push({ x: xx, y: base + vaShift(it.cs), text: it.text, w: it.w, font: it.font, cs: it.cs });
            xx += it.w;
            break;
          case "open":
            xx += it.el._L.m[3];
            fragStart.set(it.el, xx);
            xx += it.w - it.el._L.m[3];
            open.push(it.el);
            break;
          case "close": {
            xx += it.w - it.el._L.m[1];
            addFrag(it.el, fragStart.get(it.el) ?? x0, xx, base);
            fragStart.delete(it.el);
            xx += it.el._L.m[1];
            const k = open.lastIndexOf(it.el); if (k >= 0) open.splice(k, 1);
            break;
          }
          case "atom": {
            const L = it.el._L, va = it.cs["vertical-align"];
            let top;
            if (va === "middle") top = base - sa * 0.3 - it.h / 2;
            else if (va === "top" || va === "text-top") top = y;
            else if (va === "bottom" || va === "text-bottom") top = y + lineH - it.h;
            else top = base - atomBaseline(it.el);
            moveTo(it.el, xx, top);
            void L;
            xx += it.w;
            break;
          }
          case "abs": it.el._static = [xx, y]; break;
        }
      }
      // Inline elements still open at the line end get a fragment to here.
      for (const el of open) if (fragStart.has(el)) addFrag(el, fragStart.get(el), xx, base);
      y += lineH;
      first = false;
      i = j;
    }
    return y - cy;
  }
  // An inline element's box on one line: content area from the font, plus padding and border.
  function addFrag(el, x0, x1, base) {
    const cs = el._cs, L = el._L, [a, d] = fontMetrics(fontOf(cs), cs._fs);
    const f = { x: x0, y: base - a - L.p[0] - L.b[0], w: Math.max(0, x1 - x0), h: a + d + L.p[0] + L.p[2] + L.b[0] + L.b[2] };
    L.frags.push(f);
    // Bounding box of all fragments.
    const fr = L.frags;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of fr) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x + q.w); maxY = Math.max(maxY, q.y + q.h); }
    L.x = minX; L.y = minY; L.w = maxX - minX; L.h = maxY - minY;
    L.cx = L.x + L.b[3] + L.p[3]; L.cy = L.y + L.b[0] + L.p[0]; L.cw = Math.max(0, L.w - L.b[1] - L.b[3] - L.p[1] - L.p[3]); L.ch = Math.max(0, L.h - L.b[0] - L.b[2] - L.p[0] - L.p[2]);
  }
  // Distance from an atomic inline's margin top to its baseline: its last line box's baseline, or its bottom margin edge.
  function atomBaseline(el) {
    const L = el._L;
    if (!isReplaced(el) && el._cs["overflow-y"] === "visible") {
      const b = lastBaseline(el);
      if (b != null) return b - (L.y - L.m[0]);
    }
    return L.h + L.m[0] + L.m[2];
  }
  function lastBaseline(el) {
    const kk = kidsOf(el);
    for (let i = kk.length - 1; i >= 0; i--) {
      const c = kk[i];
      if (c.nodeType === 3 && c._runs && c._runs.length) return c._runs[c._runs.length - 1].y;
      if (c.nodeType === 1 && c._cs && c._cs.display !== "none" && !isOutOfFlow(c._cs) && c._cs.float === "none") { const b = lastBaseline(c); if (b != null) return b; }
    }
    return null;
  }

  // ---- the whole page ------------------------------------------------------------------------
  // A box whose size and position nothing inside it can change: absolutely positioned ones (they never push
  // other boxes), and in-flow ones with a set height (width set or filling their containing block) that start
  // their own formatting context (no floats cross their edge).
  function isBoundary(n) {
    const cs = n._cs, L = n._L;
    if (!cs || !L || cs.display === "none" || L.frags) return false;
    if (isOutOfFlow(cs)) return true;
    if (!n._args || !n._pre) return false;
    if (cs.height === "auto" || (cs.height.endsWith("%") && n._args[3] == null)) return false;
    if (cs.width === "auto" && n._args[4]) return false;
    return establishesBFC(n, cs) && !n._pseudo;
  }
  function boundaryOf(el) {
    const root = g.document.documentElement;
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) { if (n === root) return root; if (isBoundary(n)) return n; }
    return root;
  }
  // Lay out one boundary box again, then move it by what its ancestors added last time (relative offsets).
  function relayoutAt(B) {
    absPending = [];
    if (isOutOfFlow(B._cs)) {
      layoutAbs(B, containingBlock(B)); // against its containing block's final box: already in place
    } else {
      const dx = B._L.x - B._pre[0], dy = B._L.y - B._pre[1];
      const [x, y, cbW, cbH, shrink] = B._args;
      layoutBlock(B, x, y, cbW, cbH, new FloatCtx(x, x + cbW), shrink);
      shift(B, dx, dy);
    }
    while (absPending.length) { const more = absPending; absPending = []; for (const c of more) layoutAbs(c, containingBlock(c)); }
  }
  H.layout = () => {
    const doc = g.document, root = doc.documentElement;
    if (!root._cs) return;
    if (!H.fullLayout && root._L) {
      const roots = new Set();
      for (const el of H.layoutRoots) roots.add(el.isConnected ? boundaryOf(el) : root);
      H.layoutRoots.clear();
      if (!roots.has(root)) {
        // Outermost only.
        const list = [...roots].filter((b) => { for (let n = b.parentNode; n && n.nodeType === 1; n = n.parentNode) if (roots.has(n)) return false; return true; });
        for (const b of list) {
          if (H.onRelayout) H.onRelayout(b, true);
          relayoutAt(b);
          if (H.onRelayout) H.onRelayout(b, false);
        }
        H.dirtyLayout = false;
        H.layoutGen = (H.layoutGen || 0) + 1;
        H.partialLayouts = (H.partialLayouts || 0) + list.length;
        return;
      }
    }
    H.fullLayout = false;
    H.layoutRoots.clear();
    if (H.onRelayout) H.onRelayout(root, true);
    absPending = [];
    const W = g.innerWidth, Ht = g.innerHeight;
    // The root's containing block is the viewport; html and body fill at least its height when told to.
    layoutBlock(root, 0, 0, W, Ht, new FloatCtx(0, W), false);
    // Whatever is left has no positioned ancestor (or is fixed): against the viewport.
    const rest = absPending; absPending = [];
    for (const c of rest) { layoutAbs(c, containingBlock(c)); }
    while (absPending.length) { const more = absPending; absPending = []; for (const c of more) layoutAbs(c, containingBlock(c)); }
    if (H.onRelayout) H.onRelayout(root, false);
    H.dirtyLayout = false;
    H.layoutGen = (H.layoutGen || 0) + 1;
    H.fullLayouts = (H.fullLayouts || 0) + 1;
  };
  // Styles then layout, when the page changed since the last time.
  // H.fstats: passes and ms of style and layout, including the ones the page forces by reading geometry.
  H.fstats = { style: 0, styleMs: 0, layout: 0, layoutMs: 0 };
  H.flush = (paint) => {
    if (H.dirtyStyle) { const t = performance.now(); H.recompute(); H.fstats.style++; H.fstats.styleMs += performance.now() - t; }
    if (H.dirtyLayout) { const t = performance.now(); H.layout(); H.fstats.layout++; H.fstats.layoutMs += performance.now() - t; }
  };

  // ---- geometry the page reads ---------------------------------------------------------------
  // Page position of a box after its ancestors' scrolling.
  function scrollOffset(el) {
    let sx = 0, sy = 0;
    for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) { sx += n._scrollLeft || 0; sy += n._scrollTop || 0; }
    return [sx, sy];
  }
  // Boxes of elements not displayed (or detached) are stale: none.
  const Lof = (el) => (el._cs && el.isConnected ? el._L : null);
  H.Lof = Lof;
  const rect = (el) => {
    H.flush();
    const L = Lof(el);
    if (!L) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const [sx, sy] = scrollOffset(el);
    const x = L.x - sx, y = L.y - sy;
    return { x, y, left: x, top: y, right: x + L.w, bottom: y + L.h, width: L.w, height: L.h, toJSON() { return this; } };
  };
  const isCanvas = (el) => el.tagName === "CANVAS";
  EP.getBoundingClientRect = function () { return rect(this); };
  EP.getClientRects = function () { H.flush(); const L = this._L; if (!L) return []; if (L.frags) return L.frags.map((f) => ({ left: f.x, top: f.y, right: f.x + f.w, bottom: f.y + f.h, width: f.w, height: f.h, x: f.x, y: f.y })); return [rect(this)]; };
  const def = (name, fn) => Object.defineProperty(EP, name, { get: fn, configurable: true });
  def("offsetWidth", function () { H.flush(); return Lof(this) ? Math.round(this._L.w) : 0; });
  def("offsetHeight", function () { H.flush(); return Lof(this) ? Math.round(this._L.h) : 0; });
  def("offsetParent", function () { H.flush(); for (let n = this.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n._cs && n._cs.position !== "static" || n.tagName === "BODY") return n; return null; });
  def("offsetLeft", function () { H.flush(); const p = this.offsetParent, L = Lof(this); if (!L) return 0; return Math.round(L.x - (p && p._L ? p._L.x + p._L.b[3] : 0)); });
  def("offsetTop", function () { H.flush(); const p = this.offsetParent, L = Lof(this); if (!L) return 0; return Math.round(L.y - (p && p._L ? p._L.y + p._L.b[0] : 0)); });
  def("clientWidth", function () { if (this === g.document.documentElement || this === g.document.body && false) return g.innerWidth; H.flush(); const L = this._L; return L ? Math.round(L.w - L.b[1] - L.b[3] - (L.sb || 0)) : 0; });
  def("clientHeight", function () { if (this === g.document.documentElement) return g.innerHeight; H.flush(); const L = this._L; return L ? Math.round(L.h - L.b[0] - L.b[2]) : 0; });
  def("clientLeft", function () { H.flush(); return this._L ? this._L.b[3] : 0; });
  def("clientTop", function () { H.flush(); return this._L ? this._L.b[0] : 0; });
  def("scrollWidth", function () { H.flush(); const L = this._L; return L ? Math.round(Math.max(L.w - L.b[1] - L.b[3], contentExtent(this)[0])) : 0; });
  def("scrollHeight", function () { H.flush(); const L = this._L; return L ? Math.round(Math.max(L.h - L.b[0] - L.b[2], contentExtent(this)[1])) : 0; });
  // How far content reaches below / right of the padding box's top-left.
  function contentExtent(el) {
    const L = el._L, ox = L.x + L.b[3], oy = L.y + L.b[0];
    let mx = 0, my = 0;
    const visit = (n) => {
      for (const c of kidsOf(n)) {
        if (c.nodeType === 3 && c._runs) { for (const r of c._runs) { mx = Math.max(mx, r.x + r.w - ox); my = Math.max(my, r.y + 4 - oy); } continue; }
        if (c.nodeType !== 1 || !c._L) continue;
        mx = Math.max(mx, c._L.x + c._L.w + c._L.m[1] - ox); my = Math.max(my, c._L.y + c._L.h + c._L.m[2] - oy);
        if (c._cs && c._cs["overflow-y"] === "visible") visit(c);
      }
    };
    visit(el);
    return [mx + L.p[1], my + L.p[2]];
  }
  H.contentExtent = contentExtent;
  const scrollProp = (name, axis) => Object.defineProperty(EP, name, {
    get() { return this["_" + name] || 0; },
    set(v) {
      H.flush();
      const L = this._L; if (!L) return;
      const max = axis ? Math.max(0, contentExtent(this)[1] - (L.h - L.b[0] - L.b[2])) : Math.max(0, contentExtent(this)[0] - (L.w - L.b[1] - L.b[3]));
      const n = Math.max(0, Math.min(max, +v || 0));
      if (this["_" + name] !== n) { this["_" + name] = n; H.dirtyPaint = true; if (H.onScroll) H.onScroll(this); }
    },
    configurable: true,
  });
  scrollProp("scrollTop", 1); scrollProp("scrollLeft", 0);
  EP.scrollTo = function (x, y) { if (typeof x === "object") { y = x.top; x = x.left; } if (x != null) this.scrollLeft = x; if (y != null) this.scrollTop = y; };
  EP.scrollBy = function (x, y) { if (typeof x === "object") { y = x.top; x = x.left; } this.scrollTo(this.scrollLeft + (x || 0), this.scrollTop + (y || 0)); };
  EP.scrollIntoView = function () {};
  H.scrollOffset = scrollOffset;
  void isCanvas;
})();
