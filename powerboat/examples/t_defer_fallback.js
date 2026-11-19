// Deferred Canvas 2D fallback check: draws and reads pixels back 5 times per frame. With
// POWERBOAT_C2D_DEFER=1 the runtime should switch to drawing in each op after ~3 s and say so in the log;
// the pixels read back must be right before and after the switch.
//   POWERBOAT_C2D_DEFER=1 powerboat --script t_defer_fallback.js --secs 6
(() => {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const g = c.getContext("2d");
  let frames = 0, bad = 0;
  const tick = () => {
    for (let i = 0; i < 5; i++) {
      const v = (frames * 5 + i) % 256;
      g.fillStyle = `rgb(${v},0,0)`;
      g.fillRect(0, 0, 64, 64);
      if (g.getImageData(10, 10, 1, 1).data[0] !== v) bad++;
    }
    frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => {
    console.log(`t_defer_fallback: ${frames} frames, ${bad} wrong reads`);
    globalThis.close && globalThis.close();
  }, 5000);
})();
