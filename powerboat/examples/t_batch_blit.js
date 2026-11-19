// Pixel A/B for draw_batch (2026-11-18): runs of drawImage calls drawn band by band must give exactly the
// pixels of drawing them one by one. Run with and without POWERBOAT_C2D_BANDS=0 and compare the hashes / files.
//   powerboat --script examples/t_batch_blit.js   (env T_OUT=<file>: raw 640x480 RGBA, premultiplied)
// Runs: overlapping sprites at whole and fractional offsets (order matters where they overlap), global alpha,
// "lighter", mirrored by the CTM, partly off every edge, a run broken by a fillRect, and a canvas drawn onto itself.
const c = document.createElement("canvas");
c.width = 640; c.height = 480;
const x = c.getContext("2d");
x.fillStyle = "#223"; x.fillRect(0, 0, 640, 480);

const a = document.createElement("canvas");
a.width = 256; a.height = 256;
const ax = a.getContext("2d");
for (let i = 0; i < 64; i++) {
  ax.fillStyle = "hsla(" + (i * 37 % 360) + ", 70%, 55%, " + (0.4 + (i % 3) * 0.3) + ")";
  ax.fillRect((i & 7) * 32 + 2, (i >> 3) * 32 + 2, 28, 28);
  ax.fillStyle = "#fff"; ax.fillRect((i & 7) * 32 + 10, (i >> 3) * 32 + 10, 6, 6);
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const run = (n, frac) => {
  for (let i = 0; i < n; i++) {
    const px = rnd() * 700 - 40, py = rnd() * 540 - 40;
    x.drawImage(a, (i & 7) * 32, ((i >> 3) & 7) * 32, 32, 32, frac ? px : Math.round(px), frac ? py : Math.round(py), 32, 32);
  }
};
run(400, false);
run(400, true);
x.globalAlpha = 0.6; run(150, true); x.globalAlpha = 1;
x.globalCompositeOperation = "lighter"; run(150, false); x.globalCompositeOperation = "source-over";
x.save(); x.setTransform(-1, 0, 0, 1, 640, 0); run(150, false); x.restore();
run(20, false); x.fillStyle = "rgba(255,0,0,0.3)"; x.fillRect(100, 100, 50, 50); run(20, true);
for (let i = 0; i < 12; i++) x.drawImage(c, i * 40, 0, 40, 40, i * 40 + 3, 200, 40, 40);
// Whole images (the tiny-skia path) and scaled draws inside a run end it.
for (let i = 0; i < 12; i++) { x.drawImage(a, 0, 0, 32, 32, i * 50, 420, 32, 32); x.drawImage(a, i * 30, 440); x.drawImage(a, 0, 0, 32, 32, i * 50 + 20, 400, 48, 48); }

const d = x.getImageData(0, 0, 640, 480).data;
let h = 2166136261;
for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
console.log("t_batch_blit hash", (h >>> 0).toString(16));
const out = Deno.core.ops.op_powerboat_env("T_OUT");
if (out) require("fs").writeFileSync(out, new Uint8Array(d.buffer));
window.close();
