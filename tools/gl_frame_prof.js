// Test only (POWERBOAT_PATCHES), any WebGL game: the inside of a frame's GL work. Every 5 s, per frame: for each call kind
// the count, total ms and the mean of each frame's slowest call (one long wait, or evenly spread?); indices drawn;
// the render targets used, by size, with their draws. Times are wall time on the JS thread, GPU waits included.
(function () {
  const G = globalThis.WebGLRenderingContext && WebGLRenderingContext.prototype;
  if (!G) { console.log("GLF no WebGLRenderingContext"); return; }
  const kinds = {};
  let targets = new Map();
  const sizes = new WeakMap();
  const sizeOf = (t) => (t && sizes.get(t)) || "?";
  function time(name) {
    const f = G[name];
    if (typeof f !== "function") return;
    const k = (kinds[name] = { n: 0, ms: 0, top: 0, topSum: 0 });
    G[name] = function () {
      const t = performance.now();
      try { return f.apply(this, arguments); }
      finally {
        const d = performance.now() - t;
        k.n++; k.ms += d;
        if (d > k.top) k.top = d;
      }
    };
  }
  for (const m of ["drawElements", "drawArrays", "clear", "bindFramebuffer", "framebufferTexture2D", "bufferSubData", "bufferData", "texImage2D", "texSubImage2D", "useProgram", "bindTexture", "flush", "finish", "readPixels", "copyTexSubImage2D"]) time(m);
  const row = (key) => targets.get(key) || (targets.set(key, { passes: 0, draws: 0, idx: 0, clears: 0 }), targets.get(key));
  const fb = G.framebufferTexture2D, bf = G.bindFramebuffer, de = G.drawElements, cl = G.clear, bt = G.bindTexture, up = G.useProgram, tx = G.texImage2D, at = G.activeTexture;
  let curFb = null, curTex = null, unit = 0, prog = 0, progN = 0, drawI = 0, passI = 0, idx = 0;
  const progIds = new WeakMap(), slow = new Map();
  let frameTop = null;
  const passName = () => (curFb ? (curFb._att ? sizeOf(curFb._att) : "fb?") : "canvas");
  G.activeTexture = function (u) { unit = u - this.TEXTURE0; return at.apply(this, arguments); };
  G.bindTexture = function (t, tex) { if (unit === 0) curTex = tex; return bt.apply(this, arguments); };
  G.useProgram = function (p) { if (p && !progIds.has(p)) progIds.set(p, ++progN); prog = p ? progIds.get(p) : 0; return up.apply(this, arguments); };
  G.texImage2D = function (tgt, level) {
    const r = tx.apply(this, arguments);
    if (curTex && level === 0) {
      if (arguments.length >= 8) sizes.set(curTex, arguments[3] + "x" + arguments[4]);
      else { const s = arguments[5]; if (s && s.width) sizes.set(curTex, s.width + "x" + s.height); }
    }
    return r;
  };
  G.framebufferTexture2D = function (t, a, tt, tex) {
    if (curFb) curFb._att = tex;
    if (tex) { passI++; row(sizeOf(tex)).passes++; }
    return fb.apply(this, arguments);
  };
  G.bindFramebuffer = function (t, f) {
    curFb = f; passI++;
    row(passName()).passes++;
    return bf.apply(this, arguments);
  };
  G.drawElements = function (m, c) {
    idx += c; drawI++;
    const r = row(passName()); r.draws++; r.idx += c;
    const t = performance.now();
    const v = de.apply(this, arguments);
    const d = performance.now() - t;
    if (!frameTop || d > frameTop.d) frameTop = { d, key: "draw#" + drawI + " pass#" + passI + " into " + passName() + " tex " + sizeOf(curTex) + " prog " + prog + " idx " + c + " blend " + this.isEnabled(this.BLEND) };
    return v;
  };
  G.clear = function () { row(passName()).clears++; return cl.apply(this, arguments); };
  // Frame edges: an rAF loop of our own (Construct 2 keeps its own reference, Construct 3 calls rAF twice a frame).
  const raf = globalThis.requestAnimationFrame;
  let last = performance.now(), frames = 0;
  function tick() {
    raf.call(globalThis, tick);
    frames++;
    for (const k in kinds) { kinds[k].topSum += kinds[k].top; kinds[k].top = 0; }
    if (frameTop) { const q = slow.get(frameTop.key) || { n: 0, ms: 0 }; q.n++; q.ms += frameTop.d; slow.set(frameTop.key, q); frameTop = null; }
    drawI = 0; passI = 0;
    const now = performance.now();
    if (now - last >= 5000) {
      const a = Object.keys(kinds).filter((k) => kinds[k].ms / frames >= 0.05).map((k) => k + " " + (kinds[k].n / frames).toFixed(1) + "x " + (kinds[k].ms / frames).toFixed(2) + "ms top " + (kinds[k].topSum / frames).toFixed(2));
      const b = [...targets.entries()].sort((x, y) => y[1].passes - x[1].passes).slice(0, 8).map(([s, r]) => s + ": passes " + (r.passes / frames).toFixed(1) + " draws " + (r.draws / frames).toFixed(1) + " idx " + (r.idx / frames).toFixed(0) + " clears " + (r.clears / frames).toFixed(1));
      const c = [...slow.entries()].sort((x, y) => y[1].ms - x[1].ms).slice(0, 3).map(([k, q]) => k + " in " + q.n + " frames, " + (q.ms / q.n).toFixed(2) + "ms");
      console.log("GLF fps " + (frames * 1000 / (now - last)).toFixed(1) + " idx " + (idx / frames).toFixed(0) + " | " + a.join(", ") + " | " + b.join("; ") + " | slowest " + c.join("; "));
      for (const k in kinds) { const q = kinds[k]; q.n = 0; q.ms = 0; q.topSum = 0; }
      targets = new Map(); slow.clear(); idx = 0; frames = 0; last = now;
    }
  }
  raf.call(globalThis, tick);
  console.log("GLF on");
})();
