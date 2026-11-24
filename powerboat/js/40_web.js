// powerboat JS environment, part 5: the web platform pieces MV's boot needs. XMLHttpRequest
// over local files (POST to an http sink prints to stdout: the PM_Bench protocol), Blob and
// object URLs (MV's Decrypter hands decrypted images to Image.src this way), file-backed
// localStorage (MV web saves), document.fonts with @font-face parsing from the game's CSS,
// <audio>/<video> element stubs and a stub AudioContext (50_audio.js replaces it), TextEncoder/Decoder,
// and __powerboat.bootHtml: running index.html the way a browser would (stylesheets, scripts in
// order, DOMContentLoaded, window.onload).
"use strict";
(() => {
  const core = Deno.core;
  const ops = core.ops;
  const g = globalThis;

  // ---- bytes / text ----------------------------------------------------------------------------
  const readBytes = (path) => {
    const b = ops.op_powerboat_read_bytes(path);
    const err = ops.op_powerboat_take_io_error();
    if (err) throw new Error(err);
    return b;
  };
  const toArrayBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;
  class TextDecoder {
    constructor(label = "utf-8") { this.encoding = String(label).toLowerCase(); }
    decode(input) {
      if (input === undefined) return "";
      const u8 = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return core.decode(u8);
    }
  }
  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(s = "") { return core.encode(String(s)); }
  }
  g.TextDecoder = g.TextDecoder || TextDecoder;
  g.TextEncoder = g.TextEncoder || TextEncoder;
  const decodeUtf8 = (u8) => core.decode(u8);
  // JSON text kept one-byte for V8 (src/ops.rs json_one_byte: characters above U+00FF as \u escapes): half the
  // memory during JSON.parse and V8's faster one-byte parser. POWERBOAT_JSON_ONE_BYTE=0 off.
  const JSON_ONE_BYTE = Deno.core.ops.op_powerboat_env("POWERBOAT_JSON_ONE_BYTE") !== "0";
  const decodeJson = (u8) => {
    if (JSON_ONE_BYTE && u8.length > 4096) {
      const s = Deno.core.ops.op_json_one_byte(u8);
      if (s != null) return s;
    }
    return core.decode(u8);
  };
  __powerboat.decodeJson = JSON_ONE_BYTE ? decodeJson : null;

  // ---- Blob / URL -------------------------------------------------------------------------------
  const partBytes = (p) => {
    if (p instanceof Blob) return p._bytes;
    if (typeof p === "string") return core.encode(p);
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    return core.encode(String(p));
  };
  class Blob {
    constructor(parts = [], options = {}) {
      const chunks = Array.from(parts, partBytes);
      const size = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.byteLength; }
      this._bytes = out;
      this.size = size;
      this.type = String(options.type || "").toLowerCase();
    }
    slice(start = 0, end = this.size, type = "") { return new Blob([this._bytes.subarray(start, end)], { type }); }
    arrayBuffer() { return Promise.resolve(this._bytes.slice().buffer); }
    text() { return Promise.resolve(decodeUtf8(this._bytes)); }
    stream() { throw new Error("powerboat: Blob.stream not implemented"); }
  }
  class File extends Blob {
    constructor(parts, name, options = {}) { super(parts, options); this.name = String(name); this.lastModified = Date.now(); }
  }
  g.Blob = Blob;
  g.File = File;

  const blobUrls = new Map();
  let blobSeq = 0;
  class URL {
    constructor(url, base) {
      let s = String(url);
      if (base !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        const b = String(base);
        s = b.replace(/[^/]*$/, "") + s;
      }
      this.href = s;
      const m = /^([a-z][a-z0-9+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s) || [];
      this.protocol = m[1] || ""; this.host = m[2] || ""; this.hostname = this.host.replace(/:\d+$/, "");
      this.pathname = m[3] || ""; this.search = m[4] || ""; this.hash = m[5] || "";
      this.origin = this.protocol && this.host ? this.protocol + "//" + this.host : "null";
      this.searchParams = { get: (k) => { const r = new RegExp("[?&]" + k + "=([^&]*)").exec(this.search); return r ? decodeURIComponent(r[1]) : null; }, has: (k) => new RegExp("[?&]" + k + "(=|&|$)").test(this.search) };
    }
    toString() { return this.href; }
    static createObjectURL(blob) { const u = "blob:powerboat/" + (++blobSeq); blobUrls.set(u, blob); return u; }
    static revokeObjectURL(u) { blobUrls.delete(u); }
  }
  g.URL = URL;
  g.webkitURL = URL;
  __powerboat.blobImage = (url) => {
    const b = blobUrls.get(url);
    if (!b) return [0, 0, 0, "revoked or unknown blob URL"];
    return ops.op_image_decode(b._bytes);
  };
  __powerboat.blobBytes = (url) => { const b = blobUrls.get(url); return b ? b._bytes : null; };

  // ---- XMLHttpRequest ---------------------------------------------------------------------------
  const MIME = { json: "application/json", js: "text/javascript", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", ogg: "audio/ogg", m4a: "audio/mp4", webm: "video/webm", mp4: "video/mp4", css: "text/css", html: "text/html", ttf: "font/ttf", yaml: "text/yaml", yml: "text/yaml" };
  class XMLHttpRequest extends EventTarget {
    constructor() {
      super();
      this.readyState = 0; this.status = 0; this.statusText = "";
      this.responseType = ""; this.response = null; this._responseText = "";
      this.responseURL = ""; this.timeout = 0; this.withCredentials = false;
      this.upload = new EventTarget();
      this._headers = {}; this._mime = null; this._ctype = "";
    }
    static get UNSENT() { return 0; } static get OPENED() { return 1; } static get HEADERS_RECEIVED() { return 2; } static get LOADING() { return 3; } static get DONE() { return 4; }
    // On every request too, as in browsers: three.js's JSONLoader waits for `readyState === xhr.DONE`.
    get UNSENT() { return 0; } get OPENED() { return 1; } get HEADERS_RECEIVED() { return 2; } get LOADING() { return 3; } get DONE() { return 4; }
    get responseText() { return this._responseText; }
    get responseXML() { return null; }
    open(method, url, async = true) {
      this._method = String(method).toUpperCase(); this._url = String(url); this._async = async !== false;
      this._aborted = false; this.readyState = 1; this._change();
    }
    setRequestHeader(k, v) { this._headers[String(k).toLowerCase()] = String(v); }
    overrideMimeType(m) { this._mime = String(m); }
    getResponseHeader(k) { return String(k).toLowerCase() === "content-type" ? this._ctype : null; }
    getAllResponseHeaders() { return this._ctype ? "content-type: " + this._ctype + "\r\n" : ""; }
    abort() { this._aborted = true; this.readyState = 0; }
    _change() { this.dispatchEvent(new Event("readystatechange")); }
    send(body) {
      // Async replies come a task later. One sent while the page boots is counted (__powerboat.bootXhr): the load event
      // waits for it, as a local XHR in NW.js finishes long before load (RPG Maker MZ's main.js checks its
      // testXhr in onload: "Your browser does not allow to read local files").
      const deliver = (fn) => {
        if (!this._async) return fn();
        const boot = !!__powerboat.booting;
        if (boot) __powerboat.bootXhr++;
        setTimeout(() => { try { fn(); } finally { if (boot) __powerboat.bootXhr--; } }, 0);
      };
      if (/^https?:/i.test(this._url)) {
        if (this._method === "POST") {
          // A benchmark/report sink: the body goes to stdout in the sink's own "time text" format.
          const text = typeof body === "string" ? body : body instanceof Blob ? decodeUtf8(body._bytes) : String(body);
          ops.op_powerboat_log((performance.now() / 1000).toFixed(1).padStart(7) + " " + text, false);
          deliver(() => this._finish(204, "No Content", new Uint8Array(0)));
        } else {
          deliver(() => this._fail());
        }
        return;
      }
      let bytes;
      if (this._url.startsWith("blob:")) {
        bytes = __powerboat.blobBytes(this._url);
        if (!bytes) { deliver(() => this._fail()); return; }
      } else {
        try { bytes = readBytes(__powerboat.resolvePath(this._url)); } catch (e) { deliver(() => this._fail()); return; }
      }
      deliver(() => this._finish(200, "OK", bytes));
    }
    _fail() {
      if (this._aborted) return;
      this.readyState = 4; this.status = 0; this._change();
      this.dispatchEvent(new Event("error")); this.dispatchEvent(new Event("loadend"));
    }
    _finish(status, statusText, bytes) {
      if (this._aborted) return;
      this.status = status; this.statusText = statusText; this.responseURL = this._url;
      const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(this._url) || [])[1];
      this._ctype = this._mime || MIME[ext && ext.toLowerCase()] || "application/octet-stream";
      switch (this.responseType) {
        case "": case "text": this._responseText = decodeUtf8(bytes); this.response = this._responseText; break;
        case "json": try { this.response = JSON.parse(decodeJson(bytes)); } catch (_) { this.response = null; } break;
        case "arraybuffer": this.response = toArrayBuffer(bytes); break;
        case "blob": this.response = new Blob([bytes], { type: this._ctype }); break;
        default: this.response = null;
      }
      this.readyState = 2; this._change(); this.readyState = 3; this._change(); this.readyState = 4; this._change();
      this.dispatchEvent(new Event("load")); this.dispatchEvent(new Event("loadend"));
    }
  }
  g.XMLHttpRequest = XMLHttpRequest;
  g.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(init.method || "GET", String(url));
    x.responseType = "arraybuffer";
    x.onload = () => resolve({
      ok: x.status < 400, status: x.status, url: String(url), headers: { get: (k) => x.getResponseHeader(k) },
      arrayBuffer: () => Promise.resolve(x.response), text: () => Promise.resolve(decodeUtf8(new Uint8Array(x.response))),
      json: () => Promise.resolve(JSON.parse(decodeJson(new Uint8Array(x.response)))), blob: () => Promise.resolve(new Blob([x.response])),
    });
    x.onerror = () => reject(new TypeError("powerboat: fetch failed: " + url));
    x.send(init.body);
  });

  // ---- localStorage (file-backed JSON, written at most once per frame) --------------------------
  // POWERBOAT_DATA_DIR (tests): web storage and the NW.js home (60_node.js) go there instead of the game
  // folder, so a bench can run from a copy of a save without touching the player's own.
  __powerboat.dataHome = Deno.core.ops.op_powerboat_env("POWERBOAT_DATA_DIR") || "";
  __powerboat.dataDir = (__powerboat.dataHome || __powerboat.root) + "/save";
  class Storage {
    constructor(path) {
      this._path = path; this._map = new Map(); this._timer = 0;
      if (ops.op_powerboat_exists(path)) {
        try { for (const [k, v] of Object.entries(JSON.parse(__powerboat.readText(path)))) this._map.set(k, String(v)); }
        catch (e) { console.warn("powerboat: localStorage file unreadable: " + e); }
      }
    }
    get length() { return this._map.size; }
    key(i) { return i < this._map.size ? [...this._map.keys()][i] : null; }
    getItem(k) { const v = this._map.get(String(k)); return v === undefined ? null : v; }
    setItem(k, v) { this._map.set(String(k), String(v)); this._dirty(); }
    removeItem(k) { if (this._map.delete(String(k))) this._dirty(); }
    clear() { this._map.clear(); this._dirty(); }
    _dirty() { if (!this._timer) this._timer = setTimeout(() => { this._timer = 0; this.flush(); }, 0); }
    flush() {
      const obj = {}; for (const [k, v] of this._map) obj[k] = v;
      let err = ops.op_powerboat_mkdirs(__powerboat.dataDir);
      if (!err) err = ops.op_powerboat_write_text(this._path, JSON.stringify(obj));
      if (err) console.error("powerboat: localStorage write failed: " + err);
    }
  }
  g.Storage = Storage;
  g.localStorage = new Storage(__powerboat.dataDir + "/webstorage.json");
  g.sessionStorage = new Storage("");
  g.sessionStorage.flush = () => {};
  __powerboat.flushStorage = () => { if (g.localStorage._timer) { clearTimeout(g.localStorage._timer); g.localStorage._timer = 0; g.localStorage.flush(); } };

  // ---- fonts ------------------------------------------------------------------------------------
  const loadedFamilies = new Set();
  const loadFontFile = (family, url, baseDir, bold, italic) => {
    let path = url.replace(/^["']|["']$/g, "");
    if (!family || !path || path.endsWith("/")) { console.warn("powerboat: @font-face ignored: family '" + family + "' src '" + path + "'"); return false; }
    if (!/^([A-Za-z]:\/|\/|file:)/.test(path)) path = baseDir + "/" + path;
    const err = ops.op_font_load(family, __powerboat.resolvePath(path), !!bold, !!italic);
    if (err) { console.warn("powerboat: font " + family + ": " + err); return false; }
    loadedFamilies.add(family);
    console.log("powerboat: font " + family + " <- " + path);
    return true;
  };
  // @font-face rules in a stylesheet; urls are relative to the stylesheet's folder.
  __powerboat.parseFontFaces = (css, baseDir) => {
    for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const body = m[1];
      const fam = /font-family\s*:\s*([^;]+)/i.exec(body);
      const src = [...body.matchAll(/src\s*:\s*([^;]+)/gi)].pop(); // the last src declaration wins, as in CSS
      if (!fam || !src) continue;
      // The first TrueType/OpenType source (by format() or extension): the font loader reads no .eot, .svg or .woff,
      // and Font Squirrel's rules list the .eot first.
      const urls = [...src[1].matchAll(/url\(\s*([^)]+?)\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/gi)];
      const ttf = (u) => /^(truetype|opentype)$/i.test(u[2] || "") || /\.(ttf|otf|ttc)(["'?#]|$)/i.test(u[1]);
      const url = urls.find(ttf) || urls[0];
      if (!url) continue;
      const weight = /font-weight\s*:\s*([^;]+)/i.exec(body);
      const style = /font-style\s*:\s*([^;]+)/i.exec(body);
      const bold = weight ? /bold|[6-9]00/i.test(weight[1]) : false;
      const italic = style ? /italic|oblique/i.test(style[1]) : false;
      loadFontFile(fam[1].trim().replace(/^["']|["']$/g, ""), url[1], baseDir, bold, italic);
    }
  };
  __powerboat.loadStylesheet = (href) => {
    const path = __powerboat.resolvePath(href);
    let css;
    try { css = __powerboat.readText(path); } catch (e) { console.warn("powerboat: stylesheet " + href + ": " + e.message); return; }
    __powerboat.parseFontFaces(css, path.replace(/[^/]*$/, "").replace(/\/$/, "") || ".");
  };
  class FontFace {
    constructor(family, source, descriptors = {}) {
      this.family = String(family); this._source = source; this.weight = descriptors.weight || "normal"; this.style = descriptors.style || "normal";
      this.status = "unloaded";
      this.loaded = new Promise((res) => { this._resolve = res; });
    }
    load() {
      if (this.status === "unloaded") {
        const url = typeof this._source === "string" ? (/url\(\s*([^)]+?)\s*\)/i.exec(this._source) || [])[1] || this._source : null;
        const ok = url ? loadFontFile(this.family, url, __powerboat.root, /bold|[6-9]00/i.test(this.weight), /italic|oblique/i.test(this.style)) : false;
        this.status = ok ? "loaded" : "error";
        this._resolve(this);
      }
      return this.loaded;
    }
  }
  g.FontFace = FontFace;
  const fontSet = new EventTarget();
  Object.assign(fontSet, {
    status: "loaded",
    size: 0,
    ready: null,
    check() { return true; },
    load(spec) { return Promise.resolve([]); },
    add(ff) { if (ff instanceof FontFace) ff.load(); this.size++; return this; },
    delete() { return false; },
    has(ff) { return ff instanceof FontFace && ff.status === "loaded"; },
    forEach() {},
    clear() {},
  });
  fontSet.ready = Promise.resolve(fontSet);
  g.FontFaceSet = function FontFaceSet() {};
  g.FontFaceSet.prototype = Object.getPrototypeOf(fontSet);
  document.fonts = fontSet;
  // <style> elements: sheet.insertRule with @font-face (Graphics.loadFont in MV 1.6).
  class HTMLStyleElement extends HTMLElement {
    constructor() {
      super("style");
      this.sheet = { cssRules: [], insertRule: (rule, i) => { this.sheet.cssRules.splice(i | 0, 0, rule); __powerboat.parseFontFaces(String(rule), __powerboat.root); return i | 0; }, deleteRule() {} };
    }
    appendChild(c) { super.appendChild(c); if (c.textContent) __powerboat.parseFontFaces(String(c.textContent), __powerboat.root); return c; }
  }
  g.HTMLStyleElement = HTMLStyleElement;

  // ---- <audio>, <video>, AudioContext stub ---------------------------------------------------
  class HTMLMediaElement extends HTMLElement {
    constructor(tag) {
      super(tag);
      this._src = ""; this.currentTime = 0; this.duration = NaN; this.paused = true; this.ended = false; this.muted = false;
      this.volume = 1; this.loop = false; this.autoplay = false; this.playbackRate = 1; this.readyState = 0; this.networkState = 0;
      this.buffered = { length: 0, start: () => 0, end: () => 0 }; this.preload = "auto"; this.crossOrigin = null;
    }
    get src() { return this._src; }
    set src(v) { this._src = String(v); }
    get currentSrc() { return this._src; }
    // Other formats answer "maybe" so a game offering Ogg too keeps picking it.
    canPlayType(type) { return /ogg|vorbis/i.test(type) ? "probably" : /mpeg|mp3|mp4|m4a|aac|wav/i.test(type) ? "maybe" : ""; }
    load() { if (this._src) setTimeout(() => this.dispatchEvent(new Event("error")), 0); }
    play() { return Promise.resolve(); }
    pause() {}
    addTextTrack() { return null; }
    get HAVE_NOTHING() { return 0; } get HAVE_METADATA() { return 1; } get HAVE_CURRENT_DATA() { return 2; } get HAVE_FUTURE_DATA() { return 3; } get HAVE_ENOUGH_DATA() { return 4; }
    get NETWORK_EMPTY() { return 0; } get NETWORK_IDLE() { return 1; } get NETWORK_LOADING() { return 2; } get NETWORK_NO_SOURCE() { return 3; }
  }
  class HTMLAudioElement extends HTMLMediaElement { constructor(src) { super("audio"); if (src) this.src = src; } }
  class HTMLVideoElement extends HTMLMediaElement {
    constructor() { super("video"); this.videoWidth = 0; this.videoHeight = 0; this.width = 0; this.height = 0; this.playsInline = false; }
    canPlayType(type) { return ""; } // M3: webm through vpx
  }
  g.HTMLMediaElement = HTMLMediaElement;
  g.HTMLAudioElement = HTMLAudioElement;
  g.HTMLVideoElement = HTMLVideoElement;
  g.Audio = function Audio(src) { return new HTMLAudioElement(src); };
  g.Audio.prototype = HTMLAudioElement.prototype;

  if (typeof g.AudioContext === "undefined") {
    // Silent stand-in for when no audio device opens; 50_audio.js replaces it when one does. Keep the two APIs the
    // same: whatever is missing here throws only on a device without audio, where nobody looks (an ImpactJS game stayed
    // black over one compressor param).
    __powerboat.audioStub = true;
    class AudioParam {
      constructor(v) { this._v = v; this.defaultValue = v; this.minValue = -3.4e38; this.maxValue = 3.4e38; }
      get value() { return this._v; }
      set value(v) { v = +v; if (Number.isFinite(v)) this._v = v; }
      setValueAtTime(v) { this.value = v; return this; } linearRampToValueAtTime(v) { this.value = v; return this; }
      exponentialRampToValueAtTime(v) { this.value = v; return this; } setTargetAtTime(v) { this.value = v; return this; }
      setValueCurveAtTime(curve) { if (curve && curve.length) this.value = curve[curve.length - 1]; return this; }
      cancelScheduledValues() { return this; } cancelAndHoldAtTime() { return this; }
    }
    class AudioNode extends EventTarget {
      constructor(ctx) { super(); this.context = ctx; this.numberOfInputs = 1; this.numberOfOutputs = 1; this.channelCount = 2; this.channelCountMode = "max"; this.channelInterpretation = "speakers"; }
      connect(n) { return n; } disconnect() {}
    }
    class AudioDestinationNode extends AudioNode { constructor(ctx) { super(ctx); this.maxChannelCount = 2; this.numberOfOutputs = 0; } }
    class GainNode extends AudioNode { constructor(ctx) { super(ctx); this.gain = new AudioParam(1); } }
    class PannerNode extends AudioNode {
      constructor(ctx) {
        super(ctx);
        this.panningModel = "equalpower"; this.distanceModel = "inverse"; this.refDistance = 1; this.maxDistance = 10000;
        this.rolloffFactor = 1; this.coneInnerAngle = 360; this.coneOuterAngle = 360; this.coneOuterGain = 0;
        this.positionX = new AudioParam(0); this.positionY = new AudioParam(0); this.positionZ = new AudioParam(0);
        this.orientationX = new AudioParam(1); this.orientationY = new AudioParam(0); this.orientationZ = new AudioParam(0);
      }
      setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
      setOrientation(x, y, z) { this.orientationX.value = x; this.orientationY.value = y; this.orientationZ.value = z; }
      setVelocity() {}
    }
    class StereoPannerNode extends AudioNode { constructor(ctx) { super(ctx); this.pan = new AudioParam(0); } }
    class AnalyserNode extends AudioNode {
      constructor(ctx) { super(ctx); this.fftSize = 2048; this.frequencyBinCount = 1024; this.minDecibels = -100; this.maxDecibels = -30; this.smoothingTimeConstant = 0.8; }
      getByteFrequencyData(a) { a.fill(0); } getByteTimeDomainData(a) { a.fill(128); } getFloatFrequencyData(a) { a.fill(-100); } getFloatTimeDomainData(a) { a.fill(0); }
    }
    class BiquadFilterNode extends AudioNode { constructor(ctx) { super(ctx); this.type = "lowpass"; this.frequency = new AudioParam(350); this.Q = new AudioParam(1); this.gain = new AudioParam(0); this.detune = new AudioParam(0); } getFrequencyResponse() {} }
    class DynamicsCompressorNode extends AudioNode { constructor(ctx) { super(ctx); this.threshold = new AudioParam(-24); this.knee = new AudioParam(30); this.ratio = new AudioParam(12); this.attack = new AudioParam(0.003); this.release = new AudioParam(0.25); this.reduction = 0; } }
    class DelayNode extends AudioNode { constructor(ctx) { super(ctx); this.delayTime = new AudioParam(0); } }
    class OscillatorNode extends AudioNode {
      constructor(ctx) { super(ctx); this.type = "sine"; this.frequency = new AudioParam(440); this.detune = new AudioParam(0); this.onended = null; this._started = false; this._done = false; }
      start() {
        if (this._started) throw new Error("powerboat: OscillatorNode.start called twice");
        this._started = true;
      }
      stop(when = 0) {
        if (!this._started) return;
        setTimeout(() => { if (!this._done) { this._done = true; this.dispatchEvent(new Event("ended")); } }, Math.max(0, when - this.context.currentTime) * 1000);
      }
    }
    class AudioBufferSourceNode extends AudioNode {
      constructor(ctx) { super(ctx); this.buffer = null; this.loop = false; this.loopStart = 0; this.loopEnd = 0; this.playbackRate = new AudioParam(1); this.detune = new AudioParam(0); this.onended = null; this._started = false; this._timer = 0; this._done = false; }
      start(when = 0, offset = 0, duration) {
        if (this._started) throw new Error("powerboat: AudioBufferSourceNode.start called twice");
        this._started = true;
        if (!this.buffer) return;
        const left = this.loop ? Infinity : Math.max(0, this.buffer.duration - offset) / ((this.playbackRate.value || 1) * 2 ** (this.detune.value / 1200));
        const plays = duration > 0 ? Math.min(duration, left) : left;
        if (plays !== Infinity) this._endAt(Math.max(when, this.context.currentTime) + plays);
      }
      // As with a mixer: a started source ends once, by itself or at stop, and fires "ended" then.
      stop(when = 0) { if (this._started && this.buffer) this._endAt(when); }
      _endAt(t) {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => { if (!this._done) { this._done = true; this.dispatchEvent(new Event("ended")); } }, Math.max(0, t - this.context.currentTime) * 1000);
      }
    }
    class AudioBuffer {
      constructor(channels, length, sampleRate) { this.numberOfChannels = channels; this.length = length; this.sampleRate = sampleRate; this.duration = length / sampleRate; this._channels = []; }
      getChannelData(ch) {
        ch |= 0;
        if (ch < 0 || ch >= this.numberOfChannels) throw new RangeError("powerboat: channel index out of range");
        return this._channels[ch] || (this._channels[ch] = new Float32Array(this.length));
      }
      copyFromChannel(dst, ch, start = 0) { dst.set(this.getChannelData(ch).subarray(start, start + dst.length)); }
      copyToChannel(src, ch, start = 0) { this.getChannelData(ch).set(src.subarray(0, Math.min(src.length, this.length - start)), start); }
    }
    class AudioContext extends EventTarget {
      constructor() {
        super();
        this.sampleRate = 44100; this.state = "running"; this.destination = new AudioDestinationNode(this); this._t0 = performance.now(); this.onstatechange = null; this.baseLatency = 1024 / this.sampleRate;
        const p = (v) => new AudioParam(v);
        this.listener = {
          positionX: p(0), positionY: p(0), positionZ: p(0), forwardX: p(0), forwardY: p(0), forwardZ: p(-1), upX: p(0), upY: p(1), upZ: p(0),
          setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; },
          setOrientation(fx, fy, fz, ux, uy, uz) { this.forwardX.value = fx; this.forwardY.value = fy; this.forwardZ.value = fz; this.upX.value = ux; this.upY.value = uy; this.upZ.value = uz; },
          setVelocity() {},
        };
      }
      get currentTime() { return (performance.now() - this._t0) / 1000; }
      createGain() { return new GainNode(this); }
      createPanner() { return new PannerNode(this); }
      createStereoPanner() { return new StereoPannerNode(this); }
      createBufferSource() { return new AudioBufferSourceNode(this); }
      createBuffer(c, l, r) { return new AudioBuffer(c, l, r); }
      createAnalyser() { return new AnalyserNode(this); }
      createDynamicsCompressor() { return new DynamicsCompressorNode(this); }
      createBiquadFilter() { return new BiquadFilterNode(this); }
      createDelay() { return new DelayNode(this); }
      createOscillator() { return new OscillatorNode(this); }
      createConvolver() { return new AudioNode(this); }
      createWaveShaper() { return new AudioNode(this); }
      createChannelMerger() { return new AudioNode(this); }
      createChannelSplitter() { return new AudioNode(this); }
      createScriptProcessor() { return Object.assign(new AudioNode(this), { onaudioprocess: null }); }
      createMediaElementSource() { throw new Error("powerboat: MediaElementAudioSourceNode not supported"); }
      decodeAudioData(data, ok, fail) {
        // Decoding needs the mixer (op_audio_decode), so this is a fixed guess at the length: every sound lasts 2 s.
        const buffer = new AudioBuffer(2, 44100 * 2, 44100);
        const p = new Promise((res) => setTimeout(() => res(buffer), 0));
        if (ok) p.then(ok);
        return p;
      }
      resume() { this.state = "running"; return Promise.resolve(); }
      suspend() { this.state = "suspended"; return Promise.resolve(); }
      close() { this.state = "closed"; return Promise.resolve(); }
    }
    Object.assign(g, { AudioContext, webkitAudioContext: AudioContext, AudioNode, AudioParam, GainNode, PannerNode, StereoPannerNode,
      AudioBufferSourceNode, AudioBuffer, AnalyserNode, BiquadFilterNode, DynamicsCompressorNode, AudioDestinationNode, DelayNode, OscillatorNode });
  }

  // ---- document pieces: createElement knows the new tags; getElementsByTagName().item ----------
  const Document = g.Document;
  const baseCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag) {
    switch (String(tag).toLowerCase()) {
      case "audio": return new HTMLAudioElement();
      case "video": return new HTMLVideoElement();
      case "style": return new HTMLStyleElement();
      default: return baseCreate.call(this, tag);
    }
  };
  const withItem = (arr) => { arr.item = (i) => arr[i] || null; arr.namedItem = () => null; return arr; };
  const baseDocTags = Document.prototype.getElementsByTagName;
  Document.prototype.getElementsByTagName = function (t) { return withItem(baseDocTags.call(this, t)); };
  const baseElTags = HTMLElement.prototype.getElementsByTagName;
  HTMLElement.prototype.getElementsByTagName = function (t) { return withItem(baseElTags.call(this, t)); };

  // ---- DOMParser for XML ---------------------------------------------------------------------
  // Data files only (bitmap fonts, texture atlases, Tiled maps): elements, attributes and text. A
  // document that does not parse answers as browsers do, with a <parsererror> element.
  class XmlNode {
    constructor(type, name, value) {
      this.nodeType = type; this.nodeName = name; this.nodeValue = value === undefined ? null : value;
      this.parentNode = null; this.childNodes = [];
    }
    get textContent() { return this.nodeType === 1 || this.nodeType === 9 ? this.childNodes.map((c) => c.textContent).join("") : this.nodeValue; }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) + 1] || null; }
    get tagName() { return this.nodeType === 1 ? this.nodeName : undefined; }
    get localName() { return this.nodeType === 1 ? this.nodeName.replace(/^.*:/, "") : null; }
    get documentElement() { return this.nodeType === 9 ? this.firstElementChild : null; }
    getAttribute(k) { const a = this.attributes.find((x) => x.name === k); return a ? a.value : null; }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    setAttribute(k, v) { const a = this.attributes.find((x) => x.name === k); if (a) a.value = String(v); else this.attributes.push({ name: k, nodeName: k, value: String(v), nodeValue: String(v) }); }
    getElementsByTagName(t) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (t === "*" || c.nodeName === t) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(t) { return this.getElementsByTagName(t)[0] || null; }
    querySelectorAll(t) { return this.getElementsByTagName(t); }
  }
  const xmlText = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (_, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(+dec) : { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[name.toLowerCase()]);
  const parseXml = (text, type) => {
    const doc = new XmlNode(9, "#document");
    doc.contentType = type;
    const stack = [doc];
    const add = (n) => { const p = stack[stack.length - 1]; n.parentNode = p; p.childNodes.push(n); return n; };
    const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
    let at = 0, bad = false, m;
    const between = (end) => { const t = text.slice(at, end); if (/\S/.test(t)) { if (stack.length === 1) bad = true; else add(new XmlNode(3, "#text", xmlText(t))); } };
    while (!bad && (m = tag.exec(text))) {
      between(m.index);
      at = tag.lastIndex;
      if (m[1] !== undefined) add(new XmlNode(4, "#cdata-section", m[1]));
      else if (m[2]) { if (stack.length === 1 || stack[stack.length - 1].nodeName !== m[2]) bad = true; else stack.pop(); }
      else if (m[3]) {
        const el = add(new XmlNode(1, m[3]));
        el.attributes = [];
        for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.setAttribute(a[1], xmlText(a[2] !== undefined ? a[2] : a[3]));
        if (!m[5]) stack.push(el);
      }
    }
    if (!bad) between(text.length);
    if (bad || stack.length > 1 || !doc.documentElement) {
      doc.childNodes = [new XmlNode(1, "parsererror")];
      doc.childNodes[0].attributes = [];
      doc.childNodes[0].parentNode = doc;
    }
    return doc;
  };
  g.DOMParser = class DOMParser { parseFromString(text, type) { return parseXml(String(text), String(type || "text/xml")); } };

  // ---- boot from index.html ---------------------------------------------------------------------
  __powerboat.bootHtml = (htmlPath) => {
    const html = __powerboat.readText(htmlPath);
    document.readyState = "loading";
    __powerboat.quitOnStart = false; // a game owns Start; Select+Start quits
    __powerboat.booting = true;
    __powerboat.bootXhr = 0;
    __powerboat.bootQueue = [];
    __powerboat.bootImages = [];
    const title = /<title>([^<]*)<\/title>/i.exec(html);
    if (title) document.title = title[1].trim();
    const bg = /<body[^>]*background-color:\s*([^;"']+)/i.exec(html);
    if (bg) document.body.style.backgroundColor = bg[1].trim();
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
      const href = /href\s*=\s*["']([^"']+)/i.exec(tag);
      if (href) __powerboat.loadStylesheet(href[1]);
    }
    for (const [, attrs, inline] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /src\s*=\s*["']([^"']+)/i.exec(attrs);
      const el = document.createElement("script");
      el._ran = true; // appended as a record of the tag; executed right here, in order, like a browser
      document.currentScript = el;
      if (src) {
        el._src = src[1];
        document.body.appendChild(el);
        try {
          __powerboat.loadScript(src[1]);
          // Core patches that plugins must see (they capture originals when they load).
          if (/rpg_managers.js$/.test(src[1]) && __powerboat.onManagersLoaded) __powerboat.onManagersLoaded();
          if (g.Phaser && __powerboat.phaserFixes) __powerboat.phaserFixes();
        }
        catch (e) { console.error("powerboat: script " + src[1] + " failed:", e && e.stack ? e.stack : e); }
      } else if (inline.trim()) {
        el.text = inline;
        document.body.appendChild(el);
        try { __powerboat.evalScript(inline, htmlPath + "#inline"); }
        catch (e) { console.error("powerboat: inline script failed:", e && e.stack ? e.stack : e); }
      }
      document.currentScript = null;
    }
    // Scripts inserted during boot (plugins), in order, each able to insert more.
    for (let i = 0; i < __powerboat.bootQueue.length; i++) __powerboat.bootQueue[i]._exec();
    // Data images set during boot load now (20_dom.js); their handlers may set more.
    for (let i = 0; i < __powerboat.bootImages.length; i++) __powerboat.bootImages[i]();
    __powerboat.bootImages = null;
    __powerboat.bootQueue = null;
    // Per-page patches (79_webpage.js) see every page script and run before the load event.
    if (__powerboat.beforeLoad) { try { __powerboat.beforeLoad(); } catch (e) { console.error("powerboat: beforeLoad:", e && e.stack ? e.stack : e); } }
    __powerboat.booting = false;
    document.readyState = "interactive";
    document.dispatchEvent(new Event("DOMContentLoaded"));
    const fireLoad = () => {
      document.readyState = "complete";
      document.dispatchEvent(new Event("readystatechange"));
      g.dispatchEvent(new Event("load"));
    };
    // XHRs the page started while booting finish first (see XMLHttpRequest.send), for at most 3 s. Pages that
    // started none get load right here, as before.
    if (__powerboat.bootXhr > 0) {
      const t0 = performance.now();
      const wait = () => (__powerboat.bootXhr > 0 && performance.now() - t0 < 3000 ? setTimeout(wait, 0) : fireLoad());
      setTimeout(wait, 0);
    } else {
      fireLoad();
    }
  };
})();
