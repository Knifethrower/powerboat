// Render-pass cost check (tiler GPUs): a full-screen background plus PASSES small objects per frame,
// each drawn through an offscreen target the way Construct's effect chains do it, in several variants.
// Prints ms per frame for each. Run with --no-vsync: powerboat --script examples/t_passes.js --no-vsync --secs 40
const canvas = document.createElement("canvas");
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
document.body.appendChild(canvas);
const gl = canvas.getContext("webgl");
const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
const PASSES = 13, RW = 90, RH = 40, SECS = 3;
console.log("t_passes: " + W + "x" + H + ", " + PASSES + " passes of " + RW + "x" + RH + " | " + gl.getParameter(gl.RENDERER));

const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 uv; uniform vec4 r; void main(){ uv = p; gl_Position = vec4((r.xy + p * r.zw) * 2.0 - 1.0, 0.0, 1.0); }"));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; uniform sampler2D t; uniform vec4 c; uniform vec4 s; void main(){ gl_FragColor = c + texture2D(t, s.xy + uv * s.zw); }"));
gl.linkProgram(prog);
gl.useProgram(prog);
const uR = gl.getUniformLocation(prog, "r"), uC = gl.getUniformLocation(prog, "c"), uS = gl.getUniformLocation(prog, "s");
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

const tex = (w, h, px) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); return t; };
const bgPx = new Uint8Array(256 * 256 * 4);
for (let i = 0; i < bgPx.length; i += 4) { bgPx[i] = i % 251; bgPx[i + 1] = (i >> 8) % 253; bgPx[i + 2] = 90; bgPx[i + 3] = 255; }
const bg = tex(256, 256, bgPx);
const fbo = (w, h) => { const t = tex(w, h, null), f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { t, f, w, h }; };
const big = fbo(W, H), small = fbo(128, 64);
const bigs = Array.from({ length: PASSES }, () => fbo(W, H));

// Draws rect (pixels, in a target of tw x th) sampling texture t over sub-rect s (0..1).
const quad = (tw, th, x, y, w, h, t, s, c) => {
  gl.uniform4f(uR, x / tw, y / th, w / tw, h / th);
  gl.uniform4f(uS, s[0], s[1], s[2], s[3]);
  gl.uniform4f(uC, c[0], c[1], c[2], c[3]);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};
const rectOf = (i) => [40 + (i * 53) % (W - RW - 80), 40 + (i * 97) % (H - RH - 80)];

const variants = {
  // objects drawn straight to the screen: the floor
  direct(i, x, y) { quad(W, H, x, y, RW, RH, bg, [0, 0, 0.3, 0.3], [0.1, 0, 0, 0.1]); },
  // Construct's way: full-size target, unscissored clear, scissored draw, scissored composite
  bigFullClear(i, x, y) { this._big(x, y, "full"); },
  bigScissorClear(i, x, y) { this._big(x, y, "scissor"); },
  bigNoClear(i, x, y) { this._big(x, y, "none"); },
  // one full-size target per object: no target is drawn into again after being sampled this frame
  bigRotate(i, x, y) { this._big(x, y, "full", bigs[i]); },
  // full-size target drawn into but never sampled (composite reads another texture)
  bigNoSample(i, x, y) { this._big(x, y, "full", big, true); },
  // small target of the object's size
  smallTarget(i, x, y) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, small.f);
    gl.viewport(0, 0, small.w, small.h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    quad(small.w, small.h, 0, 0, RW, RH, bg, [0, 0, 0.3, 0.3], [0.1, 0, 0, 0.1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    quad(W, H, x, y, RW, RH, small.t, [0, 0, RW / small.w, RH / small.h], [0, 0, 0, 0]);
  },
  _big(x, y, clear, fb = big, noSample = false) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.f);
    if (clear === "full") { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, RW, RH);
    if (clear === "scissor") { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    quad(W, H, x, y, RW, RH, bg, [0, 0, 0.3, 0.3], [0.1, 0, 0, 0.1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    quad(W, H, x, y, RW, RH, noSample ? bg : fb.t, [x / W, y / H, RW / W, RH / H], [0, 0, 0, 0]);
    gl.disable(gl.SCISSOR_TEST);
  },
};
const order = ["direct", "bigFullClear", "bigRotate", "bigNoSample", "smallTarget", "bigFullClear", "bigRotate"];
let vi = 0, frames = 0, t0 = performance.now();
const results = [];
// Vsync may not be switchable (KMS): each swap gets REPS copies of the frame's work, timed to a
// glFinish, so the figure is GPU time per copy rather than the display rate.
const REPS = 4;
let busy = 0;
function frame() {
  const name = order[vi];
  gl.finish();
  const a = performance.now();
  for (let k = 0; k < REPS; k++) {
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.2, 0.2, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    quad(W, H, 0, 0, W, H, bg, [0, 0, 1, 1], [0, 0, 0, 0]);
    for (let i = 0; i < PASSES; i++) { const [x, y] = rectOf(i + frames % 7); variants[name](i, x, y); }
  }
  gl.finish();
  busy += performance.now() - a;
  frames++;
  const now = performance.now();
  if (now - t0 >= SECS * 1000) {
    const ms = busy / frames / REPS; busy = 0;
    results.push(name + " " + ms.toFixed(2) + " ms");
    console.log("t_passes " + name + ": " + ms.toFixed(2) + " ms/frame (" + frames + " frames) err " + gl.getError());
    vi++; frames = 0; t0 = now;
    if (vi >= order.length) { console.log("t_passes done: " + results.join(", ")); window.close(); return; }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
