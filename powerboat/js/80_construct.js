// powerboat JS environment, part 9: what Construct 2/3 exports need beyond MV.
// Construct 3 runs in DOM mode here (no OffscreenCanvas / navigator.userActivation, so it never
// picks worker mode); its type="module" scripts have no import/export and run as classic scripts.
"use strict";
(() => {
  // Construct exports only (main.rs sets POWERBOAT_CONSTRUCT=1 from index.html); MV games never see this layer.
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_CONSTRUCT") !== "1") return;
  const ops = Deno.core.ops;
  const g = globalThis;
  // supportcheck.js tests "noModule" in HTMLScriptElement.prototype for module support.
  g.HTMLScriptElement.prototype.noModule = false;

  // ---- Render below the window size: CONSTRUCT_RENDER_SCALE=<0..1> -------------------------------
  // Construct sizes its canvas as CSS size x devicePixelRatio, so a ratio below 1 makes it draw fewer
  // pixels while page and mouse coordinates stay those of the window (as a browser's "low quality"
  // fullscreen); the runtime's final blit scales the frame up (POWERBOAT_PRESENT_FILTER=nearest keeps pixel
  // art sharp). Moonstone Island (640x360 pixel art) drew 13.5 full 1280x720 screens a frame on the
  // Smart Pro's PowerVR GE8300 (fill-bound: draws/clears/binds 31 % of the main thread); at 0.5 the
  // same picture costs a quarter of the fill.
  {
    const rs = Number(ops.op_powerboat_env("CONSTRUCT_RENDER_SCALE"));
    if (rs > 0 && rs < 1) {
      g.devicePixelRatio = rs;
      console.log("powerboat: rendering at " + rs + " of the window size (devicePixelRatio " + rs + ")");
      // The canvas's page box is its CSS size (Construct sets style.width/height), not its smaller backing
      // size: the pointer maps through that box (82_forms.js pagePoint); with the backing size clicks landed
      // at half the position.
      const CP = g.HTMLCanvasElement.prototype, baseRect = CP.getBoundingClientRect;
      CP.getBoundingClientRect = function () {
        const r = baseRect.call(this);
        const sw = parseFloat(this.style && this.style.width), sh = parseFloat(this.style && this.style.height);
        if (!(sw > 0 && sh > 0)) return r;
        return { left: r.left, top: r.top, x: r.x, y: r.y, width: sw, height: sh, right: r.left + sw, bottom: r.top + sh };
      };
    }
  }

  // ---- Construct 3 desktop wrapper exports (WebView2, Linux CEF, macOS WKWebView) ---------------
  // They talk to their native host through one JSON message protocol; only the transport differs.
  // Here the runtime is the host: every transport exists, messages are logged with
  // CONSTRUCT_WRAPPER_DEBUG=1, and replies go back through __powerboat.wrapperReply.
  {
    const listeners = new Set();
    const debug = ops.op_powerboat_env("CONSTRUCT_WRAPPER_DEBUG") === "1";
    const deliver = (data) => setTimeout(() => {
      for (const cb of listeners) { try { cb({ data, additionalObjects: [] }); } catch (e) { console.error("wrapper message handler:", e && e.stack || e); } }
    }, 0);
    __powerboat.wrapperReply = (obj) => deliver(obj);
    // C3 waits for this before starting the runtime; it reads only registeredComponentIds (the
    // wrapper's native extensions, e.g. Steam): none here, so such plugins report "unavailable".
    // Other wrapper messages (window title, fullscreen, ...) need no reply.
    __powerboat.wrapperHandle = (m) => {
      if (m && m.type === "wrapper-init") deliver({ type: "wrapper-init-response", registeredComponentIds: [] });
    };
    const onMessage = (msg) => {
      const m = typeof msg === "string" ? (() => { try { return JSON.parse(msg); } catch (_) { return { type: "?", raw: msg }; } })() : msg;
      if (debug) console.log("powerboat: wrapper message " + JSON.stringify(m).slice(0, 300));
      if (__powerboat.wrapperHandle) __powerboat.wrapperHandle(m);
    };
    g.chrome = g.chrome || {};
    g.chrome.webview = {
      postMessage: (m) => onMessage(m),
      addEventListener: (type, cb) => { if (type === "message") listeners.add(cb); },
      removeEventListener: (type, cb) => { listeners.delete(cb); },
      hostObjects: {},
    };
    g.c3_linux_cef_set_message_callback = (cb) => listeners.add((e) => cb(JSON.stringify(e.data)));
    g.c3_linux_cef_sendmessage = (s) => onMessage(s);
    g.webkit = g.webkit || { messageHandlers: { C3Wrapper: { postMessage: (s) => onMessage(s) } } };
  }

  // C3's DOM handlers use parentElement (text input: elem.parentElement.removeChild(elem)).
  Object.defineProperty(g.HTMLElement.prototype, "parentElement", { get() { return this.parentNode || null; }, configurable: true });
  // Storage persistence check at startup (navigator.storage.persisted()).
  if (!g.navigator.storage) {
    g.navigator.storage = { persisted: () => Promise.resolve(true), persist: () => Promise.resolve(true), estimate: () => Promise.resolve({ quota: 1 << 30, usage: 0 }) };
  }

  // Construct 2's Audio plugin calls listener.setVelocity (and PannerNode.setVelocity) every tick;
  // also when there is no audio device and AudioContext is 40_web.js's silent stub.
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const AC = g[name];
    if (typeof AC !== "function" || AC._c3Listener) continue;
    const Wrapped = class extends AC {
      constructor(...a) {
        super(...a);
        const l = this.listener || (this.listener = {});
        for (const m of ["setPosition", "setOrientation", "setVelocity"]) if (typeof l[m] !== "function") l[m] = () => {};
      }
    };
    Wrapped._c3Listener = true;
    g[name] = Wrapped;
  }
  if (g.PannerNode && !g.PannerNode.prototype.setVelocity) g.PannerNode.prototype.setVelocity = () => {};
  // WebM/Opus decodes natively (src/opus.rs), so say so: C3 otherwise sends it to a wasm decoder
  // job that NW.js exports do not ship.
  const AudioEl = (new g.Audio()).constructor;
  const baseCanPlay = AudioEl.prototype.canPlayType;
  AudioEl.prototype.canPlayType = function (type) { return /opus/i.test(type) && /webm/i.test(type) ? "probably" : baseCanPlay.call(this, type); };

  // ---- type="module" scripts --------------------------------------------------------------------
  // Exports seen so far use modules only for side-effect imports (`import "./../xmlDom.js";` at the
  // top of c3main.js). Those load first, once each, as classic scripts; any other import/export
  // syntax is reported (real ES module loading is not wired up).
  const loadedModules = new Set();
  const SIDE_IMPORT = /^\s*import\s*(["'])([^"']+)\1\s*;?/;
  const runModule = (path) => {
    if (loadedModules.has(path)) return;
    loadedModules.add(path);
    let text = __powerboat.readText(path);
    let m;
    while ((m = SIDE_IMPORT.exec(text.replace(/^\s*(\/\/[^\n]*\n\s*)*/, "")))) {
      text = text.replace(/^\s*(\/\/[^\n]*\n\s*)*/, "");
      text = text.slice(m[0].length);
      runModule(new URL(m[2], "file://" + path).href.replace(/^file:\/\//, ""));
    }
    // A module has its own scope (newer C3 exports: c3main.js declares a top-level `C3` like main.js
    // does, and has `export` statements). Nothing imports from a <script type="module">, so exports
    // are dropped and the body runs in a function scope; async if it uses top-level await.
    text = text
      .replace(/(^|[;}\n\r])\s*export\s*\{[^}]*\}\s*;?/g, "$1")
      .replace(/(^|[;}\n\r]\s*)export\s+default\s+/g, "$1void ")
      .replace(/(^|[;}\n\r]\s*)export\s+(?=(?:const|let|var|function|class|async)\b)/g, "$1");
    try {
      __powerboat.evalScript("(function () {" + text + "\n}).call(undefined);", path);
    } catch (e) {
      if (!(e instanceof SyntaxError) || !/await/.test(String(e.message))) throw e;
      __powerboat.evalScript("(async function () {" + text + "\n}).call(undefined).catch((e) => console.error('module " + path.replace(/'/g, "") + ":', e && e.stack || e));", path);
    }
  };
  const baseExec = g.HTMLScriptElement.prototype._exec;
  g.HTMLScriptElement.prototype._exec = function () {
    if (this.type !== "module" || !this._src) return baseExec.call(this);
    const prev = document.currentScript;
    document.currentScript = this;
    let ok = true;
    try { runModule(__powerboat.resolvePath(this._src)); }
    catch (e) { ok = false; console.error("powerboat: module " + this._src + " failed:", e && e.stack ? e.stack : e); }
    document.currentScript = prev;
    this.dispatchEvent(new Event(ok ? "load" : "error"));
  };

  // ---- MessageChannel: C3's DOM side and runtime side talk through one even on one thread ------
  // Same thread, so messages are passed by reference (no structured clone); delivery is a task.
  class MessagePort extends EventTarget {
    constructor() { super(); this._other = null; this._started = false; this._queue = []; this._onmessage = null; this._closed = false; }
    get onmessage() { return this._onmessage; }
    set onmessage(f) { this._onmessage = f; this.start(); }
    postMessage(data) {
      const to = this._other;
      if (!to || this._closed || to._closed) return;
      // Music through Web Audio buffers (C3's own Safari path) instead of a streaming <audio>
      // element, which this runtime does not have: decodeAudioData covers Vorbis, Opus and AAC.
      if (data && data.handler === "create-audio-context" && data.data) data.data.usePlayMusicAsSoundWorkaround = true;
      to._queue.push(data);
      if (to._started) to._flushSoon();
    }
    start() { if (this._started) return; this._started = true; if (this._queue.length) this._flushSoon(); }
    close() { this._closed = true; this._queue.length = 0; }
    _flushSoon() {
      if (this._pending) return;
      this._pending = true;
      setTimeout(() => {
        this._pending = false;
        const q = this._queue.splice(0);
        for (const data of q) {
          const e = new Event("message");
          e.data = data; e.ports = []; e.source = null;
          this.dispatchEvent(e);
        }
      }, 0);
    }
  }
  class MessageChannel {
    constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._other = this.port2; this.port2._other = this.port1; }
  }
  g.MessagePort = MessagePort;
  g.MessageChannel = MessageChannel;

  // ---- Worker on the main thread ---------------------------------------------------------------
  // C3's job scheduler always starts dispatchworker.js + jobworker.js (message routing, small
  // image jobs). Each worker script runs once inside a function whose `self`/`globalThis` is its
  // own scope object; other names (console, setTimeout, navigator...) come from the real global.
  const WORKER_NAMES = ["self", "globalThis", "postMessage", "addEventListener", "removeEventListener", "importScripts", "close", "onmessage"];
  class WorkerScope extends EventTarget {
    constructor(worker, url) { super(); this._worker = worker; this._url = url; this._closed = false; this.name = ""; this.location = { href: url }; }
    set onmessage(f) { this._onmessage = f; }
    get onmessage() { return this._onmessage; }
  }
  const runWorkerSource = (scope, source, name) => {
    const fn = new Function(...WORKER_NAMES, source + "\n//# sourceURL=" + name);
    fn.call(scope, scope, scope, scope.postMessage.bind(scope), scope.addEventListener.bind(scope),
      scope.removeEventListener.bind(scope), scope.importScripts.bind(scope), scope.close.bind(scope), undefined);
  };
  class Worker extends EventTarget {
    constructor(url, opts = {}) {
      super();
      const u = String(url);
      const scope = new WorkerScope(this, u);
      scope.name = opts.name || "";
      this._scope = scope;
      this._onmessage = null;
      this._terminated = false;
      const deliver = (target, data) => setTimeout(() => {
        if (this._terminated) return;
        const e = new Event("message");
        e.data = data; e.ports = [];
        target.dispatchEvent(e);
      }, 0);
      // worker -> page
      scope.postMessage = (data) => deliver(this, data);
      // page -> worker
      this._post = (data) => deliver(scope, data);
      scope.close = () => { this._terminated = true; };
      scope.importScripts = (...urls) => {
        for (const s of urls) runWorkerSource(scope, __powerboat.readText(new URL(String(s), u).href), String(s));
      };
      let source;
      if (u.startsWith("blob:")) {
        const bytes = __powerboat.blobBytes(u);
        source = bytes ? new TextDecoder().decode(bytes) : null;
      } else source = __powerboat.readText(u);
      if (source == null) throw new Error("powerboat: Worker script not found: " + u);
      // Started a task later, as a real worker would be, after the creator set its handlers.
      setTimeout(() => {
        try { runWorkerSource(scope, source, u); }
        catch (err) {
          console.error("powerboat: worker " + u + " failed:", err && err.stack || err);
          const e = new Event("error"); e.message = String(err); this.dispatchEvent(e);
        }
      }, 0);
    }
    get onmessage() { return this._onmessage; }
    set onmessage(f) { this._onmessage = f; }
    postMessage(data) { if (!this._terminated) this._post(data); }
    terminate() { this._terminated = true; }
  }
  g.Worker = Worker;

  g.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 }), 1);
  g.cancelIdleCallback = (id) => clearTimeout(id);

  // ---- createImageBitmap: decoded by image.rs, usable wherever an <img> is (texImage2D, drawImage)
  class ImageBitmap extends g.HTMLImageElement {
    close() { this._release(); this.width = 0; this.height = 0; }
  }
  g.ImageBitmap = ImageBitmap;
  const loadInto = (bmp, src) => new Promise((resolve, reject) => {
    bmp.addEventListener("load", () => { bmp.width = bmp.naturalWidth; bmp.height = bmp.naturalHeight; resolve(bmp); });
    bmp.addEventListener("error", () => reject(new DOMException("createImageBitmap: " + (bmp._error || "decode failed"), "InvalidStateError")));
    bmp.src = src;
  });
  // ImageData, canvases, crops and resizes go through a 2D canvas (also an image source for GL).
  const viaCanvas = (src, sw, sh, sx, sy, cw, ch, opts) => {
    const w = (opts && opts.resizeWidth) || (opts && opts.resizeHeight ? Math.round(cw * opts.resizeHeight / ch) : cw);
    const h = (opts && opts.resizeHeight) || (opts && opts.resizeWidth ? Math.round(ch * opts.resizeWidth / cw) : ch);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (src instanceof g.ImageData) {
      if (w === sw && h === sh && !sx && !sy) ctx.putImageData(src, 0, 0);
      else {
        const t = document.createElement("canvas");
        t.width = sw; t.height = sh;
        t.getContext("2d").putImageData(src, 0, 0);
        ctx.drawImage(t, sx, sy, cw, ch, 0, 0, w, h);
      }
    } else ctx.drawImage(src, sx, sy, cw, ch, 0, 0, w, h);
    c.close = () => { c.width = 0; c.height = 0; };
    return c;
  };
  // premultiplyAlpha: "premultiply" (and "default", as Chrome decodes) means the bitmap's pixels
  // are premultiplied: C3 then uploads with UNPACK_PREMULTIPLY_ALPHA_WEBGL false. The pixels here are
  // straight, so the bitmap carries _c3Premultiply and the texture upload premultiplies them (below).
  // Without it transparent pixels that keep a color drew as solid blocks (Janosik's HUD digits).
  const createBitmap = (source, ...rest) => {
    const opts = rest.length === 1 || rest.length === 5 ? rest[rest.length - 1] : null;
    const crop = rest.length >= 4 ? rest.slice(0, 4).map(Number) : null;
    const resize = !!(opts && (opts.resizeWidth || opts.resizeHeight));
    try {
      if (source instanceof g.Blob) {
        const bmp = new ImageBitmap();
        const url = g.URL.createObjectURL(source);
        const p = loadInto(bmp, url).finally(() => g.URL.revokeObjectURL(url));
        if (!crop && !resize) return p;
        return p.then((b) => {
          const r = crop || [0, 0, b.width, b.height];
          const c = viaCanvas(b, b.width, b.height, r[0], r[1], r[2], r[3], opts);
          b.close();
          return c;
        });
      }
      if (source instanceof g.HTMLImageElement && !crop && !resize) return loadInto(new ImageBitmap(), source.src);
      // A video frame (C3's Video plugin, BOD EFSANESI's intro): a texture source that uploads the
      // video's current frame (10_webgl.js handles _powerboatVideoId); not a frozen copy, which C3 does
      // not rely on, since it asks for a new bitmap every frame.
      if (source && source._powerboatVideoId !== undefined && !crop && !resize) {
        // An ImageBitmap by prototype: C3's texture update checks instanceof (post-bitmaps mode).
        return Promise.resolve(Object.assign(Object.create(ImageBitmap.prototype), { _powerboatVideoId: source._powerboatVideoId, width: source.videoWidth || source.width, height: source.videoHeight || source.height, close() {} }));
      }
      const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
      const r = crop || [0, 0, sw, sh];
      return Promise.resolve(viaCanvas(source, sw, sh, r[0], r[1], r[2], r[3], opts));
    } catch (e) { return Promise.reject(e); }
  };
  g.createImageBitmap = (source, ...rest) => {
    const opts = rest.length === 1 || rest.length === 5 ? rest[rest.length - 1] : null;
    const premultiply = !opts || opts.premultiplyAlpha !== "none";
    return createBitmap(source, ...rest).then((b) => { b._c3Premultiply = premultiply; return b; });
  };
  if (typeof g.DOMException !== "function") {
    g.DOMException = class DOMException extends Error {
      constructor(message = "", name = "Error") { super(message); this.name = name; }
    };
  }

  // ---- GLSL: non-constant global initializers --------------------------------------------------
  // GLSL ES 1.00 wants constant global initializers; ANGLE (Chrome, NW.js) accepts others by moving
  // them into main(), and Construct 2 effects rely on it (e.g. `vec2 resolution = vec2(pixelWidth, ..)`).
  // Mesa rejects them. Same rewrite here: `T name = expr;` at file scope becomes `T name;` plus
  // `name = expr;` first thing in main().
  const GLOBAL_INIT = /^((?:(?:highp|mediump|lowp)\s+)?(?:float|int|bool|[ib]?vec[234]|mat[234])\s+)(\w+)\s*=\s*([\s\S]+)$/;
  const deferGlobalInits = (src) => {
    if (!/\bvoid\s+main\s*\(/.test(src)) return src;
    const text = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
    let depth = 0, start = 0, out = "", moved = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "#" && depth === 0 && /(^|\n)\s*$/.test(text.slice(start, i))) {
        // preprocessor line: copy as is
        const end = text.indexOf("\n", i);
        const e = end < 0 ? text.length : end + 1;
        out += text.slice(start, e); start = e; i = e - 1;
        continue;
      }
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") { depth--; if (depth === 0 && ch === "}") { out += text.slice(start, i + 1); start = i + 1; } }
      else if (ch === ";" && depth === 0) {
        const stmt = text.slice(start, i);
        const lead = /^\s*/.exec(stmt)[0];
        const m = GLOBAL_INIT.exec(stmt.trim());
        if (m && !/^\s*(const|uniform|varying|attribute)\b/.test(stmt) && !/,/.test(m[3].replace(/\([^()]*\)/g, ""))) {
          out += lead + m[1] + m[2] + ";";
          moved.push(m[2] + " = " + m[3].trim() + ";");
        } else out += stmt + ";";
        start = i + 1;
      }
    }
    out += text.slice(start);
    if (!moved.length) return src;
    return out.replace(/\bvoid\s+main\s*\(\s*(void)?\s*\)\s*\{/, (h) => h + "\n" + moved.join("\n"));
  };
  __powerboat.deferGlobalInits = deferGlobalInits;
  const baseCreateGL = __powerboat.createWebGLContext;
  __powerboat.createWebGLContext = (canvas, attrs) => {
    const ctx = baseCreateGL(canvas, attrs);
    const proto = Object.getPrototypeOf(ctx);
    if (!proto._c3GlobalInits) {
      proto._c3GlobalInits = true;
      const ss = proto.shaderSource;
      proto.shaderSource = function (s, src) { return ss.call(this, s, deferGlobalInits(String(src))); };
      // Uploads of a bitmap made with premultiplyAlpha "premultiply" (createImageBitmap above).
      const UNPACK_PREMULTIPLY = 0x9241;
      const withPremultiply = (base, srcIndex) => function (...args) {
        const src = args.length > srcIndex ? args[srcIndex] : null;
        if (!src || !src._c3Premultiply || this["_ps" + UNPACK_PREMULTIPLY]) return base.apply(this, args);
        this.pixelStorei(UNPACK_PREMULTIPLY, true);
        try { return base.apply(this, args); } finally { this.pixelStorei(UNPACK_PREMULTIPLY, false); }
      };
      // Deleted image textures are kept for a few seconds and reused when the same image is
      // uploaded again. C2 deletes and re-creates a layout's textures when it restarts (Penelope's
      // race: ~126 re-uploads at once, every ~20 s); images decode lazily and drop their pixels after
      // upload (src/image.rs), so each re-upload meant decoding the PNG again on the main thread:
      // ~770 ms, a drop to ~16 fps. The pooled textures were alive a moment before, so peak memory
      // stays the same. CONSTRUCT_TEXTURE_POOL=0 turns it off.
      if (ops.op_powerboat_env("CONSTRUCT_TEXTURE_POOL") !== "0") {
        // Up to 10 s (Penelope's wreck screen stays up > 3 s) and 64 MB, oldest out first: an uncapped
        // 10 s pool held the intro's story art while the next scene loaded, and the RG Cube XX ran out
        // of memory (killed). Bytes = w x h x 4, + 1/3 for mipmaps.
        const TEXTURE_2D = 0x0de1, FLIP_Y = 0x9240, PREMUL = 0x9241, KEEP_MS = 10000;
        // Cap: a quarter of the memory available at startup, 32-256 MB (64 MB held too little of
        // Penelope's race to help: it is unloaded for the wreck screen and loaded again after).
        const availMB = (() => {
          try { const m = /MemAvailable:\s+(\d+)/.exec(__powerboat.readText("/proc/meminfo")); return m ? Number(m[1]) / 1024 : 0; }
          catch (_) { return 0; }
        })();
        const poolMB = Number(ops.op_powerboat_env("CONSTRUCT_TEXTURE_POOL_MB")) || Math.min(256, Math.max(32, Math.round(availMB / 4) || 64));
        const KEEP_BYTES = poolMB * 1048576;
        console.log("powerboat: texture pool up to " + poolMB + " MB, " + KEEP_MS / 1000 + " s");
        const pool = new Map(); // key -> { id, at, bytes }, in insertion (= age) order
        let pooled = 0;
        const drop = (k, e) => { ops.op_gl_delete_texture(e.id); pool.delete(k); pooled -= e.bytes; };
        const expire = (now) => {
          for (const [k, e] of pool) if (now - e.at > KEEP_MS) drop(k, e);
          for (const [k, e] of pool) { if (pooled <= KEEP_BYTES) break; drop(k, e); }
        };
        setInterval(() => expire(performance.now()), 1000);
        const boundTex = (ctx) => { const u = ctx._textures[ctx._activeUnit]; return u ? u["2d"] : null; };
        const baseTexImage = proto.texImage2D, baseDelete = proto.deleteTexture;
        proto.texImage2D = function (target, level, internalformat, format, type, src, ...rest) {
          if (arguments.length !== 6 || target !== TEXTURE_2D || level !== 0 || !src || !src._powerboatImageId) {
            // Other contents: no longer the tagged image.
            if (target === TEXTURE_2D && level === 0) { const b = boundTex(this); if (b) b._c3PoolKey = null; }
            return baseTexImage.apply(this, arguments);
          }
          const t = boundTex(this);
          const key = src._powerboatImageId + "|" + internalformat + "|" + format + "|" + type + "|" + !!this["_ps" + PREMUL] + "|" + !!this["_ps" + FLIP_Y] + "|" + !!src._c3Premultiply;
          const hit = t && pool.get(key);
          if (hit) {
            pool.delete(key);
            pooled -= hit.bytes;
            ops.op_gl_delete_texture(t._id);
            t._id = hit.id;
            ops.op_gl_bind_texture(TEXTURE_2D, hit.id);
            t._c3PoolKey = key;
            t._c3PoolBytes = hit.bytes;
            return;
          }
          const r = baseTexImage.apply(this, arguments);
          if (t) { t._c3PoolKey = key; t._c3PoolBytes = Math.ceil((src.naturalWidth || src.width || 0) * (src.naturalHeight || src.height || 0) * 4 * 4 / 3); }
          return r;
        };
        for (const name of ["texSubImage2D", "copyTexImage2D", "copyTexSubImage2D"]) {
          const base = proto[name];
          if (typeof base !== "function") continue;
          proto[name] = function (target, ...rest) {
            if (target === TEXTURE_2D) { const b = boundTex(this); if (b) b._c3PoolKey = null; }
            return base.call(this, target, ...rest);
          };
        }
        proto.deleteTexture = function (t) {
          if (!t || t._deleted || !t._c3PoolKey) return baseDelete.call(this, t);
          const old = pool.get(t._c3PoolKey);
          if (old) drop(t._c3PoolKey, old);
          const bytes = t._c3PoolBytes || 0;
          pool.set(t._c3PoolKey, { id: t._id, at: performance.now(), bytes });
          pooled += bytes;
          expire(performance.now());
          t._deleted = true;
          for (const u of this._textures) if (u) { if (u["2d"] === t) u["2d"] = null; if (u.cube === t) u.cube = null; }
        };
      }
      const ti6 = withPremultiply(proto.texImage2D, 5), ti9 = withPremultiply(proto.texImage2D, 8);
      const tsi7 = withPremultiply(proto.texSubImage2D, 6), tsi9 = withPremultiply(proto.texSubImage2D, 8);
      proto.texImage2D = function (...args) { return (args.length === 6 ? ti6 : ti9).apply(this, args); };
      proto.texSubImage2D = function (...args) { return (args.length === 7 ? tsi7 : tsi9).apply(this, args); };
    }
    return ctx;
  };

  // ---- Construct 2: render at least at the project size ------------------------------------------
  // On a window smaller than the project (handhelds: 720x405 for a 1280x720 game) C2 draws at the
  // window size, and mipmapped, densely packed sheets then bleed into each other (thin bars beside
  // SpriteFont letters in The Next Penelope). C2 is told the viewport is just big enough for the
  // letterboxed game to reach the project size (window shape kept), so it renders at that size, and the
  // runtime's final blit scales the frame to the screen, as a browser stretches its canvas.
  // Opt-in (CONSTRUCT_RENDER_UP=1): on the RG Cube XX it cost Penelope's race ~20 % (31-46 -> 24-29 fps);
  // the SpriteFont inset below fixes the bars without it.
  if (ops.op_powerboat_env("CONSTRUCT_RENDER_UP") === "1") {
    const baseLoad = __powerboat.loadScript;
    let done = false;
    __powerboat.loadScript = (url) => {
      baseLoad(url);
      const R = g.cr && g.cr.runtime;
      if (done || typeof R !== "function" || typeof R.prototype.load !== "function") return;
      done = true;
      // The project size is known once Runtime.load has read the model (the constructor calls
      // setSize right after it). The model itself is left alone: C2 changes it while loading.
      let pw = 0, ph = 0;
      const baseRtLoad = R.prototype.load;
      R.prototype.load = function (...a) {
        const r = baseRtLoad.apply(this, a);
        pw = Number(this.original_width) || 0; ph = Number(this.original_height) || 0;
        console.log("powerboat: C2 project " + pw + "x" + ph + ", window " + winW() + "x" + winH() + ", viewport x" + scale().toFixed(3));
        return r;
      };
      const winW = Object.getOwnPropertyDescriptor(g, "innerWidth").get, winH = Object.getOwnPropertyDescriptor(g, "innerHeight").get;
      // By the letterboxed fit: a 720x720 screen shows a 1280x720 game at 720x405.
      const scale = () => { const fit = pw && ph ? Math.min(winW() / pw, winH() / ph) : 1; return fit >= 1 ? 1 : 1 / fit; };
      Object.defineProperty(g, "innerWidth", { get: () => Math.round(winW() * scale()), configurable: true });
      Object.defineProperty(g, "innerHeight", { get: () => Math.round(winH() * scale()), configurable: true });
    };
  }

  // ---- Construct 2 SpriteFont: no mipmaps on glyph sheets ---------------------------------------
  // Glyph sheets have no padding between cells. With mipmaps on (projects with "medium"/"high"
  // downscaling quality) the smaller mip levels mix neighboring glyphs, and text drawn smaller than
  // the sheet (window below the project size) gets thin bars beside letters (The Next Penelope at
  // 720x405). C2's own loadTexture has a nomip flag; SpriteFont2 never sets it. Other sprites keep
  // their mipmaps. CONSTRUCT_SPRITEFONT_MIPS=1 keeps them for glyph sheets too.
  if (ops.op_powerboat_env("CONSTRUCT_SPRITEFONT_MIPS") !== "1") {
    const baseLoad2 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad2(url);
      const SF = !patched && g.cr && g.cr.plugins_ && g.cr.plugins_.Spritefont2;
      const TP = SF && SF.prototype && SF.prototype.Type && SF.prototype.Type.prototype;
      const GW = g.cr && g.cr.GLWrap && g.cr.GLWrap.prototype;
      if (!TP || typeof TP.onCreate !== "function" || !GW || typeof GW.loadTexture !== "function") return;
      patched = true;
      const sheets = new WeakSet();
      const baseCreate = TP.onCreate;
      TP.onCreate = function (...a) {
        const r = baseCreate.apply(this, a);
        if (this.texture_img) sheets.add(this.texture_img);
        return r;
      };
      const baseTex = GW.loadTexture;
      GW.loadTexture = function (img, tiling, linear, format, tiletype, nomip) {
        return baseTex.call(this, img, tiling, linear, format, tiletype, nomip || sheets.has(img));
      };
    };
  }


  // ---- Construct 2 array truncation without the length setter -------------------------------------
  // C2 empties its selection lists through cr.truncateArray(arr, n) = `arr.length = n` (cr.clearArray: n = 0,
  // 130 call sites). V8 has no inline path for that store: each one is a C++ accessor call, even on an empty
  // array (Hypnospace Outlaw's desktop on the RG Cube XX: ~4 % of the JS thread in ArrayLengthSetter /
  // JSArray::SetLength). Nothing to drop returns at once, a short tail is popped (an inlined builtin), a long
  // one still takes the setter. CONSTRUCT_FAST_TRUNCATE=0 keeps C2's own.
  if (ops.op_powerboat_env("CONSTRUCT_FAST_TRUNCATE") !== "0") {
    const baseLoad3 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad3(url);
      if (patched || !g.cr || typeof g.cr.truncateArray !== "function" || typeof g.cr.clearArray !== "function") return;
      patched = true;
      g.cr.truncateArray = function (arr, index) {
        let n = arr.length - index;
        if (n === 0) return;
        if (n < 0 || n > 32 || !Array.isArray(arr)) { arr.length = index; return; }
        while (n-- > 0) arr.pop();
      };
    };
    // Construct 3 has the same helper: C3.truncateArray(arr, n) = `arr.length = n` (C3.clearArray calls it for
    // non-empty arrays, arrayRemoveAllInSet even when nothing was removed). Janosik's tutorial on the RG Cube XX:
    // ~1.9 % of the JS thread in ArrayLengthSetter / JSArray::SetLength, from the collision conditions
    // (TestTilemapOverlap, DoOverlapCondition2, OnCollision2) and event picking (_RunObject_NextFilter).
    // C3's helpers live on self.C3 and are read at call time, so they are replaced once the script that
    // defines them has run.
    let c3patched = false;
    const exec3 = g.HTMLScriptElement.prototype._exec;
    g.HTMLScriptElement.prototype._exec = function () {
      const r = exec3.call(this);
      const C3 = g.C3;
      if (!c3patched && C3 && typeof C3.truncateArray === "function" && typeof C3.clearArray === "function") {
        c3patched = true;
        C3.truncateArray = function (arr, index) {
          let n = arr.length - index;
          if (n === 0) return;
          if (n < 0 || n > 32 || !Array.isArray(arr)) { arr.length = index; return; }
          while (n-- > 0) arr.pop();
        };
      }
      return r;
    };
  }

  // ---- Construct 2 "Move to object" that is already there ---------------------------------------------
  // Layer.moveInstanceAdjacent (actions ZMoveToObject, "place above/below") always takes the instance out of the
  // layer's list, puts it back and marks the z indices stale from there, even when it already sits right next to
  // the other one on that side: then the next get_zindex() renumbers the rest of the layer. Event sheets that keep
  // UI pieces above their window every tick (Hypnospace Outlaw's desktop: ZMoveToObject 1.7 % of the JS thread)
  // pay that each time. Already in place = the same list, so nothing is done. CONSTRUCT_ZMOVE_SKIP=0 keeps C2's
  // own; =count also prints how many calls were skipped.
  const ZSKIP = ops.op_powerboat_env("CONSTRUCT_ZMOVE_SKIP") || "1";
  if (ZSKIP !== "0") {
    const baseLoad5 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad5(url);
      const LP = g.cr && typeof g.cr.layer === "function" && g.cr.layer.prototype;
      if (patched || !LP || typeof LP.moveInstanceAdjacent !== "function" || typeof LP.updateZIndices !== "function") return;
      patched = true;
      const base = LP.moveInstanceAdjacent;
      let skipped = 0, moved = 0;
      LP.moveInstanceAdjacent = function (inst, other, isafter) {
        const myZ = inst.get_zindex(), otherZ = other.get_zindex();
        // The original removes myZ and inserts at otherZ (- 1 if myZ was before it) (+ 1 after): back at myZ.
        if (this.instances[myZ] === inst && (isafter ? myZ === otherZ + 1 : myZ === otherZ - 1)) {
          if (ZSKIP === "count" && ++skipped % 5000 === 0) console.log(`powerboat: zmove skipped ${skipped}, moved ${moved}`);
          return;
        }
        moved++;
        return base.call(this, inst, other, isafter);
      };
      console.log("powerboat: C2 already-placed z moves skipped");
    };
  }

  // ---- Construct 2 behavior passes from flat lists -------------------------------------------------
  // Runtime.logic walks every object type, its instances and their behavior instances three times a frame:
  // tick() on all of them, then posttick() and tick2() where a behavior has one. Hypnospace Outlaw's desktop
  // (RG Cube XX): 1,811 instances with 2,023 behaviors in 422 types, 1,711 of them Pin (tick empty, tick2 the
  // work); the three walks were ~56 % of logic()'s own time. Here each pass runs a flat list in C2's order
  // (type index, instance, behavior) holding only the behaviors with that hook (tick: a non-empty one). The
  // lists are rebuilt when instance lists may have changed: C2 changes type.instances only in ClearDeathRow
  // (creations and destructions wait for it, and none run during the passes: isInOnDestroy > 0), at startup,
  // on a layout change and on loading a save. logic() is patched by rewriting its source; a C2 build whose
  // logic() has not exactly the three loops is left alone. CONSTRUCT_FLAT_BEHAVIORS=0 keeps C2's own;
  // =check runs C2's own and compares its order with the lists every pass (prints the first mismatches).
  const FLAT = ops.op_powerboat_env("CONSTRUCT_FLAT_BEHAVIORS") || "1";
  if (FLAT !== "0") {
    const baseLoad4 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad4(url);
      const R = g.cr && g.cr.runtime, RP = R && R.prototype;
      if (patched || typeof R !== "function" || typeof RP.logic !== "function" || typeof RP.ClearDeathRow !== "function") return;
      patched = true;
      const src = RP.logic.toString();
      // Each pass: for (i ... types_by_index) { ... for (j ... instances) { ... for (k ... behavior_insts) { ... } } }
      const LOOP = /for\s*\(\s*i\s*=\s*0\s*,\s*leni\s*=\s*this\.types_by_index\.length;[\s\S]*?\}\s*\}\s*\}/g;
      const loops = src.match(LOOP) || [];
      const hook = (s) => (/\.tick2\s*\(/.test(s) ? 2 : /\.posttick\s*\(/.test(s) ? 1 : /\.tick\s*\(\s*\)/.test(s) ? 0 : -1);
      const kinds = loops.map(hook);
      if (loops.length !== 3 || kinds.join() !== "0,1,2" || !loops.every((s) => /behavior_insts/.test(s))) {
        console.log("powerboat: C2 logic() not as expected (" + loops.length + " loops): flat behavior lists off");
        return;
      }
      let n = 0;
      const fresh = src.replace(LOOP, () => "this.__flatRun(" + n++ + ");");
      let logic;
      try { logic = (0, eval)("(" + fresh + ")"); } catch (e) { console.log("powerboat: flat behavior lists off (" + e + ")"); return; }
      let stale = true;
      const lists = [[], [], []];
      const empty = new Map(); // function -> its body is empty
      const isEmpty = (f) => {
        if (typeof f !== "function") return false; // C2's own loop would throw on it too: keep it
        let e = empty.get(f);
        if (e === undefined) { e = /^function\s*\([^)]*\)\s*\{\s*\}$/.test(Function.prototype.toString.call(f)); empty.set(f, e); }
        return e;
      };
      // C2's walk, as logic() does it; keep = which behavior instances that pass calls.
      const walk = (rt, keep, out) => {
        const types = rt.types_by_index;
        for (let i = 0; i < types.length; i++) {
          const type = types[i];
          if (type.is_family || (!type.behaviors.length && !type.families.length)) continue;
          const insts = type.instances;
          for (let j = 0; j < insts.length; j++) {
            const b = insts[j].behavior_insts;
            for (let k = 0; k < b.length; k++) if (keep(b[k])) out.push(b[k]);
          }
        }
        return out;
      };
      const KEEP = [(b) => !isEmpty(b.tick), (b) => !!b.posttick, (b) => !!b.tick2];
      const build = (rt) => {
        for (let p = 0; p < 3; p++) { lists[p] = []; }
        const types = rt.types_by_index;
        const t0 = lists[0], t1 = lists[1], t2 = lists[2];
        for (let i = 0; i < types.length; i++) {
          const type = types[i];
          if (type.is_family || (!type.behaviors.length && !type.families.length)) continue;
          const insts = type.instances;
          for (let j = 0; j < insts.length; j++) {
            const b = insts[j].behavior_insts;
            for (let k = 0; k < b.length; k++) {
              const bi = b[k];
              if (!isEmpty(bi.tick)) t0.push(bi);
              if (bi.posttick) t1.push(bi);
              if (bi.tick2) t2.push(bi);
            }
          }
        }
        stale = false;
      };
      // Pin: tick2 only where something moved. Hypnospace Outlaw's idle desktop runs 1,711 Pin tick2s a tick, 8.7 % of the JS
      // thread on the RG Cube XX, nearly all of it cache misses on data that has not changed. What a Pin tick2 reads: the x, y
      // and angle of its object and of the one it is pinned to (every change of those calls set_bbox_changed, or the bounding
      // box would go stale) and its own fields (set by the Pin action and by loading a save). So it needs to run only when
      // one of those moved, and once more after that, because a mode that does not write the angle settles on its second run.
      // Moves during the pass flag later entries as C2's own order would see them. CONSTRUCT_PIN_DIRTY=0 off; =check runs every
      // tick2 and reports any flagged clean that changed something.
      const PIN = FLAT === "check" ? "0" : (ops.op_powerboat_env("CONSTRUCT_PIN_DIRTY") || "1");
      const PinI = PIN !== "0" && g.cr.behaviors && g.cr.behaviors.Pin && g.cr.behaviors.Pin.prototype.Instance;
      const pinTick2 = PinI && PinI.prototype.tick2;
      const PinActs = PinI && g.cr.behaviors.Pin.prototype.acts;
      const pinUsable = pinTick2 && typeof g.cr.set_bbox_changed === "function" && PinActs && typeof PinActs.Pin === "function"
        && /pinObject/.test(String(pinTick2)) && /set_bbox_changed/.test(String(pinTick2));
      const PIN_CLEAN = 0, PIN_ONCE_MORE = 1, PIN_ALWAYS = 2, PIN_MOVED = 3;
      let pinFlags = null;
      const pinDeps = new Map();  // instance -> entries of the tick2 list to flag when it moves
      const pinEntry = new Map(); // Pin behavior instance -> { i: entry, target: what its dependency was added for }
      const addPinDep = (inst, i) => {
        const d = pinDeps.get(inst);
        if (d === undefined) pinDeps.set(inst, [i]); else d.push(i);
      };
      const buildPins = () => {
        const list = lists[2];
        pinFlags = new Uint8Array(list.length);
        pinDeps.clear();
        pinEntry.clear();
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (b.tick2 !== pinTick2) { pinFlags[i] = PIN_ALWAYS; continue; }
          pinFlags[i] = PIN_MOVED;
          addPinDep(b.inst, i);
          if (b.pinObject) addPinDep(b.pinObject, i);
          pinEntry.set(b, { i, target: b.pinObject });
        }
      };
      if (pinUsable) {
        const baseBbox = g.cr.set_bbox_changed;
        g.cr.set_bbox_changed = function () {
          const d = pinDeps.get(this);
          if (d !== undefined) for (let i = 0; i < d.length; i++) if (pinFlags[d[i]] !== PIN_ALWAYS) pinFlags[d[i]] = PIN_MOVED;
          return baseBbox.call(this);
        };
        const basePin = PinActs.Pin;
        PinActs.Pin = function (obj, mode) {
          const r = basePin.call(this, obj, mode);
          const e = pinEntry.get(this);
          if (e === undefined) stale = true; // not in the list yet: it is rebuilt before the pass
          else {
            pinFlags[e.i] = PIN_MOVED;
            if (e.target !== this.pinObject) {
              e.target = this.pinObject;
              if (this.pinObject) addPinDep(this.pinObject, e.i);
            }
          }
          return r;
        };
      }
      let pinChecks = 0, pinSkipped = 0, pinBad = 0;
      const pinCheckRun = (b) => {
        const t = b.inst, o = [t.x, t.y, t.angle, b.myStartAngle, b.lastKnownAngle];
        b.tick2();
        pinSkipped++;
        if (o[0] !== t.x || o[1] !== t.y || o[2] !== t.angle || o[3] !== b.myStartAngle || o[4] !== b.lastKnownAngle) {
          if (pinBad++ < 20) console.error(`powerboat: Pin flagged clean but changed: ${t.type && t.type.name} uid ${t.uid}, x ${o[0]} -> ${t.x}, y ${o[1]} -> ${t.y}, angle ${o[2]} -> ${t.angle}, start ${o[3]} -> ${b.myStartAngle}, known ${o[4]} -> ${b.lastKnownAngle}`);
        }
      };
      let checked = 0, mismatches = 0;
      const ALL = [(b) => true, (b) => !!b.posttick, (b) => !!b.tick2];
      RP.__flatRun = function (p) {
        if (stale) { build(this); if (pinUsable) buildPins(); }
        if (p === 2 && pinFlags !== null) {
          const list = lists[2], fl = pinFlags;
          for (let i = 0; i < list.length; i++) {
            const f = fl[i];
            if (f === PIN_CLEAN) { if (PIN === "check") pinCheckRun(list[i]); continue; }
            if (f === PIN_MOVED) fl[i] = PIN_ONCE_MORE;
            else if (f === PIN_ONCE_MORE) fl[i] = PIN_CLEAN;
            list[i].tick2();
          }
          if (PIN === "check" && ++pinChecks % 1000 === 0) console.log(`powerboat: Pin check: ${pinChecks} passes, ${(pinSkipped / pinChecks).toFixed(0)} of ${list.length} skipped a pass, ${pinBad} changed`);
          return;
        }
        if (FLAT === "check") {
          // C2's own calls, then the list compared with what C2 would have called (tick: minus empty ones).
          const own = walk(this, ALL[p], []);
          if (p === 0) for (let i = 0; i < own.length; i++) own[i].tick();
          else if (p === 1) for (let i = 0; i < own.length; i++) own[i].posttick();
          else for (let i = 0; i < own.length; i++) own[i].tick2();
          const want = own.filter(KEEP[p]), got = lists[p];
          checked++;
          if (want.length !== got.length || want.some((b, i) => b !== got[i])) {
            if (mismatches++ < 5) console.log(`powerboat: flat check pass ${p}: C2 ${want.length}, list ${got.length} (check ${checked})`);
          }
          if (checked % 3000 === 0) console.log(`powerboat: flat check ${checked} passes, ${mismatches} mismatches, lists ${lists[0].length}/${lists[1].length}/${lists[2].length}`);
          return;
        }
        const list = lists[p];
        if (p === 0) for (let i = 0; i < list.length; i++) list[i].tick();
        else if (p === 1) for (let i = 0; i < list.length; i++) list[i].posttick();
        else for (let i = 0; i < list.length; i++) list[i].tick2();
      };
      // Anything for ClearDeathRow to do? Newer C2 keeps a flag; older builds (The Next Penelope) have none: a
      // createRow array and a deathRow ObjectSet (newer: an object of ObjectSets by type name).
      const pending = (rt) => {
        if (rt.hasPendingInstances !== undefined) return !!rt.hasPendingInstances;
        if (rt.createRow && rt.createRow.length) return true;
        const d = rt.deathRow;
        if (!d) return true;
        if (typeof d.valuesRef === "function") return d.valuesRef().length > 0;
        for (const k in d) if (Object.prototype.hasOwnProperty.call(d, k)) return true;
        return false;
      };
      const baseClear = RP.ClearDeathRow;
      RP.ClearDeathRow = function () {
        if (!stale && pending(this)) stale = true;
        return baseClear.call(this);
      };
      if (RP.__flatRun === undefined) { console.log("powerboat: flat behavior lists off (runtime prototype not writable)"); return; }
      for (const name of ["doChangeLayout", "loadFromJSONString"]) {
        const base = RP[name];
        if (typeof base !== "function") continue;
        RP[name] = function (...a) { stale = true; try { return base.apply(this, a); } finally { stale = true; } };
      }
      RP.logic = logic;
      console.log("powerboat: C2 behavior passes from flat lists" + (FLAT === "check" ? " (check mode)" : "") + (pinUsable ? ", Pin by moves" + (PIN === "check" ? " (check mode)" : "") : ""));
    };
  }

  // ---- Construct 2 event sheet includes: a clean object list only for types that are looked at ----------
  // An include inside a group pushes a clean selected object list on every object type in the project and pops them all after
  // it. Hypnospace Outlaw: 5 such includes a tick over 265 types, 7 % of the JS thread on the RG Cube XX, for the few types its
  // events touch. Those pushes now wait: entering an include only notes it, and a type catches up (pops includes that ended,
  // pushes those that began) the first time anything uses its list. A type nothing looks at needs neither, since the only way to
  // a list is type.getCurrentSol and the push and pop functions replaced here. CONSTRUCT_SOL_LAZY=0 off; =check also keeps the
  // depth a type would have and reports any list read at another depth.
  const SOLLAZY = ops.op_powerboat_env("CONSTRUCT_SOL_LAZY") || "1";
  if (SOLLAZY !== "0") {
    const baseLoad9 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad9(url);
      const cr = g.cr, RP = cr && typeof cr.runtime === "function" && cr.runtime.prototype;
      if (patched || !RP || typeof cr.type_getCurrentSol !== "function" || typeof RP.pushCleanSol !== "function") return;
      patched = true;
      // The stock functions, compared with what is rewritten below (comments and spacing aside); another version keeps its own.
      const norm = (f) => String(f).replace(/\/\/.*/g, "").replace(/[\s;]/g, "");
      if (norm(cr.type_getCurrentSol) !== "function(){returnthis.solstack[this.cur_sol]}"
        || norm(cr.type_popSol) !== "function(){this.cur_sol--}"
        || norm(cr.type_pushCleanSol) !== "function(){this.cur_sol++if(this.cur_sol===this.solstack.length){this.solstack.push(newcr.selection(this))}else{this.solstack[this.cur_sol].select_all=truecr.clearArray(this.solstack[this.cur_sol].else_instances)}}"
        || norm(cr.type_pushCopySol) !== "function(){this.cur_sol++if(this.cur_sol===this.solstack.length)this.solstack.push(newcr.selection(this))varclonesol=this.solstack[this.cur_sol]varprevsol=this.solstack[this.cur_sol-1]if(prevsol.select_all){clonesol.select_all=true}else{clonesol.select_all=falsecr.shallowAssignArray(clonesol.instances,prevsol.instances)}cr.clearArray(clonesol.else_instances)}"
        || !/\.pushCleanSol\(\)/.test(String(RP.pushCleanSol)) || !/\.popSol\(\)/.test(String(RP.popSol))) {
        console.log("powerboat: C2 object lists not as expected: includes push them all");
        return;
      }
      const check = SOLLAZY === "check";
      const active = [];   // ids of the includes being run, outermost first
      let top = 0, nextId = 1; // top: the innermost one's id, 0 outside any
      let reads = 0, wrong = 0;
      // Each object type gets its own four functions over its own stack: they run thousands of times a tick, and object types
      // have too many shapes for V8 (a generic property load for each of type.solstack and type.cur_sol, 3 % of the JS thread).
      const install = (t) => {
        const stack = t.solstack;
        let cur = t.cur_sol, at = 0, own = 0; // at: the include this stack is in step with; own: the type's own pushes (check mode)
        const applied = [];
        const clean = () => {
          cur++;
          if (cur === stack.length) stack.push(new cr.selection(t));
          else { const s = stack[cur]; s.select_all = true; cr.clearArray(s.else_instances); }
        };
        // Its own pushes and pops nest with the includes, so what has ended is on top of the stack.
        const catchUp = () => {
          const depth = active.length;
          let k = 0;
          while (k < applied.length && k < depth && applied[k] === active[k]) k++;
          while (applied.length > k) { applied.pop(); cur--; }
          for (let i = k; i < depth; ++i) { applied.push(active[i]); clean(); }
          at = top;
        };
        t.getCurrentSol = () => {
          if (at !== top) catchUp();
          if (check) {
            if (cur !== own + active.length && wrong++ < 20) console.error(`powerboat: lazy SOL: ${t.name} at depth ${cur}, should be ${own + active.length}`);
            if (++reads % 2000000 === 0) console.log(`powerboat: lazy SOL check: ${reads} reads, ${wrong} at the wrong depth`);
          }
          return stack[cur];
        };
        t.pushCleanSol = () => {
          if (at !== top) catchUp();
          if (check) own++;
          clean();
        };
        t.pushCopySol = () => {
          if (at !== top) catchUp();
          if (check) own++;
          cur++;
          if (cur === stack.length) stack.push(new cr.selection(t));
          const c = stack[cur], p = stack[cur - 1];
          if (p.select_all) c.select_all = true;
          else { c.select_all = false; cr.shallowAssignArray(c.instances, p.instances); }
          cr.clearArray(c.else_instances);
        };
        t.popSol = () => {
          if (at !== top) catchUp();
          if (check) own--;
          cur--;
        };
      };
      cr.type_getCurrentSol = function () { install(this); return this.getCurrentSol(); };
      cr.type_pushCleanSol = function () { install(this); return this.pushCleanSol(); };
      cr.type_pushCopySol = function () { install(this); return this.pushCopySol(); };
      cr.type_popSol = function () { install(this); return this.popSol(); };
      const basePushAll = RP.pushCleanSol, basePopAll = RP.popSol;
      RP.pushCleanSol = function (list) {
        if (list !== this.types_by_index) return basePushAll.call(this, list);
        top = nextId++;
        active.push(top);
      };
      RP.popSol = function (list) {
        if (list !== this.types_by_index) return basePopAll.call(this, list);
        active.pop();
        top = active.length ? active[active.length - 1] : 0;
      };
      console.log("powerboat: C2 include object lists on demand" + (check ? " (check mode)" : ""));
    };
  }

  // ---- Construct 2 render cells for crowded layers -----------------------------------------------------
  // A frame visits every object on a layer, and on a 1 GB handheld's small caches the first touch of each is most of the cost
  // (Hypnospace Outlaw: 1,236 objects on one layer, inst.visible 58 % of Layer.drawInstanceGL), even when they are parked far
  // outside the view. C2 has a cure, render cells, but it is a per-layer project setting the developer rarely turns on. It is
  // now on for layers that start with at least 100 objects: a frame visits only the cells around the view, and that list is kept
  // until something on the layer changes cell or z order. RG Cube XX: 40.9 -> 43.3 fps. CONSTRUCT_RENDER_CELLS=0 off.
  if (ops.op_powerboat_env("CONSTRUCT_RENDER_CELLS") !== "0") {
    const baseLoad8 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad8(url);
      const cr = g.cr;
      if (patched || !cr || typeof cr.layer !== "function" || typeof cr.RenderGrid !== "function") return;
      patched = true;
      if (!/this\.useRenderCells\s*=\s*\w+\[10\]/.test(String(cr.layer))) { console.log("powerboat: C2 layer not as expected: render cells left as the project has them"); return; }
      const Base = cr.layer;
      const Layer = function (layout, m) {
        if (!m[10] && Array.isArray(m[14]) && m[14].length >= 100) {
          m[10] = true;
          console.log(`powerboat: C2 render cells on for layer "${m[0]}" of layout "${layout && layout.name}" (${m[14].length} objects)`);
        }
        return new Base(layout, m);
      };
      Layer.prototype = Base.prototype;
      cr.layer = Layer;
    };
  }

  // ---- Construct 2 sprites with nothing to animate ---------------------------------------------------
  // A sprite whose animation has speed 0 starts off the tick list, but "Set animation frame" puts it on for good, and from then
  // on its tick only moves its animation clock. Hypnospace Outlaw's desktop: 848 of the 884 objects on the list, 5 % of the JS
  // thread on the RG Cube XX. Such a sprite now leaves the list at its next tick, and "Set animation frame" leaves it off when
  // the frame can change at once. Every action that starts an animation puts it back. The one thing that reads the clock's
  // lost time is a later "Set animation speed" (C2 steps the frame at once if a frame's time has gone by), so that catches up.
  // CONSTRUCT_SPRITE_PARK=0 off; =count prints how many left.
  const PARK = ops.op_powerboat_env("CONSTRUCT_SPRITE_PARK") || "1";
  if (PARK !== "0") {
    const baseLoad7 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad7(url);
      const S = g.cr && g.cr.plugins_ && g.cr.plugins_.Sprite;
      if (patched || !S || !S.prototype.Instance || !S.prototype.acts) return;
      patched = true;
      const P = S.prototype.Instance.prototype, A = S.prototype.acts;
      if (typeof P.tick !== "function" || typeof A.SetAnimFrame !== "function" || typeof A.SetAnimSpeed !== "function"
        || !/this\.animTimer\.add\(this\.runtime\.getDt\(this\)\)/.test(String(P.tick))
        || !/this\.animPlaying\s*&&\s*now\s*>=\s*this\.frameStart\s*\+\s*cur_frame_time/.test(String(P.tick))
        || !/this\.changeAnimFrame\s*=\s*\w+/.test(String(A.SetAnimFrame)) || !/doChangeAnimFrame/.test(String(A.SetAnimFrame))
        || !/isTicking/.test(String(A.SetAnimFrame))) { console.log("powerboat: C2 Sprite not as expected: sprites stay on the tick list"); return; }
      const parkedAt = new WeakMap();
      let parks = 0;
      const baseTick = P.tick;
      P.tick = function () {
        if ((!this.animPlaying || this.cur_anim_speed === 0) && this.changeAnimFrame < 0 && this.changeAnimName.length === 0 && this.my_timescale === -1) {
          this.runtime.untickMe(this);
          this.isTicking = false;
          parkedAt.set(this, this.runtime.kahanTime.sum);
          if (PARK === "count" && ++parks % 500 === 0) console.log(`powerboat: ${parks} sprites left the tick list, ${this.runtime.objects_to_tick.count()} on it`);
          return;
        }
        return baseTick.call(this);
      };
      const baseFrame = A.SetAnimFrame;
      A.SetAnimFrame = function (f) {
        // Already on that frame: event sheets that set it every tick (Hypnospace Outlaw: 655 objects a tick).
        if (f === this.cur_frame && this.changeAnimFrame < 0 && !this.inAnimTrigger && (this.isTicking || !this.animPlaying || this.cur_anim_speed === 0)) return;
        if (!this.isTicking && !this.inAnimTrigger && (!this.animPlaying || this.cur_anim_speed === 0)) {
          this.changeAnimFrame = f;
          this.doChangeAnimFrame();
          return;
        }
        return baseFrame.call(this, f);
      };
      const baseSpeed = A.SetAnimSpeed;
      A.SetAnimSpeed = function (s) {
        const t = parkedAt.get(this);
        if (t !== undefined) {
          parkedAt.delete(this);
          this.animTimer.add(this.runtime.kahanTime.sum - t);
        }
        return baseSpeed.call(this, s);
      };
      const baseCreate = P.onCreate;
      if (typeof baseCreate === "function") P.onCreate = function () { parkedAt.delete(this); return baseCreate.call(this); };
      console.log("powerboat: C2 sprites with nothing to animate leave the tick list");
    };
  }

  // ---- Construct 2: conditions that need no interpreter ----------------------------------------------
  // Every condition evaluates its parameters and calls its function through apply(); on a family each object also looks its
  // variable's index up through the selected object list again. Hypnospace Outlaw's desktop on the RG Cube XX:
  // - "Is group active" with a constant name: 256 runs a tick, each going through the string expression and a toLowerCase of
  //   the name, 3.6 % of a tick. The group is looked up once.
  // - "Is boolean instance variable set": 5,064 objects a tick (family of 813, six conditions), 12 % of a tick.
  // Same results as C2's own run_system / run_object. CONSTRUCT_FAST_CONDS=0 off; =check runs C2's own and compares.
  const FASTC = ops.op_powerboat_env("CONSTRUCT_FAST_CONDS") || "1";
  if (FASTC !== "0") {
    const baseLoad6 = __powerboat.loadScript;
    let patched = false;
    __powerboat.loadScript = (url) => {
      baseLoad6(url);
      const cr = g.cr, C = cr && typeof cr.condition === "function" && cr.condition.prototype;
      if (patched || !C || typeof C.postInit !== "function" || typeof C.run_object !== "function" || !cr.system_object) return;
      patched = true;
      const isGroupActive = cr.system_object.prototype.cnds && cr.system_object.prototype.cnds.IsGroupActive;
      const groupOk = typeof isGroupActive === "function" && /groups_by_name\[\w+\.toLowerCase\(\)\]/.test(String(isGroupActive)) && /group_active/.test(String(isGroupActive));
      const BOOLVAR = /^function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+this\.instance_vars\[\1\];?\s*\}$/;
      const boolVarFuncs = new Map();
      const isBoolVar = (f) => {
        let r = boolVarFuncs.get(f);
        if (r === undefined) { r = BOOLVAR.test(Function.prototype.toString.call(f)); boolVarFuncs.set(f, r); }
        return r;
      };
      // C2's own wraps a test of the fast one: both must say the same, and C2's own result is what counts.
      const check = FASTC === "check";
      let runs = 0, bad = 0;
      const basePost = C.postInit;
      C.postInit = function () {
        basePost.call(this);
        if (this.trigger || this.fasttrigger) return;
        // ---- "Is group active" with a constant name
        if (groupOk && this.func === isGroupActive && this.run === C.run_system && this.parameters.length === 1) {
          const e = this.parameters[0].expression;
          if (!e || e.type !== 2 || typeof e.value !== "string") return;
          const rt = this.runtime, name = e.value.toLowerCase(), inverted = !this.inverted;
          let group = null, known = false;
          const fast = () => {
            if (!known) { group = rt.groups_by_name[name] || null; known = true; }
            return (group === null || !group.group_active) !== inverted;
          };
          if (!check) { this.run = fast; return; }
          const own = C.run_system, cond = this;
          this.run = function () {
            const r = own.call(cond), f = fast();
            if (r !== f && bad++ < 20) console.error(`powerboat: fast "is group active" differs for ${name}: C2 ${r}, fast ${f}`);
            if (++runs % 200000 === 0) console.log(`powerboat: fast conditions check: ${runs} runs, ${bad} differ`);
            return r;
          };
          return;
        }
        // ---- "Is boolean instance variable set", not in an OR block, on an object in no container, no behavior
        if (this.run === C.run_object && this.beh_index === -1 && this.parameters.length === 1 && !this.block.orblock
          && !this.type.is_contained && this.parameters[0].type === 10 && isBoolVar(this.func)) {
          const type = this.type, index = this.parameters[0].index, family = !!type.is_family, fi = type.family_index;
          const inverted = !this.inverted;
          const clear = cr.clearArray;
          const fast = () => {
            const sol = type.getCurrentSol();
            if (sol.select_all) {
              const out = sol.instances;
              clear(out);
              clear(sol.else_instances);
              const arr = type.instances;
              for (let i = 0, n = arr.length; i < n; ++i) {
                const inst = arr[i];
                if (!inst.instance_vars[family ? index + inst.type.family_var_map[fi] : index] !== inverted) out.push(inst);
              }
              if (type.finish) type.finish(true);
              sol.select_all = false;
              type.applySolToContainer();
              return sol.hasObjects();
            }
            const arr = sol.instances;
            let k = 0;
            let any = false;
            for (let i = 0, n = arr.length; i < n; ++i) {
              const inst = arr[i];
              if (!inst.instance_vars[family ? index + inst.type.family_var_map[fi] : index] !== inverted) { arr[k++] = inst; any = true; }
            }
            cr.truncateArray(arr, k);
            if (type.finish) type.finish(any);
            return sol.hasObjects();
          };
          if (!check) { this.run = fast; return; }
          // The fast one on a copy of the list, then C2's own on the real one.
          const own = C.run_object, cond = this;
          this.run = function () {
            const sol = type.getCurrentSol(), wasAll = sol.select_all, was = wasAll ? null : sol.instances.slice();
            const r = own.call(cond);
            const got = sol.instances.slice();
            sol.select_all = wasAll;
            if (!wasAll) { clear(sol.instances); for (const x of was) sol.instances.push(x); }
            const f = fast();
            let same = !!r === !!f && got.length === sol.instances.length;
            for (let i = 0; same && i < got.length; i++) same = got[i] === sol.instances[i];
            if (!same && bad++ < 20) console.error(`powerboat: fast boolean variable condition differs on ${type.name}: C2 ${got.length} objects, fast ${sol.instances.length}`);
            if (++runs % 200000 === 0) console.log(`powerboat: fast conditions check: ${runs} runs, ${bad} differ`);
            return r;
          };
          return;
        }
        // ---- "Pick by evaluate" of instance variables, event variables and constants: compiled on its first run
        if (pickOk && this.func === pickByEvaluate && this.run === C.run_system && this.parameters.length === 2 && this.parameters[0].type === 4 && this.parameters[1].expression) {
          const cond = this;
          this.run = () => {
            const fast = compilePick(cond);
            if (fast === null) { cond.run = C.run_system; return cond.run(); }
            cond.run = check ? checkedPick(cond, fast) : fast;
            return cond.run();
          };
        }
      };
      // A pick by evaluate walks its objects through the expression tree: a pure interpreter, one call per node, with every value
      // going through a temporary. Hypnospace Outlaw's desktop: 74 runs a tick, 17 % of the JS thread on the RG Cube XX, nearly all
      // comparisons of instance variables. Those become one JavaScript function for each condition. An expression with
      // anything else in it (a function, another instance's index, arithmetic) stays with C2. Nothing here has a side effect, so
      // the values that cannot change in the loop are read once, and `&` and `|` of comparisons may stop early.
      const pickByEvaluate = cr.system_object.prototype.cnds && cr.system_object.prototype.cnds.PickByEvaluate;
      const E = cr.expNode && cr.expNode.prototype;
      const COMPARE = { 12: ["eval_equal", "==="], 13: ["eval_notequal", "!=="], 14: ["eval_less", "<"], 15: ["eval_lessequal", "<="], 16: ["eval_greater", ">"], 17: ["eval_greaterequal", ">="] };
      const pickOk = typeof pickByEvaluate === "function" && E && typeof Function === "function"
        && /current_condition\.parameters\[1\]\.get\(i\)/.test(String(pickByEvaluate)) && /else_instances\.push\(inst\)/.test(String(pickByEvaluate))
        && /!!sol\.instances\.length/.test(String(pickByEvaluate)) && /applySolToContainer/.test(String(pickByEvaluate))
        && Object.values(COMPARE).every(([f, op]) => typeof E[f] === "function" && String(E[f]).includes(`ret.data ${op} temp.data ? 1 : 0`))
        && /this\.owner\.solindex/.test(String(E.eval_instvar_exp)) && /inst\.instance_vars\[varindex \+ offset\]/.test(String(E.eval_instvar_exp))
        && /inst\.type\.family_var_map\[object_type\.family_index\]/.test(String(E.eval_instvar_exp))
        && /ret\.data && temp\.data \? 1 : 0/.test(String(E.eval_and_logical)) && /this\.eventvar\.getValue\(\)/.test(String(E.eval_eventvar_exp));
      const compilePick = (cond) => {
        const obj = cond.parameters[0].object;
        if (!obj) return null;
        const L = [];
        const others = new Map();
        let hoists = "", perObject = "";
        const isTruth = (e) => (e.type >= 10 && e.type <= 17);
        const instVar = (e, base) => "(" + base + ".instance_vars[" + e.varindex + (e.object_type.is_family ? " + " + base + ".type.family_var_map[" + e.object_type.family_index + "]" : "") + "])";
        const walk = (e) => {
          const t = e.type;
          if (t === 0 || t === 1) return typeof e.value === "number" && Number.isFinite(e.value) ? "(" + e.value + ")" : null;
          if (t === 2) return typeof e.value === "string" ? JSON.stringify(e.value) : null;
          if (COMPARE[t]) {
            const a = walk(e.first), b = walk(e.second);
            return a === null || b === null ? null : "(" + a + " " + COMPARE[t][1] + " " + b + " ? 1 : 0)";
          }
          if (t === 10 || t === 11) {
            // Only of comparisons: otherwise `&` may be a string concatenation.
            if (!isTruth(e.first) || !isTruth(e.second)) return null;
            const a = walk(e.first), b = walk(e.second);
            return a === null || b === null ? null : "(" + a + (t === 10 ? " && " : " || ") + b + " ? 1 : 0)";
          }
          if (t === 21) {
            if (e.instance_expr || !e.object_type || !(e.varindex >= 0)) return null;
            if (e.object_type === obj) return instVar(e, "inst");
            let v = others.get(e.object_type);
            if (v === undefined) {
              v = "o" + L.length;
              others.set(e.object_type, v);
              hoists += `const ${v} = L[${L.length}].getCurrentSol().getObjects(), n${v} = ${v}.length; if (n${v} === 0) return slow();\n`;
              perObject += `const x${v} = ${v}[i % n${v}];\n`;
              L.push(e.object_type);
            }
            return instVar(e, "x" + v);
          }
          if (t === 23) {
            if (!e.eventvar) return null;
            const v = "e" + L.length;
            hoists += `const ${v} = L[${L.length}].getValue();\n`;
            L.push(e.eventvar);
            return v;
          }
          return null;
        };
        const test = walk(cond.parameters[1].expression);
        if (test === null) return null;
        const body = `"use strict";
const out = [];
return function () {
  const sol = obj.getCurrentSol(), src = sol.getObjects();
  ${hoists}if (sol.select_all) cr.clearArray(sol.else_instances);
  const els = sol.else_instances;
  let k = 0;
  for (let i = 0, n = src.length; i < n; i++) {
    const inst = src[i];
    ${perObject}if (${test}) out[k++] = inst; else els.push(inst);
  }
  cr.truncateArray(out, k);
  sol.select_all = false;
  cr.shallowAssignArray(sol.instances, out);
  cr.clearArray(out);
  obj.applySolToContainer();
  return !sol.instances.length !== notInverted;
};`;
        try { return new Function("obj", "L", "cr", "slow", "notInverted", body)(obj, L, cr, () => C.run_system.call(cond), !cond.inverted); }
        catch (e) { console.log("powerboat: pick by evaluate left to C2 (" + e + ")"); return null; }
      };
      const checkedPick = (cond, fast) => () => {
        const obj = cond.parameters[0].object, sol = obj.getCurrentSol();
        const wasAll = sol.select_all, wasI = sol.instances.slice(), wasE = sol.else_instances.slice();
        const fill = (a, b) => { cr.clearArray(a); for (const x of b) a.push(x); };
        const r = C.run_system.call(cond);
        const gotI = sol.instances.slice(), gotE = sol.else_instances.slice();
        sol.select_all = wasAll; fill(sol.instances, wasI); fill(sol.else_instances, wasE);
        const f = fast();
        const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
        if ((!!r !== !!f || !same(gotI, sol.instances) || !same(gotE, sol.else_instances)) && bad++ < 20) {
          console.error(`powerboat: fast pick by evaluate differs on ${obj.name}: C2 ${r} ${gotI.length}/${gotE.length} objects, fast ${f} ${sol.instances.length}/${sol.else_instances.length}`);
        }
        sol.select_all = false; fill(sol.instances, gotI); fill(sol.else_instances, gotE);
        if (++runs % 200000 === 0) console.log(`powerboat: fast conditions check: ${runs} runs, ${bad} differ`);
        return r;
      };
      console.log("powerboat: C2 fast conditions" + (check ? " (check mode)" : ""));
    };
  }

  // ---- Layer textures clipped to what was drawn (C3) ---------------------------------------------
  // A C3 layer with its own texture (opacity, blend mode, force-own-texture) is cleared and then
  // composited back as a full-screen quad, however little is on it. On a tiler GPU that is a whole
  // screen of fill per layer (Solitaire Holiday: ~10 per frame, fill-bound on the Mali-G31). When
  // the layer's contents are plain instances, the clear and the composite are scissored to the
  // union of their draw-surface boxes; pixels outside it would be transparent anyway.
  // POWERBOAT_C3_LAYER_CLIP=0 off, =2 scissors the composite only (clear stays full);
  // POWERBOAT_C3_LAYER_DEBUG=1 prints per-layer coverage every 300 frames.
  const CLIP = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_LAYER_CLIP") || "1", CLIP_DEBUG = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_LAYER_DEBUG") === "1";
  const MARGIN = 2;
  let clipPatched = false;
  const patchLayerClip = () => {
    const C3 = g.C3, LP = C3 && C3.Layer && C3.Layer.prototype;
    if (clipPatched || !LP || typeof LP.Draw !== "function" || typeof LP._InstanceBoxToDrawSurface !== "function") return;
    clipPatched = true;
    if (CLIP === "0") return;
    const baseDraw = LP.Draw;
    const stats = new Map(), big = [];
    let frames = 0, lastFrame = -1;
    // The draw-surface box covering every instance the layer will draw, or null when the layer
    // needs its whole texture (background color, effects, sub-layers, 3D, copy compositing).
    const drawnBox = (layer, renderer, first) => {
      if (!layer.UsesOwnTexture() || !layer.IsTransparent()) return null;
      if (layer._effectList.HasAnyActiveEffect() || layer._subLayers.length) return null;
      if (layer.Has3DCamera() || layer.GetZElevation() !== 0 || layer._anyInstanceZElevated) return null;
      if (first && layer.GetBlendMode() === 0 && layer.HasDefaultColor()) return null;
      const vp = layer.GetViewport(), lay = layer.GetLayout();
      const outside = lay.HasVanishingPointOutsideViewport(), ortho = lay.IsOrthographicProjection();
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const inst of layer._GetInstances()) {
        const wi = inst.GetWorldInfo();
        if (!wi.IsVisible() || !wi.IsInViewport(vp, outside, ortho)) continue;
        if (wi.HasAnyActiveEffect()) return null;
        const box = layer._InstanceBoxToDrawSurface(wi);
        if (!box) return null;
        l = Math.min(l, box.getLeft()); t = Math.min(t, box.getTop());
        r = Math.max(r, box.getRight()); b = Math.max(b, box.getBottom());
      }
      const [w, h] = renderer.GetRenderTargetSize(renderer.GetRenderTarget());
      if (l === Infinity) return [0, 0, 0, 0, w * h];
      l = Math.max(0, Math.floor(l) - MARGIN); t = Math.max(0, Math.floor(t) - MARGIN);
      r = Math.min(w, Math.ceil(r) + MARGIN); b = Math.min(h, Math.ceil(b) + MARGIN);
      return [l, t, Math.max(0, r - l), Math.max(0, b - t), w * h];
    };
    LP.Draw = function (renderer, target, first) {
      let box = null;
      try { box = drawnBox(this, renderer, first); } catch (e) { box = null; }
      if (CLIP_DEBUG) {
        const fr = this._runtime.GetTickCount ? this._runtime.GetTickCount() : 0;
        if (fr !== lastFrame) { lastFrame = fr; if (++frames % 300 === 0) {
          const out = [];
          let total = 0;
          for (const [name, s] of stats) {
            total += s.fill / Math.max(1, s.n);
            out.push(`${name} ${s.clipped}/${s.n} ${(100 * s.area / Math.max(1, s.n)).toFixed(0)}% inst ${(s.inst / Math.max(1, s.n)).toFixed(1)} fill ${(s.fill / Math.max(1, s.n)).toFixed(2)}`);
          }
          console.log(`[c3 layer clip] layers (clipped/drawn, mean area, instances drawn, fill in screens; total fill ${total.toFixed(2)}): ` + out.join(", "));
          if (big.length) console.log("[c3 layer clip] largest instances (screens): " + big.sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, a]) => `${n} ${a.toFixed(2)}`).join(", "));
          stats.clear(); big.length = 0;
        } }
        {
          let fx = 0, inst = 0, fill = 0;
          const [sw, sh] = renderer.GetRenderTargetSize(renderer.GetRenderTarget());
          const vp = this.GetViewport(), lay = this.GetLayout();
          const outside = lay.HasVanishingPointOutsideViewport(), ortho = lay.IsOrthographicProjection();
          for (const it of this._GetInstances()) {
            const wi = it.GetWorldInfo();
            if (!wi.IsVisible() || !wi.IsInViewport(vp, outside, ortho)) continue;
            const bx = this._InstanceBoxToDrawSurface(wi);
            if (!bx) continue;
            const l = Math.max(0, bx.getLeft()), t = Math.max(0, bx.getTop()), r = Math.min(sw, bx.getRight()), b = Math.min(sh, bx.getBottom());
            const a = Math.max(0, r - l) * Math.max(0, b - t) / (sw * sh);
            inst++; fill += a;
            if (frames % 300 === 299 && a > 0.05) big.push([`${this.GetName()}/${it.GetObjectClass().GetName()}`, a]);
          }
          if (this.UsesOwnTexture()) fill += box ? 2 * box[2] * box[3] / box[4] : 2;
          for (const it of this._GetInstances()) {
            const wi = it.GetWorldInfo();
            if (!wi.HasAnyActiveEffect()) continue;
            fx++;
            if (frames % 300 === 299) {
              const el = wi.GetInstanceEffectList(), ch = el.GetEffectChain();
              const bx = this._InstanceBoxToDrawSurface(wi);
              console.log(`[c3 layer clip] fx instance ${it.GetObjectClass().GetName()} visible=${wi.IsVisible()} effects=${el.GetActiveEffectTypes().map((t) => t.GetName()).join("+")} fullSurface=${ch.CanSkipCalculatingDrawSurfaceRect()} box=${bx ? [bx.getLeft(), bx.getTop(), bx.width(), bx.height()].map(Math.round).join(",") : "none"}`);
            }
          }
          const name = (this.GetName ? this.GetName() : "?") + (this.UsesOwnTexture() ? "[own]" : "") + (fx ? `[fx ${fx}]` : "");
          const s = stats.get(name) || { n: 0, clipped: 0, area: 0, inst: 0, fill: 0 };
          s.n++; s.inst += inst; s.fill += fill;
          if (box) { s.clipped++; s.area += box[2] * box[3] / box[4]; } else s.area += 1;
          stats.set(name, s);
        }
      }
      // Whole texture anyway: nothing to gain.
      if (!box || box[2] * box[3] > 0.7 * box[4]) return baseDraw.call(this, renderer, target, first);
      if (CLIP === "2") {
        // Composite only: the clear runs unscissored inside Draw; scissor from the parent switch on.
        const baseSet = renderer.SetRenderTarget;
        renderer.SetRenderTarget = function (rt, p) {
          baseSet.call(this, rt, p);
          if (rt === target) this.SetScissorRect(box[0], box[1], box[2], box[3]);
        };
        try { baseDraw.call(this, renderer, target, first); }
        finally { renderer.SetRenderTarget = baseSet; renderer.RemoveScissorRect(); }
        return;
      }
      renderer.SetScissorRect(box[0], box[1], box[2], box[3]);
      try { baseDraw.call(this, renderer, target, first); }
      finally { renderer.RemoveScissorRect(); }
    };
  };
  // A C3 instance effect chain (outline, drop shadow, tint...) runs each pass on a render target of
  // the whole draw size, scissored to the object. On the Mali-G31 a pass on a full-size target costs
  // about 1 ms whatever the scissor (examples/t_passes.js: 13 objects 16.5 ms, 4.1 on small targets;
  // Solitaire Holiday has 12 such objects). Here an eligible chain runs in a draw space of its own:
  // a box around the object (rounded up to 32 px so targets are shared), its content drawn through
  // the layer projection remapped onto that box, the result composited back in place through the
  // chain's own compositOff support. Pass coordinates (rcTex*, pixel size) then follow from the box
  // as they would from the full size, except destStart/destEnd: where on the destination the object
  // is (background-blending shaders such as skymen's DropShadow sample the layer there), so it stays
  // in full draw space. Cross-sampling shaders (skymen's BetterOutline: neighbors of the source,
  // relative to srcOrigin) work the same in the box. Chains sampling depth keep the full-size path. POWERBOAT_C3_SMALL_FX=0 off; POWERBOAT_C3_FX_DEBUG=1 prints how many
  // chains took each path every 300 ticks.
  const SMALL_FX = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_SMALL_FX") !== "0", FX_DEBUG = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_FX_DEBUG") === "1";
  const FX_ROUND = 32, FX_TRACE = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_FX_TRACE") === "1";
  // POWERBOAT_C3_FX_CHECK=<s>: at game time s, freeze time and write the same frame drawn the normal way,
  // in small boxes and the normal way again (fxcheck_full/small/full2.ppm in POWERBOAT_C3_FX_CHECK_DIR or /tmp).
  const FX_CHECK = +(Deno.core.ops.op_powerboat_env("POWERBOAT_C3_FX_CHECK") || 0), FX_CHECK_DIR = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_FX_CHECK_DIR") || "/tmp";
  let traced = 0, traceCalls = 0, fxForceFull = false;
  const FX_CHECK_WALL = Deno.core.ops.op_powerboat_env("POWERBOAT_C3_FX_CHECK_WALL") === "1";
  const patchFxCheck = (C3) => {
    const RP = C3.Runtime && C3.Runtime.prototype;
    if (!FX_CHECK || !RP || typeof RP.Render !== "function") return;
    const baseFrame = RP.Render, names = [null, null, "full", "small", "full2"];
    let phase = 0, wait = 0;
    const save = (rt, name) => {
      const r = rt.GetRenderer(), gl = r.GetContext();
      r.EndBatch();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const head = `P6\n${w} ${h}\n255\n`, out = new Uint8Array(head.length + w * h * 3);
      for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
      let o = head.length;
      for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4; out[o++] = px[s]; out[o++] = px[s + 1]; out[o++] = px[s + 2]; }
      Deno.core.ops.op_powerboat_write_bytes(`${FX_CHECK_DIR}/fxcheck_${name}.ppm`, out, false);
      console.log(`[c3 small fx] check: wrote fxcheck_${name}.ppm (${w}x${h})`);
    };
    RP.Render = function () {
      // POWERBOAT_C3_FX_CHECK_WALL=1: s is seconds since start, not game time (games that pause time in dialogues).
      const now = FX_CHECK_WALL ? g.performance.now() / 1000 : this.GetGameTime();
      if (phase === 0 && now >= FX_CHECK) { this.SetTimeScale(0); phase = 1; wait = 0; }
      if (phase === 1 && ++wait > 10) phase = 2;
      if (phase >= 1 && phase <= 4) this.UpdateRender();
      fxForceFull = phase === 2 || phase === 4;
      const r = baseFrame.apply(this, arguments);
      if (phase >= 2 && phase <= 4) { try { save(this, names[phase]); } catch (e) { console.error("fx check:", e); } phase++; }
      fxForceFull = false;
      return r;
    };
  };
  let fxPatched = false;
  const patchSmallFx = () => {
    const C3 = g.C3, EC = C3 && C3.Gfx && C3.Gfx.EffectChain, EP = EC && EC.prototype;
    if (fxPatched || !EP || !g.glMatrix || typeof EP.Render !== "function" || typeof EP._CalculateDrawSizeAndRectangles !== "function"
      || typeof EP._DrawContent !== "function" || typeof EP._GetRenderTarget !== "function" || typeof EP._DoSetProgramParameters !== "function") return;
    fxPatched = true;
    if (!SMALL_FX) return;
    patchFxCheck(C3);
    const mat4 = g.glMatrix.mat4, remap = mat4.create(), saved = mat4.create(), proj = mat4.create();
    const rect = C3.New(C3.Rect);
    const counts = new Map(), fxFill = new Map();
    let lastTick = -1, ticks = 0;
    const count = (key) => counts.set(key, (counts.get(key) || 0) + 1);
    // The box around the object in the full draw space, or a reason string for the normal path.
    const smallBox = (chain, renderer, dest, o) => {
      if (!renderer.IsWebGL() || !o.drawSurfaceRect) return "no box";
      if (chain._canUseFastPath || chain._useFullSurface || chain._needsRebuild) return "fast path";
      if (chain._useCopyTextureBackgroundSampling) return "copy-texture background";
      if (chain._isAnyShaderDepthSampling) return "depth sampling";
      if (o.compositOffX || o.compositOffY || o.compositRtWidth || o.compositRtHeight || o.updateOwnProjection || o.drawContentHook) return "composit offset";
      const inst = o.contentObject, wi = inst && inst.GetWorldInfo && inst.GetWorldInfo();
      if (!wi || typeof wi.GetTotalZElevation !== "function") return "not an instance";
      if (wi.GetLayer().Has3DCamera() || wi.GetTotalZElevation() !== 0 || wi.GetDepth() > 0) return "3D";
      const [W, H] = chain._manager.GetDrawSize(renderer);
      const [dw, dh] = renderer.GetRenderTargetSize(dest);
      if (W !== dw || H !== dh) return "destination not draw size";
      const s = (o.layerScale || 1) * (o.devicePixelRatio || 1), d = o.drawSurfaceRect;
      const ex = Math.max(chain._boxExtendHorizontal, 1) * s + 2, ey = Math.max(chain._boxExtendVertical, 1) * s + 2;
      const l = Math.max(0, Math.floor(d.getLeft() - ex)), t = Math.max(0, Math.floor(d.getTop() - ey));
      const r = Math.min(W, Math.ceil(d.getRight() + ex)), b = Math.min(H, Math.ceil(d.getBottom() + ey));
      if (!(r > l && b > t)) return "off screen";
      const w = Math.min(W, Math.ceil((r - l) / FX_ROUND) * FX_ROUND), h = Math.min(H, Math.ceil((b - t) / FX_ROUND) * FX_ROUND);
      if (w * h > 0.5 * W * H) return "large";
      const cm = inst.GetRuntime().GetCanvasManager();
      return { ox: l, oy: t, w, h, W, H, cm, sampling: inst.GetRuntime().GetSampling() };
    };
    const baseRender = EP.Render, baseCalc = EP._CalculateDrawSizeAndRectangles, baseDraw = EP._DrawContent, baseGet = EP._GetRenderTarget;
    EP.Render = function (renderer, dest, o) {
      let box;
      try { box = smallBox(this, renderer, dest, o || {}); } catch (e) { box = "error " + e; }
      if (FX_DEBUG) {
        const rt = o && o.contentObject && o.contentObject.GetRuntime && o.contentObject.GetRuntime();
        const tick = rt ? rt.GetTickCount() : 0;
        if (tick !== lastTick) {
          lastTick = tick;
          if (++ticks % 300 === 0) {
            console.log("[c3 small fx] chains per 300 ticks: " + [...counts].map(([k, n]) => `${k} ${n}`).join(", "));
            let tot = 0;
            for (const v of fxFill.values()) tot += v / 300;
            console.log(`[c3 small fx] effect pass fill per tick (screens): total ${tot.toFixed(2)}; ` + [...fxFill].map(([k, v]) => `${k} ${(v / 300).toFixed(2)}`).join(", "));
            counts.clear(); fxFill.clear();
          }
        }
        const names = this._shaderProgramList.map((p) => (p.GetName ? p.GetName() : "?") + (p.BlendsBackground() ? "(bg)" : "")).join("+");
        count((typeof box === "string" ? box : "small") + " [" + names + "]");
        // Fill of the chain's passes in screens: the content pass covers the object, every later
        // pass the box-extended surface rect.
        const r = renderOne(this, renderer, dest, o, box);
        const [W, H] = this._manager.GetDrawSize(renderer), dr = o && o.drawSurfaceRect, ds = this._drawSurfaceRect;
        if (dr && !this._canUseFastPath) {
          const passes = this._steps.length;
          const f = (dr.width() * dr.height() + Math.max(0, passes - 1) * ds.width() * ds.height()) / (W * H);
          fxFill.set(names, (fxFill.get(names) || 0) + f);
        }
        return r;
      }
      return renderOne(this, renderer, dest, o, box);
    };
    const renderOne = (chain, renderer, dest, o, box) => {
      if (fxForceFull && typeof box !== "string") box = "check: full";
      if (typeof box === "string") return baseRender.call(chain, renderer, dest, o);
      const dr = o.drawSurfaceRect;
      rect.set(dr.getLeft() - box.ox, dr.getTop() - box.oy, dr.getRight() - box.ox, dr.getBottom() - box.oy);
      chain._powerboatSmall = box;
      try {
        return baseRender.call(chain, renderer, dest, Object.assign({}, o, { drawSurfaceRect: rect, compositOffX: -box.ox, compositOffY: -box.oy }));
      } finally { chain._powerboatSmall = null; }
    };
    EP._CalculateDrawSizeAndRectangles = function (renderer, o) {
      const box = this._powerboatSmall;
      if (!box) return baseCalc.call(this, renderer, o);
      this._SetDrawSize(renderer, box.w, box.h);
      this._CalculateRectangles(o);
    };
    // The content is drawn with the layer's projection (full draw size): remap clip space so the
    // box lands on the small target. x' = (W/w) x + (W/w - 2 ox/w - 1) w_clip, y likewise (y up).
    EP._DrawContent = function (renderer) {
      const box = this._powerboatSmall;
      if (!box) return baseDraw.call(this, renderer);
      const sx = box.W / box.w, sy = box.H / box.h;
      mat4.identity(remap);
      remap[0] = sx; remap[5] = sy;
      remap[12] = sx - 2 * box.ox / box.w - 1;
      remap[13] = 1 - sy + 2 * box.oy / box.h;
      mat4.copy(saved, renderer._matP);
      mat4.multiply(proj, remap, saved);
      renderer._SetViewport(0, 0, box.w, box.h);
      renderer.SetProjectionMatrix(proj);
      if (FX_TRACE && traced < 6 && ++traceCalls % 97 === 0) {
        traced++;
        const inst = this.GetContentObject(), r = (x) => [x.getLeft(), x.getTop(), x.getRight(), x.getBottom()].map((v) => +v.toFixed(3)).join(",");
        console.log(`[c3 small fx] ${inst.GetObjectClass().GetName()} ${this._shaderProgramList.map((p) => p.GetName()).join("+")} steps ${this._steps.map((s) => s.constructor.name + s.GetSrcTargetId() + ">" + s.GetDestTargetId()).join(" ")}`
          + ` box ${box.ox},${box.oy} ${box.w}x${box.h} of ${box.W}x${box.H} surface ${r(this._drawSurfaceRect)} texOrig ${r(this._rcTexOriginal)} texDest ${r(this._rcTexDest)} bounce ${r(this._rcTexBounce)}`
          + ` rt ${renderer.GetRenderTargetSize(renderer.GetRenderTarget())} P ${Array.from(saved).map((v) => +v.toFixed(3))} P' ${Array.from(proj).map((v) => +v.toFixed(3))}`);
      }
      // Unrotated text draws pixel-snapped in device space (CanvasManager.SetDeviceTransform at the
      // current target's size): its offset moves the box origin to the target's corner.
      const cm = box.cm, offX = cm._deviceTransformOffX, offY = cm._deviceTransformOffY;
      cm.SetDeviceTransformOffset(offX + box.ox, offY + box.oy);
      try { baseDraw.call(this, renderer); }
      finally { cm.SetDeviceTransformOffset(offX, offY); renderer.SetProjectionMatrix(saved); }
    };
    const destRect = C3.New(C3.Rect), baseParams = EP._DoSetProgramParameters;
    EP._DoSetProgramParameters = function (renderer, index, srcRect, srcOrigin, dest, pw, ph) {
      const box = this._powerboatSmall;
      if (box) {
        const d = this._rcTexDest;
        destRect.set((d.getLeft() * box.w + box.ox) / box.W, (d.getTop() * box.h + box.oy) / box.H,
          (d.getRight() * box.w + box.ox) / box.W, (d.getBottom() * box.h + box.oy) / box.H);
        destRect.flipAround(1);
        dest = destRect;
      }
      return baseParams.call(this, renderer, index, srcRect, srcOrigin, dest, pw, ph);
    };
    EP._GetRenderTarget = function () {
      const box = this._powerboatSmall;
      if (!box) return baseGet.call(this);
      return box.cm.GetAdditionalRenderTarget({ sampling: box.sampling, width: box.w, height: box.h });
    };
  };

  // Construct 3 overwrites the start of its big batch buffers once per batch while the GPU may still read last frame's
  // draws from them. The driver call returns quickly, but the first draw after it waits: 5.5 of Aye Leon's 6.8 ms of
  // draws on the RG Cube XX (Mali-G31). A batch only draws what it just wrote (EndBatch resets the pointers), so
  // new storage of just those bytes is the same picture. CONSTRUCT_BATCH_ORPHAN=0 keeps C3's own.
  // Builds whose EndBatch does not reset _vertexPtr keep persistent meshes updated in ranges: left alone.
  let batchWritePatched = false;
  const patchBatchWrite = () => {
    const R = g.C3 && g.C3.Gfx && g.C3.Gfx.WebGLRenderer, RP = R && R.prototype, GLP = g.WebGLRenderingContext && g.WebGLRenderingContext.prototype;
    if (batchWritePatched || !RP || !GLP || typeof RP._WriteBuffers !== "function" || typeof RP.EndBatch !== "function") return;
    batchWritePatched = true;
    if (ops.op_powerboat_env("CONSTRUCT_BATCH_ORPHAN") === "0") return;
    if (!/_WriteBuffers\(\)[^}]*_ExecuteBatch\(\)[^}]*_vertexPtr\s*=/.test(String(RP.EndBatch))) return;
    if (!/^\s*_WriteBuffers\(\)\s*\{[^]*bufferSubData\([^,]+,\s*0,[^]*subarray\(0,/.test(String(RP._WriteBuffers))) return;
    const write = RP._WriteBuffers, sub = GLP.bufferSubData;
    let inWrite = false;
    RP._WriteBuffers = function () {
      inWrite = true;
      try { write.call(this); } finally { inWrite = false; }
    };
    GLP.bufferSubData = function (target, offset, data) {
      if (inWrite && offset === 0) this.bufferData(target, data, this.STREAM_DRAW);
      else sub.call(this, target, offset, data);
    };
    console.log("powerboat: batch buffers get new storage per batch");
  };

  // ---- Animation frames share identical collision polygons (C3) ----------------------------------
  // Every animation frame of every object type is created at startup, each with its own CollisionPoly
  // and Float64Array of points (Moonstone Island: 80,737 polys, ~25 MB of arrays, buffers and backing
  // stores on a 64-bit heap, mostly the same few boxes). Frames with the same points share one array;
  // the methods that write points (setPoints, setFromRect, transformPrecalc, offset, mirror, flip, diag)
  // first give a shared poly its own copy. Readers (collision tests, image points, mesh) only read.
  // CONSTRUCT_SHARE_POLYS=0 off.
  let polyPatched = false;
  const patchPolyShare = () => {
    const C3 = g.C3, CP = C3 && C3.CollisionPoly, AF = C3 && C3.AnimationFrameInfo;
    if (polyPatched || !CP || !AF || ops.op_powerboat_env("CONSTRUCT_SHARE_POLYS") === "0") return;
    const P = CP.prototype;
    const names = ["setPoints", "setFromRect", "transformPrecalc", "offset", "mirror", "flip", "diag"];
    if (names.some((n) => typeof P[n] !== "function")) return;
    polyPatched = true;
    const pool = new Map();
    let polys = 0;
    const own = (p) => { p._ptsArr = Float64Array.from(p._ptsArr); p._powerboatShared = false; };
    const baseSet = P.setPoints, baseRect = P.setFromRect, baseTp = P.transformPrecalc, baseOff = P.offset;
    const baseMirror = P.mirror, baseFlip = P.flip, baseDiag = P.diag;
    P.setPoints = function (a) {
      if (this._powerboatShared) { this._powerboatShared = false; this._ptsArr = Float64Array.from(a); this._isBboxChanged = true; return; }
      return baseSet.call(this, a);
    };
    P.setFromRect = function (a, b, c) { if (this._powerboatShared) own(this); return baseRect.call(this, a, b, c); };
    P.transformPrecalc = function (a, b, c, d) { if (this._powerboatShared) own(this); return baseTp.call(this, a, b, c, d); };
    P.offset = function (a, b) { if (this._powerboatShared) own(this); return baseOff.call(this, a, b); };
    P.mirror = function (a) { if (this._powerboatShared) own(this); return baseMirror.call(this, a); };
    P.flip = function (a) { if (this._powerboatShared) own(this); return baseFlip.call(this, a); };
    P.diag = function () { if (this._powerboatShared) own(this); return baseDiag.call(this); };
    C3.AnimationFrameInfo = class extends AF {
      constructor(...a) {
        super(...a);
        const poly = this._collisionPoly;
        if (poly && poly._ptsArr instanceof Float64Array && Object.isExtensible(poly)) {
          const key = poly._ptsArr.join(",");
          const s = pool.get(key);
          if (s) poly._ptsArr = s; else pool.set(key, poly._ptsArr);
          poly._powerboatShared = true;
          polys++;
        }
      }
    };
    setTimeout(function report() {
      if (!polys) { setTimeout(report, 5000); return; }
      console.log("powerboat: " + polys + " frame collision polys share " + pool.size + " point arrays");
    }, 15000);
    // CONSTRUCT_SHARE_POLYS=check: every 10 s, every shared array must still hold the points it was pooled
    // with (a write that bypassed the copy-on-write methods would show here).
    if (ops.op_powerboat_env("CONSTRUCT_SHARE_POLYS") === "check") {
      setInterval(() => {
        let bad = 0;
        for (const [key, arr] of pool) if (arr.join(",") !== key) bad++;
        console.log("powerboat: poly share check: " + pool.size + " arrays, " + bad + " changed");
      }, 10000);
    }
  };

  // ---- "Force own texture" layers that need none (C3) --------------------------------------------
  // A layer with "force own texture" set is drawn into a texture of its own and composited back, even
  // with no effect, default color and normal blend. When its instances also blend normally and carry
  // no effects, drawing them straight onto what is below gives the same picture (source-over is
  // associative; at most +-1 of 8-bit rounding): no render-target switch, clear or full-screen composite.
  // On a tiler GPU each switch is a render pass (PowerVR GE8300: draws/clears/binds were 31 % of the
  // main thread). Moonstone Island's tutorial: Tilemap and UI layers. Checked every frame (instances
  // change). CONSTRUCT_SKIP_FORCED_TEXTURE=0 off.
  // CONSTRUCT_LAYER_PATCH_DEBUG=1: each layer's own-texture / draw decision of the two patches below, logged
  // when it changes.
  const LAYER_PATCH_DEBUG = ops.op_powerboat_env("CONSTRUCT_LAYER_PATCH_DEBUG") === "1";
  const layerDecisions = new Map();
  const layerDebug = (layer, what, why) => {
    const key = (layer.GetName ? layer.GetName() : "?") + " " + what;
    if (layerDecisions.get(key) === why) return;
    layerDecisions.set(key, why);
    console.log("powerboat: layer " + key + ": " + why);
  };
  let ownPatched = false;
  const patchForcedOwnTexture = () => {
    const C3 = g.C3, LP = C3 && C3.Layer && C3.Layer.prototype;
    if (ownPatched || !LP || typeof LP.UsesOwnTexture !== "function" || typeof LP.HasDefaultColor !== "function") return;
    if (ops.op_powerboat_env("CONSTRUCT_SKIP_FORCED_TEXTURE") === "0") return;
    ownPatched = true;
    const base = LP.UsesOwnTexture;
    // Layer effects that change nothing at their current parameters (from the shader sources):
    // brightness: front.rgb += brightness - 1 (unpremultiplied), so 1 (100 %) is the picture as it is.
    const noopEffect = (layer, t) => {
      const all = layer._effectList._effectParams, idx = t.GetIndex ? t.GetIndex() : t._index;
      const p = all && all[idx];
      if (t._id === "brightness") return !!p && p[0] === 1;
      return false;
    };
    // An instance far from the view is not drawn (C3 culls by viewport). The layer's viewport is last
    // frame's when this runs (before the layer's transform is set), so the test uses a box twice the
    // view's size around it: an instance just scrolling in still counts.
    const nearView = (wi, vp) => {
      const bb = wi.GetBoundingBox ? wi.GetBoundingBox() : null;
      if (!bb || !vp) return true;
      const w = vp.width(), h = vp.height();
      return !(bb.getRight() < vp.getLeft() - w || bb.getLeft() > vp.getRight() + w || bb.getBottom() < vp.getTop() - h || bb.getTop() > vp.getBottom() + h);
    };
    // Why a layer keeps its own texture (a string), or "" when drawing it straight gives the same picture.
    const ownReason = (layer) => {
      // POWERBOAT_C3_FX_CHECK's "full" frames are drawn the normal way (this patch off too).
      if (fxForceFull) return "fx check";
      if (!layer.HasDefaultColor()) return "color/opacity";
      if (layer.GetBlendMode() !== 0) return "blend " + layer.GetBlendMode();
      if (layer._effectList) for (const t of layer._effectList.GetActiveEffectTypes()) if (!noopEffect(layer, t)) return "layer effect " + t._id;
      if (layer.RendersIn3DMode ? layer.RendersIn3DMode() : layer._renderAs3d) return "3d";
      if (layer._subLayers && layer._subLayers.length) return "sublayers";
      const insts = layer._instances;
      if (!insts) return "no instance list";
      const vp = layer.GetViewport ? layer.GetViewport() : null;
      for (let i = 0; i < insts.length; i++) {
        const wi = insts[i].GetWorldInfo ? insts[i].GetWorldInfo() : null;
        if (!wi || !wi.IsVisible() || !nearView(wi, vp)) continue;
        if (wi.GetBlendMode() !== 0) return "instance blend " + wi.GetBlendMode() + " (" + insts[i].GetObjectClass().GetName() + ")";
        if (wi.HasAnyActiveEffect && wi.HasAnyActiveEffect()) return "instance effect (" + insts[i].GetObjectClass().GetName() + ")";
      }
      return "";
    };
    LP.UsesOwnTexture = function () {
      if (!base.call(this)) return false;
      const why = ownReason(this);
      if (LAYER_PATCH_DEBUG) layerDebug(this, "own texture", why || "skipped");
      return why !== "";
    };
  };

  // ---- Layers whose instances all draw nothing (C3) ----------------------------------------------
  // C3 draws a layer whenever it has instances, even when every one of them is invisible or at opacity
  // 0 (it skips invisible ones itself, but not opacity 0). For a layer with its own texture and an effect
  // that blends the background, that is a render-target switch, a clear and full-screen effect passes
  // for nothing: Moonstone Island's day-time "Overlay" layer (two full-screen night sprites at opacity 0
  // under Multiply). Skipped when the layer is transparent, 2D, has no sublayers, every instance is
  // invisible or at opacity 0 with normal blending and no effects, and every active layer effect leaves
  // a transparent input transparent / the background as it is (whitelist, from the shader sources:
  // multiply = front * back drawn source-over; brightness keeps alpha 0 at 0). The picture is the same.
  // CONSTRUCT_SKIP_EMPTY_LAYERS=0 off.
  const NOOP_ON_EMPTY = new Set(["multiply", "brightness"]);
  let emptyPatched = false;
  const patchSkipEmptyLayers = () => {
    const C3 = g.C3, LP = C3 && C3.Layer && C3.Layer.prototype;
    if (emptyPatched || !LP || typeof LP.ShouldDraw !== "function" || ops.op_powerboat_env("CONSTRUCT_SKIP_EMPTY_LAYERS") === "0") return;
    emptyPatched = true;
    const base = LP.ShouldDraw;
    // Why a layer must be drawn (a string), or "" when it draws nothing.
    const drawReason = (layer) => {
      if (fxForceFull) return "fx check"; // POWERBOAT_C3_FX_CHECK's normal frames
      if (!layer._isTransparent) return "not transparent";
      if (layer.RendersIn3DMode ? layer.RendersIn3DMode() : layer._renderAs3d) return "3d";
      if (layer._subLayers && layer._subLayers.length) return "sublayers";
      const insts = layer._instances;
      if (!insts || !insts.length) return "no instances (C3's rule)";
      for (let i = 0; i < insts.length; i++) {
        const wi = insts[i].GetWorldInfo ? insts[i].GetWorldInfo() : null;
        if (!wi) return "no world info";
        if (!wi.IsVisible()) continue;
        if (wi.GetOpacity() > 0) return "visible instance";
        if (wi.GetBlendMode() !== 0 || (wi.HasAnyActiveEffect && wi.HasAnyActiveEffect())) return "opacity-0 instance with blend/effect";
      }
      const fx = layer._effectList && layer._effectList.GetActiveEffectTypes ? layer._effectList.GetActiveEffectTypes() : [];
      for (const t of fx) if (!NOOP_ON_EMPTY.has(t._id)) return "effect " + t._id;
      return "";
    };
    LP.ShouldDraw = function () {
      if (!base.call(this)) return false;
      const why = drawReason(this);
      if (LAYER_PATCH_DEBUG && why !== "no instances (C3's rule)") layerDebug(this, "draw", why || "skipped (draws nothing)");
      return why !== "";
    };
  };

  // ---- The layout's own texture only when something blends the background (C3, WebGL) ------------
  // A project with any background-blending effect anywhere (Multiply, Screen, ...) makes C3 draw every
  // frame of every layout into a texture of its own and copy it to the canvas, since such effects read
  // what is below them and WebGL cannot sample the canvas. In frames where no drawn layer and no visible
  // instance has such an effect active, the layout can be drawn straight to the canvas: one full-screen
  // pass and a render-target switch less. Moonstone Island: the only one is the night overlay's Multiply,
  // idle (skipped above) in daytime. The other reasons C3 has for the layout texture (low fullscreen
  // quality, low-latency compositing, layout effects, 3D) keep it. Decided once per tick.
  // NOT the same picture: the canvas path rounds exact half-texel positions the other way (Y flip), so
  // 1-px rows/columns along some tile and sprite edges take the neighboring texel (Moonstone frozen
  // frame: 466 pixels, up to 217/255) - what a browser shows for a project without background blending,
  // not what this game shows. Opt-in: CONSTRUCT_LAYOUT_TEXTURE_ON_DEMAND=1.
  let layoutPatched = false;
  const patchLayoutTexture = () => {
    const C3 = g.C3, LYP = C3 && C3.Layout && C3.Layout.prototype;
    if (layoutPatched || !LYP || typeof LYP.UsesOwnTexture !== "function" || ops.op_powerboat_env("CONSTRUCT_LAYOUT_TEXTURE_ON_DEMAND") !== "1") return;
    layoutPatched = true;
    const base = LYP.UsesOwnTexture;
    const blends = (types) => {
      for (const t of types || []) {
        const p = t.GetShaderProgram ? t.GetShaderProgram() : null;
        if (!p || typeof p.BlendsBackground !== "function" || p.BlendsBackground()) return true;
      }
      return false;
    };
    const layerBlends = (layer) => {
      if (!layer.ShouldDraw()) return false;
      if (layer._effectList && blends(layer._effectList.GetActiveEffectTypes())) return true;
      for (const inst of layer._instances || []) {
        const wi = inst.GetWorldInfo ? inst.GetWorldInfo() : null;
        if (!wi || !wi.IsVisible() || !(wi.HasAnyActiveEffect && wi.HasAnyActiveEffect())) continue;
        const oc = inst.GetObjectClass(), el = oc && oc.GetEffectList ? oc.GetEffectList() : null;
        if (!el || blends(el.GetAllEffectTypes())) return true;
      }
      for (const sub of layer._subLayers || []) if (layerBlends(sub)) return true;
      return false;
    };
    let tick = -1, cached = true;
    LYP.UsesOwnTexture = function () {
      if (!base.call(this)) return false;
      if (fxForceFull) return true;
      const rt = this._runtime, r = rt.GetRenderer();
      if (!r.IsWebGL() || rt.GetCanvasManager().GetCurrentFullscreenScalingQuality() === "low" || rt.GetCompositingMode() === "low-latency"
        || this._effectList.HasAnyActiveEffect() || rt.Uses3DFeatures()) return true;
      const t = rt.GetTickCount();
      if (t === tick) return cached;
      tick = t;
      cached = false;
      for (const layer of this.GetLayers ? this.GetLayers() : this._layers) if (layerBlends(layer)) { cached = true; break; }
      if (LAYER_PATCH_DEBUG) layerDebug({ GetName: () => "(layout)" }, "own texture", cached ? "background blending drawn" : "skipped");
      return cached;
    };
  };

  // ---- Parameter values kept from the last run of an action or condition (C3) --------------------
  // Each action/condition keeps its evaluated parameters in _results until its next run (EvalParams fills
  // them in again before every use). Actions that loaded data keep their argument strings for good:
  // Moonstone Island's ~30 Array/JSON "load" actions hold ~15 MB of JSON text after parsing it. Every 5 s,
  // string values over 16 KB are dropped. CONSTRUCT_DROP_STALE_PARAMS=0 off.
  if (ops.op_powerboat_env("CONSTRUCT_DROP_STALE_PARAMS") !== "0") {
    let dropped = 0, droppedBytes = 0;
    setInterval(() => {
      let rt = null;
      try { rt = g.c3_runtimeInterface && !g.c3_runtimeInterface._useWorker && g.c3_runtimeInterface._GetLocalRuntime(); } catch (_) { rt = null; }
      const esm = rt && rt._eventSheetManager;
      if (!esm) return;
      let n = 0;
      for (const map of [esm._actsBySid, esm._cndsBySid]) {
        if (!(map instanceof Map)) continue;
        for (const x of map.values()) {
          const r = x && x._results;
          if (!Array.isArray(r)) continue;
          for (let i = 0; i < r.length; i++) {
            const v = r[i];
            if (typeof v === "string" && v.length > 16384) { droppedBytes += v.length; r[i] = ""; n++; }
          }
        }
      }
      if (n) { dropped += n; console.log("powerboat: dropped " + n + " stale parameter strings (" + dropped + " so far, " + (droppedBytes / 1048576).toFixed(1) + " MB)"); }
    }, 5000);
  }

  // ---- C3 JSON assets through the one-byte JSON decode (40_web.js decodeJson) ---------------------
  // C3's AssetManager.FetchJson is JSON.parse(await FetchText(url)): data.json as text. Moonstone Island's 37 MB
  // data.json holds 17 curly quotes, so V8 kept the text two-byte (74 MB) and used its slower two-byte JSON
  // parser at boot. Fetched as bytes and decoded with those characters as \u escapes instead: the same parsed
  // project, half the text's memory. POWERBOAT_JSON_ONE_BYTE=0 off.
  // data.json also loses its animation frames here when patchLazyFrames is on.
  let jsonPatched = false;
  const patchFetchJson = () => {
    const C3 = g.C3, AP = C3 && C3.AssetManager && C3.AssetManager.prototype;
    if (jsonPatched || !AP || typeof AP.FetchJson !== "function" || typeof AP.FetchArrayBuffer !== "function") return;
    if (!__powerboat.decodeJson && !lazyFrames) return;
    jsonPatched = true;
    const base = AP.FetchJson;
    const decode = __powerboat.decodeJson || ((u8) => Deno.core.decode(u8));
    AP.FetchJson = async function (url) {
      let buf;
      try { buf = await this.FetchArrayBuffer(url); } catch (_) { return base.call(this, url); }
      let u8 = new Uint8Array(buf);
      if (lazyFrames && url === "data.json") {
        const path = __powerboat.resolvePath(url);
        const text = ops.op_c3_strip_frames(path, u8);
        if (text) { lazyFrames.path = path; u8 = text; }
      }
      return JSON.parse(decode(u8));
    };
  };

  // ---- Animation frames built on first use (C3) ---------------------------------------------------
  // C3 makes objects for every animation frame of every object type at startup: an ImageInfo, Rect, Quad, Vector2,
  // ImagePoints, CollisionPoly and script interfaces each. Moonstone Island: 83,218 frames, ~100 MB of a 262 MB heap,
  // ~20 % of the boot, and its title screen uses 217 of them. src/c3frames.rs takes each animation's frames out of the
  // project text before JSON.parse (patchFetchJson above) and leaves [-1, offset, length, count, sheet url, sheet size,
  // ...]. An AnimationInfo holding that reads its frames from data.json the first time anything asks for them, which is
  // when its object type's textures load or something calls for a frame. Nothing else changes: the sheets are still
  // registered with the asset manager at startup, frame counts come from the placeholder.
  // CONSTRUCT_LAZY_FRAMES=0 off; =debug logs each build.
  let lazyFrames = null;
  const patchLazyFrames = () => {
    const C3 = g.C3, AI = C3 && C3.AnimationInfo, OC = C3 && C3.ObjectClass, II = C3 && C3.ImageInfo;
    const mode = ops.op_powerboat_env("CONSTRUCT_LAZY_FRAMES");
    if (lazyFrames || !AI || !OC || !II || mode === "0") return;
    // Only an engine that reads the project the way src/c3frames.rs expects; property names survive only in exports
    // that are not minified with mangled properties.
    const P = AI.prototype, IP = II.prototype;
    const needed = ["Release", "LoadAllAssets", "ReleaseAllTextures", "GetFrameCount"];
    if (needed.some((n) => typeof P[n] !== "function") || typeof IP.LoadData !== "function" || typeof IP.LoadAsset !== "function") return;
    if (!/this\._frames\s*=\s*\w+\[7\]\.map\(/.test(String(AI)) || !/this\._animations\s*=\s*\w+\[7\]\.map\(/.test(String(OC))
      || !/this\._url\s*=\s*\w+\[0\]/.test(String(IP.LoadData)) || !/this\._size\s*=\s*\w+\[1\]/.test(String(IP.LoadData))
      || !/\.LoadImage\(/.test(String(IP.LoadAsset))) return;
    const stats = { animations: 0, frames: 0, builtAnimations: 0, builtFrames: 0, buildMs: 0, path: null };
    lazyFrames = stats;
    __powerboat.lazyFrames = stats;
    const debug = mode === "debug";
    const EMPTY = [];
    const Lazy = class extends AI {
      constructor(a) {
        const f = a[7];
        const lazy = f.length > 0 && typeof f[0] === "number";
        if (lazy) a[7] = EMPTY;
        super(a);
        this._powerboatLazy = null;
        this._powerboatRuntime = null;
        if (lazy) {
          a[7] = f;
          this._powerboatLazy = f;
          stats.animations++;
          stats.frames += f[3];
        }
      }
      _powerboatBuild() {
        const l = this._powerboatLazy;
        const t0 = performance.now();
        const text = ops.op_powerboat_read_range(stats.path, l[1], l[2]);
        if (!text) throw new Error("powerboat: cannot read frames of animation " + this.GetName() + " from " + stats.path);
        const raw = JSON.parse(text);
        this._powerboatLazy = null;
        const rt = this._powerboatRuntime;
        for (const d of raw) {
          const fr = C3.New(C3.AnimationFrameInfo, d);
          if (rt) fr.GetImageInfo().LoadAsset(rt);
          this._frames.push(fr);
        }
        const ms = performance.now() - t0;
        stats.builtAnimations++;
        stats.builtFrames += raw.length;
        stats.buildMs += ms;
        if (debug) console.log("powerboat: built " + raw.length + " frames of animation " + this.GetName() + " in " + ms.toFixed(2) + " ms");
      }
      Release() { this._powerboatLazy = null; return super.Release(); }
      LoadAllAssets(rt) {
        const l = this._powerboatLazy;
        if (!l) return super.LoadAllAssets(rt);
        this._powerboatRuntime = rt;
        for (let i = 4; i < l.length; i += 2) rt.LoadImage({ url: l[i], size: l[i + 1] });
      }
      ReleaseAllTextures() { if (!this._powerboatLazy) super.ReleaseAllTextures(); }
      GetFrameCount() { const l = this._powerboatLazy; return l ? l[3] : super.GetFrameCount(); }
    };
    // Every other method that touches the frames builds them first, whichever methods this engine version has
    // (LoadAllTextures, GetFrames, GetFrameAt, InsertFrameAt, RemoveFrameAt, GetFrameIndexByTag, ...).
    for (const n of Object.getOwnPropertyNames(P)) {
      const base = Object.getOwnPropertyDescriptor(P, n).value;
      if (n === "constructor" || Object.prototype.hasOwnProperty.call(Lazy.prototype, n)) continue;
      if (typeof base !== "function" || !String(base).includes("_frames")) continue;
      Lazy.prototype[n] = function (...a) {
        if (this._powerboatLazy) this._powerboatBuild();
        return base.apply(this, a);
      };
    }
    C3.AnimationInfo = Lazy;
  };

  // ---- Pointer on a letterboxed canvas ----------------------------------------------------------
  // Construct's Mouse and Touch read the pointer as pageX/pageY minus the margin it gave the canvas. Here
  // the canvas stays at 0,0 of the page and pointer points are relative to it (82_forms.js pagePoint), so
  // the margin came off twice: on the RG Cube XX's 720x720 a 16:10 canvas has a 135 px margin, and Moonstone
  // Island's Continue button could not be clicked. HTML elements place themselves by the canvas's page rect
  // and do not read this.
  let canvasClientDone = false;
  const patchCanvasClient = () => {
    const C3 = g.C3;
    if (canvasClientDone || !C3 || !C3.Runtime || !C3.CanvasManager) return;
    canvasClientDone = true;
    for (const P of [C3.Runtime.prototype, C3.CanvasManager.prototype]) {
      if (typeof P.GetCanvasClientX === "function") P.GetCanvasClientX = () => 0;
      if (typeof P.GetCanvasClientY === "function") P.GetCanvasClientY = () => 0;
    }
  };

  // ---- Construct 3 JSON object: each path parsed once --------------------------------------------
  // _ParsePathUnsafe walks the path string one character at a time, with a push per character and a join per
  // part, whenever its one-entry cache misses, which is on nearly every call when a game reads two paths in
  // turn. Moonstone Island's skill tables did that at every tick: array joins, string iteration and pushes
  // together about 3-4 % of the JS thread on the TrimUI Smart Pro. The parts of each string are kept here (the
  // relative form has its current path put in front of them, as before). CONSTRUCT_JSON_PATHS=0 off, =check
  // also runs the engine's own parser on every call and logs any difference.
  let jsonPathsDone = false;
  const patchJsonPaths = () => {
    const J = g.C3 && g.C3.Plugins && g.C3.Plugins.Json && g.C3.Plugins.Json.Instance, P = J && J.prototype;
    const mode = ops.op_powerboat_env("CONSTRUCT_JSON_PATHS");
    if (jsonPathsDone || !P || typeof P._ParsePathUnsafe !== "function" || mode === "0") return;
    jsonPathsDone = true;
    const base = P._ParsePathUnsafe, src = String(base);
    if (!/_HasLocationCache/.test(src) || !/_GetLocationCache/.test(src) || !/_UpdateLocationCache/.test(src) || !/\.slice\(1\)/.test(src)) return;
    const parse = (s) => {
      const parts = [], b = [];
      let esc = false;
      for (const ch of s) {
        if (esc) { b.push(ch); esc = false; }
        else if (ch === "\\") esc = true;
        else if (ch === ".") { parts.push(b.join("")); b.length = 0; }
        else b.push(ch);
      }
      if (b.length !== 0) parts.push(b.join(""));
      return parts;
    };
    const parsed = new Map();
    const check = mode === "check";
    const concatFree = ops.op_powerboat_env("CONSTRUCT_EVENT_LOOPS") !== "0";
    let checks = 0, diffs = 0;
    // Keyed by the string as given, so a relative path is not sliced and hashed a second time: most paths here are
    // built each tick ("." + key + ".unlocked"), and hashing them is native time.
    P._ParsePathUnsafe = function (a) {
      if (this._HasLocationCache(a)) return this._GetLocationCache();
      let entry = parsed.get(a);
      if (entry === undefined) {
        const rel = a[0] === ".", tail = rel ? a.slice(1) : a;
        entry = { rel, tail, parts: parse(tail) };
        // Full: start again, so that tables read once at boot do not keep out the paths read every tick.
        if (parsed.size >= 4096) parsed.clear();
        parsed.set(a, entry);
      }
      let d;
      if (entry.rel && concatFree) { // Array.prototype.concat is a native call
        d = this._path.slice();
        const p = entry.parts;
        for (let i = 0, m = p.length; i < m; ++i) d.push(p[i]);
      } else d = entry.rel ? this._path.concat(entry.parts) : entry.parts.slice();
      if (check) {
        const fake = { _path: this._path, _HasLocationCache: () => false, _GetLocationCache: () => null, _UpdateLocationCache: () => {} };
        const e = base.call(fake, a);
        checks++;
        if (JSON.stringify(e) !== JSON.stringify(d)) { diffs++; console.error("powerboat: JSON path differs: " + JSON.stringify(a) + " " + JSON.stringify(e) + " vs " + JSON.stringify(d)); }
        if (checks % 20000 === 0) console.log("powerboat: JSON path check: " + checks + " parses, " + parsed.size + " paths, " + diffs + " differences");
      }
      this._UpdateLocationCache(entry.tail, d);
      return d;
    };
  };

  // ---- Construct 3: SOL pushes that are never looked at ----------------------------------------------
  // Before every sub-event the engine copies the selected object list of each object type the event may
  // pick from (PushCopySol), runs it and pops them again (PopSol). Most events fail a condition early:
  // Moonstone Island's tutorial makes 267 pushes of 681 lists per tick, and 49 % of those lists are popped
  // with nothing having read any list since. On the TrimUI Smart Pro PushCopySol alone is 6.3 % of the JS
  // thread. A push now waits until some list is read (GetCurrentSol, GetSolStack: the only ways to a stack);
  // no list can change before that, so the copy made then is the copy made now, and a pop that meets its own
  // waiting push cancels it. CONSTRUCT_SOL_DEFER=0 off, =check also reports any stack used with pushes waiting
  // and any list that changed while a push of it waited (code holding a Sol from before the push).
  // Per list: each stack counts its own waiting pushes, and reading a list makes only that list's. Making every waiting
  // push at the first read of any list was 1.4 % self on the TrimUI Smart Pro (flush), and most lists an event may pick
  // from are never read. Pushes and pops of one object type nest, so its waiting pushes are always the top of its stack.
  // CONSTRUCT_SOL_PERLIST=0: all waiting pushes are made at the first read, as before.
  let solDeferDone = false;
  const patchSolDefer = () => {
    const C3 = g.C3, E = C3 && C3.EventSheetManager && C3.EventSheetManager.prototype, O = C3 && C3.ObjectClass && C3.ObjectClass.prototype;
    const mode = ops.op_powerboat_env("CONSTRUCT_SOL_DEFER");
    if (solDeferDone || !E || !O || mode === "0") return;
    solDeferDone = true;
    if (!/\.GetSolStack\(\)\.PushCopy\(\)/.test(String(E.PushCopySol)) || !/\.GetSolStack\(\)\.Pop\(\)/.test(String(E.PopSol))
      || !/this\._solStack\.GetCurrentSol\(\)/.test(String(O.GetCurrentSol)) || !/this\._solStack/.test(String(O.GetSolStack))) return;
    const perList = ops.op_powerboat_env("CONSTRUCT_SOL_PERLIST") !== "0";
    // Check mode: what each waiting push would have copied, compared when it is cancelled or made.
    const check = mode === "check";
    let snapChecks = 0, snapBad = 0;
    const snapOne = (st) => { const c = st._current; return [c, c._selectAll, c._instances.slice()]; };
    const snapCompare = (s, where) => {
      snapChecks++;
      const c = s[0], all = s[1], inst = s[2];
      if (!(c._selectAll === all && (all || (c._instances.length === inst.length && c._instances.every((x, i) => x === inst[i])))) && snapBad++ < 20) {
        console.error("powerboat: SOL of " + c._objectClass.GetName() + " changed while its push waited (" + where + "): " + new Error().stack);
      }
      if (snapChecks % 500000 === 0) console.log("powerboat: SOL snapshot check: " + snapChecks + " lists, " + snapBad + " changed");
    };
    // makeFor(stack): that stack's waiting pushes (per list) or all of them; makeAll(): all; waitingOn(stack) for the check.
    let makeFor, makeAll, waitingOn;
    if (perList) {
      const stacks = [];
      let total = 0, adopted = false;
      const adopt = (st) => { st._powerboatPend = 0; if (check) st._powerboatSnaps = []; stacks.push(st); };
      // Every stack gets the field before the first push, so they all keep one shape.
      const adoptAll = (esm) => { adopted = true; for (const c of esm.GetRuntime().GetAllObjectClasses()) if (c._solStack._powerboatPend === undefined) adopt(c._solStack); };
      const make = (st) => {
        const k = st._powerboatPend;
        st._powerboatPend = 0;
        total -= k;
        if (check) { for (const s of st._powerboatSnaps) snapCompare(s, "made"); st._powerboatSnaps.length = 0; }
        for (let i = 0; i < k; ++i) st.PushCopy();
      };
      makeFor = (st) => { if (st._powerboatPend > 0) make(st); };
      makeAll = () => { if (total !== 0) for (let i = 0, m = stacks.length; i < m; ++i) if (stacks[i]._powerboatPend > 0) make(stacks[i]); };
      waitingOn = (st) => st._powerboatPend > 0 ? st._powerboatPend : 0;
      E.PushCopySol = function (a) {
        if (!adopted) adoptAll(this);
        for (let j = 0, m = a.length; j < m; ++j) {
          const st = a[j]._solStack;
          if (st._powerboatPend === undefined) adopt(st);
          st._powerboatPend++;
          if (check) st._powerboatSnaps.push(snapOne(st));
        }
        total += a.length;
      };
      E.PopSol = function (a) {
        for (let j = 0, m = a.length; j < m; ++j) {
          const st = a[j]._solStack;
          if (st._powerboatPend > 0) { st._powerboatPend--; total--; if (check) snapCompare(st._powerboatSnaps.pop(), "cancelled"); }
          else st.Pop();
        }
      };
      O.GetCurrentSol = function () { const st = this._solStack; if (st._powerboatPend > 0) make(st); return st.GetCurrentSol(); };
      O.GetSolStack = function () { const st = this._solStack; if (st._powerboatPend > 0) make(st); return st; };
      console.log("powerboat: SOL pushes made per list");
    } else {
      const waiting = [], snaps = [];
      let n = 0;
      const flush = () => {
        const count = n;
        n = 0;
        if (check) for (let i = 0; i < count; ++i) for (const s of snaps[i]) snapCompare(s, "made");
        for (let i = 0; i < count; ++i) {
          const a = waiting[i];
          for (let j = 0, m = a.length; j < m; ++j) a[j]._solStack.PushCopy();
        }
      };
      makeFor = () => { if (n !== 0) flush(); };
      makeAll = makeFor;
      waitingOn = () => n;
      E.PushCopySol = function (a) { if (check) snaps[n] = a.map((o) => snapOne(o._solStack)); waiting[n++] = a; };
      E.PopSol = function (a) {
        if (n !== 0) {
          if (waiting[n - 1] === a) { n--; if (check) for (const s of snaps[n]) snapCompare(s, "cancelled"); return; }
          flush();
        }
        for (let j = 0, m = a.length; j < m; ++j) a[j]._solStack.Pop();
      };
      O.GetCurrentSol = function () { if (n !== 0) flush(); return this._solStack.GetCurrentSol(); };
      O.GetSolStack = function () { if (n !== 0) flush(); return this._solStack; };
    }
    // After each sub-event of a top-level group the engine clears the list of every object type that event may
    // pick from (ClearSol): 9.5 % of the JS thread on the TrimUI Smart Pro in Moonstone Island's tutorial, nearly all
    // of it setting "all selected" on lists that already are. A Wait does the like, testing all 544 object types
    // (2 %). The lists that are not "all selected" are kept here (every write of false is in the Sol class); with none,
    // a clear has nothing to do, and a Wait has only its event's own types and these to look at.
    // CONSTRUCT_SOL_DIRTY=0 off.
    const SP = C3.Sol && C3.Sol.prototype, SS = C3.SolStack && C3.SolStack.prototype;
    if (ops.op_powerboat_env("CONSTRUCT_SOL_DIRTY") !== "0" && SP && SS && /\.GetSolStack\(\)\.Clear\(\)/.test(String(E.ClearSol))
      && /_index/.test(String(SS.PushCopy)) && /_stack/.test(String(SS.PushCopy)) && /_current/.test(String(SS.PushCopy))) {
      const dirty = [], todo = [];
      // With some list picked a clear still has hundreds of lists to go through in a top-level group, and all but the
      // picked ones are "all selected" already: only those are looked at now. CONSTRUCT_EVENT_LOOPS=0: every list, as before.
      const pickedOnly = ops.op_powerboat_env("CONSTRUCT_EVENT_LOOPS") !== "0";
      const toClear = (l, a) => !l._selectAll && l._stack && l._stack._current === l && a.includes(l._objectClass);
      for (const name of Object.getOwnPropertyNames(SP)) {
        const base = SP[name];
        if (name === "constructor" || typeof base !== "function" || !/_selectAll\s*=\s*(?:!1|!!|false)/.test(String(base))) continue;
        SP[name] = function (x) {
          const r = base.call(this, x);
          if (!this._selectAll && !this._powerboatDirty) { this._powerboatDirty = true; dirty.push(this); }
          return r;
        };
      }
      // Drops lists that are "all selected" again, and popped ones: being pushed again goes through Reset or Copy.
      const compact = () => {
        let w = 0;
        for (let i = 0, m = dirty.length; i < m; ++i) {
          const l = dirty[i], st = l._stack;
          let keep = false;
          if (!l._selectAll && st) for (let k = st._index; k >= 0; --k) if (st._stack[k] === l) { keep = true; break; }
          if (keep) dirty[w++] = l; else l._powerboatDirty = false;
        }
        if (pickedOnly) { while (dirty.length > w) dirty.pop(); } // `length =` is a native call
        else dirty.length = w;
      };
      let fast = 0, slow = 0, badClear = 0, inits = 0, badInit = 0;
      const counts = () => { if ((fast + slow) % 200000 === 0) console.log("powerboat: SOL dirty check: clears " + fast + " skipped, " + slow + " run, " + badClear + " wrong; waits " + inits + ", " + badInit + " wrong"); };
      E.ClearSol = function (a) {
        if (dirty.length === 0) {
          if (check) {
            fast++;
            for (let j = 0, m = a.length; j < m; ++j) {
              if (!a[j]._solStack._current._selectAll && badClear++ < 20) console.error("powerboat: SOL clear skipped with " + a[j].GetName() + " picked: " + new Error().stack);
            }
            counts();
          }
          return;
        }
        if (pickedOnly) {
          // Waiting pushes need not be made unless a list changes: a copy of "all selected" stays that. The stacks are
          // taken first, because making a waiting push adds its copy to the dirty list.
          let k = 0;
          for (let i = 0, m = dirty.length; i < m; ++i) if (toClear(dirty[i], a)) todo[k++] = dirty[i]._stack;
          for (let i = 0; i < k; ++i) { const st = todo[i]; makeFor(st); st.Clear(); }
        } else {
          for (let j = 0, m = a.length; j < m; ++j) { const st = a[j]._solStack; makeFor(st); st.Clear(); }
        }
        compact();
        if (check) {
          slow++;
          for (let j = 0, m = a.length; j < m; ++j) {
            if (!a[j]._solStack._current._selectAll && badClear++ < 20) console.error("powerboat: SOL clear skipped with " + a[j].GetName() + " picked: " + new Error().stack);
          }
          counts();
        }
      };
      const W = C3.ScheduledWait && C3.ScheduledWait.prototype, R = C3.Runtime && C3.Runtime.prototype;
      if (W && R && typeof W._Init === "function" && /GetAllObjectClasses\(\)/.test(String(W._Init)) && /HasSolModifier/.test(String(W._Init))) {
        const baseAll = R.GetAllObjectClasses, baseInit = W._Init;
        let reduced = null;
        R.GetAllObjectClasses = function () {
          if (reduced === null) return baseAll.call(this);
          const r = reduced;
          reduced = null;
          return r;
        };
        W._Init = function () {
          makeAll();
          const ev = this._eventSheetManager.GetCurrentEventStackFrame().GetCurrentEvent();
          const list = ev.GetSolModifiers().slice();
          for (let i = 0, m = dirty.length; i < m; ++i) {
            const l = dirty[i];
            if (!l._selectAll && l._stack && l._stack._current === l && !list.includes(l._objectClass)) list.push(l._objectClass);
          }
          reduced = list;
          const r = baseInit.call(this);
          reduced = null;
          if (check) {
            inits++;
            const got = new Set(this._solModifiers);
            for (const c of baseAll.call(this._eventSheetManager.GetRuntime())) {
              const want = !c._solStack._current._selectAll || ev.HasSolModifier(c);
              if (want !== got.has(c) && badInit++ < 20) console.error("powerboat: SOL wait list differs at " + c.GetName() + " (expected " + want + ")");
            }
          }
          return r;
        };
      }
    }
    if (check && C3.SolStack) {
      let bad = 0, calls = 0;
      const S = C3.SolStack.prototype;
      for (const name of Object.getOwnPropertyNames(S)) {
        const base = S[name];
        if (name === "constructor" || typeof base !== "function") continue;
        S[name] = function (...args) {
          // Making pushes zeroes the count before it pushes, so this sees only a stack used behind the patch's back.
          const w = waitingOn(this);
          if (w !== 0 && bad++ < 20) console.error("powerboat: SOL stack " + name + " with " + w + " pushes waiting: " + new Error().stack);
          if (++calls % 2000000 === 0) console.log("powerboat: SOL defer check: " + calls + " stack calls, " + bad + " behind the patch");
          return base.apply(this, args);
        };
      }
    }
  };

  // ---- Construct 3: local variable frames and group names ---------------------------------------------
  // A function call made from inside a trigger pushes a frame holding every local variable in the project. The engine
  // refills a recycled frame with C3.shallowAssignArray: empty the array, then push(...all initial values). It is the
  // same length each time, so a new frame is now a plain copy of them (Array slice is a memory copy; a JS loop over 2,172
  // values was still 1.7 % of the JS thread on the TrimUI Smart Pro; CONSTRUCT_EVENT_LOOPS=0 keeps that loop).
  // CONSTRUCT_LOCAL_FRAMES=0 off, =check counts them and compares each frame with the initial values.
  // "Is group active" looks its group up by name each time, lower-casing the string first; the names used are now kept
  // as written. CONSTRUCT_GROUP_NAMES=0 off.
  let eventSmallDone = false;
  const patchEventSmall = () => {
    const C3 = g.C3, L = C3 && C3.LocalVarStack && C3.LocalVarStack.prototype, E = C3 && C3.EventSheetManager && C3.EventSheetManager.prototype;
    if (eventSmallDone || !L || !E) return;
    eventSmallDone = true;
    const framesMode = ops.op_powerboat_env("CONSTRUCT_LOCAL_FRAMES");
    const pushSrc = String(L.Push);
    if (framesMode !== "0" && /shallowAssignArray\(\w+\[\w+\],\s*this\._initialValues\)/.test(pushSrc) && /this\._index/.test(pushSrc) && /this\._current=/.test(pushSrc.replace(/\s/g, ""))) {
      const check = framesMode === "check";
      const copyFrames = ops.op_powerboat_env("CONSTRUCT_EVENT_LOOPS") !== "0";
      let pushes = 0, grown = 0, bad = 0;
      L.Push = function () {
        const i = ++this._index, st = this._stack, init = this._initialValues;
        if (i === st.length) {
          st.push(init.slice(0));
          if (check) grown++;
        } else if (copyFrames) {
          st[i] = init.slice(0);
        } else {
          const f = st[i], n = init.length;
          if (f.length === n) { for (let k = 0; k < n; ++k) f[k] = init[k]; }
          else C3.shallowAssignArray(f, init);
        }
        this._current = st[i];
        if (check) {
          const f = st[i];
          if (f.length !== init.length || f.some((x, k) => x !== init[k])) bad++;
          if (++pushes % 20000 === 0) console.log("powerboat: local frames check: " + pushes + " pushes of " + init.length + " values, depth " + i + ", " + grown + " new frames, " + bad + " wrong");
        }
      };
    }
    if (ops.op_powerboat_env("CONSTRUCT_GROUP_NAMES") !== "0" && /_groupsByName\.get\(\w+\.toLowerCase\(\)\)/.test(String(E.GetEventGroupByName))) {
      const asWritten = new Map();
      E.GetEventGroupByName = function (a) {
        let r = asWritten.get(a);
        if (r === undefined) {
          r = this._groupsByName.get(a.toLowerCase()) || null;
          if (r !== null) {
            if (asWritten.size >= 4096) asWritten.clear();
            asWritten.set(a, r);
          }
        }
        return r;
      };
    }
    // Strings the engine works out again on every call (native time, most of it case folding and regular expressions):
    // C3.equalsNoCase runs normalize().toLowerCase() on both sides whenever they differ ("Is animation playing"), and
    // the system expressions find, findcase and replace build a new RegExp each call. The results are kept by string.
    // CONSTRUCT_STRING_CACHES=0 off, =check compares every answer with the engine's own function.
    const strMode = ops.op_powerboat_env("CONSTRUCT_STRING_CACHES");
    if (strMode !== "0") {
      const check = strMode === "check";
      let calls = 0, bad = 0;
      const tally = (ok, what) => {
        if (!ok && bad++ < 20) console.error("powerboat: string cache differs in " + what + ": " + new Error().stack);
        if (++calls % 200000 === 0) console.log("powerboat: string cache check: " + calls + " calls, " + bad + " wrong");
      };
      const baseEq = C3.equalsNoCase;
      if (typeof baseEq === "function" && /normalize\(\)\.toLowerCase\(\)/.test(String(baseEq))) {
        const folded = new Map();
        const fold = (s) => {
          let r = folded.get(s);
          if (r === undefined) {
            r = s.normalize().toLowerCase();
            if (folded.size >= 4096) folded.clear();
            folded.set(s, r);
          }
          return r;
        };
        C3.equalsNoCase = function (a, b) {
          const r = typeof a === "string" && typeof b === "string" && (a === b || fold(a) === fold(b));
          if (check) tally(r === baseEq(a, b), "equalsNoCase");
          return r;
        };
      }
      const X = C3.Plugins && C3.Plugins.System && C3.Plugins.System.Exps;
      const makesRegExp = (f) => typeof f === "function" && /new RegExp/.test(String(f)) && /EscapeRegex/.test(String(f));
      if (X && typeof C3.EscapeRegex === "function" && makesRegExp(X.find) && makesRegExp(X.findcase) && makesRegExp(X.replace)) {
        const regExps = (flags) => {
          const m = new Map();
          return (s) => {
            let r = m.get(s);
            if (r === undefined) {
              r = new RegExp(C3.EscapeRegex(s), flags);
              if (m.size >= 1024) m.clear();
              m.set(s, r);
            }
            return r;
          };
        };
        const anyCase = regExps("i"), exactCase = regExps(""), allAnyCase = regExps("gi");
        const baseFind = X.find, baseFindCase = X.findcase, baseReplace = X.replace;
        X.find = function (a, b) {
          const r = typeof a === "string" && typeof b === "string" ? a.search(anyCase(b)) : -1;
          if (check) tally(r === baseFind(a, b), "find");
          return r;
        };
        X.findcase = function (a, b) {
          const r = typeof a === "string" && typeof b === "string" ? a.search(exactCase(b)) : -1;
          if (check) tally(r === baseFindCase(a, b), "findcase");
          return r;
        };
        X.replace = function (a, b, c) {
          const r = typeof a === "string" && typeof b === "string" && typeof c === "string" ? a.replace(allAnyCase(b), c) : typeof a === "string" ? a : "";
          if (check) tally(r === baseReplace(a, b, c), "replace");
          return r;
        };
      }
    }
  };

  const clipExec = g.HTMLScriptElement.prototype._exec;
  g.HTMLScriptElement.prototype._exec = function () {
    const r = clipExec.call(this);
    try { patchCanvasClient(); } catch (e) { console.error("powerboat: canvas client patch:", e); }
    try { patchJsonPaths(); } catch (e) { console.error("powerboat: JSON paths patch:", e); }
    try { patchSolDefer(); } catch (e) { console.error("powerboat: SOL defer patch:", e); }
    try { patchEventSmall(); } catch (e) { console.error("powerboat: event small patch:", e); }
    try { patchLayerClip(); } catch (e) { console.error("powerboat: layer clip patch:", e); }
    try { patchSmallFx(); } catch (e) { console.error("powerboat: small fx patch:", e); }
    try { patchBatchWrite(); } catch (e) { console.error("powerboat: batch write patch:", e); }
    try { patchPolyShare(); } catch (e) { console.error("powerboat: poly share patch:", e); }
    try { patchForcedOwnTexture(); } catch (e) { console.error("powerboat: forced own texture patch:", e); }
    try { patchSkipEmptyLayers(); } catch (e) { console.error("powerboat: empty layer patch:", e); }
    try { patchLayoutTexture(); } catch (e) { console.error("powerboat: layout texture patch:", e); }
    try { patchLazyFrames(); } catch (e) { console.error("powerboat: lazy frames patch:", e); }
    try { patchFetchJson(); } catch (e) { console.error("powerboat: fetch json patch:", e); }
    return r;
  };
})();
