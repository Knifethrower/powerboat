// Memory readings (src/mem.rs): process.memoryUsage() follows the V8 heap, ArrayBuffers, the runtime's own
// native memory (a Canvas 2D pixmap here) and RSS; resourceUsage().maxRSS is in KB; the cost of one call.
//   bash tools/pcbuild.sh run examples/t_memory.js 10
const MB = 1048576;
const f = (v) => (v / MB).toFixed(1);
const show = (tag) => {
  const u = process.memoryUsage(), pm = performance.memory;
  console.log(`[mem] ${tag}: rss ${f(u.rss)} heapUsed ${f(u.heapUsed)} heapTotal ${f(u.heapTotal)} external ${f(u.external)} arrayBuffers ${f(u.arrayBuffers)} | maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} | perf.memory used ${f(pm.usedJSHeapSize)} total ${f(pm.totalJSHeapSize)} limit ${f(pm.jsHeapSizeLimit)}`);
  return u;
};
const frames = (n) => new Promise((r) => { const step = () => (n-- > 0 ? requestAnimationFrame(step) : r()); step(); });
let keep = null;
(async () => {
  const a = show("start");
  keep = new Uint8Array(64 * MB).fill(1);
  const b = show("64 MB ArrayBuffer filled");
  console.log(`[mem] delta arrayBuffers ${f(b.arrayBuffers - a.arrayBuffers)} rss ${f(b.rss - a.rss)} (expect 64, 64)`);
  const objs = []; for (let i = 0; i < 200000; i++) objs.push({ i, j: i + 1 });
  const c = show("200000 objects");
  console.log(`[mem] delta heapUsed ${f(c.heapUsed - b.heapUsed)} (expect ~4-8)`);
  const cv = document.createElement("canvas"); cv.width = cv.height = 2048;
  const x = cv.getContext("2d"); x.fillStyle = "#4a8"; x.fillRect(0, 0, 2048, 2048); x.getImageData(0, 0, 1, 1);
  await frames(70); // main.rs tells V8 about native memory every 30 frames
  const d = show("2048px canvas, 70 frames later");
  console.log(`[mem] delta external ${f(d.external - c.external)} arrayBuffers ${f(d.arrayBuffers - c.arrayBuffers)} (expect 16, 0: V8's external_memory is ArrayBuffers only)`);
  const time = (name, fn) => { const n = 20000; for (let i = 0; i < 1000; i++) fn(); const t = performance.now(); for (let i = 0; i < n; i++) fn(); console.log(`[mem] ${name}: ${((performance.now() - t) * 1000 / n).toFixed(2)} us per call`); };
  time("process.memoryUsage()", () => process.memoryUsage());
  time("process.memoryUsage.rss()", () => process.memoryUsage.rss());
  time("performance.memory", () => performance.memory);
  time("process.resourceUsage()", () => process.resourceUsage());
  console.log(`[mem] gc is ${typeof gc === "function" ? "a function" : typeof gc}`);
  keep = null; objs.length = 0;
  window.close();
})();
