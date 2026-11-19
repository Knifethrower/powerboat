// powerboat JS environment, part 8: <video> over src/video.rs. WebM (VP8/VP9 + Vorbis) and MP4 (H.264 + AAC).
// The soundtrack plays as an AudioBufferSourceNode in a runtime-owned AudioContext and is the
// clock; without one, performance.now() is. Each frame (__powerboat_tick, before rAF callbacks) the
// playing videos advance; texImage2D(video) uploads the current frame; a <video> in the document
// with opacity != 0 is drawn over the game picture (MV's Graphics.playVideo).
"use strict";
(() => {
  const ops = Deno.core.ops;
  const g = globalThis;
  const Base = g.HTMLMediaElement;
  const playing = new Set();
  // Elements holding a decoder: the per-frame overlay check only runs while there are any. A weak
  // reference would let a dropped element go; MV keeps its one video for good, PIXI its few.
  const loaded = new Set();
  let overlayOn = false;
  __powerboat.videoDebug = !!ops.op_powerboat_env("POWERBOAT_VIDEO_DEBUG");
  let mediaCtx = null;
  const ctx = () => (mediaCtx || (mediaCtx = new g.AudioContext()));
  const freeVideos = new FinalizationRegistry((id) => ops.op_video_close(id));
  const fire = (el, type) => el.dispatchEvent(new Event(type));

  class HTMLVideoElement extends Base {
    constructor() {
      super("video");
      this.videoWidth = 0; this.videoHeight = 0; this.width = 0; this.height = 0;
      this.playsInline = false; this.poster = "";
      this._powerboatVideoId = 0; this._abuf = null; this._node = null; this._gain = null;
      this._t = 0; this._clock0 = 0; this._volume = 1; this._muted = false;
    }
    // MP4 (H.264) answers "maybe" so a game offering both picks WebM.
    canPlayType(type) { return /webm/i.test(type) ? "probably" : /mp4|avc1|h264/i.test(type) ? "maybe" : ""; }
    get src() { return this._src; }
    set src(v) { this._src = String(v); if (this._src) this.load(); else this._close(); }
    get currentTime() { return this._now(); }
    set currentTime(t) {
      t = Math.max(0, +t || 0);
      const was = !this.paused;
      if (was) this._stopAudio();
      if (t < this._t && this._powerboatVideoId) ops.op_video_rewind(this._powerboatVideoId);
      this._t = t; this.ended = false;
      if (this._powerboatVideoId) ops.op_video_advance(this._powerboatVideoId, t);
      if (was) this._startClock();
      setTimeout(() => { fire(this, "seeked"); fire(this, "timeupdate"); }, 0);
    }
    get volume() { return this._volume; }
    set volume(v) { this._volume = Math.min(1, Math.max(0, +v)); this._applyGain(); }
    get muted() { return this._muted; }
    set muted(v) { this._muted = !!v; this._applyGain(); }
    _applyGain() { if (this._gain) this._gain.gain.value = this._muted ? 0 : this._volume; }
    _close() {
      this.pause();
      if (this._powerboatVideoId) { freeVideos.unregister(this); ops.op_video_close(this._powerboatVideoId); this._powerboatVideoId = 0; }
      loaded.delete(this);
      this.readyState = 0; this.videoWidth = this.videoHeight = 0; this._abuf = null;
    }
    load() {
      this._close();
      let url = this._src;
      if (!url) {
        // <source> children (PIXI's VideoBaseTexture.fromUrl): the first playable one.
        const s = this.children.find((c) => c.tagName === "SOURCE" && (!c.type || this.canPlayType(c.type)) && (c.src || c.getAttribute("src")));
        url = s ? (s.src || s.getAttribute("src")) : "";
      }
      if (!url) return;
      this._current = url;
      this.networkState = 2;
      const [id, w, h, dur, abuf, err] = ops.op_video_open(__powerboat.resolvePath(url));
      if (!id) {
        console.warn("powerboat: video " + url + ": " + err);
        this.networkState = 3;
        this.error = { code: 4, message: err };
        setTimeout(() => fire(this, "error"), 0);
        return;
      }
      this._powerboatVideoId = id;
      loaded.add(this);
      freeVideos.register(this, id, this);
      this.videoWidth = w; this.videoHeight = h; this.duration = dur;
      if (!this.width) this.width = w;
      if (!this.height) this.height = h;
      if (abuf) {
        const c = ctx();
        this._abuf = new g.AudioBuffer(abuf, 2, Math.round(dur * c.sampleRate), c.sampleRate);
      }
      this._t = 0; this.ended = false; this.paused = true; this.readyState = 4; this.networkState = 1;
      this.buffered = { length: 1, start: () => 0, end: () => dur };
      ops.op_video_advance(id, 0); // first frame ready for loadeddata
      setTimeout(() => {
        for (const t of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) fire(this, t);
        if (this.autoplay) this.play();
      }, 0);
    }
    _unload() {
      if (!this._powerboatVideoId) return;
      freeVideos.unregister(this);
      ops.op_video_close(this._powerboatVideoId);
      this._powerboatVideoId = 0;
      this._abuf = null;
      loaded.delete(this);
    }
    get currentSrc() { return this._current || this._src; }
    _now() {
      if (this.paused) return this._t;
      const t = this._abuf ? ctx().currentTime - this._clock0 : (performance.now() / 1000) - this._clock0;
      return Math.max(0, t * (this._abuf ? 1 : this.playbackRate));
    }
    _startClock() {
      if (this._abuf) {
        const c = ctx();
        this._gain = c.createGain();
        this._applyGain();
        this._gain.connect(c.destination);
        this._node = c.createBufferSource();
        this._node.buffer = this._abuf;
        this._node.connect(this._gain);
        this._node.start(0, this._t);
        this._clock0 = c.currentTime - this._t;
      } else {
        this._clock0 = performance.now() / 1000 - this._t / (this.playbackRate || 1);
      }
    }
    _stopAudio() {
      if (this._node) { try { this._node.stop(); } catch (_) {} this._node.disconnect(); this._node = null; }
      if (this._gain) { this._gain.disconnect(); this._gain = null; }
    }
    // Called once per new frame position, for the frame the next texture upload will show (Phaser's
    // Video calls it unconditionally). One-shot, as in browsers.
    requestVideoFrameCallback(cb) {
      const pending = this._rvfc || (this._rvfc = new Map());
      const id = (this._rvfcId = (this._rvfcId || 0) + 1);
      const tick = (now) => {
        const t = this._now();
        if (this.paused || this.readyState < 2 || t === this._rvfcLast) { pending.set(id, requestAnimationFrame(tick)); return; }
        this._rvfcLast = t;
        pending.delete(id);
        this._rvfcFrames = (this._rvfcFrames || 0) + 1;
        cb(now, { presentationTime: now, expectedDisplayTime: now, width: this.videoWidth, height: this.videoHeight, mediaTime: t, presentedFrames: this._rvfcFrames });
      };
      pending.set(id, requestAnimationFrame(tick));
      return id;
    }
    cancelVideoFrameCallback(id) { if (this._rvfc && this._rvfc.has(id)) { cancelAnimationFrame(this._rvfc.get(id)); this._rvfc.delete(id); } }
    play() {
      if (!this._powerboatVideoId) {
        if (this._src || this.children.length) this.load();
        if (!this._powerboatVideoId) { const e = new Error("powerboat: play() on a video with no playable source"); e.name = "NotSupportedError"; if (__powerboat.videoDebug) console.warn(e.stack); return Promise.reject(e); }
      }
      if (!this.paused) return Promise.resolve();
      if (this.ended) { this.currentTime = 0; }
      this.paused = false; this.ended = false;
      this._startClock();
      playing.add(this);
      setTimeout(() => { fire(this, "play"); fire(this, "playing"); }, 0);
      return Promise.resolve();
    }
    pause() {
      if (this.paused) return;
      this._t = this._now();
      this.paused = true;
      this._stopAudio();
      playing.delete(this);
      setTimeout(() => fire(this, "pause"), 0);
    }
    _tick() {
      const t = this._now();
      const r = ops.op_video_advance(this._powerboatVideoId, t);
      if (r === 1) fire(this, "timeupdate");
      if (__powerboat.videoDebug && (this._dbgSec | 0) !== (t | 0)) {
        this._dbgSec = t | 0;
        console.log("[video] " + this._current + " t " + t.toFixed(2) + " / " + this.duration.toFixed(2) + (this._abuf ? " (audio clock " + ctx().currentTime.toFixed(2) + ", state " + ctx().state + ")" : ""));
      }
      if (t >= this.duration) {
        if (__powerboat.videoDebug) console.log("[video] " + this._current + " ended at " + t.toFixed(2) + (this.loop ? " (loops)" : ""));
        if (this.loop) { this._stopAudio(); ops.op_video_rewind(this._powerboatVideoId); this._t = 0; this._startClock(); fire(this, "seeked"); return; }
        this._t = this.duration; this.paused = true; this.ended = true;
        this._stopAudio(); playing.delete(this);
        fire(this, "pause"); fire(this, "ended");
        // A finished movie lets its packets, decoder and soundtrack go (OMORI caches every video
        // element it plays: 131 MB of files plus PCM); play() opens it again from its source.
        // Not if an ended handler already started it again.
        if (this.ended && this.paused) this._unload();
      }
    }
  }
  class HTMLSourceElement extends HTMLElement {
    constructor() { super("source"); this.src = ""; this.type = ""; }
    setAttribute(k, v) { super.setAttribute(k, v); if (k === "src") this.src = String(v); if (k === "type") this.type = String(v); }
  }
  g.HTMLVideoElement = HTMLVideoElement;
  g.HTMLSourceElement = HTMLSourceElement;

  const Document = g.Document;
  const baseCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tag) {
    switch (String(tag).toLowerCase()) {
      case "video": return new HTMLVideoElement();
      case "source": return new HTMLSourceElement();
      default: return baseCreate.call(this, tag);
    }
  };

  // Once per frame, before the game's rAF callbacks: advance playing videos, and put a visible
  // <video> that sits in the document over the game picture.
  const inDocument = (el) => { for (let n = el; n; n = n.parentNode) if (n === document.body) return true; return false; };
  __powerboat.tickVideo = () => {
    if (!loaded.size && !playing.size) {
      if (overlayOn) { ops.op_video_overlay(0, 0, 0, 0, 0); overlayOn = false; }
      return;
    }
    let overlay = null;
    for (const v of [...playing]) {
      try { v._tick(); } catch (e) { __powerboat.reportError(e); }
    }
    for (const v of document.body.children) {
      if (v instanceof HTMLVideoElement && v._powerboatVideoId && String(v.style.opacity) !== "0" && v.style.display !== "none" && v.style.visibility !== "hidden" && inDocument(v) && (!v.paused || v.ended)) overlay = v;
    }
    if (overlay) {
      const c = __powerboat.mainCanvas && __powerboat.mainCanvas();
      ops.op_video_overlay(overlay._powerboatVideoId, 0, 0, c ? c.width : overlay.width, c ? c.height : overlay.height);
      overlayOn = true;
    } else if (overlayOn) { ops.op_video_overlay(0, 0, 0, 0, 0); overlayOn = false; }
  };
})();
