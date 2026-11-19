// Framebuffer semantics check for gl.rs's FboCache (one real framebuffer per COLOR_ATTACHMENT0 texture of a
// game framebuffer). Every case reads pixels back and prints them; the same output with POWERBOAT_FBO_PER_TEXTURE=0
// (plain attachments, GL as asked) and without it is the check, plus a PASS/FAIL against what WebGL gives.
//   powerboat --script examples/t_fbo.js --secs 3
const canvas = document.createElement("canvas");
canvas.width = 64;
canvas.height = 64;
document.body.appendChild(canvas);
const gl = canvas.getContext("webgl");
const out = [];
let fails = 0;
const log = (name, got, want) => {
  const ok = want === undefined || got === want;
  if (!ok) fails++;
  out.push(`t_fbo: ${ok ? "PASS" : "FAIL"} ${name}: ${got}${ok || want === undefined ? "" : " (want " + want + ")"}`);
};

const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
const program = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p); return p; };
// Solid quad over a 0..1 rectangle r (x, y, w, h) at depth z.
const solid = program("attribute vec2 p; uniform vec4 r; uniform float z; void main(){ gl_Position = vec4((r.xy + p * r.zw) * 2.0 - 1.0, z, 1.0); }",
  "precision mediump float; uniform vec4 c; void main(){ gl_FragColor = c; }");
// Textured full quad.
const blit = program("attribute vec2 p; varying vec2 uv; void main(){ uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }",
  "precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }");
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const S = 16;
const tex = () => {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
};
const depthRb = () => {
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, S, S);
  return rb;
};
const clear = (r, g, b) => { gl.clearColor(r, g, b, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); };
const quad = (rect, col, z = 0) => {
  gl.useProgram(solid);
  gl.uniform4fv(gl.getUniformLocation(solid, "r"), rect);
  gl.uniform4fv(gl.getUniformLocation(solid, "c"), col);
  gl.uniform1f(gl.getUniformLocation(solid, "z"), z);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};
const px = (x, y) => { const p = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return Array.from(p.slice(0, 3)).join(","); };
const att = (f, t) => { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); };
const status = () => { const s = gl.checkFramebufferStatus(gl.FRAMEBUFFER); return s === gl.FRAMEBUFFER_COMPLETE ? "complete" : "0x" + s.toString(16); };
// Draws texture t over the whole canvas and reads the canvas at (x, y) of a 64x64 picture.
const show = (t, x, y) => {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, 64, 64);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(blit);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return px(x, y);
};
const R = "255,0,0", G = "0,255,0", B = "0,0,255", Y = "255,255,0", M = "255,0,255", K = "0,0,0";

// 1. Construct 2's swap: one framebuffer, its color attachment changed at every render-target switch.
{
  const F = gl.createFramebuffer(), A = tex(), Bt = tex();
  gl.viewport(0, 0, S, S);
  att(F, A); clear(1, 0, 0);
  att(F, Bt); clear(0, 1, 0);
  att(F, A); log("swap: A kept", px(2, 2), R);
  quad([0, 0, 0.5, 1], [0, 0, 1, 1]);
  log("swap: A drawn left", px(2, 2), B);
  log("swap: A right", px(12, 2), R);
  att(F, null);
  log("swap: detached status", status());
  log("swap: B on canvas", show(Bt, 40, 40), G);
  log("swap: A on canvas left", show(A, 8, 8), B);
  log("swap: A on canvas right", show(A, 56, 8), R);
  att(F, Bt); gl.viewport(0, 0, S, S);
  log("swap: B again", px(5, 5), G);
  log("swap: B status", status(), "complete");
  gl.deleteFramebuffer(F); gl.deleteTexture(A); gl.deleteTexture(Bt);
}

