// powerboat JS environment, part 9d: <audio> that plays, for HTML pages (POWERBOAT_HTML=1).
// Elsewhere <audio> is a silent stand-in (40_web.js); pages with a DOM interface play their sounds and
// music through it. Each element decodes its file once (decoded buffers are shared by URL; long files stay
// compressed in the mixer) and plays it on the runtime's AudioContext through its own gain node (volume,
// muted). createMediaElementSource hands out that node, so a page can route the element into its own graph.
"use strict";
(() => {
  const ops = Deno.core.ops;
  if (ops.op_powerboat_env("POWERBOAT_HTML") !== "1") return;
  const g = globalThis;
  // Classes taken now: pages overwrite the globals (Cookie Clicker: `AudioContext = new AudioContext()`).
  const AC = g.AudioContext, AB = g.AudioBuffer, ACproto = AC && AC.prototype;
  let ctx = null;
  const context = () => ctx || (ctx = new AC());
  const buffers = new Map(); // resolved path -> Promise<AudioBuffer>
  const extOf = (p) => (/\.(mp3|wav|ogg|oga|m4a|mp4|aac|webm|opus)$/i.exec(p) || [])[1];
  function decode(url) {
    const path = __powerboat.resolvePath(url);
    let p = buffers.get(path);
    if (!p) {
      p = (async () => {
        const b = ops.op_powerboat_read_bytes(path);
        const err = ops.op_powerboat_take_io_error();
        if (err) throw new Error(err);
        const ext = (extOf(path) || "").toLowerCase();
        const [id, rate, channels, frames] = await ops.op_audio_decode(b, ext === "m4a" || ext === "aac" ? "mp4" : ext === "oga" ? "ogg" : ext);
        return new AB(id, channels, frames, rate);
      })();
      buffers.set(path, p);
    }
    return p;
  }

  const fire = (el, type) => { try { el.dispatchEvent(new g.Event(type)); } catch (e) { reportError(e); } };
  // Per-element state lives in el._m; the element's media properties become accessors over it.
  function upgrade(el) {
    if (el._m) return el;
    const m = el._m = { src: "", buf: null, loading: null, node: null, startAt: 0, offset: 0, paused: true, ended: false, loop: false, volume: 1, muted: false, out: null, routed: false, wantPlay: false, gen: 0, rate: 1 };
    for (const k of ["currentTime", "duration", "paused", "ended", "loop", "volume", "muted", "readyState", "playbackRate"]) delete el[k];
    const out = () => {
      if (!m.out) { const c = context(); m.out = c.createGain(); m.out.gain.value = m.muted ? 0 : m.volume; if (!m.routed) m.out.connect(c.destination); }
      return m.out;
    };
    m.outNode = out;
    const now = () => (m.node && !m.paused ? context().currentTime - m.startAt : m.offset);
    const pos = () => { const d = m.buf ? m.buf.duration : 0, t = now(); return m.loop && d ? t % d : Math.min(t, d || t); };
    const stopNode = () => { if (m.node) { const n = m.node; m.node = null; n.onended = null; try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} } };
    const startNode = () => {
      const c = context();
      stopNode();
      const n = c.createBufferSource();
      n.buffer = m.buf; n.loop = m.loop;
      n.connect(out());
      const off = Math.max(0, Math.min(m.offset, m.buf.duration || 0));
      m.startAt = c.currentTime - off;
      const gen = ++m.gen;
      n.onended = () => {
        if (gen !== m.gen || m.loop) return;
        m.node = null; m.paused = true; m.ended = true; m.offset = m.buf.duration;
        fire(el, "pause"); fire(el, "ended");
      };
      n.start(0, off);
      m.node = n;
    };
    const load = () => {
      const src = m.src;
      if (!src) return;
      m.buf = null;
      m.loading = decode(src).then((buf) => {
        if (m.src !== src) return;
        m.buf = buf; m.loading = null;
        for (const t of ["loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) fire(el, t);
        if (m.wantPlay) { m.wantPlay = false; startNode(); }
      }, (e) => { if (m.src === src) { m.loading = null; console.warn("powerboat: audio " + src + ": " + (e && e.message)); fire(el, "error"); } });
    };
    const def = (k, get, set) => Object.defineProperty(el, k, { get, set, configurable: true, enumerable: true });
    def("src", () => m.src, (v) => { v = String(v ?? ""); if (v === m.src && m.buf) return; stopNode(); m.src = v; m.offset = 0; m.paused = true; m.ended = false; load(); });
    def("currentSrc", () => m.src);
    def("currentTime", pos, (v) => { m.offset = Math.max(0, +v || 0); m.ended = false; if (m.node && !m.paused) startNode(); });
    def("duration", () => (m.buf ? m.buf.duration : NaN));
    def("paused", () => m.paused);
    def("ended", () => m.ended);
    def("readyState", () => (m.buf ? 4 : 0));
    def("loop", () => m.loop, (v) => { m.loop = !!v; if (m.node) m.node.loop = m.loop; });
    def("volume", () => m.volume, (v) => { m.volume = Math.max(0, Math.min(1, +v || 0)); if (m.out) m.out.gain.value = m.muted ? 0 : m.volume; });
    def("muted", () => m.muted, (v) => { m.muted = !!v; if (m.out) m.out.gain.value = m.muted ? 0 : m.volume; });
    def("playbackRate", () => m.rate, (v) => { m.rate = +v || 1; });
    el.play = () => {
      if (!m.paused && m.node) return Promise.resolve();
      if (m.ended) { m.offset = 0; m.ended = false; }
      m.paused = false;
      fire(el, "play");
      if (m.buf) startNode(); else { m.wantPlay = true; if (!m.loading) load(); }
      return Promise.resolve();
    };
    el.pause = () => {
      if (m.paused) return;
      m.offset = pos(); m.wantPlay = false; m.paused = true;
      stopNode();
      fire(el, "pause");
    };
    el.load = () => { stopNode(); m.offset = 0; m.paused = true; load(); };
    return el;
  }
  const baseCreate = g.Document.prototype.createElement;
  g.Document.prototype.createElement = function (tag) {
    const el = baseCreate.call(this, tag);
    return String(tag).toLowerCase() === "audio" ? upgrade(el) : el;
  };
  const Proto = g.Audio.prototype;
  g.Audio = function Audio(src) { const a = g.document.createElement("audio"); if (src) a.src = src; return a; };
  g.Audio.prototype = Proto;
  // A page's own graph: the element's output node, now feeding the page's nodes instead of the speakers.
  if (ACproto) {
    ACproto.createMediaElementSource = function (el) {
      upgrade(el);
      const m = el._m;
      if (m.out && !m.routed) { try { m.out.disconnect(); } catch (e) {} }
      m.routed = true;
      const n = m.outNode();
      n.mediaElement = el;
      return n;
    };
  }
})();
