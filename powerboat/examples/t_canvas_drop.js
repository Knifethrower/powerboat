// Dropped canvases: their pixmaps (native memory) are freed by a FinalizationRegistry once V8 collects the JS
// objects. How long after 100 512px canvases (100 MB) are made and dropped in one frame does RSS come back, with no
// gc() (as games run)? Prints RSS and the runtime's native bytes every 100 ms.
//   bash tools/pcbuild.sh run examples/t_canvas_drop.js 20
const MB = 1048576;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = () => { const u = process.memoryUsage(); return { rss: u.rss / MB, native: (u.external - u.arrayBuffers) / MB }; };
(async () => {
  await sleep(1500);
  for (let round = 1; round <= 2; round++) {
    const base = read();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) { const c = document.createElement("canvas"); c.width = c.height = 512; const x = c.getContext("2d"); x.fillStyle = "#4a8"; x.fillRect(0, 0, 512, 512); x.getImageData(0, 0, 1, 1); }
    const made = read();
    console.log(`[drop] round ${round}: before rss ${base.rss.toFixed(0)} native ${base.native.toFixed(0)} | after making 100: rss ${made.rss.toFixed(0)} native ${made.native.toFixed(0)}`);
    let back = null;
    for (let k = 1; k <= 60; k++) {
      await sleep(100);
      const m = read();
      if (k % 5 === 0 || (back === null && m.native < base.native + 5)) console.log(`[drop]   +${((performance.now() - t0) / 1000).toFixed(1)} s: rss ${m.rss.toFixed(0)} native ${m.native.toFixed(0)}`);
      if (back === null && m.native < base.native + 5) { back = performance.now() - t0; break; }
    }
    console.log(`[drop] round ${round}: native memory back after ${back === null ? "more than 6 s" : (back / 1000).toFixed(2) + " s"}`);
    await sleep(1000);
  }
  window.close();
})();
