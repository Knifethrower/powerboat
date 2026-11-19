// Pixel A/B for blit_affine (2026-11-18): rotated and smoothly scaled drawImage. Run the same binary with
// and without POWERBOAT_C2D_AFFINE=0 (tiny-skia's pattern) and compare the files it writes.
//   powerboat --script examples/t_affine_blit.js   (env T_OUT=<file>: raw 640x480 RGBA, premultiplied)
// Cases: h5bench's rotated 32 px sprites (1.5x, any angle), smoothing off, global alpha, "lighter",
// mirrored by a negative width, a smooth 1.5x and 0.6x zoom without rotation, a sub-rect at the atlas edge,
// a fractional source rect, a big rotated background (the threaded path), and draws partly off the canvas.
const c = document.createElement("canvas");
c.width = 640; c.height = 480;
const x = c.getContext("2d");
x.fillStyle = "#304860"; x.fillRect(0, 0, 640, 480);

const a = document.createElement("canvas");
a.width = 256; a.height = 256;
const ax = a.getContext("2d");
for (let i = 0; i < 64; i++) {
  const cx = (i & 7) * 32, cy = (i >> 3) * 32;
  const g = ax.createLinearGradient(cx, cy, cx + 32, cy + 32);
  g.addColorStop(0, "hsl(" + i * 23 + ", 85%, 65%)"); g.addColorStop(1, "hsla(" + i * 23 + ", 70%, 35%, 0.4)");
  ax.fillStyle = g; ax.beginPath(); ax.arc(cx + 16, cy + 16, 14, 0, Math.PI * 2); ax.fill();
  if (i % 3 === 0) { ax.fillStyle = "#fff"; ax.fillRect(cx + 4, cy + 14, 24, 4); }
}

for (let i = 0; i < 60; i++) {
  x.setTransform(1.5, 0, 0, 1.5, 20 + (i % 10) * 60, 20 + Math.floor(i / 10) * 45);
  x.rotate(i * 0.37 + 0.05);
  x.drawImage(a, (i & 7) * 32, ((i >> 3) & 7) * 32, 32, 32, -16, -16, 32, 32);
}
x.setTransform(1, 0, 0, 1, 0, 0);
x.imageSmoothingEnabled = false;
for (let i = 0; i < 6; i++) { x.save(); x.translate(40 + i * 50, 300); x.rotate(0.4 + i * 0.5); x.drawImage(a, i * 32, 64, 32, 32, -20, -20, 40, 40); x.restore(); }
x.imageSmoothingEnabled = true;
x.globalAlpha = 0.55;
for (let i = 0; i < 6; i++) { x.save(); x.translate(340 + i * 50, 300); x.rotate(-0.3 - i * 0.4); x.drawImage(a, i * 32, 96, 32, 32, -16, -16, 32, 32); x.restore(); }
x.globalAlpha = 1;
x.globalCompositeOperation = "lighter";
for (let i = 0; i < 4; i++) { x.save(); x.translate(40 + i * 45, 360); x.rotate(i); x.drawImage(a, 32, 0, 32, 32, -16, -16, 32, 32); x.restore(); }
x.globalCompositeOperation = "source-over";
x.save(); x.translate(260, 360); x.rotate(0.2); x.drawImage(a, 64, 0, 32, 32, 16, -16, -32, 32); x.restore();
x.save(); x.setTransform(1.5, 0, 0, 1.5, 300.3, 340.6); x.drawImage(a, 96, 0, 32, 32, 0, 0, 32, 32); x.restore();
x.save(); x.setTransform(0.6, 0, 0, 0.6, 360.25, 345.5); x.drawImage(a, 0, 0, 128, 64, 0, 0, 128, 64); x.restore();
x.save(); x.translate(470, 370); x.rotate(0.7); x.drawImage(a, 224, 224, 32, 32, -16, -16, 32, 32); x.restore();
x.save(); x.translate(520, 370); x.rotate(-0.9); x.drawImage(a, 40.5, 8.25, 20.5, 17.75, -10, -9, 20.5, 17.75); x.restore();
x.save(); x.translate(320, 430); x.rotate(0.12); x.globalAlpha = 0.5; x.drawImage(a, 0, 0, 256, 256, -300, -80, 600, 160); x.restore();
x.save(); x.translate(632, 100); x.rotate(0.8); x.drawImage(a, 0, 32, 64, 64, -32, -32, 64, 64); x.restore();
x.save(); x.translate(4, 470); x.rotate(-0.5); x.drawImage(a, 64, 64, 64, 64, -32, -32, 64, 64); x.restore();

const d = x.getImageData(0, 0, 640, 480).data;
let h = 2166136261;
for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
console.log("t_affine_blit hash", (h >>> 0).toString(16));
const out = Deno.core.ops.op_powerboat_env("T_OUT");
if (out) require("fs").writeFileSync(out, new Uint8Array(d.buffer));
window.close();
