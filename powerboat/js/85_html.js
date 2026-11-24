// powerboat JS environment, part 9a: HTML pages drawn by the runtime (POWERBOAT_HTML=1).
// Pages whose interface is HTML and CSS (an Electron or NW.js game with a DOM interface) get a real
// style system here: element.style as a CSSStyleDeclaration, stylesheets parsed into rules, selector
// matching and the cascade into one computed style per element. 86_layout.js lays the boxes out and
// 87_paint.js draws them into the window. Builds on 79_webpage.js's DOM (innerHTML, queries).
"use strict";
(() => {
  const ops = Deno.core.ops;
  if (ops.op_powerboat_env("POWERBOAT_HTML") !== "1") return;
  const g = globalThis;
  const H = (__powerboat.html = { rules: [], keyframes: new Map(), styleGen: 1, dirtyStyle: true, dirtyLayout: true, dirtyPaint: true, hover: null, active: null });
  // The page is its own top window (games check `top != self` for being framed).
  for (const k of ["window", "self", "top", "parent", "frames"]) if (!(k in g)) g[k] = g;
  // Change tracking. touch(): everything again (new sheets, a resize, an image arriving). restyle(el): el's
  // subtree gets new computed styles (ancestors carry a "child dirty" mark down to it). relayout(el): el's box or
  // content changed; 86_layout.js lays out again from the nearest box whose size cannot change outside it.
  H.fullStyle = true; H.fullLayout = true; H.layoutRoots = new Set();
  const touch = () => { H.fullStyle = H.fullLayout = true; H.dirtyStyle = H.dirtyLayout = H.dirtyPaint = true; };
  H.touch = touch;
  // Ancestors lose their "same innerHTML" shortcut whenever anything below them changes.
  const htmlDirtyUp = (n) => { for (; n; n = n.parentNode) n._htmlSet = undefined; };
  H.restyle = (el) => {
    if (!el || el.nodeType !== 1) return;
    htmlDirtyUp(el);
    if (!el.isConnected) return;
    el._sd = true;
    for (let n = el.parentNode; n && n.nodeType === 1 && !n._sdc; n = n.parentNode) n._sdc = true;
    H.dirtyStyle = H.dirtyLayout = H.dirtyPaint = true;
  };
  H.relayout = (el) => {
    if (!el) return;
    htmlDirtyUp(el);
    if (el.nodeType !== 1 || !el.isConnected) return;
    H.layoutRoots.add(el);
    H.dirtyLayout = H.dirtyPaint = true;
  };
  const EP = g.HTMLElement.prototype, DP = g.Document.prototype;

  // ---- colors -> [r, g, b, a] (0-255, a 0-1) --------------------------------------------------
  const NAMED = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1],
    blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1], purple: [128, 0, 128, 1], gray: [128, 128, 128, 1],
    grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1], lime: [0, 255, 0, 1],
    aqua: [0, 255, 255, 1], cyan: [0, 255, 255, 1], teal: [0, 128, 128, 1], navy: [0, 0, 128, 1], fuchsia: [255, 0, 255, 1],
    magenta: [255, 0, 255, 1], pink: [255, 192, 203, 1], brown: [165, 42, 42, 1], gold: [255, 215, 0, 1], darkgray: [169, 169, 169, 1],
    lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1], darkgrey: [169, 169, 169, 1], dimgray: [105, 105, 105, 1],
    darkred: [139, 0, 0, 1], darkgreen: [0, 100, 0, 1], darkblue: [0, 0, 139, 1], skyblue: [135, 206, 235, 1], lightblue: [173, 216, 230, 1],
    beige: [245, 245, 220, 1], tan: [210, 180, 140, 1], khaki: [240, 230, 140, 1], coral: [255, 127, 80, 1], salmon: [250, 128, 114, 1],
    crimson: [220, 20, 60, 1], indigo: [75, 0, 130, 1], violet: [238, 130, 238, 1], wheat: [245, 222, 179, 1], ivory: [255, 255, 240, 1],
    chocolate: [210, 105, 30, 1], goldenrod: [218, 165, 32, 1], lightgreen: [144, 238, 144, 1], lightyellow: [255, 255, 224, 1],
    whitesmoke: [245, 245, 245, 1], snow: [255, 250, 250, 1], firebrick: [178, 34, 34, 1], orangered: [255, 69, 0, 1], plum: [221, 160, 221, 1] };
  const colorCache = new Map();
  // currentcolor resolves against `cur` (the element's color).
  function parseColor(v, cur) {
    if (!v) return null;
    v = String(v).trim().toLowerCase();
    if (v === "currentcolor") return cur ? parseColor(cur) : [0, 0, 0, 1];
    let c = colorCache.get(v);
    if (c !== undefined) return c;
    c = null;
    if (NAMED[v]) c = NAMED[v];
    else if (v[0] === "#") {
      const h = v.slice(1);
      if (h.length === 3 || h.length === 4) c = [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1];
      else if (h.length === 6 || h.length === 8) c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    } else {
      const m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
      if (m) {
        const p = m[2].split(/[\s,\/]+/).filter(Boolean).map((x) => (x.endsWith("%") ? parseFloat(x) * (m[1][0] === "r" ? 2.55 : 1) : parseFloat(x)));
        if (m[1][0] === "r") c = [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
        else {
          const hh = (((p[0] % 360) + 360) % 360) / 360, s = p[1] / 100, l = p[2] / 100;
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - q;
          const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp; };
          c = [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255, p[3] === undefined ? 1 : p[3]];
        }
      }
    }
    colorCache.set(v, c);
    return c;
  }
  H.parseColor = parseColor;
  H.css = (c, alpha = 1) => "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + (c[3] * alpha) + ")";

  // ---- property names ------------------------------------------------------------------------
  const camel = (k) => k.replace(/^-(webkit|moz|ms|o)-/, (m, p) => p + "-").replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/^(webkit|moz|ms|o)-/, "-$1-");
  // Vendor prefixes map onto the standard property.
  const unprefix = (k) => k.replace(/^-(webkit|moz|ms|o)-/, "");
  const PROPS = ("display position float clear left right top bottom width height min-width min-height max-width max-height " +
    "margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left " +
    "border border-top border-right border-bottom border-left border-width border-style border-color border-radius " +
    "border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style " +
    "border-top-color border-right-color border-bottom-color border-left-color border-image box-sizing " +
    "border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius " +
    "overflow overflow-x overflow-y z-index opacity visibility color background background-color background-image background-position " +
    "background-size background-repeat background-blend-mode font font-family font-size font-weight font-style font-variant line-height " +
    "text-align text-shadow text-decoration text-transform text-indent letter-spacing white-space vertical-align word-wrap word-break " +
    "box-shadow transform transform-origin transition animation animation-name animation-duration animation-delay animation-iteration-count " +
    "animation-timing-function animation-fill-mode pointer-events cursor content filter mix-blend-mode mask-image outline " +
    "user-select touch-action image-rendering list-style resize clip scrollbar-color scrollbar-width").split(" ");
  const SHORT = new Set(["margin", "padding", "border", "border-top", "border-right", "border-bottom", "border-left", "border-width",
    "border-style", "border-color", "border-radius", "background", "font", "overflow"]);
  const SIDES = ["top", "right", "bottom", "left"];
  const four = (v) => { const p = splitTop(v); return p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p.slice(0, 4); };
  // Split on spaces outside parentheses.
  function splitTop(v, sep = " ") {
    const out = []; let depth = 0, cur = "";
    for (const ch of String(v).trim()) {
      if (ch === "(") depth++; else if (ch === ")") depth--;
      if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) { if (cur) out.push(cur); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(sep === " " ? cur : cur.trim());
    return out;
  }
  H.splitTop = splitTop;
  const isColor = (t) => /^(#|rgba?\(|hsla?\(|transparent$|currentcolor$)/i.test(t) || NAMED[t.toLowerCase()] !== undefined;
  const isLength = (t) => /^-?[\d.]+(px|em|rem|%|pt|vw|vh)?$/i.test(t) || t === "0" || t === "auto";
  const BSTYLE = /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;
  // Shorthand -> longhands (lists of [name, value]); "inherit"/"initial" spread to every longhand.
  function expand(name, v, out) {
    v = String(v).trim();
    switch (name) {
      case "margin": case "padding": { const f = four(v); SIDES.forEach((s, i) => out.push([name + "-" + s, f[i] ?? "0"])); return; }
      case "border-width": case "border-style": case "border-color": { const f = four(v), k = name.slice(7); SIDES.forEach((s, i) => out.push(["border-" + s + "-" + k, f[i]])); return; }
      case "border": case "border-top": case "border-right": case "border-bottom": case "border-left": {
        let w = "medium", st = "none", c = "currentcolor";
        if (v === "none" || v === "0") { st = "none"; w = "0"; }
        else for (const t of splitTop(v)) { if (BSTYLE.test(t)) st = t; else if (isColor(t)) c = t; else w = t; }
        const sides = name === "border" ? SIDES : [name.slice(7)];
        for (const s of sides) out.push(["border-" + s + "-width", w], ["border-" + s + "-style", st], ["border-" + s + "-color", c]);
        if (name === "border") out.push(["border-image", "none"]);
        return;
      }
      case "border-radius": { const f = four(v.split("/")[0]); ["top-left", "top-right", "bottom-right", "bottom-left"].forEach((c, i) => out.push(["border-" + c + "-radius", f[i]])); return; }
      case "overflow": { const p = splitTop(v); out.push(["overflow-x", p[0]], ["overflow-y", p[1] || p[0]]); return; }
      case "background": {
        // Layers: image, position, size and repeat as comma lists (first = top); the color is the last layer's.
        const layers = splitTop(v, ",");
        let color = "transparent";
        const images = [], poss = [], sizes = [], reps = [];
        for (const layer of layers) {
          const toks = splitTop(layer); const posT = [];
          let image = "none", size = "auto", rep = "";
          for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (/^(url|linear-gradient|radial-gradient|-webkit-linear-gradient|-webkit-radial-gradient|repeating-linear-gradient)\(/i.test(t)) image = t;
            else if (/^(repeat|no-repeat|repeat-x|repeat-y|space|round)$/i.test(t)) rep = rep ? rep + " " + t : t;
            else if (t === "none") {}
            else if (t === "/") { const sz = []; while (i + 1 < toks.length && (isLength(toks[i + 1]) || /^(cover|contain)$/.test(toks[i + 1]))) sz.push(toks[++i]); size = sz.join(" "); }
            else if (t.includes("/") && !/\(/.test(t)) { const [a, b] = t.split("/"); if (a) posT.push(a); if (b) size = b; }
            else if (/^(left|right|top|bottom|center)$/i.test(t) || isLength(t)) posT.push(t);
            else if (isColor(t)) color = t;
          }
          images.push(image); poss.push(posT.length ? posT.join(" ") : "0% 0%"); sizes.push(size); reps.push(rep || "repeat");
        }
        out.push(["background-color", color], ["background-image", images.join(", ")], ["background-position", poss.join(", ")], ["background-size", sizes.join(", ")], ["background-repeat", reps.join(", ")]);
        return;
      }
      case "font": {
        // [style] [variant] [weight] size[/line-height] family
        const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|\d00)\s+)*)([\d.]+(?:px|pt|em|rem|%)|small|medium|large|x-large|smaller|larger)(?:\s*\/\s*([^\s]+))?\s+(.+)$/i.exec(v);
        if (!m) return;
        let st = "normal", va = "normal", we = "normal";
        for (const t of m[1].trim().split(/\s+/).filter(Boolean)) { if (/italic|oblique/i.test(t)) st = t; else if (/small-caps/i.test(t)) va = t; else if (t !== "normal") we = t; }
        out.push(["font-style", st], ["font-variant", va], ["font-weight", we], ["font-size", m[2]], ["line-height", m[3] || "normal"], ["font-family", m[4]]);
        return;
      }
    }
    out.push([name, v]);
  }
  H.expand = expand;

  // ---- CSSStyleDeclaration -------------------------------------------------------------------
  // Longhands by name; a shorthand set through the object reads back as written.
  class CSSStyleDeclaration {
    constructor(el) { Object.defineProperty(this, "_el", { value: el || null, writable: true }); Object.defineProperty(this, "_m", { value: new Map(), writable: true }); Object.defineProperty(this, "_raw", { value: new Map(), writable: true }); }
    _set(name, value, important) {
      name = unprefix(String(name).trim().toLowerCase());
      const v = value == null ? "" : String(value).trim();
      if (!v) { this._remove(name); return; }
      // Writing the value already there changes nothing (pages set the same styles every frame).
      if (SHORT.has(name)) { if (this._raw.get(name) === v) return; this._raw.set(name, v); const out = []; expand(name, v, out); for (const [k, val] of out) this._m.set(k, val); }
      else { if (this._m.get(name) === v) return; this._m.set(name, v); }
      if (!this._quiet) { this._lastText = undefined; if (this._el) H.restyle(this._el); }
    }
    _remove(name) {
      if (!this._m.has(name) && !this._raw.has(name) && !SHORT.has(name)) return;
      if (SHORT.has(name)) { this._raw.delete(name); const out = []; expand(name, "0", out); for (const [k] of out) this._m.delete(k); }
      this._m.delete(name);
      if (!this._quiet) { this._lastText = undefined; if (this._el) H.restyle(this._el); }
    }
    _get(name) {
      name = unprefix(String(name).toLowerCase());
      if (this._raw.has(name)) return this._raw.get(name);
      if (name === "margin" || name === "padding") { const p = SIDES.map((s) => this._m.get(name + "-" + s)); return p.every((x) => x !== undefined) ? p.join(" ") : ""; }
      return this._m.get(name) ?? "";
    }
    setProperty(k, v, prio) { this._set(k, v, prio === "important"); }
    getPropertyValue(k) { return this._get(k); }
    removeProperty(k) { const old = this._get(k); this._remove(unprefix(String(k).toLowerCase())); return old; }
    get length() { return this._m.size; }
    item(i) { return [...this._m.keys()][i] || ""; }
    get cssText() { let s = ""; for (const [k, v] of this._m) s += k + ": " + v + "; "; return s.trim(); }
    set cssText(t) {
      t = String(t ?? "");
      if (t === this._lastText) return;
      this._lastText = t;
      this._m.clear(); this._raw.clear();
      this._quiet = true;
      for (const [k, v] of parseDecls(t)) this._set(k, v);
      this._quiet = false;
      if (this._el) H.restyle(this._el);
    }
  }
  for (const k of PROPS) {
    const names = new Set([camel(k), "webkit" + camel(k)[0].toUpperCase() + camel(k).slice(1), "Webkit" + camel(k)[0].toUpperCase() + camel(k).slice(1), "Moz" + camel(k)[0].toUpperCase() + camel(k).slice(1), "ms" + camel(k)[0].toUpperCase() + camel(k).slice(1)]);
    for (const n of names) Object.defineProperty(CSSStyleDeclaration.prototype, n, { get() { return this._get(k); }, set(v) { this._set(k, v); }, configurable: true });
  }
  Object.defineProperty(CSSStyleDeclaration.prototype, "cssFloat", { get() { return this._get("float"); }, set(v) { this._set("float", v); } });
  g.CSSStyleDeclaration = CSSStyleDeclaration;
  // Every element's style object, made on first use.
  Object.defineProperty(EP, "style", {
    get() { let s = this._styleObj; if (!s) { s = new CSSStyleDeclaration(this); Object.defineProperty(this, "_styleObj", { value: s, writable: true }); } return s; },
    set(v) { this.style.cssText = typeof v === "string" ? v : ""; },
    configurable: true,
  });
  // Elements made before this layer carry a plain style object of their own.
  const adoptStyle = (n) => { if (Object.prototype.hasOwnProperty.call(n, "style")) { const old = n.style; delete n.style; for (const k of Object.keys(old)) if (k !== "cssText" && old[k] !== "" && typeof old[k] === "string") n.style[k] = old[k]; } for (const c of n.children) adoptStyle(c); };
  // New elements: the base constructor assigns this.style = new CSSStyle(); the setter above takes it (cssText "").
  // Declarations "a: b; c: d" with !important flags, comments removed.
  function parseDecls(text) {
    const out = [];
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0, cur = "", q = null;
    const flush = () => {
      const i = cur.indexOf(":");
      if (i > 0) { let v = cur.slice(i + 1).trim(); const imp = /!\s*important\s*$/i.test(v); if (imp) v = v.replace(/!\s*important\s*$/i, "").trim(); out.push([cur.slice(0, i).trim().toLowerCase(), v, imp]); }
      cur = "";
    };
    for (const ch of text) {
      if (q) { if (ch === q) q = null; cur += ch; continue; }
      if (ch === "'" || ch === "\"") { q = ch; cur += ch; continue; }
      if (ch === "(") depth++; else if (ch === ")") depth--;
      if (ch === ";" && depth === 0) flush(); else cur += ch;
    }
    flush();
    return out;
  }
  H.parseDecls = parseDecls;

  // ---- selectors -----------------------------------------------------------------------------
  // A selector is compounds joined right to left: [{c: compound, comb: " " | ">" | "+" | "~"}].
  // compound: {tag, id, cls[], attrs[[name, op, value]], pseudo[[name, arg]], pe: "before"|"after"|null}
  function parseSelector(sel) {
    const parts = []; let comb = null;
    const re = /\s*([>+~])\s*|\s+|([^\s>+~]+(?:\([^)]*\))?[^\s>+~]*)/g;
    sel = sel.trim();
    const toks = [];
    // Tokenize: compounds may hold :not(...) and [..] with spaces; handle by scanning.
    let i = 0;
    while (i < sel.length) {
      const ch = sel[i];
      if (/\s/.test(ch) || ch === ">" || ch === "+" || ch === "~") {
        let j = i, c = " ";
        while (j < sel.length && /[\s>+~]/.test(sel[j])) { if (sel[j] !== " " && !/\s/.test(sel[j])) c = sel[j]; j++; }
        toks.push({ comb: c }); i = j; continue;
      }
      let j = i, depth = 0;
      while (j < sel.length && (depth > 0 || !/[\s>+~]/.test(sel[j]))) { if (sel[j] === "(" || sel[j] === "[") depth++; else if (sel[j] === ")" || sel[j] === "]") depth--; j++; }
      toks.push({ c: parseCompound(sel.slice(i, j)) }); i = j;
    }
    void re; void comb;
    let spec = 0;
    for (const t of toks) {
      if (t.comb) { if (parts.length) parts[parts.length - 1].comb = t.comb; continue; }
      if (!t.c) return null;
      parts.push({ c: t.c, comb: null });
      spec += t.c.spec;
    }
    if (!parts.length) return null;
    parts.reverse();
    // After reversing, each part's comb says how it joins the part to its right; shift so parts[i].comb joins parts[i] to parts[i+1].
    const combs = parts.map((p) => p.comb);
    for (let k = 0; k < parts.length; k++) parts[k].comb = k + 1 < parts.length ? combs[k + 1] || " " : null;
    return { parts, spec, pe: parts[0].c.pe, key: keyOf(parts[0].c) };
  }
  function parseCompound(s) {
    const c = { tag: "", id: "", cls: [], attrs: [], pseudo: [], pe: null, spec: 0 };
    const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]|::?([\w-]+)(?:\(([^)]*)\))?/y;
    let m, i = 0;
    while (i < s.length) {
      re.lastIndex = i;
      m = re.exec(s);
      if (!m) return null;
      i = re.lastIndex;
      if (m[1]) { if (m[1] !== "*") { c.tag = m[1].toUpperCase(); c.spec += 1; } }
      else if (m[2]) { c.id = m[2]; c.spec += 10000; }
      else if (m[3]) { c.cls.push(m[3]); c.spec += 100; }
      else if (m[4]) { c.attrs.push([m[4].toLowerCase(), m[5] || "", m[6] ?? m[7] ?? m[8] ?? ""]); c.spec += 100; }
      else if (m[9]) {
        const p = m[9].toLowerCase();
        if (p === "before" || p === "after") { c.pe = p; c.spec += 1; }
        else if (p === "not") { const inner = parseCompound(m[10] || ""); if (!inner) return null; c.pseudo.push(["not", inner]); c.spec += inner.spec; }
        else if (p === "nth-child" || p === "nth-of-type" || p === "nth-last-child") { c.pseudo.push([p, nth(m[10] || "")]); c.spec += 100; }
        else if (/^(hover|active|focus|first-child|last-child|only-child|first-of-type|last-of-type|empty|root|link|visited|checked|disabled|enabled|focus-within|focus-visible)$/.test(p)) { c.pseudo.push([p, null]); c.spec += 100; }
        else if (/^(selection|-moz-selection|-webkit-scrollbar|-webkit-scrollbar-thumb|-webkit-scrollbar-track|placeholder|-webkit-input-placeholder|-moz-placeholder|first-line|first-letter)/.test(p)) return null; // never drawn
        else return null;
      }
    }
    return c;
  }
  function nth(arg) {
    arg = arg.replace(/\s+/g, "").toLowerCase();
    if (arg === "odd") return [2, 1]; if (arg === "even") return [2, 0];
    const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(arg);
    if (m) return [m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
    return [0, parseInt(arg, 10) || 0];
  }
  const keyOf = (c) => (c.id ? "#" + c.id : c.cls.length ? "." + c.cls[0] : c.tag ? c.tag : "*");
  const classesOf = (el) => { const cn = el.className; if (cn === el._cnStr) return el._cnSet; el._cnStr = cn; el._cnSet = new Set(String(cn || "").split(/\s+/).filter(Boolean)); return el._cnSet; };
  H.classesOf = classesOf;
  const elementChildren = (p) => (p ? p.children.filter((n) => n.nodeType === 1) : []);
  function matchCompound(el, c) {
    if (!el || el.nodeType !== 1) return false;
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.id !== c.id) return false;
    if (c.cls.length) { const s = classesOf(el); for (const k of c.cls) if (!s.has(k)) return false; }
    for (const [name, op, val] of c.attrs) {
      const a = name === "class" ? el.className : name === "id" ? el.id : el.getAttribute(name);
      if (a == null || (name === "class" && a === "")) return false;
      const s = String(a);
      if (op === "=" && s !== val) return false;
      if (op === "~=" && !s.split(/\s+/).includes(val)) return false;
      if (op === "^=" && !s.startsWith(val)) return false;
      if (op === "$=" && !s.endsWith(val)) return false;
      if (op === "*=" && !s.includes(val)) return false;
      if (op === "|=" && s !== val && !s.startsWith(val + "-")) return false;
    }
    for (const [p, arg] of c.pseudo) {
      switch (p) {
        case "hover": { let ok = false; for (let n = H.hover; n; n = n.parentNode) if (n === el) { ok = true; break; } if (!ok) return false; break; }
        case "active": { let ok = false; for (let n = H.active; n; n = n.parentNode) if (n === el) { ok = true; break; } if (!ok) return false; break; }
        case "focus": case "focus-within": case "focus-visible": case "visited": case "checked": case "disabled": return false;
        case "link": if (el.tagName !== "A") return false; break;
        case "enabled": break;
        case "root": if (el !== g.document.documentElement) return false; break;
        case "empty": if (el.children.length) return false; break;
        case "not": if (matchCompound(el, arg)) return false; break;
        default: {
          const sib = elementChildren(el.parentNode);
          const of = p.endsWith("of-type") ? sib.filter((n) => n.tagName === el.tagName) : sib;
          const i = of.indexOf(el);
          if (p === "first-child" || p === "first-of-type") { if (i !== 0) return false; }
          else if (p === "last-child" || p === "last-of-type") { if (i !== of.length - 1) return false; }
          else if (p === "only-child") { if (of.length !== 1) return false; }
          else {
            const [a, b] = arg, pos = p === "nth-last-child" ? of.length - i : i + 1;
            if (a === 0) { if (pos !== b) return false; }
            else if ((pos - b) / a < 0 || (pos - b) % a !== 0) return false;
          }
        }
      }
    }
    return true;
  }
  function matchFrom(el, parts, k) {
    if (!matchCompound(el, parts[k].c)) return false;
    if (k + 1 >= parts.length) return true;
    const comb = parts[k].comb;
    if (comb === ">") return matchFrom(el.parentNode, parts, k + 1);
    if (comb === " ") { for (let n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (matchFrom(n, parts, k + 1)) return true; return false; }
    const sib = elementChildren(el.parentNode), i = sib.indexOf(el);
    if (comb === "+") return i > 0 && matchFrom(sib[i - 1], parts, k + 1);
    for (let j = i - 1; j >= 0; j--) if (matchFrom(sib[j], parts, k + 1)) return true;
    return false;
  }
  // Can a :hover (or :active) rule apply to el? (Then its hover state changing restyles its subtree.)
  H.stateSensitive = (el, kind) => { const l = H.statePseudo && H.statePseudo[kind]; if (!l || el.nodeType !== 1) return false; for (const c of l) if (matchCompound(el, c)) return true; return false; };
  H.matches = (el, selText) => { for (const s of String(selText).split(",")) { const p = parseSelector(s); if (p && !p.pe && matchFrom(el, p.parts, 0)) return true; } return false; };
  // Full selectors for querySelector(All) and matches (79_webpage.js had simple ones only).
  const walk = (root, fn) => { for (const c of root.children) { if (c.nodeType === 1) { fn(c); walk(c, fn); } } };
  const qsa = (root, sel) => { const sels = String(sel).split(",").map(parseSelector).filter(Boolean); const out = []; walk(root, (el) => { for (const s of sels) if (matchFrom(el, s.parts, 0)) { out.push(el); break; } }); return out; };
  const qs = (root, sel) => { const sels = String(sel).split(",").map(parseSelector).filter(Boolean); let hit = null; const f = (r) => { for (const c of r.children) { if (hit) return; if (c.nodeType !== 1) continue; for (const s of sels) if (matchFrom(c, s.parts, 0)) { hit = c; return; } f(c); } }; f(root); return hit; };
  EP.querySelectorAll = function (s) { return qsa(this, s); };
  EP.querySelector = function (s) { return qs(this, s); };
  DP.querySelectorAll = function (s) { return qsa(this.documentElement, s); };
  DP.querySelector = function (s) { return qs(this.documentElement, s); };
  EP.matches = EP.webkitMatchesSelector = function (s) { return H.matches(this, s); };
  EP.closest = function (s) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (H.matches(n, s)) return n; return null; };

  // ---- stylesheets ---------------------------------------------------------------------------
  let ruleOrder = 0;
  // Rules come from the UA sheet, <link> sheets and head <style> blocks (H.staticRules, in load order),
  // then the document's <style> elements, re-read whenever their text changes.
  H.staticRules = [];
  let styleKey = "";
  // <style> elements are looked for again only after one may have come, gone or changed (H.styleScan).
  H.styleScan = true;
  const hasStyle = (n) => { if (n.nodeType !== 1) return false; if (n.tagName === "STYLE") return true; for (const c of n.children) if (hasStyle(c)) return true; return false; };
  H.hasStyle = hasStyle;
  function syncStyleElements() {
    if (!H.styleScan) return;
    H.styleScan = false;
    const els = [];
    const w = (n) => { for (const c of n.children) { if (c.nodeType !== 1) continue; if (c.tagName === "STYLE") els.push(c); else w(c); } };
    w(g.document.documentElement);
    const texts = els.map((e) => e._rawHTML ?? e.textContent ?? "");
    const key = texts.join("\u0000");
    if (key === styleKey) return;
    styleKey = key;
    const dyn = [];
    for (const t of texts) parseSheet(t, "", dyn);
    H.rules = H.staticRules.concat(dyn);
    indexRules();
  }
  H.syncStyleElements = syncStyleElements;
  function addSheet(css, base) {
    parseSheet(css, base, H.staticRules);
    H.rules = H.staticRules.slice();
    styleKey = "\u0001"; // the next style pass puts the <style> elements back on top
    indexRules();
    touch();
  }
  function parseSheet(css, base, into) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, "");
    let i = 0;
    const n = css.length;
    while (i < n) {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      const head = css.slice(i, open).trim();
      // Matching close brace.
      let depth = 1, j = open + 1;
      while (j < n && depth) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
      const body = css.slice(open + 1, j - 1);
      i = j;
      if (head.startsWith("@")) {
        const km = /^@(?:-webkit-|-moz-|-o-)?keyframes\s+([\w-]+)/i.exec(head);
        if (km) H.keyframes.set(km[1], parseKeyframes(body));
        continue; // @font-face: 40_web.js; @media: none in the pages this serves
      }
      const decls = [];
      for (const [k, v, imp] of parseDecls(body)) { const out = []; expand(unprefix(k), resolveUrls(v, base), out); for (const [a, b] of out) decls.push([a, b, imp]); }
      for (const s of splitTop(head, ",")) {
        const sel = parseSelector(s);
        if (sel) into.push({ sel, decls, order: ruleOrder++ });
      }
    }
  }
  function parseKeyframes(body) {
    const frames = [];
    for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls = []; for (const [k, v] of parseDecls(m[2])) { const out = []; expand(unprefix(k), v, out); decls.push(...out); }
      for (const at of m[1].split(",")) { const t = at.trim(); frames.push({ at: t === "from" ? 0 : t === "to" ? 1 : parseFloat(t) / 100, decls }); }
    }
    return frames.sort((a, b) => a.at - b.at);
  }
  // url(...) relative to the stylesheet's folder becomes relative to the page.
  function resolveUrls(v, base) {
    if (!base || !v.includes("url(")) return v;
    return v.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (/^(data:|\/|[a-z]+:)/i.test(u) ? m : "url(" + base + u + ")"));
  }
  H.addSheet = addSheet;
  // Rules indexed by their rightmost compound's id, first class or tag.
  let byKey = new Map();
  function indexRules() {
    byKey = new Map();
    for (const r of H.rules) { const k = r.sel.key; let l = byKey.get(k); if (!l) byKey.set(k, l = []); l.push(r); }
    // What makes a change restyle more than the element: attribute selectors, sibling positions.
    H.attrNames = new Set(); H.structural = false;
    const scan = (c) => {
      for (const a of c.attrs) H.attrNames.add(a[0]);
      for (const [p, arg] of c.pseudo) { if (p === "not") scan(arg); else if (/child|of-type|empty/.test(p)) H.structural = true; }
    };
    for (const r of H.rules) for (const part of r.sel.parts) { scan(part.c); if (part.comb === "+" || part.comb === "~") H.structural = true; }
    // Compounds that carry :hover / :active (without that pseudo-class): an element whose state changes needs
    // restyling only when one of them matches it.
    H.statePseudo = { hover: [], active: [] };
    for (const r of H.rules) for (const part of r.sel.parts) for (const k of ["hover", "active"]) {
      if (part.c.pseudo.some((q) => q[0] === k)) H.statePseudo[k].push({ ...part.c, pseudo: part.c.pseudo.filter((q) => q[0] !== k) });
    }
    H.fullStyle = true;
  }
  // <link rel=stylesheet> and <style> both feed the rule list (fonts still go through 40_web.js).
  const baseLoadSheet = __powerboat.loadStylesheet;
  __powerboat.loadStylesheet = (href) => {
    if (baseLoadSheet) baseLoadSheet(href);
    const clean = String(href).replace(/[?#].*$/, "");
    let css = "";
    try { css = __powerboat.readText(__powerboat.resolvePath(clean)); } catch (e) { return; }
    const slash = clean.lastIndexOf("/");
    addSheet(css, slash >= 0 ? clean.slice(0, slash + 1) : "");
  };

  // ---- cascade -------------------------------------------------------------------------------
  // Inherited properties take the parent's computed value when the element sets none.
  const INHERITED = new Set(["color", "font-family", "font-size", "font-weight", "font-style", "font-variant", "line-height", "text-align",
    "text-shadow", "text-transform", "text-indent", "letter-spacing", "white-space", "visibility", "cursor", "pointer-events", "word-wrap", "word-break",
    "list-style", "image-rendering", "scrollbar-color"]);
  const INITIAL = {
    display: "inline", position: "static", float: "none", clear: "none", left: "auto", right: "auto", top: "auto", bottom: "auto",
    width: "auto", height: "auto", "min-width": "0", "min-height": "0", "max-width": "none", "max-height": "none",
    "margin-top": "0", "margin-right": "0", "margin-bottom": "0", "margin-left": "0",
    "padding-top": "0", "padding-right": "0", "padding-bottom": "0", "padding-left": "0",
    "border-top-width": "medium", "border-right-width": "medium", "border-bottom-width": "medium", "border-left-width": "medium",
    "border-top-style": "none", "border-right-style": "none", "border-bottom-style": "none", "border-left-style": "none",
    "border-top-color": "currentcolor", "border-right-color": "currentcolor", "border-bottom-color": "currentcolor", "border-left-color": "currentcolor",
    "border-top-left-radius": "0", "border-top-right-radius": "0", "border-bottom-right-radius": "0", "border-bottom-left-radius": "0",
    "border-image": "none", "box-sizing": "content-box", "overflow-x": "visible", "overflow-y": "visible", "z-index": "auto", opacity: "1",
    visibility: "visible", color: "#000", "background-color": "transparent", "background-image": "none", "background-position": "0% 0%",
    "background-size": "auto", "background-repeat": "repeat", "font-family": "serif", "font-size": "16px", "font-weight": "normal",
    "font-style": "normal", "font-variant": "normal", "line-height": "normal", "text-align": "start", "text-shadow": "none",
    "text-decoration": "none", "text-transform": "none", "text-indent": "0", "letter-spacing": "normal", "white-space": "normal",
    "vertical-align": "baseline", "box-shadow": "none", transform: "none", "transform-origin": "50% 50%", "pointer-events": "auto",
    cursor: "auto", content: "normal", filter: "none", "mix-blend-mode": "normal", "animation-name": "none", "animation-duration": "0s",
    "animation-delay": "0s", "animation-iteration-count": "1", "animation-timing-function": "ease", "animation-fill-mode": "none", "word-wrap": "normal",
    "list-style": "none", "image-rendering": "auto", "text-overflow": "clip", "scrollbar-color": "",
  };
  // The browser's own sheet, as far as these pages notice it.
  addSheet(`html,body,div,p,ul,ol,li,h1,h2,h3,h4,h5,h6,form,table,tr,center,blockquote,section,header,footer,nav,article,aside,main,dl,dt,dd,fieldset,hr,pre,figure,figcaption,details,summary,address{display:block}
    head,script,style,link,meta,title,template,noscript{display:none}
    table{display:table} tr{display:table-row} td,th{display:table-cell} tbody,thead,tfoot{display:table-row-group}
    li{display:list-item} body{margin:8px} p,blockquote,ul,ol,dl,pre,figure{margin-top:1em;margin-bottom:1em}
    h1{font-size:2em;margin-top:0.67em;margin-bottom:0.67em;font-weight:bold} h2{font-size:1.5em;margin-top:0.83em;margin-bottom:0.83em;font-weight:bold}
    h3{font-size:1.17em;margin-top:1em;margin-bottom:1em;font-weight:bold} h4{margin-top:1.33em;margin-bottom:1.33em;font-weight:bold}
    b,strong,th{font-weight:bold} i,em,cite,var{font-style:italic} small{font-size:smaller} big{font-size:larger} sub,sup{font-size:smaller}
    a{color:#00e;text-decoration:underline;cursor:pointer} u,ins{text-decoration:underline} s,strike,del{text-decoration:line-through}
    ul,ol{padding-left:40px} hr{border:1px inset #888;margin-top:0.5em;margin-bottom:0.5em} pre,code,tt,kbd,samp{font-family:monospace}
    pre{white-space:pre} center{text-align:center} td,th{padding:1px} table{border-spacing:2px}
    input,select,textarea,button{display:inline-block;font-size:13.33px;font-family:sans-serif} textarea{white-space:pre-wrap}
    img,canvas,video,iframe{display:inline}`, "");

  // Matching rules for el (or its ::before/::after), as [decl, important, spec, order].
  function matched(el, pe) {
    const out = [];
    const tryList = (l) => { if (!l) return; for (const r of l) { if ((r.sel.pe || null) !== pe) continue; if (matchFrom(el, r.sel.parts, 0)) out.push(r); } };
    if (el.id) tryList(byKey.get("#" + el.id));
    for (const c of classesOf(el)) tryList(byKey.get("." + c));
    tryList(byKey.get(el.tagName));
    tryList(byKey.get("*"));
    return out;
  }
  // Specified -> computed: plain strings per longhand; lengths stay strings (86_layout.js resolves them).
  function computeFor(el, parentCs, pe) {
    const rules = matched(el, pe);
    rules.sort((a, b) => a.sel.spec - b.sel.spec || a.order - b.order);
    const spec = new Map(), imp = new Map();
    for (const r of rules) for (const [k, v, i] of r.decls) { if (i) imp.set(k, v); else spec.set(k, v); }
    if (!pe && el._styleObj) for (const [k, v] of el._styleObj._m) spec.set(k, v);
    for (const [k, v] of imp) spec.set(k, v);
    // Presentational attributes that the pages here use.
    if (!pe) {
      if (el.tagName === "IMG" || el.tagName === "CANVAS") {
        const w = el.getAttribute("width"), h = el.getAttribute("height");
        if (w && !spec.has("width")) spec.set("width", w + "px"); if (h && !spec.has("height")) spec.set("height", h + "px");
      }
      if (el.hidden) spec.set("display", "none");
      if (el.tagName === "FONT") { const c = el.getAttribute("color"); if (c && !spec.has("color")) spec.set("color", c); }
      const al = el.getAttribute("align"); if (al && !spec.has("text-align") && /^(DIV|P|TD|TH|H\d)$/.test(el.tagName)) spec.set("text-align", al);
    }
    const vals = new Array(CS_KEYS.length);
    for (let i = 0; i < CS_KEYS.length; i++) {
      const k = CS_KEYS[i];
      let v = spec.get(k);
      if (v === undefined || v === "inherit") v = (v === "inherit" || INHERITED.has(k)) && parentCs ? parentCs[k] : INITIAL[k];
      else if (v === "initial" || v === "unset") v = v === "unset" && INHERITED.has(k) && parentCs ? parentCs[k] : INITIAL[k];
      vals[i] = v;
    }
    const cs = new CS(vals);
    // Properties outside the computed set (getComputedStyle still reports them).
    for (const [k, v] of spec) if (!(k in INITIAL)) (cs._x || (cs._x = {}))[k] = v;
    // font-size in px, for em lengths (layout resolves the rest).
    const pfs = parentCs ? parentCs._fs : 16;
    cs._fs = fontPx(cs["font-size"], pfs);
    cs["font-size"] = cs._fs + "px";
    if (cs.display !== "none" && cs.float !== "none" && !/^(absolute|fixed)$/.test(cs.position)) cs.display = blockify(cs.display);
    if (/^(absolute|fixed)$/.test(cs.position)) { cs.display = blockify(cs.display); cs.float = "none"; }
    return cs;
  }
  // Computed styles share one shape (all properties assigned in one order by one constructor): V8 keeps them
  // as fast objects with a single hidden class, so cs["overflow-x"] and friends are plain field loads. (Built with
  // Object.create(null) they were dictionaries, and every read in layout and paint a megamorphic lookup.)
  // _fs font size in px, _font the font string (86_layout.js), _d values derived from the style (87_paint.js),
  // _x specified properties outside the set.
  const CS_KEYS = Object.keys(INITIAL);
  const CS = new Function("a", CS_KEYS.map((k, i) => "this[" + JSON.stringify(k) + "] = a[" + i + "];").join(" ") + " this._fs = 16; this._font = null; this._d = null; this._x = null;");
  H.CS_KEYS = CS_KEYS;
  const blockify = (d) => (d === "inline" || d === "inline-block" || d === "table-cell" || d === "table-row" ? "block" : d === "inline-table" ? "table" : d);
  const SIZES = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 };
  function fontPx(v, parent) {
    if (SIZES[v]) return SIZES[v];
    if (v === "smaller") return parent / 1.2; if (v === "larger") return parent * 1.2;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return parent;
    if (v.endsWith("em") && !v.endsWith("rem")) return n * parent;
    if (v.endsWith("rem")) return n * 16;
    if (v.endsWith("%")) return (n / 100) * parent;
    if (v.endsWith("pt")) return n * 4 / 3;
    return n;
  }
  H.fontPx = fontPx;
  // Computed styles for the whole document; el._cs, el._before, el._after.
  // Properties whose change can move or resize boxes; a change to others only needs painting.
  const LAYOUT_PROPS = ["display", "position", "float", "clear", "left", "right", "top", "bottom", "width", "height", "min-width", "min-height",
    "max-width", "max-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom",
    "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-right-style",
    "border-bottom-style", "border-left-style", "box-sizing", "overflow-x", "overflow-y", "font-family", "font-size", "font-weight", "font-style",
    "font-variant", "line-height", "text-align", "text-transform", "text-indent", "letter-spacing", "white-space", "vertical-align", "content", "word-wrap", "word-break"];
  const sameLayout = (a, b) => { if (!a || !b) return false; for (const k of LAYOUT_PROPS) if (a[k] !== b[k]) return false; return true; };
  const pseudoKey = (p) => (p ? LAYOUT_PROPS.map((k) => p[k]).join("|") : "");
  const outOfFlow = (cs) => cs && (cs.position === "absolute" || cs.position === "fixed");
  // Computed styles: the whole document after a full change, else the marked subtrees. Elements whose
  // layout properties changed go to H.layoutRoots (their parent, unless they stay out of flow), the others
  // to H.paintOnly (87_paint.js repaints where they are).
  H.paintOnly = new Set();
  H.recompute = () => {
    syncStyleElements();
    const root = g.document.documentElement;
    const full = H.fullStyle;
    const rec = (el, pcs) => {
      const old = el._cs, oldB = el._before, oldA = el._after;
      el._cs = computeFor(el, pcs, null);
      const cs = el._cs;
      el._sd = el._sdc = false;
      if (cs.display !== "none") {
        el._before = byPe.before ? pseudoStyle(el, "before", cs) : null;
        el._after = byPe.after ? pseudoStyle(el, "after", cs) : null;
        if (H.buildKids) H.buildKids(el);
        for (const c of el.children) if (c.nodeType === 1) rec(c, cs);
      } else { el._before = el._after = null; el._kids = null; for (const c of el.children) if (c.nodeType === 1) clearCs(c); }
      if (!full) {
        if (!sameLayout(old, cs) || pseudoKey(oldB) !== pseudoKey(el._before) || pseudoKey(oldA) !== pseudoKey(el._after) || !old) {
          H.layoutRoots.add(outOfFlow(old) && outOfFlow(cs) ? el : el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : el);
          if (old && el._L) H.paintOnly.add(el); // its old place needs repainting too
        } else H.paintOnly.add(el);
      }
    };
    const clearCs = (el) => { el._cs = null; el._sd = el._sdc = false; for (const c of el.children) if (c.nodeType === 1) clearCs(c); };
    const walk = (el, pcs) => {
      if (el._sd) { rec(el, pcs); return; }
      if (!el._sdc) return;
      el._sdc = false;
      if (!el._cs || el._cs.display === "none") return;
      for (const c of el.children) if (c.nodeType === 1) walk(c, el._cs);
    };
    if (full) {
      byPe.before = H.rules.some((r) => r.sel.pe === "before");
      byPe.after = H.rules.some((r) => r.sel.pe === "after");
      rec(root, null);
      H.fullStyle = false;
      H.fullLayout = true;
    } else {
      walk(root, null);
    }
    H.dirtyStyle = false;
  };
  const byPe = { before: false, after: false };
  function pseudoStyle(el, pe, cs) {
    const pcs = computeFor(el, cs, pe);
    if (pcs.content === "normal" || pcs.content === "none") return null;
    return pcs;
  }
  // getComputedStyle: the computed longhands by camelCase and kebab names.
  g.getComputedStyle = (el, pe) => {
    H.flush && H.flush(false);
    const cs = (pe && el ? (String(pe).includes("before") ? el._before : el._after) : el && el._cs) || INITIAL;
    const o = { getPropertyValue: (k) => cs[unprefix(String(k).toLowerCase())] ?? "" };
    for (const k of CS_KEYS) o[camel(k)] = o[k] = cs[k];
    if (cs._x) for (const k in cs._x) o[camel(k)] = o[k] = cs._x[k];
    if (el && el._layout && cs === el._cs) { o.width = el._layout.cw + "px"; o.height = el._layout.ch + "px"; }
    return o;
  };

  // ---- mutations mark the page dirty ----------------------------------------------------------
  // A child list changed: the new child gets styles, siblings too when rules look at positions (nth-child),
  // and the parent lays out again. A removed box leaves damage where it was (87_paint.js).
  const childrenChanged = (parent, added) => {
    if (!parent || parent.nodeType !== 1) return;
    if (parent.tagName === "STYLE" || (added && hasStyle(added))) H.styleScan = true;
    if (added && added.nodeType === 1) H.restyle(added);
    if (H.structural) for (const c of parent.children) if (c.nodeType === 1) H.restyle(c);
    H.relayout(parent);
  };
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) {
    const base = EP[name];
    if (!base) continue;
    EP[name] = function (c, ...a) { const r = base.call(this, c, ...a); if (c && c._nodeType === 11) { for (const k of this.children) childrenChanged(this, k); } else childrenChanged(this, c); return r; };
  }
  {
    const base = EP.removeChild;
    EP.removeChild = function (c) { if (c && hasStyle(c)) H.styleScan = true; if (H.onRemove && c && c._L) H.onRemove(c); const r = base.call(this, c); childrenChanged(this, null); return r; };
  }
  if (!EP.replaceChild) EP.replaceChild = function (n, old) { this.insertBefore(n, old); this.removeChild(old); return old; };
  if (!EP.append) EP.append = function (...ns) { for (const n of ns) this.appendChild(typeof n === "string" ? g.document.createTextNode(n) : n); };
  if (!EP.prepend) EP.prepend = function (...ns) { const f = this.firstChild; for (const n of ns) this.insertBefore(typeof n === "string" ? g.document.createTextNode(n) : n, f); };
  // Accessors that mark the page dirty when their value changes.
  const watch = (proto, name, onSet) => {
    const key = "_w_" + name;
    Object.defineProperty(proto, name, {
      get() { return this[key] ?? ""; },
      set(v) { v = v == null ? "" : String(v); if (this[key] === v) return; this[key] = v; if (onSet) onSet(this, v); H.restyle(this); },
      configurable: true,
    });
  };
  watch(EP, "className", null);
  watch(EP, "id", (el) => { H.idCache = null; });
  // textContent / innerText: text nodes hold their text; elements replace their children with one text node.
  Object.defineProperty(EP, "textContent", {
    get() {
      if (this.nodeType === 3 || this.nodeType === 8) return this._text ?? "";
      let s = ""; for (const c of this.children) if (c.nodeType !== 8) s += c.textContent; return s;
    },
    set(v) {
      v = v == null ? "" : String(v);
      if (this.nodeType === 3 || this.nodeType === 8) {
        if (this._text !== v) { this._text = v; if (this.nodeType === 3) { if (this.parentNode && this.parentNode.tagName === "STYLE") H.styleScan = true; H.relayout(this.parentNode); } }
        return;
      }
      if (this.children.length === 1 && this.children[0].nodeType === 3) { this.children[0].textContent = v; return; }
      for (const c of this.children.slice()) this.removeChild(c);
      if (v) this.appendChild(g.document.createTextNode(v));
    },
    configurable: true,
  });
  Object.defineProperty(EP, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  // Plain fields the base constructor set on elements made before this layer.
  const adoptFields = (n) => {
    for (const k of ["className", "id", "textContent"]) if (Object.prototype.hasOwnProperty.call(n, k)) { const v = n[k]; delete n[k]; if (v) n[k] = v; }
    for (const c of n.children) adoptFields(c);
  };
  adoptFields(g.document.documentElement);
  adoptStyle(g.document.documentElement);
  // createTextNode sets textContent after nodeType: the setter above sees nodeType 3 only when set first.
  DP.createTextNode = function (text) { const n = new g.HTMLElement("#text"); n._nodeType = 3; n._text = String(text); return n; };
  DP.createComment = function (text) { const n = new g.HTMLElement("#comment"); n._nodeType = 8; n._text = String(text); return n; };
  Object.defineProperty(EP, "nodeType", { get() { return this._nodeType || 1; }, set(v) { this._nodeType = v; }, configurable: true });

  // ---- attributes the page reads through properties ------------------------------------------
  // Inline handlers (onclick="...") become functions with the element as this; style and class attributes
  // are the style object and className.
  const baseSet = EP.setAttribute, baseGet = EP.getAttribute, baseRemove = EP.removeAttribute;
  EP.setAttribute = function (k, v) {
    k = String(k).toLowerCase();
    v = String(v);
    if (k === "style") { this.style.cssText = v; baseSet.call(this, k, v); return; }
    if (k.startsWith("on")) {
      try { this[k] = new Function("event", v); } catch (e) { console.error("powerboat: handler " + k + ": " + e.message); }
    }
    if (k === "width" || k === "height") { if (this.tagName === "CANVAS") { this[k] = Number(v) | 0; } }
    if (k === "src" && (this.tagName === "IMG" || this.tagName === "SCRIPT")) this.src = v;
    if (k === "hidden") this.hidden = true;
    const old = baseGet.call(this, k);
    baseSet.call(this, k, v);
    if (old === v) return;
    if (k === "width" || k === "height" || k === "src") H.relayout(this.parentNode);
    // Attributes matter to styles only when a selector names them.
    if (k === "hidden" || (H.attrNames && H.attrNames.has(k))) H.restyle(this);
  };
  EP.getAttribute = function (k) {
    k = String(k).toLowerCase();
    if (k === "style") return this._styleObj ? this._styleObj.cssText : baseGet.call(this, k);
    return baseGet.call(this, k);
  };
  EP.removeAttribute = function (k) {
    k = String(k).toLowerCase();
    if (k === "style" && this._styleObj) this._styleObj.cssText = "";
    if (k.startsWith("on")) this[k] = null;
    if (baseGet.call(this, k) == null) return;
    baseRemove.call(this, k);
    if (k === "hidden" || (H.attrNames && H.attrNames.has(k))) H.restyle(this);
  };
  // innerHTML: the same markup set again (Cookie Clicker rewrites counters and lists every frame) changes
  // nothing while nothing below the element changed since.
  {
    const d = Object.getOwnPropertyDescriptor(EP, "innerHTML");
    if (d && d.set) Object.defineProperty(EP, "innerHTML", {
      get: d.get,
      set(v) { const s = v == null ? "" : String(v); if (this._htmlSet === s) return; d.set.call(this, s); this._htmlSet = s; },
      configurable: true,
    });
  }

  // getElementById through a cache (the pages here call it hundreds of times a frame).
  H.idCache = null;
  DP.getElementById = function (id) {
    id = String(id);
    if (H.idCache && !H.idDirty) {
      const el = H.idCache.get(id);
      if (el && el.id === id && el.isConnected) return el;
      if (!el && H.idCacheGen === H.mutGen) return null;
    }
    const m = new Map();
    const w = (n) => { for (const c of n.children) { if (c.nodeType === 1) { if (c.id && !m.has(c.id)) m.set(c.id, c); w(c); } } };
    w(this.documentElement);
    H.idCache = m; H.idCacheGen = H.mutGen;
    return m.get(id) || null;
  };
  H.mutGen = 0;
  const baseTouch = touch;
  H.touch = () => { H.mutGen++; baseTouch(); };
  Object.defineProperty(EP, "isConnected", { get() { for (let n = this; n; n = n.parentNode) if (n === g.document.documentElement) return true; return false; }, configurable: true });
  // Mutation marks bump mutGen so getElementById misses are rechecked.
  for (const name of ["appendChild", "removeChild", "insertBefore"]) {
    const base = EP[name];
    EP[name] = function (...a) { H.mutGen++; return base.apply(this, a); };
  }
  g.HTMLElement.prototype.getRootNode = function () { let n = this; while (n.parentNode) n = n.parentNode; return n; };

  // ---- the page's markup ---------------------------------------------------------------------
  // The whole body is parsed before any script runs (scripts run after, in document order, through
  // 40_web.js), so head scripts see the body a browser would have built by window.onload, and inline
  // body scripts see the elements above them. <style> blocks join the stylesheet list.
  const baseBoot = __powerboat.bootHtml;
  __powerboat.bootHtml = (htmlPath) => {
    const html = __powerboat.readText(htmlPath).replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "");
    // Head <style> blocks join the static sheets; body ones become elements.
    for (const m of html.split(/<body\b/i)[0].matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) addSheet(m[1], "");
    const body = /<body([^>]*)>([\s\S]*?)(?:<\/body>|$)/i.exec(html);
    if (body) {
      const attrs = body[1];
      const st = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/i.exec(attrs); if (st) g.document.body.style.cssText = st[1] ?? st[2];
      const cl = /class\s*=\s*["']([^"']*)/i.exec(attrs); if (cl) g.document.body.className = cl[1];
      g.document.body.innerHTML = body[2].replace(/<script\b[\s\S]*?<\/script>/gi, "");
      // Handlers on <body> (onload etc.).
      for (const a of attrs.matchAll(/\b(on\w+)\s*=\s*"([^"]*)"/gi)) g.document.body.setAttribute(a[1], a[2]);
    }
    touch();
    // POWERBOAT_PRELOAD=a.js:b.js (relative to the page's folder): run before the page's own scripts, e.g. a
    // stand-in for an Electron preload bridge.
    for (const p of (ops.op_powerboat_env("POWERBOAT_PRELOAD") || "").split(":").filter(Boolean)) {
      try { __powerboat.loadScript(p); console.log("powerboat: preload " + p); }
      catch (e) { console.error("powerboat: preload " + p + " failed:", e && e.stack ? e.stack : e); }
    }
    return baseBoot(htmlPath);
  };
})();
