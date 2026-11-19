// What one object costs on the V8 heap (as h5bench's bytes.* tests measure it, with gc()). Pointer compression
// halves most of these; Chrome (with it): 24 bytes for {x, y, z} with integers, 184 for Float32Array(16).
//   POWERBOAT_V8_FLAGS=--expose-gc bash tools/pcbuild.sh run examples/t_bytes.js 10
const MB = 1048576;
const heap = () => process.memoryUsage().heapUsed;
const cost = (label, prep, fill, n) => {
  const per = [];
  for (let r = 0; r < 3; r++) { const box = prep(n); gc(); gc(); const a = heap(); const kept = fill(box, n); gc(); gc(); const b = heap(); per.push((b - a) / n); globalThis.sink = kept; }
  per.sort((x, y) => x - y); console.log(`[bytes] ${label}: ${per[1].toFixed(1)} (${per.map((v) => v.toFixed(1)).join(" ")})`);
};
const obj = (i) => ({ x: i, y: i + 1, z: i + 2 });
const each = (make) => [(n) => new Array(n).fill(0), (a, n) => { for (let i = 0; i < n; i++) a[i] = make(i); return a; }];
cost("3 ints, h5bench box n=100000", ...each(obj), 100000);
cost("3 ints, box n=50000", ...each(obj), 50000);
cost("3 ints, push", () => [], (a, n) => { for (let i = 0; i < n; i++) a.push(obj(i)); return a; }, 100000);
cost("float32array_16", ...each(() => new Float32Array(16)), 100000);
const hs = new Float64Array(6); Deno.core.ops.op_powerboat_heap_stats(new Uint8Array(hs.buffer));
console.log(`[bytes] heap used ${(hs[0] / MB).toFixed(2)} total ${(hs[1] / MB).toFixed(2)} limit ${(hs[2] / MB).toFixed(0)} MB`);
window.close();
