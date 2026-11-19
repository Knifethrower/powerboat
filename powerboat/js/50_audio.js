// powerboat JS environment, part 6: Web Audio over the mixer in src/audio.rs. Replaces the
// silent stand-in from 40_web.js when the SDL audio device opened. Shapes MV and its plugins use:
// AudioContext (resume/suspend/currentTime/destination), GainNode, PannerNode (setPosition),
// StereoPannerNode, AudioBufferSourceNode (loop, loopStart/End, playbackRate, start/stop, onended),
// AudioBuffer (getChannelData writes through to the mixer's memory), decodeAudioData (ogg/vorbis,
// off the main thread), BiquadFilter, Delay, Oscillator, a node's output as a param's input,
// pass-through Analyser/Compressor/Convolver/WaveShaper.
"use strict";
(() => {
  const ops = Deno.core.ops;
  const g = globalThis;
  if (!ops.op_audio_available()) { console.warn("powerboat: no audio device; AudioContext stays silent"); return; }
  __powerboat.audioStub = false;

  const freeNodes = new FinalizationRegistry((id) => ops.op_audio_node_free(id));
  const freeBuffers = new FinalizationRegistry((id) => ops.op_audio_buffer_free(id));
  const sources = new Map(); // node id -> playing AudioBufferSourceNode or OscillatorNode (for onended)

  // The node of a param the mixer does not use (compressor): the value only lives here.
  const LOCAL = { _id: 0 };
  // One AudioListener for all of a game's AudioContexts.
  const LISTENER = { _id: ops.op_audio_listener() };
  class AudioParam {
    // slot: which of the node's mixer params, as in op_audio_param.
    constructor(node, initial, slot = 0) { this._node = node; this._slot = slot; this._v = initial; this.defaultValue = initial; this.minValue = -3.4e38; this.maxValue = 3.4e38; }
    get value() { return this._node._id ? ops.op_audio_param_get(this._node._id, this._slot) : this._v; }
    set value(v) { v = +v; if (!Number.isFinite(v)) return; this._v = v; if (this._node._id) ops.op_audio_param(this._node._id, this._slot, 4, v, 0, 0); }
    setValueAtTime(v, t) { this._v = +v; if (this._node._id) ops.op_audio_param(this._node._id, this._slot, 0, +v, +t || 0, 0); return this; }
    linearRampToValueAtTime(v, t) { this._v = +v; if (this._node._id) ops.op_audio_param(this._node._id, this._slot, 1, +v, +t || 0, 0); return this; }
    exponentialRampToValueAtTime(v, t) { this._v = +v; if (this._node._id) ops.op_audio_param(this._node._id, this._slot, 2, +v, +t || 0, 0); return this; }
    setTargetAtTime(v, t, tc) { this._v = +v; if (this._node._id) ops.op_audio_param(this._node._id, this._slot, 3, +v, +t || 0, +tc || 0.01); return this; }
    setValueCurveAtTime(curve, t, d) { if (curve && curve.length) this.linearRampToValueAtTime(curve[curve.length - 1], (+t || 0) + (+d || 0)); return this; }
    cancelScheduledValues(t) { if (this._node._id) ops.op_audio_param_cancel(this._node._id, this._slot, +t || 0); return this; }
    cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
  }

  class AudioNode extends EventTarget {
    constructor(ctx, kind, arg = 0) {
      super();
      this.context = ctx;
      this._id = kind ? ops.op_audio_node_create(kind, arg) : 0;
      if (this._id) freeNodes.register(this, this._id, this);
      this.numberOfInputs = 1; this.numberOfOutputs = 1; this.channelCount = 2;
      this.channelCountMode = "max"; this.channelInterpretation = "speakers";
    }
    // A connection keeps its destination alive, as in browsers: a node is freed (freeNodes) when its
    // JS object is collected, and a game that keeps no reference to a node in the middle of its graph
    // (an ImpactJS game's effects compressor) would otherwise lose every sound routed through it at the first
    // GC. Playing sources stay alive through `sources` until they end.
    connect(dest) {
      if (dest instanceof AudioParam) {
        if (this._id && dest._node._id) {
          ops.op_audio_connect_param(this._id, dest._node._id, dest._slot);
          (this._outs || (this._outs = new Set())).add(dest._node);
        }
        return dest;
      }
      const to = dest instanceof AudioNode ? dest._id : 0;
      if (this._id && (to || dest === this.context.destination)) {
        ops.op_audio_connect(this._id, to);
        if (to) (this._outs || (this._outs = new Set())).add(dest);
      }
      return dest;
    }
    disconnect(dest) {
      if (!this._id) return;
      if (dest instanceof AudioParam) {
        if (dest._node._id) ops.op_audio_disconnect_param(this._id, dest._node._id, dest._slot);
      } else if (dest instanceof AudioNode) {
        ops.op_audio_disconnect(this._id, dest._id);
        if (this._outs) this._outs.delete(dest);
      } else {
        ops.op_audio_disconnect(this._id, 0xffffffff);
        this._outs = null;
      }
    }
  }
  class AudioDestinationNode extends AudioNode { constructor(ctx) { super(ctx, 0); this.maxChannelCount = 2; this.numberOfOutputs = 0; } }
  class GainNode extends AudioNode { constructor(ctx) { super(ctx, 1); this.gain = new AudioParam(this, 1); } }
  const DISTANCE_MODELS = ["inverse", "linear", "exponential"];
  class PannerNode extends AudioNode {
    constructor(ctx) {
      super(ctx, 2);
      this.panningModel = "equalpower"; // any model pans equal-power
      this._distanceModel = "inverse";
      this.positionX = new AudioParam(this, 0, 0); this.positionY = new AudioParam(this, 0, 1); this.positionZ = new AudioParam(this, 0, 2);
      this.orientationX = new AudioParam(this, 1, 3); this.orientationY = new AudioParam(this, 0, 4); this.orientationZ = new AudioParam(this, 0, 5);
    }
    get distanceModel() { return this._distanceModel; }
    set distanceModel(v) { const i = DISTANCE_MODELS.indexOf(v); if (i >= 0) { this._distanceModel = v; ops.op_audio_node_set(this._id, 0, i); } }
    setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
    setOrientation(x, y, z) { this.orientationX.value = x; this.orientationY.value = y; this.orientationZ.value = z; }
    setVelocity() {}
  }
  for (const [field, name, initial] of [[1, "refDistance", 1], [2, "maxDistance", 10000], [3, "rolloffFactor", 1], [4, "coneInnerAngle", 360], [5, "coneOuterAngle", 360], [6, "coneOuterGain", 0]]) {
    const own = "_" + name;
    Object.defineProperty(PannerNode.prototype, name, {
      get() { return own in this ? this[own] : initial; },
      set(v) { v = +v; if (Number.isFinite(v)) { this[own] = v; ops.op_audio_node_set(this._id, field, v); } },
      configurable: true,
    });
  }
  class StereoPannerNode extends AudioNode { constructor(ctx) { super(ctx, 5); this.pan = new AudioParam(this, 0); } }
  class PassNode extends AudioNode { constructor(ctx) { super(ctx, 4); } }
  class AnalyserNode extends PassNode {
    constructor(ctx) { super(ctx); this.fftSize = 2048; this.frequencyBinCount = 1024; this.minDecibels = -100; this.maxDecibels = -30; this.smoothingTimeConstant = 0.8; }
    getByteFrequencyData(a) { a.fill(0); } getByteTimeDomainData(a) { a.fill(128); } getFloatFrequencyData(a) { a.fill(-100); } getFloatTimeDomainData(a) { a.fill(0); }
  }
  const FILTER_TYPES = ["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"];
  class BiquadFilterNode extends AudioNode {
    constructor(ctx) { super(ctx, 7); this._type = "lowpass"; this.frequency = new AudioParam(this, 350, 0); this.Q = new AudioParam(this, 1, 1); this.gain = new AudioParam(this, 0, 2); this.detune = new AudioParam(this, 0, 3); }
    get type() { return this._type; }
    set type(v) { const i = FILTER_TYPES.indexOf(v); if (i >= 0) { this._type = v; ops.op_audio_node_set(this._id, 0, i); } }
    getFrequencyResponse() {}
  }
  class DynamicsCompressorNode extends PassNode { constructor(ctx) { super(ctx); this.threshold = new AudioParam(LOCAL, -24); this.knee = new AudioParam(LOCAL, 30); this.ratio = new AudioParam(LOCAL, 12); this.attack = new AudioParam(LOCAL, 0.003); this.release = new AudioParam(LOCAL, 0.25); this.reduction = 0; } }
  class DelayNode extends AudioNode { constructor(ctx, maxDelayTime) { super(ctx, 6, maxDelayTime > 0 ? +maxDelayTime : 1); this.delayTime = new AudioParam(this, 0, 0); } }
  const WAVES = ["sine", "square", "sawtooth", "triangle"];
  class OscillatorNode extends AudioNode {
    constructor(ctx) { super(ctx, 8); this._type = "sine"; this.frequency = new AudioParam(this, 440, 0); this.detune = new AudioParam(this, 0, 1); this.onended = null; this._started = false; }
    get type() { return this._type; }
    set type(v) { const i = WAVES.indexOf(v); if (i >= 0) { this._type = v; ops.op_audio_node_set(this._id, 0, i); } }
    start(when = 0) {
      if (this._started) throw new Error("powerboat: OscillatorNode.start called twice");
      this._started = true;
      sources.set(this._id, this);
      ops.op_audio_source_start(this._id, +when || 0, 0, 0);
    }
    stop(when = 0) { if (this._started) ops.op_audio_source_stop(this._id, +when || 0); }
    _ended() {
      sources.delete(this._id);
      this.dispatchEvent(new Event("ended"));
    }
  }

  class AudioBuffer {
    constructor(id, numberOfChannels, length, sampleRate) {
      this._id = id; this.numberOfChannels = numberOfChannels; this.length = length; this.sampleRate = sampleRate;
      this.duration = length / sampleRate; this._channels = [];
      freeBuffers.register(this, id, this);
    }
    getChannelData(ch) {
      ch |= 0;
      if (ch < 0 || ch >= this.numberOfChannels) throw new RangeError("powerboat: channel index out of range");
      if (!this._channels[ch]) this._channels[ch] = new Float32Array(ops.op_audio_buffer_channel(this._id, ch));
      return this._channels[ch];
    }
    copyFromChannel(dst, ch, start = 0) { dst.set(this.getChannelData(ch).subarray(start, start + dst.length)); }
    copyToChannel(src, ch, start = 0) { this.getChannelData(ch).set(src.subarray(0, Math.min(src.length, this.length - start)), start); }
  }

  class AudioBufferSourceNode extends AudioNode {
    constructor(ctx) {
      super(ctx, 3);
      this._buffer = null; this._loop = false; this._loopStart = 0; this._loopEnd = 0;
      this.playbackRate = new AudioParam(this, 1); this.detune = new AudioParam(this, 0, 1);
      this.onended = null; this._started = false;
      sources.set(this._id, this);
    }
    get buffer() { return this._buffer; }
    set buffer(b) { this._buffer = b; if (b && b._id) ops.op_audio_source_buffer(this._id, b._id); }
    get loop() { return this._loop; } set loop(v) { this._loop = !!v; this._pushLoop(); }
    get loopStart() { return this._loopStart; } set loopStart(v) { this._loopStart = +v || 0; this._pushLoop(); }
    get loopEnd() { return this._loopEnd; } set loopEnd(v) { this._loopEnd = +v || 0; this._pushLoop(); }
    _pushLoop() { ops.op_audio_source_loop(this._id, this._loop, this._loopStart, this._loopEnd); }
    start(when = 0, offset = 0, duration) {
      if (this._started) throw new Error("powerboat: AudioBufferSourceNode.start called twice");
      this._started = true;
      ops.op_audio_source_start(this._id, +when || 0, +offset || 0, duration > 0 ? +duration : 0);
    }
    stop(when = 0) { ops.op_audio_source_stop(this._id, +when || 0); }
    _ended() {
      sources.delete(this._id);
      const ev = new Event("ended");
      this.dispatchEvent(ev);
    }
  }

  class AudioContext extends EventTarget {
    constructor() {
      super();
      this.sampleRate = ops.op_audio_rate();
      this.state = "running";
      this.destination = new AudioDestinationNode(this);
      const p = (v, slot) => new AudioParam(LISTENER, v, slot);
      this.listener = {
        positionX: p(0, 0), positionY: p(0, 1), positionZ: p(0, 2), forwardX: p(0, 3), forwardY: p(0, 4), forwardZ: p(-1, 5), upX: p(0, 6), upY: p(1, 7), upZ: p(0, 8),
        setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; },
        setOrientation(fx, fy, fz, ux, uy, uz) { this.forwardX.value = fx; this.forwardY.value = fy; this.forwardZ.value = fz; this.upX.value = ux; this.upY.value = uy; this.upZ.value = uz; },
        setVelocity() {}, // Construct 2 calls it (Doppler was dropped from Web Audio)
      };
      this.onstatechange = null;
      this.baseLatency = 1024 / this.sampleRate;
    }
    get currentTime() { return ops.op_audio_now(); }
    createGain() { return new GainNode(this); }
    createPanner() { return new PannerNode(this); }
    createStereoPanner() { return new StereoPannerNode(this); }
    createBufferSource() { return new AudioBufferSourceNode(this); }
    createAnalyser() { return new AnalyserNode(this); }
    createBiquadFilter() { return new BiquadFilterNode(this); }
    createDynamicsCompressor() { return new DynamicsCompressorNode(this); }
    createDelay(maxDelayTime) { return new DelayNode(this, maxDelayTime); }
    createOscillator() { return new OscillatorNode(this); }
    createConvolver() { return new PassNode(this); }
    createWaveShaper() { return new PassNode(this); }
    createChannelMerger() { return new PassNode(this); }
    createChannelSplitter() { return new PassNode(this); }
    createScriptProcessor() { throw new Error("powerboat: ScriptProcessorNode not supported"); }
    createMediaElementSource() { throw new Error("powerboat: MediaElementAudioSourceNode not supported"); }
    createBuffer(channels, length, sampleRate) {
      const id = ops.op_audio_buffer_create(channels | 0, length | 0, sampleRate | 0);
      return new AudioBuffer(id, channels | 0, length | 0, sampleRate | 0);
    }
    decodeAudioData(data, ok, fail) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const p = ops.op_audio_decode(bytes, bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? "webm" : bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 ? "mp4" : "ogg").then(([id, rate, channels, frames]) => new AudioBuffer(id, channels, frames, rate));
      if (typeof ok === "function") p.then(ok, (e) => { if (typeof fail === "function") fail(e); else console.warn("powerboat: decodeAudioData:", e && e.message); });
      else if (typeof fail === "function") p.catch(fail);
      return p.catch((e) => { if (typeof ok !== "function" && typeof fail !== "function") throw e; });
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  Object.assign(g, { AudioContext, webkitAudioContext: AudioContext, AudioNode, AudioParam, GainNode, PannerNode, StereoPannerNode,
    AudioBufferSourceNode, AudioBuffer, AnalyserNode, BiquadFilterNode, DynamicsCompressorNode, AudioDestinationNode, DelayNode, OscillatorNode });
  g.OfflineAudioContext = undefined;

  // Finished sources: onended from the mixer's list, once per frame.
  __powerboat.pollAudio = () => {
    const ended = ops.op_audio_poll_ended();
    for (const id of ended) { const s = sources.get(id); if (s) s._ended(); }
  };
})();
