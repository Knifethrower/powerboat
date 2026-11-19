// M0 exit check: a WebGL-shaped clear through the JS environment, colour cycling, fps once a
// second, timers and microtasks working, Escape (or Start) quits.
const canvas = document.createElement("canvas");
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
document.body.appendChild(canvas);
const gl = canvas.getContext("webgl");
console.log("GL:", gl.getParameter(gl.VENDOR), "|", gl.getParameter(gl.RENDERER), "|", gl.getParameter(gl.VERSION));
console.log("drawing buffer", gl.drawingBufferWidth + "x" + gl.drawingBufferHeight, "canvas", canvas.width + "x" + canvas.height);

let frames = 0, last = performance.now();
function loop(now) {
  const t = now / 1000;
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor((Math.sin(t * 2) + 1) / 2, (Math.sin(t * 1.3 + 2) + 1) / 2, (Math.sin(t * 0.7 + 4) + 1) / 2, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  frames++;
  if (now - last >= 1000) {
    console.log("fps " + (frames * 1000 / (now - last)).toFixed(1) + " err " + gl.getError());
    frames = 0;
    last = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.addEventListener("keydown", (e) => {
  console.log("keydown", e.keyCode, JSON.stringify(e.key), e.code);
  if (e.keyCode === 27) window.close();
});
setTimeout(() => console.log("timer 500 ms ok"), 500);
const iv = setInterval(() => console.log("interval tick"), 1000);
setTimeout(() => { clearInterval(iv); console.log("interval cleared"); }, 2500);
Promise.resolve().then(() => console.log("microtask ok"));
console.log("m0.js loaded");
