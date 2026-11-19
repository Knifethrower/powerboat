// texImage2D(..., null) check (2026-11-18): a large RGBA texture made without data reads back as transparent
// black (cleared on the GPU now), and the GL state around it is what the page set.
//   powerboat --script examples/t_null_tex.js     (POWERBOAT_GL_GPU_CLEAR=0: the zero upload, for comparison)
const c = document.createElement("canvas");
c.width = 64; c.height = 64;
const gl = c.getContext("webgl");
const fb = gl.createFramebuffer();
const t0 = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, t0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t0, 0);
gl.clearColor(1, 0, 0.5, 1);
gl.enable(gl.SCISSOR_TEST);
gl.scissor(3, 4, 5, 6);
gl.colorMask(true, true, false, true);
gl.activeTexture(gl.TEXTURE3);
let ok = true;
const check = (what, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { ok = false; console.log("t_null_tex FAIL", what, g, "want", w); } };
for (const [w, h] of [[1024, 1024], [2048, 2048], [700, 500]]) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const s = performance.now();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const ms = performance.now() - s;
  check("framebuffer binding", gl.getParameter(gl.FRAMEBUFFER_BINDING) === fb, true);
  check("texture binding", gl.getParameter(gl.TEXTURE_BINDING_2D) === t, true);
  check("active texture", gl.getParameter(gl.ACTIVE_TEXTURE), gl.TEXTURE3);
  check("clear color", Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)).map((v) => Math.round(v * 100) / 100), [1, 0, 0.5, 1]);
  check("scissor test", gl.isEnabled(gl.SCISSOR_TEST), true);
  check("scissor box", Array.from(gl.getParameter(gl.SCISSOR_BOX)), [3, 4, 5, 6]);
  check("color mask", gl.getParameter(gl.COLOR_WRITEMASK), [true, true, false, true]);
  // Read the new texture's corners and middle through a second framebuffer.
  const f2 = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f2);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const px = new Uint8Array(4);
  for (const [x, y] of [[0, 0], [w - 1, h - 1], [w >> 1, h >> 1], [w - 1, 0]]) { gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); check(`pixel ${x},${y} of ${w}x${h}`, Array.from(px), [0, 0, 0, 0]); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.deleteFramebuffer(f2);
  console.log(`t_null_tex ${w}x${h}: ${ms.toFixed(1)} ms`);
}
// The first framebuffer still draws: a clear inside the scissor box shows up there and nowhere else.
gl.clear(gl.COLOR_BUFFER_BIT);
const px = new Uint8Array(4);
gl.readPixels(4, 5, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); check("cleared inside scissor", Array.from(px), [255, 0, 0, 255]);
gl.readPixels(20, 20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); check("outside scissor", Array.from(px), [0, 0, 0, 0]);
console.log("t_null_tex", ok ? "ok" : "FAILED");
window.close();
