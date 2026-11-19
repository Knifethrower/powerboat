// getImageData A/B (2026-11-18): rects inside, across every edge and outside a canvas with translucent pixels;
// one hash per rect, to compare builds.   powerboat --script examples/t_getimage.js
const c = document.createElement("canvas");
c.width = 200; c.height = 150;
const x = c.getContext("2d");
for (let i = 0; i < 40; i++) {
  x.fillStyle = "hsla(" + i * 29 + ", 80%, 50%, " + (0.1 + (i % 9) / 10) + ")";
  x.fillRect((i * 37) % 190, (i * 23) % 140, 30, 20);
}
x.fillStyle = "rgba(255, 255, 255, 0.004)"; x.fillRect(0, 0, 5, 5);
const rects = [[0, 0, 200, 150], [-10, -5, 50, 40], [180, 140, 40, 30], [-50, -50, 10, 10], [50, 20, 100, 100], [190, -3, 20, 160], [-7, 60, 220, 3], [199, 149, 1, 1]];
const out = [];
for (const [rx, ry, rw, rh] of rects) {
  const d = x.getImageData(rx, ry, rw, rh).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
  out.push(`${rx},${ry},${rw},${rh}:${(h >>> 0).toString(16)}`);
}
console.log("t_getimage " + out.join(" "));
window.close();
