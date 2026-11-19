// powerboat JS environment, part 3: file paths, Image (decoded on the Rust side, referenced by
// id), <script> elements and __powerboat.loadScript (classic scripts in the global scope, as a browser
// runs MV's <script src> tags).
"use strict";
(() => {
  const ops = Deno.core.ops;
  const core = Deno.core;
  const g = globalThis;
  const root = ops.op_powerboat_root().replace(/\\/g, "/").replace(/\/$/, "");
  __powerboat.root = root;

  // A URL or relative path -> a file path under the game folder (MV asks for "img/system/x.png",
  // "js/plugins/Y.js", sometimes with a cache-busting "?..." or a "file://" prefix).
  __powerboat.resolvePath = (url) => {
    let s = String(url);
    if (s.startsWith("file://")) s = s.slice(7);
    const q = s.indexOf("?"); if (q >= 0) s = s.slice(0, q);
    const h = s.indexOf("#"); if (h >= 0) s = s.slice(0, h);
    try { s = decodeURIComponent(s); } catch (_) {}
    if (/^[A-Za-z]:\//.test(s)) return s;
    // "/fonts/x.ttf" is a URL from the site root (the game folder), unless it is already a real
    // path under the game folder or exists on disk as given.
    if (s.startsWith("/")) return s.startsWith(root + "/") || ops.op_powerboat_exists(s) ? s : root + s;
    while (s.startsWith("./")) s = s.slice(2);
    return root + "/" + s;
  };

  // ---- classic script execution --------------------------------------------------------------
  __powerboat.evalScript = (source, name) => {
    const [, error] = core.evalContext(source, "file://" + name.replace(/\\/g, "/"));
    if (error) throw error.thrown;
  };
  __powerboat.loadScript = (url) => {
    const path = __powerboat.resolvePath(url);
    const [text, err] = ops.op_powerboat_read_text(path);
    if (err) throw new Error("powerboat: script " + err);
    __powerboat.evalScript(text, path);
  };
  __powerboat.readText = (url) => {
    const [text, err] = ops.op_powerboat_read_text(__powerboat.resolvePath(url));
    if (err) throw new Error("powerboat: " + err);
    return text;
  };

  class HTMLScriptElement extends HTMLElement {
    constructor() { super("script"); this._src = ""; this.type = ""; this.async = false; this.defer = false; this.text = ""; this._ran = false; }
    get src() { return this._src; }
    set src(v) { this._src = String(v); if (this.parentNode) this._run(); }
    // Browsers run the script when it is inserted into the document; MV appends to body.
    _onConnected() { this._run(); }
    _run() {
      if (this._ran) return;
      if (!this._src) {
        // Inline script (OMORI inserts its decrypted plugins this way): runs at insertion.
        const code = this.text || this.textContent || this.innerHTML;
        if (!code) return;
        this._ran = true;
        const prev = document.currentScript;
        document.currentScript = this;
        try { __powerboat.evalScript(code, __powerboat.root + "/" + (this._url || "inline-script.js")); }
        catch (e) { console.error("powerboat: inline script " + (this._url || "") + " failed:", e && e.stack ? e.stack : e); }
        document.currentScript = prev;
        return;
      }
      this._ran = true;
      // While index.html boots, inserted scripts (MV's plugins) queue up and run in order before
      // window.onload, as in a browser (they delay the load event). Later ones run next tick:
      // their load/error listeners are usually set after appendChild.
      if (__powerboat.bootQueue) { __powerboat.bootQueue.push(this); return; }
      setTimeout(() => this._exec(), 0);
    }
    _exec() {
      // An engine layer may leave a library out (84_rmmz.js: MZ's vorbisdecoder.js); its load event still fires.
      if (__powerboat.skipScript && __powerboat.skipScript(this._src)) { this.dispatchEvent(new Event("load")); return; }
      // Plugins find their own file name through document.currentScript (VE_BasicModule, CXJ_Exit).
      const prev = document.currentScript;
      document.currentScript = this;
      let ok = true;
      try {
        __powerboat.loadScript(this._src);
      } catch (e) {
        ok = false;
        console.error("powerboat: script " + this._src + " failed:", e && e.stack ? e.stack : e);
      }
      document.currentScript = prev;
      this.dispatchEvent(new Event(ok ? "load" : "error"));
    }
  }
  g.HTMLScriptElement = HTMLScriptElement;

  // ---- Image -----------------------------------------------------------------------------------
  const syncImages = ops.op_powerboat_env("POWERBOAT_SYNC_IMAGES") === "1";
  const freeImages = new FinalizationRegistry((imgId) => { ops.op_image_free(imgId); });
  // How MV slices an image, by its folder (crop.rs stores sheets cropped cell by cell; PIXI frames
  // are mapped in 60_node.js). [cols, rows, cell w, cell h]; all 0 = store whole. Folders drawn by
  // tilemaps or TilingSprites are left whole. A game patch may replace __powerboat.cropHint.
  const NO_HINT = [0, 0, 0, 0];
  __powerboat.cropHint = (url) => {
    const m = /(?:^|\/)img\/([^/]+)\/([^/?#]+)$/.exec(String(url).replace(/[?#].*$/, ""));
    if (!m) return NO_HINT;
    const folder = m[1].toLowerCase();
    let name = m[2];
    try { name = decodeURIComponent(name); } catch (e) { /* keep it raw */ }
    switch (folder) {
      case "characters": {
        // "[SF]": one frame for the whole sheet (OMORI); "%(n)": n frames per row (Galv's naming).
        if (name.includes("[SF]")) return [1, 1, 0, 0];
        const big = /^[!$]*\$/.test(name), n = Number((/%\((\d+)\)/.exec(name) || [0, 3])[1]) || 3;
        return big ? [n, 4, 0, 0] : [n * 4, 8, 0, 0];
      }
      case "sv_actors": return [9, 6, 0, 0];
      case "animations": return [0, 0, 192, 192];
      case "faces": return [4, 2, 0, 0];
      case "tilesets": case "parallaxes": case "battlebacks1": case "battlebacks2": case "titles1": case "titles2": return NO_HINT;
      default: return [1, 1, 0, 0];
    }
  };
  class HTMLImageElement extends HTMLElement {
    constructor(w, h) {
      super("img");
      this._src = "";
      this._powerboatImageId = 0;
      this.naturalWidth = 0; this.naturalHeight = 0;
      this.width = w | 0; this.height = h | 0;
      this.complete = true;
      this.crossOrigin = null;
      this.decoding = "auto";
    }
    get src() { return this._src; }
    set src(v) {
      this._src = String(v);
      this._release();
      this.complete = false;
      if (!this._src) return;
      // Decoded on other cores (tokio's blocking pool); load/error fire when done, as in browsers.
      // A later src assignment wins: earlier results are dropped. POWERBOAT_SYNC_IMAGES=1: old path.
      const seq = (this._seq = (this._seq || 0) + 1);
      let p;
      if (this._src.startsWith("blob:")) {
        const bytes = __powerboat.blobBytes ? __powerboat.blobBytes(this._src) : null;
        // A decrypted MV image: the hint comes from the URL MV asked for (60_node.js sets it).
        const h = this._powerboatHintUrl ? __powerboat.cropHint(this._powerboatHintUrl) : NO_HINT;
        p = bytes ? (syncImages ? Promise.resolve(ops.op_image_decode(bytes, h[0], h[1], h[2], h[3])) : ops.op_image_decode_async(bytes, h[0], h[1], h[2], h[3])) : Promise.resolve([0, 0, 0, "revoked or unknown blob URL"]);
      } else if (this._src.startsWith("data:")) {
        const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(this._src);
        const text = m ? (m[1] ? atob(m[2]) : decodeURIComponent(m[2])) : "";
        const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
        // While index.html boots: load fires before DOMContentLoaded (40_web.js), still after this
        // script. Phaser's blend mode check loads two data images and its game boots at that event.
        if (m && __powerboat.bootImages) {
          __powerboat.bootImages.push(() => {
            const r = ops.op_image_decode(bytes, 0, 0, 0, 0);
            if (seq === this._seq) this._loaded(r); else if (r[0]) ops.op_image_free(r[0]);
          });
          return;
        }
        p = m ? (syncImages ? Promise.resolve(ops.op_image_decode(bytes, 0, 0, 0, 0)) : ops.op_image_decode_async(bytes, 0, 0, 0, 0)) : Promise.resolve([0, 0, 0, "bad data URL"]);
      } else {
        const path = __powerboat.resolvePath(this._src);
        const h = __powerboat.cropHint(this._src);
        p = syncImages ? Promise.resolve(ops.op_image_load(path, h[0], h[1], h[2], h[3])) : ops.op_image_load_async(path, h[0], h[1], h[2], h[3]);
      }
      p.then((r) => {
        if (seq !== this._seq) { if (r[0]) ops.op_image_free(r[0]); return; }
        this._loaded(r);
      }, (e) => { if (seq === this._seq) this._loaded([0, 0, 0, String(e && e.message || e)]); });
    }
    _loaded(r) {
      const [imgId, w, h, err] = r;
      this.complete = true;
      if (!imgId) {
        this._error = err;
        console.warn("powerboat: image " + this._src + ": " + err);
        this.dispatchEvent(new Event("error"));
        return;
      }
      this._powerboatImageId = imgId;
      freeImages.register(this, imgId, this);
      const l = ops.op_image_layout(imgId);
      this._powerboatLayout = l.length ? Uint32Array.from(l) : null;
      this.naturalWidth = w; this.naturalHeight = h;
      if (!this.width) this.width = w;
      if (!this.height) this.height = h;
      this.dispatchEvent(new Event("load"));
    }
    // Stored whole again (a use the cropped page cannot serve); the next texture upload is full size.
    _powerboatUncrop() {
      if (!this._powerboatLayout) return;
      this._powerboatLayout = null;
      if (this._powerboatImageId) ops.op_image_uncrop(this._powerboatImageId);
    }
    _release() {
      this._powerboatLayout = null;
      if (this._powerboatImageId) { freeImages.unregister(this); ops.op_image_free(this._powerboatImageId); this._powerboatImageId = 0; }
      this.naturalWidth = 0; this.naturalHeight = 0;
    }
    decode() { return Promise.resolve(); }
  }
  g.HTMLImageElement = HTMLImageElement;
  g.Image = function Image(w, h) { return new HTMLImageElement(w, h); };
  g.Image.prototype = HTMLImageElement.prototype;

  // document.createElement knows the new elements; appendChild tells a script it is connected.
  const Document = g.Document;
  const baseCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag) {
    switch (String(tag).toLowerCase()) {
      case "img": return new HTMLImageElement();
      case "script": return new HTMLScriptElement();
      default: return baseCreate.call(this, tag);
    }
  };
  const baseAppend = HTMLElement.prototype.appendChild;
  HTMLElement.prototype.appendChild = function (c) {
    const r = baseAppend.call(this, c);
    if (typeof c._onConnected === "function") c._onConnected();
    if (c && c._gl && __powerboat.canvasConnected) __powerboat.canvasConnected(c);
    return r;
  };
  const baseInsert = HTMLElement.prototype.insertBefore;
  HTMLElement.prototype.insertBefore = function (c, ref) {
    const r = baseInsert.call(this, c, ref);
    if (typeof c._onConnected === "function") c._onConnected();
    return r;
  };
})();
