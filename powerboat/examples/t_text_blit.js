// Pixel A/B for the cached glyph masks and the bilinear sub-pixel blit (2026-11-17): run the same binary
// with and without POWERBOAT_GLYPH_CACHE=0 / POWERBOAT_C2D_BILINEAR=0 and compare the files it writes.
//   powerboat --script examples/t_text_blit.js   (env T_OUT=<file>: raw 640x480 RGBA, premultiplied)
// Text: fill and stroke (MV's outline: lineWidth 4, round joins), whole and fractional positions, center
// and right alignment, maxWidth squeeze, global alpha, a 1.5x CTM, and a rotated CTM (outline path).
// Sprites: an atlas with soft edges drawn 1:1 at whole, quarter and odd fractions, with global alpha,
// smoothing off, and next to the atlas edge.
const c = document.createElement("canvas");
c.width = 640; c.height = 480;
const x = c.getContext("2d");
x.fillStyle = "#406080"; x.fillRect(0, 0, 640, 480);

x.fillStyle = "#fff"; x.font = "18px sans-serif";
x.fillText("Harold HP 120/120 MP 45", 10, 24);
x.fillText("Harold HP 120/120 MP 45", 10.3, 46.6);
x.fillStyle = "rgba(255, 220, 0, 0.6)"; x.font = "bold 28px serif";
x.fillText("Gold 1,234 G", 10.75, 84.25);
x.textAlign = "center"; x.fillStyle = "#e0e0ff"; x.font = "22px sans-serif";
x.fillText("Centered title text", 320, 110);
x.textAlign = "right"; x.fillText("Right edge", 630.5, 134.5);
x.textAlign = "left";
x.fillText("Squeezed into 120 px of width", 10, 160, 120);
x.font = "22px sans-serif"; x.lineWidth = 4; x.lineJoin = "round"; x.strokeStyle = "rgba(0, 0, 0, 0.5)"; x.fillStyle = "#fff";
for (let i = 0; i < 4; i++) { const s = "Outlined " + i; x.strokeText(s, 10 + i * 0.25 + i * 150, 196); x.fillText(s, 10 + i * 0.25 + i * 150, 196); }
x.globalAlpha = 0.5; x.fillStyle = "#0f0"; x.fillText("Half alpha", 10, 226); x.globalAlpha = 1;
x.save(); x.setTransform(1.5, 0, 0, 1.5, 200, 200); x.fillStyle = "#fc8"; x.fillText("Scaled 1.5x", 0, 20); x.restore();
x.save(); x.translate(500, 230); x.rotate(0.3); x.fillStyle = "#8cf"; x.fillText("Rotated", 0, 0); x.restore();
x.font = "12px sans-serif"; x.fillStyle = "#ddd";
x.fillText("Small 12 px text, the quick brown fox jumps over the lazy dog 0123456789", 10, 250.5);

const a = document.createElement("canvas");
a.width = 128; a.height = 64;
const ax = a.getContext("2d");
for (let i = 0; i < 8; i++) {
  const g = ax.createLinearGradient(i * 16, 0, i * 16 + 16, 16);
  g.addColorStop(0, "hsl(" + i * 45 + ", 80%, 60%)"); g.addColorStop(1, "rgba(255, 255, 255, 0.2)");
  ax.fillStyle = g; ax.beginPath(); ax.arc(i * 16 + 8, 8, 7, 0, Math.PI * 2); ax.fill();
  ax.fillStyle = "hsl(" + i * 45 + ", 60%, 40%)"; ax.fillRect(i * 16, 16, 16, 16);
}
ax.fillStyle = "#fff"; ax.fillRect(0, 32, 128, 32);
const fr = [0, 0.25, 0.5, 0.75, 0.3, 0.9];
for (let r = 0; r < fr.length; r++) for (let k = 0; k < 8; k++) {
  const dx = 10 + k * 20 + fr[r], dy = 270 + r * 20 + fr[(r + k) % fr.length];
  x.drawImage(a, (k & 7) * 16, (k & 1) * 16, 16, 16, dx, dy, 16, 16);
}
x.globalAlpha = 0.6;
for (let k = 0; k < 8; k++) x.drawImage(a, k * 16, 0, 16, 16, 200 + k * 20 + 0.4, 270.7, 16, 16);
x.globalAlpha = 1;
x.imageSmoothingEnabled = false;
for (let k = 0; k < 8; k++) x.drawImage(a, k * 16, 0, 16, 16, 200 + k * 20 + 0.4, 300.2, 16, 16);
x.imageSmoothingEnabled = true;
x.drawImage(a, 0, 32, 128, 32, 400.5, 270.5, 128, 32);
x.drawImage(a, 0, 0, 128, 64, 633.6, 400.4, 128, 64);
x.drawImage(a, 0, 0, 128, 64, -100.3, 470.6, 128, 64);

const d = x.getImageData(0, 0, 640, 480).data;
let h = 2166136261;
for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
console.log("t_text_blit hash", (h >>> 0).toString(16));
const out = Deno.core.ops.op_powerboat_env("T_OUT");
if (out) require("fs").writeFileSync(out, new Uint8Array(d.buffer));
window.close();
