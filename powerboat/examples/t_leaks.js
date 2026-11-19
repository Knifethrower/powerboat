// h5bench memory.html's leak tests, with RSS after each step: where memory goes in the warm-up round, whether the
// measured round gives it back, and what is left after the runtime's periodic malloc_trim (every 300 frames).
// Needs h5bench's assets (sheet_1024.png, tone_10s.ogg) as the root; LEAK_ONLY=canvas,audio runs some. In WSL, Xvfb up:
//   POWERBOAT_V8_FLAGS=--expose-gc powerboat --root <h5bench checkout> --script examples/t_leaks.js --secs 160
const MB = 1048576;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { if (typeof gc === "function") { gc(); gc(); } await sleep(70); };
const m = () => { const u = process.memoryUsage(); return { rss: u.rss / MB, heap: u.heapUsed / MB, ext: u.external / MB, peak: process.resourceUsage().maxRSS / 1024 }; };
const fmt = (x) => `rss ${x.rss.toFixed(1)} heap ${x.heap.toFixed(1)} ext ${x.ext.toFixed(1)} peak ${x.peak.toFixed(0)}`;
const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error(src)); im.src = src; });
const bytes = (url) => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", url); x.responseType = "arraybuffer"; x.onload = () => res(x.response); x.onerror = rej; x.send(); });
const gl = (() => { const c = document.createElement("canvas"); c.width = 640; c.height = 480; return c.getContext("webgl"); })();
const tests = {
  texture: { n: 100, setup: () => ({ data: new Uint8Array(512 * 512 * 4).fill(7), px: new Uint8Array(4) }), cycle: (c, i) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, c.data); gl.bindTexture(gl.TEXTURE_2D, null); gl.deleteTexture(t); if (i % 10 === 9) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, c.px); } },
  buffer: { n: 100, setup: () => ({ data: new Float32Array(262144).fill(1), px: new Uint8Array(4) }), cycle: (c, i) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, c.data, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.deleteBuffer(b); if (i % 10 === 9) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, c.px); } },
  canvas: { n: 100, cycle: () => { const c = document.createElement("canvas"); c.width = c.height = 512; const x = c.getContext("2d"); x.fillStyle = "#4a8"; x.fillRect(0, 0, 512, 512); x.getImageData(0, 0, 1, 1); } },
  image: { n: 30, cycle: async () => { const im = await load("assets/sheet_1024.png"); const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im); gl.bindTexture(gl.TEXTURE_2D, null); gl.deleteTexture(t); } },
  audio: { n: 20, setup: async () => ({ ac: new AudioContext(), ogg: await bytes("assets/tone_10s.ogg") }), cycle: (c) => new Promise((res, rej) => { const p = c.ac.decodeAudioData(c.ogg.slice(0), res, rej); if (p && p.then) p.then(res, rej); }), teardown: (c) => c.ac.close() },
};
const only = (Deno.core.ops.op_powerboat_env("LEAK_ONLY") || "").split(",").filter(Boolean);
(async () => {
  await settle();
  console.log(`[leak] start: ${fmt(m())}`);
  for (const [name, t] of Object.entries(tests)) {
    if (only.length && !only.includes(name)) continue;
    const ctx = t.setup ? await t.setup() : {};
    await settle(); const a0 = m();
    for (let i = 0; i < t.n; i++) await t.cycle(ctx, i);
    const a1 = m(); await settle(); await settle(); const a = m();
    for (let i = 0; i < t.n; i++) await t.cycle(ctx, i);
    await settle(); await settle(); const b = m();
    if (t.teardown) await t.teardown(ctx);
    await sleep(6000); await settle(); const c = m(); // past one malloc_trim
    console.log(`[leak] ${name}: before ${fmt(a0)} | round 1 end ${fmt(a1)} | settled ${fmt(a)} | round 2 ${fmt(b)} | +6 s ${fmt(c)} | growth ${(b.rss - a.rss).toFixed(2)} MB`);
  }
  window.close();
})();
