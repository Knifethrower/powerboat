// powerboat JS environment, part 8b: the web page DOM that HTML5 games outside RPG Maker need
// (jQuery/Sizzle, element queries, body markup, data: URLs). Construct 2/3 exports (POWERBOAT_CONSTRUCT=1) and
// NW.js apps whose package.json names their page (POWERBOAT_WEBPAGE=1, e.g. ImpactJS games) get it; RPG Maker MV
// keeps the lean DOM of 00_env.js.
"use strict";
(() => {
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_CONSTRUCT") !== "1" && Deno.core.ops.op_powerboat_env("POWERBOAT_WEBPAGE") !== "1") return;
  const g = globalThis;
  // Browser globals NW.js pages read bare (ImpactJS: `name` in its module system).
  if (!("name" in g)) g.name = "";

  // ---- DOM core that jQuery 2.x (every Construct 2 export) and Sizzle expect ---------------------
  // Sizzle adopts a document only if nodeType === 9 and documentElement exists; jQuery(window).width()
  // reads documentElement.clientWidth; jQuery's support tests need fragments, comments, cloneNode.
  const EP = g.HTMLElement.prototype, DP = g.Document.prototype;
  const doc = g.document;
  Object.defineProperty(EP, "nodeType", { get() { return this._nodeType || 1; }, set(v) { this._nodeType = v; }, configurable: true });
  Object.defineProperty(EP, "ownerDocument", { get() { return doc; }, configurable: true });
  Object.defineProperty(DP, "nodeType", { get() { return 9; }, configurable: true });
  Object.defineProperty(DP, "nodeName", { get() { return "#document"; }, configurable: true });
  Object.defineProperty(DP, "ownerDocument", { get() { return null; }, configurable: true });
  Object.defineProperty(EP, "nextSibling", { get() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] || null; }, configurable: true });
  Object.defineProperty(EP, "previousSibling", { get() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return i > 0 ? p.children[i - 1] : null; }, configurable: true });
  Object.defineProperty(EP, "firstElementChild", { get() { return this.children.find((c) => c.nodeType === 1) || null; }, configurable: true });
  Object.defineProperty(EP, "nextElementSibling", { get() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }, configurable: true });
  const walkAll = (root, pred, out) => { for (const c of root.children) { if (pred(c)) out.push(c); walkAll(c, pred, out); } return out; };
  const hasClass = (el, cls) => (" " + (el.className || "") + " ").includes(" " + cls + " ");
  EP.getElementsByTagName = function (t) { const u = String(t).toUpperCase(); return walkAll(this, (c) => u === "*" || c.tagName === u, []); };
  EP.getElementsByClassName = function (cls) { return walkAll(this, (c) => hasClass(c, cls), []); };
  DP.getElementsByClassName = function (cls) { return walkAll(this.documentElement, (c) => hasClass(c, cls), []); };
  DP.getElementsByName = function (n) { return walkAll(this.documentElement, (c) => c.getAttribute && c.getAttribute("name") === n, []); };
  // Simple selectors only (#id, tag, .class, tag.class, [attr]); enough for what exports ask.
  const simpleMatch = (sel) => {
    const m = /^\s*([a-zA-Z0-9*]*)(?:#([\w-]+))?((?:\.[\w-]+)*)\s*$/.exec(sel);
    if (!m) return null;
    const tag = m[1] && m[1] !== "*" ? m[1].toUpperCase() : "", id = m[2] || "", classes = m[3] ? m[3].split(".").filter(Boolean) : [];
    return (el) => el.nodeType === 1 && (!tag || el.tagName === tag) && (!id || el.id === id) && classes.every((c) => hasClass(el, c));
  };
  const qsa = (root, sel) => {
    const out = [];
    for (const part of String(sel).split(",")) {
      const f = simpleMatch(part);
      if (f) walkAll(root, f, out);
    }
    return out;
  };
  EP.querySelectorAll = function (sel) { return qsa(this, sel); };
  EP.querySelector = function (sel) { return qsa(this, sel)[0] || null; };
  DP.querySelectorAll = function (sel) { return qsa(this.documentElement, sel); };
  DP.querySelector = function (sel) { return qsa(this.documentElement, sel)[0] || null; };
  EP.matches = function (sel) { const f = simpleMatch(sel); return !!(f && f(this)); };
  EP.webkitMatchesSelector = EP.matches;
  EP.cloneNode = function (deep) {
    const c = doc.createElement(this.tagName.toLowerCase());
    for (const k of Object.keys(this)) if (k.startsWith("_attr_") || k === "className" || k === "id") c[k] = this[k];
    c.textContent = this.textContent; c._nodeType = this._nodeType;
    if (deep) for (const ch of this.children) c.appendChild(ch.cloneNode(true));
    return c;
  };
  EP.compareDocumentPosition = function (other) {
    if (this === other) return 0;
    if (this.contains(other)) return 20; // CONTAINED_BY | FOLLOWING
    if (other.contains && other.contains(this)) return 10; // CONTAINS | PRECEDING
    return 4; // FOLLOWING (document order not tracked)
  };
  EP.getAttributeNode = function (k) { const v = this.getAttribute(k); return v === null ? null : { value: v, specified: true }; };
  EP.hasChildNodes = function () { return this.children.length > 0; };
  EP.replaceChild = function (n, old) { const i = this.children.indexOf(old); if (i >= 0) { if (n.parentNode) n.parentNode.removeChild(n); this.children[i] = n; n.parentNode = this; old.parentNode = null; } return old; };
  DP.createDocumentFragment = function () { const f = new g.HTMLElement("#document-fragment"); f._nodeType = 11; return f; };
  DP.createComment = function (t) { const c = new g.HTMLElement("#comment"); c._nodeType = 8; c.textContent = String(t); return c; };
  DP.contains = function (n) { return this.documentElement.contains(n); };
  DP.compareDocumentPosition = function (other) { return other === this ? 0 : 20; };
  // getElementsByTagName("html"/"*") includes documentElement itself.
  DP.getElementsByTagName = function (t) {
    const u = String(t).toUpperCase();
    const out = walkAll(this.documentElement, (c) => u === "*" || c.tagName === u, []);
    if (u === "*" || u === "HTML") out.unshift(this.documentElement);
    return out;
  };
  doc.implementation = { createHTMLDocument: () => new g.Document(), hasFeature: () => true };
  // The root element is the viewport for jQuery(window).width()/height() and C2's canvas sizing.
  for (const el of [doc.documentElement, doc.body]) {
    Object.defineProperty(el, "clientWidth", { get: () => g.innerWidth, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => g.innerHeight, configurable: true });
  }
  if (!g.getComputedStyle) g.getComputedStyle = (el) => el.style;
  // <select>/<option> for the List plugin (BOD EFSANESI): the element is never drawn, but the
  // runtime keeps items and selection in it.
  const baseCreateEl = DP.createElement;
  DP.createElement = function (tag) {
    const el = baseCreateEl.call(this, tag);
    const t = String(tag).toLowerCase();
    if (t === "option") {
      el.selected = false;
      Object.defineProperty(el, "text", { get() { return this.textContent; }, set(v) { this.textContent = String(v); }, configurable: true });
      Object.defineProperty(el, "value", { get() { return this.getAttribute("value") ?? this.textContent; }, set(v) { this.setAttribute("value", String(v)); }, configurable: true });
    } else if (t === "select") {
      const opts = () => el.children.filter((c) => c.tagName === "OPTION");
      Object.defineProperty(el, "options", { get: opts, configurable: true });
      Object.defineProperty(el, "length", { get: () => opts().length, configurable: true });
      Object.defineProperty(el, "selectedIndex", {
        get: () => opts().findIndex((o) => o.selected),
        set: (i) => opts().forEach((o, k) => { o.selected = k === i; }),
        configurable: true,
      });
      Object.defineProperty(el, "value", { get: () => { const o = opts().find((x) => x.selected); return o ? o.value : ""; }, configurable: true });
      el.add = (opt, before) => {
        const o = opts();
        const ref = typeof before === "number" ? o[before] : before;
        if (ref) el.insertBefore(opt, ref); else el.appendChild(opt);
        if (!el.multiple && el.selectedIndex < 0) opt.selected = true;
      };
      el.remove = function (i) { if (i === undefined) { if (this.parentNode) this.parentNode.removeChild(this); return; } const o = opts()[i]; if (o) el.removeChild(o); };
      el.item = (i) => opts()[i] || null;
    }
    return el;
  };

  // ---- data: URLs (BOD EFSANESI, Yapori Advance fetch inline SVGs) --------------------------------
  const dataUrlBlob = (u) => {
    const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(u);
    if (!m) return null;
    const type = (m[1] || "text/plain").split(";")[0];
    let bytes;
    if (m[2]) {
      const bin = atob(m[3]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    return new g.Blob([bytes], { type });
  };
  {
    const baseFetch = g.fetch;
    g.fetch = (url, init) => {
      const u = typeof url === "string" ? url : url && url.url ? url.url : String(url);
      if (!u.startsWith("data:")) return baseFetch(url, init);
      const b = dataUrlBlob(u);
      if (!b) return Promise.reject(new TypeError("bad data: URL"));
      const r = { ok: true, status: 200, statusText: "OK", url: u, headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? b.type : null) },
        arrayBuffer: () => b.arrayBuffer(), text: () => b.text(), blob: () => Promise.resolve(b), json: () => b.text().then(JSON.parse) };
      return Promise.resolve(r);
    };
    const sd = Object.getOwnPropertyDescriptor(g.HTMLImageElement.prototype, "src");
    Object.defineProperty(g.HTMLImageElement.prototype, "src", {
      get: sd.get,
      set(v) {
        const s = String(v);
        if (s.startsWith("data:") && (!__powerboat.bootImages || /^data:image\/svg/i.test(s))) { const b = dataUrlBlob(s); if (b) { sd.set.call(this, g.URL.createObjectURL(b)); this._dataSrc = s; return; } }
        sd.set.call(this, v);
      },
      configurable: true,
    });
  }

  // jQuery 3.x offset(): getClientRects (Topzerah, Construct 2).
  if (!EP.getClientRects) EP.getClientRects = function () { return [this.getBoundingClientRect()]; };

  // ---- innerHTML: a small HTML fragment parser ----------------------------------------------------
  // jQuery 1.x builds elements from markup and probes the DOM through innerHTML at load ("  <link/>
  // <table></table><a href='/a'>a</a>...", then firstChild.nodeType); without parsing it stops there.
  // Elements, attributes, text, comments; void tags; script/style/textarea/title keep raw text.
  // No tree fix-ups (implicit tbody, misnesting): a closing tag closes up to its open element.
  {
    const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    const RAW = new Set(["script", "style", "textarea", "title"]);
    const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©" };
    const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
    const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const parse = (html, parent) => {
      const doc = g.document, stack = [parent];
      const top = () => stack[stack.length - 1];
      const re = /<!--([\s\S]*?)-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+|<)/g;
      let m;
      while ((m = re.exec(html))) {
        if (m[1] !== undefined) top().appendChild(doc.createComment(m[1]));
        else if (m[2] !== undefined) {
          const t = m[2].toUpperCase();
          for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === t) { stack.length = i; break; }
        } else if (m[3] !== undefined) {
          const name = m[3].toLowerCase(), el = doc.createElement(name);
          for (const a of m[4].matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
            el.setAttribute(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
          top().appendChild(el);
          if (RAW.has(name)) {
            const end = html.toLowerCase().indexOf("</" + name, re.lastIndex);
            const text = html.slice(re.lastIndex, end < 0 ? html.length : end);
            if (text) { el._rawHTML = text; el.textContent = name === "textarea" || name === "title" ? decode(text) : text; }
            re.lastIndex = end < 0 ? html.length : html.indexOf(">", end) + 1 || html.length;
          } else if (!VOID.has(name) && !m[5]) stack.push(el);
        } else top().appendChild(doc.createTextNode(decode(m[6])));
      }
    };
    const serialize = (n) => {
      if (n.nodeType === 3) return escText(n.textContent);
      if (n.nodeType === 8) return "<!--" + n.textContent + "-->";
      const name = n.tagName.toLowerCase();
      let s = "<" + name;
      for (const k of Object.keys(n)) if (k.startsWith("_attr_")) s += " " + k.slice(6) + "=\"" + escAttr(n[k]) + "\"";
      s += ">";
      if (VOID.has(name)) return s;
      return s + n.innerHTML + "</" + name + ">";
    };
    const EP2 = g.HTMLElement.prototype;
    Object.defineProperty(EP2, "innerHTML", {
      get() {
        if (RAW.has(this.tagName.toLowerCase())) return this._rawHTML ?? this.textContent ?? "";
        return this.children.map(serialize).join("");
      },
      set(v) {
        const s = v == null ? "" : String(v);
        for (const c of this.children.slice()) this.removeChild(c);
        if (RAW.has(this.tagName.toLowerCase())) { this._rawHTML = s; this.textContent = s; return; }
        if (s) parse(s, this);
      },
      configurable: true,
    });
    Object.defineProperty(EP2, "outerHTML", { get() { return serialize(this); }, configurable: true });
    // class/style attributes are the className / style.cssText properties.
    const baseSet = EP2.setAttribute, baseGet = EP2.getAttribute, baseHas = EP2.hasAttribute, baseRemove = EP2.removeAttribute;
    EP2.setAttribute = function (k, v) {
      k = String(k).toLowerCase();
      if (k === "class") this.className = String(v);
      else if (k === "style") this.style.cssText = String(v);
      baseSet.call(this, k, v);
    };
    EP2.getAttribute = function (k) {
      k = String(k).toLowerCase();
      if (k === "class") return this.className ? this.className : baseGet.call(this, k);
      return baseGet.call(this, k);
    };
    EP2.hasAttribute = function (k) { k = String(k).toLowerCase(); return k === "class" ? !!this.className || baseHas.call(this, k) : baseHas.call(this, k); };
    EP2.removeAttribute = function (k) { k = String(k).toLowerCase(); if (k === "class") this.className = ""; baseRemove.call(this, k); };
    // attributes: the attribute list, by index and by name (jQuery reads attributes[name].expando).
    Object.defineProperty(EP2, "attributes", {
      get() {
        const list = [];
        for (const k of Object.keys(this)) if (k.startsWith("_attr_")) list.push({ name: k.slice(6), nodeName: k.slice(6), value: this[k], nodeValue: this[k], specified: true });
        for (const a of list) list[a.name] = a;
        list.getNamedItem = (n) => list[String(n).toLowerCase()] || null;
        list.item = (i) => list[i] || null;
        return list;
      },
      configurable: true,
    });
    Object.defineProperty(EP2, "nodeValue", { get() { return this.nodeType === 3 || this.nodeType === 8 ? this.textContent : null; }, set(v) { this.textContent = String(v); }, configurable: true });
    Object.defineProperty(EP2, "data", { get() { return this.nodeValue; }, set(v) { this.textContent = String(v); }, configurable: true });
    // DOMParser for HTML (ImpactJS's ig.dom.html builds elements through it): a new document whose
    // body holds the parsed markup.
    const XmlParser = g.DOMParser;
    g.DOMParser = class DOMParser {
      parseFromString(text, type) {
        if (/xml/i.test(type)) return new XmlParser().parseFromString(text, type);
        const d = new g.Document();
        const fixD = (n) => { if (Object.prototype.hasOwnProperty.call(n, "innerHTML")) delete n.innerHTML; for (const c of n.children) fixD(c); };
        fixD(d.documentElement);
        const s = String(text);
        const body = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(s);
        d.body.innerHTML = body ? body[1] : s.replace(/<\/?(?:html|head)[^>]*>/gi, "");
        d.contentType = type || "text/html";
        return d;
      }
    };
    // Elements made before this layer (html, head, body) hold innerHTML as their own field.
    const fix = (n) => { if (Object.prototype.hasOwnProperty.call(n, "innerHTML")) delete n.innerHTML; for (const c of n.children) fix(c); };
    fix(g.document.documentElement);
  }

  // ---- 2D pages: the page's 2D canvas on the window ---------------------------------------------
  // The window shows a WebGL context. A page that draws only with Canvas 2D (ImpactJS)
  // gets one of the runtime's own: after each frame its largest 2D canvas in the document is uploaded
  // and drawn as one quad (letterboxed like any game canvas). Pointer events still go to that canvas.
  // NW.js pages only (POWERBOAT_WEBPAGE); Construct always draws with WebGL.
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_WEBPAGE") === "1") {
    const inDocument = (el) => { for (let n = el; n; n = n.parentNode) if (n === g.document.body) return true; return false; };
    const pageCanvas = () => {
      let best = null;
      for (const c of g.document.getElementsByTagName("canvas"))
        if (c._powerboatCanvasId && inDocument(c) && (!best || c.width * c.height > best.width * best.height)) best = c;
      return best;
    };
    let gl = null, screen = null, prog = null, tex = null, buf = null;
    const viaFbo = Deno.core.ops.op_powerboat_env("POWERBOAT_PAGE_FBO") === "1";
    // Where the page is drawn into the window and swapped: "thread" (default) on the runtime's present
    // thread (src/present.rs) once the drawing thread uploads frames, "main" here on the JS thread.
    // POWERBOAT_PAGE_PRESENT=0 (diagnostic): frames are taken from the drawing thread but never drawn or
    // swapped, so the frame report shows what presenting costs the JS thread.
    let where_ = Deno.core.ops.op_powerboat_env("POWERBOAT_PAGE_PRESENT") || "thread";
    const noPresent = where_ === "0";
    let started = false;
    const setup = () => {
      screen = g.document.createElement("canvas");
      gl = screen.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 t; void main() { t = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }"));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "precision mediump float; uniform sampler2D s; varying vec2 t; void main() { gl_FragColor = vec4(texture2D(s, t).rgb, 1.0); }"));
      gl.bindAttribLocation(prog, 0, "p");
      gl.linkProgram(prog);
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // The window may scale it: nearest keeps pixel art crisp.
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    };
    const present = () => {
      // A page that made its own WebGL context presents itself.
      const own = __powerboat.mainCanvas && (typeof __powerboat.mainCanvas === "function" ? __powerboat.mainCanvas() : __powerboat.mainCanvas);
      // (Not a detached one: Phaser's feature check makes a WebGL canvas and drops it.)
      if (!started && own && inDocument(own)) return;
      const c = pageCanvas();
      if (!c || !c.width || !c.height) return;
      started = true;
      if (where_ === "thread") {
        __powerboat.mainCanvas = c; // pointer events target the page's canvas
        // 1 handed over, 0 nothing newer, 2 not decided yet (this frame here), -1 here from now on.
        const r = Deno.core.ops.op_c2d_present_page(c._powerboatCanvasId);
        if (r === 1 || r === 0) return;
        if (r === -1) where_ = "main";
      }
      if (!gl) setup();
      // The presenter's surface is the window (one pass: the quad is drawn letterboxed straight into it,
      // nearest-scaled) instead of a canvas-sized FBO the runtime then blits over (POWERBOAT_PAGE_FBO=1).
      const W = viaFbo ? c.width : g.innerWidth, H = viaFbo ? c.height : g.innerHeight;
      if (screen.width !== W || screen.height !== H) { screen.width = W; screen.height = H; }
      __powerboat.mainCanvas = c; // pointer events target the page's canvas
      if (noPresent) { Deno.core.ops.op_c2d_present_upload(gl.TEXTURE_2D, c._powerboatCanvasId); return; }
      if (viaFbo) gl.viewport(0, 0, W, H);
      else {
        const k = Math.min(W / c.width, H / c.height), dw = Math.round(c.width * k), dh = Math.round(c.height * k);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport((W - dw) >> 1, (H - dh) >> 1, dw, dh);
      }
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Premultiplied as the canvas keeps them: no per-pixel conversion (the shader ignores alpha).
      // With deferred Canvas 2D (POWERBOAT_C2D_DEFER=1) this is the previous frame, drawn meanwhile.
      if (!Deno.core.ops.op_c2d_present_upload(gl.TEXTURE_2D, c._powerboatCanvasId)) return;
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const baseTick = g.__powerboat_tick;
    g.__powerboat_tick = (now) => {
      const r = baseTick(now);
      try { present(); } catch (e) { console.error("powerboat: 2D page present:", e && e.stack ? e.stack : e); }
      return r;
    };
  }

  // ---- per-game patches ---------------------------------------------------------------------------
  // POWERBOAT_PATCHES=a.js:b.js (as for MV in 60_node.js): run after the page's scripts, before its load
  // event (pages that start from onload, like ImpactJS games, have defined everything by then).
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_WEBPAGE") === "1") {
    __powerboat.beforeLoad = () => {
      for (const p of (Deno.core.ops.op_powerboat_env("POWERBOAT_PATCHES") || "").split(":").filter(Boolean)) {
        try { __powerboat.loadScript(p); console.log("powerboat: patch " + p); }
        catch (e) { console.error("powerboat: patch " + p + " failed:", e && e.stack ? e.stack : e); }
      }
    };
  }

  // ---- body markup -------------------------------------------------------------------------------
  // Construct 2 exports declare their canvas in index.html (<div id="c2canvasdiv"><canvas id="c2canvas"
  // width=.. height=..>); C2 looks it up by id. Before the scripts run, the body's <div id=..>, <canvas>
  // and <input> tags become elements, nested as written. Other markup is ignored. (NW.js exports declare
  // hidden file-dialog inputs, c2nwOpenFileDialog etc.; the NodeWebkit plugin sets their onchange at start:
  // Hypnospace Outlaw stopped there.)
  const baseBoot = __powerboat.bootHtml;
  __powerboat.bootHtml = (htmlPath) => {
    const html = __powerboat.readText(htmlPath);
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    if (body) {
      const src = body[1].replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
      const stack = [document.body];
      const attr = (tag, name) => { const m = new RegExp("\\b" + name + "\\s*=\\s*[\"']?([^\"'\\s>]+)", "i").exec(tag); return m ? m[1] : null; };
      for (const m of src.matchAll(/<(\/?)(div|canvas|input)\b([^>]*)>/gi)) {
        const [, close, name, rest] = m;
        if (close) { if (stack.length > 1 && stack[stack.length - 1].tagName === name.toUpperCase()) stack.pop(); continue; }
        const id = attr(rest, "id");
        if (name.toLowerCase() === "div" && !id) { stack.push({ tagName: "DIV", _skip: true, appendChild() {} }); continue; }
        if (name.toLowerCase() === "input" && !id) continue;
        const el = document.createElement(name.toLowerCase());
        if (id) el.id = id;
        const cls = attr(rest, "class"); if (cls) el.className = cls;
        if (name.toLowerCase() === "canvas") {
          const w = attr(rest, "width"), h = attr(rest, "height");
          if (w) el.width = Number(w); if (h) el.height = Number(h);
        }
        if (name.toLowerCase() === "input") {
          const t = attr(rest, "type"); if (t) el.type = t;
          if (/display\s*:\s*none/i.test(rest)) el.style.display = "none";
        }
        let parent = stack[stack.length - 1];
        for (let i = stack.length - 1; parent._skip; i--) parent = stack[i - 1];
        parent.appendChild(el);
        if (name.toLowerCase() === "div") stack.push(el);
      }
    }
    return baseBoot(htmlPath);
  };
})();