// 2. A depth renderbuffer attached before any texture: every texture's framebuffer must test depth.
// 3. The same with the renderbuffer attached after the first texture.
for (const order of ["rb first", "rb after A"]) {
  const F = gl.createFramebuffer(), A = tex(), Bt = tex(), rb = depthRb();
  gl.bindFramebuffer(gl.FRAMEBUFFER, F);
  if (order === "rb first") gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  att(F, A);
  if (order !== "rb first") gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  gl.viewport(0, 0, S, S);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
  clear(0, 0, 0);
  quad([0, 0, 1, 1], [0, 1, 0, 1], 0.0);
  quad([0, 0, 1, 1], [1, 0, 0, 1], 0.6); // behind: hidden
  log(`depth ${order}: A`, px(8, 8), G);
  log(`depth ${order}: A status`, status(), "complete");
  att(F, Bt);
  gl.viewport(0, 0, S, S);
  gl.enable(gl.DEPTH_TEST);
  clear(0, 0, 0);
  quad([0, 0, 1, 1], [0, 0, 1, 1], 0.6);
  quad([0, 0, 1, 1], [1, 0, 0, 1], 0.8); // behind blue: hidden only if B has the depth buffer
  quad([0, 0, 0.5, 1], [1, 1, 0, 1], 0.0);
  log(`depth ${order}: B left`, px(2, 8), Y);
  log(`depth ${order}: B right`, px(12, 8), B);
  log(`depth ${order}: B status`, status(), "complete");
  gl.disable(gl.DEPTH_TEST);
  log(`depth ${order}: A on canvas`, show(A, 32, 32), G);
  gl.deleteFramebuffer(F); gl.deleteTexture(A); gl.deleteTexture(Bt); gl.deleteRenderbuffer(rb);
}

// 4. A texture deleted while attached, then a new texture (GL may reuse the name) attached in its place.
{
  const F = gl.createFramebuffer(), A = tex();
  att(F, A); gl.viewport(0, 0, S, S); clear(1, 0, 0);
  gl.deleteTexture(A);
  log("delete: status after", status());
  const D = tex();
  att(F, D); gl.viewport(0, 0, S, S); clear(1, 0, 1);
  log("delete: new texture", px(3, 3), M);
  log("delete: new status", status(), "complete");
  log("delete: new on canvas", show(D, 10, 10), M);
  gl.deleteFramebuffer(F); gl.deleteTexture(D);
}

// 5. A framebuffer that also gets a cube-map face (not a plain 2D color texture) becomes a plain one; textures
// attached later still render where they should.
{
  const F = gl.createFramebuffer(), A = tex(), Bt = tex();
  const cube = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
  for (let i = 0; i < 6; i++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  att(F, A); gl.viewport(0, 0, S, S); clear(1, 0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X, cube, 0);
  clear(0, 0, 1);
  log("plain: cube face", px(1, 1), B);
  att(F, Bt); gl.viewport(0, 0, S, S); clear(0, 1, 0);
  log("plain: B", px(1, 1), G);
  att(F, A);
  log("plain: A kept", px(1, 1), R);
  log("plain: B on canvas", show(Bt, 20, 20), G);
  gl.deleteFramebuffer(F); gl.deleteTexture(A); gl.deleteTexture(Bt); gl.deleteTexture(cube);
}

// 6. copyTexSubImage2D reads the framebuffer bound now (the real one for that texture).
{
  const F = gl.createFramebuffer(), A = tex(), Bt = tex(), C = tex();
  att(F, A); gl.viewport(0, 0, S, S); clear(1, 1, 0);
  att(F, Bt); clear(0, 0, 1);
  att(F, A);
  gl.bindTexture(gl.TEXTURE_2D, C);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, S, S);
  log("copy: from A", show(C, 30, 30), Y);
  gl.deleteFramebuffer(F); gl.deleteTexture(A); gl.deleteTexture(Bt); gl.deleteTexture(C);
}

