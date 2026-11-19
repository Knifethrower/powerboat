// Web Audio check: decode an ogg from the game folder (--root), play it through MV's chain
// (source -> gain -> panner -> destination) with a fade and a pan, a short looped SE, and report
// currentTime progress and onended. Pass the ogg path relative to root as --script arg? No: edit
// OGG below or set POWERBOAT_OGG in the env (read through location.search is not available); default
// is the MV test game's title BGM.
const OGG = (globalThis.__powerboatTestOgg) || "audio/bgm/Dream.ogg";
const ctx = new AudioContext();
console.log("audio ctx", ctx.sampleRate, "stub:", !!__powerboat.audioStub, "t0", ctx.currentTime.toFixed(3));
const xhr = new XMLHttpRequest();
xhr.open("GET", OGG);
xhr.responseType = "arraybuffer";
xhr.onload = () => {
  console.log("xhr loaded", xhr.status, xhr.response && xhr.response.byteLength, "bytes");
  const t0 = performance.now();
  ctx.decodeAudioData(xhr.response, (buffer) => {
    console.log("decoded", OGG, buffer.numberOfChannels + "ch", buffer.sampleRate + "Hz", buffer.duration.toFixed(2) + "s", "in", (performance.now() - t0).toFixed(0), "ms");
    const ch0 = buffer.getChannelData(0);
    let peak = 0; for (let i = 0; i < ch0.length; i += 97) peak = Math.max(peak, Math.abs(ch0[i]));
    console.log("peak", peak.toFixed(3), "first samples", Array.from(ch0.slice(1000, 1004)).map((v) => v.toFixed(3)).join(" "));
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    const pan = ctx.createPanner();
    src.buffer = buffer; src.loop = true; src.loopStart = 1; src.loopEnd = 3;
    src.connect(gain); gain.connect(pan); pan.connect(ctx.destination);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 1);
    pan.setPosition(0.5, 0, 0.5);
    src.start(0);
    console.log("started at", ctx.currentTime.toFixed(3), "gain now", gain.gain.value.toFixed(2));
    setTimeout(() => console.log("t=1.5 gain", gain.gain.value.toFixed(2), "ctx", ctx.currentTime.toFixed(2)), 1500);
    setTimeout(() => { src.stop(); console.log("stopped at", ctx.currentTime.toFixed(2)); }, 9000);
    src.onended = () => console.log("onended at", ctx.currentTime.toFixed(2));
    // A one-shot: a 0.3 s buffer we fill ourselves (the OMORI AudioStreaming path).
    const se = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const d = se.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / ctx.sampleRate * 440 * 2 * Math.PI) * 0.3;
    const s2 = ctx.createBufferSource(); s2.buffer = se; s2.connect(ctx.destination);
    s2.onended = () => console.log("SE ended at", ctx.currentTime.toFixed(2), "(expected ~0.3 after start)");
    setTimeout(() => { s2.start(0); console.log("SE start at", ctx.currentTime.toFixed(2)); }, 500);
  }, (e) => console.log("decode failed", e && e.message));
};
xhr.onerror = () => console.log("xhr failed for", OGG);
xhr.send();
setTimeout(() => window.close(), 25000);