// 7. Deleting the bound framebuffer binds null (the canvas): the next draw lands on the canvas.
{
  const F = gl.createFramebuffer(), A = tex();
  att(F, A); gl.viewport(0, 0, S, S); clear(0, 0, 0);
  gl.deleteFramebuffer(F);
  log("delete bound: binding", String(gl.getParameter(gl.FRAMEBUFFER_BINDING)), "null");
  gl.viewport(0, 0, 64, 64);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  quad([0, 0, 1, 1], [0, 1, 0, 1]);
  log("delete bound: canvas drawn", px(32, 32), G);
  gl.deleteTexture(A);
}

// 8. Two framebuffers sharing one texture, swapped independently.
{
  const F1 = gl.createFramebuffer(), F2 = gl.createFramebuffer(), A = tex(), Bt = tex();
  att(F1, A); gl.viewport(0, 0, S, S); clear(1, 0, 0);
  att(F2, A); quad([0.5, 0, 0.5, 1], [0, 0, 1, 1]);
  att(F1, Bt); clear(0, 1, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, F2);
  log("shared: F2 on A left", px(2, 2), R);
  log("shared: F2 on A right", px(13, 2), B);
  gl.deleteTexture(A);
  att(F2, Bt);
  log("shared: F2 on B after A deleted", px(2, 2), G);
  gl.deleteFramebuffer(F1); gl.deleteFramebuffer(F2); gl.deleteTexture(Bt);
}

// 9. Canvas clears across binds, scissor, color mask, state kept, read back (the canvas is an FBO when its
// size differs from the window: t_fbo_check.sh runs this in an 80x80 window). Written for a lazy canvas
// clear that was tried and removed (2026-11-04: no measurable gain on the Mali-G31); kept as a check.
{
  const F = gl.createFramebuffer(), A = tex();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, 64, 64);
  gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);              // canvas red, then away to F
  att(F, A); gl.viewport(0, 0, S, S); gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  quad([0, 0, 1, 1], [0, 1, 0, 1]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, 64, 64);
  log("lazy: canvas clear kept across a bind", px(40, 40), R);
  // Scissored clear, then a full one under it in the wrong order on purpose: order must hold.
  gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 16, 16);
  gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
  att(F, A); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  log("lazy: scissored clear inside", px(5, 5), B);
  log("lazy: scissored clear outside", px(40, 40), G);
  // Color mask at clear time: only red written over black.
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.colorMask(true, false, false, true); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.colorMask(true, true, true, true);
  att(F, A); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  log("lazy: color mask at clear time", px(30, 30), R);
  // State changed after the clear: the replay uses the clear's, the game keeps its own.
  gl.clearColor(1, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.clearColor(0, 0, 1, 1); gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 8, 8); gl.colorMask(true, true, true, true);
  quad([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 1]);                              // scissored to 8x8: nothing lands at (60,60)
  gl.disable(gl.SCISSOR_TEST);
  log("lazy: replayed before a draw", px(60, 60), Y);
  const cc = gl.getParameter(gl.COLOR_CLEAR_VALUE);
  log("lazy: game clear color kept", Array.from(cc).join(","), "0,0,1,1");
  log("lazy: game scissor box kept", Array.from(gl.getParameter(gl.SCISSOR_BOX)).join(","), "0,0,8,8");
  // readPixels and copyTexSubImage2D right after a waiting clear.
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  log("lazy: readPixels sees it", px(20, 50), M);
  gl.clearColor(0, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const C = tex();
  gl.bindTexture(gl.TEXTURE_2D, C);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, S, S);
  log("lazy: copyTexSubImage2D sees it", show(C, 30, 30), "0,255,255");
  gl.deleteFramebuffer(F); gl.deleteTexture(A); gl.deleteTexture(C);
}

log("gl errors", String(gl.getError()), "0");
for (const l of out) console.log(l);
console.log(`t_fbo: ${fails ? fails + " FAILED" : "all passed"} (POWERBOAT_FBO_PER_TEXTURE=${typeof process !== "undefined" && process.env ? process.env.POWERBOAT_FBO_PER_TEXTURE ?? "" : "?"})`);
