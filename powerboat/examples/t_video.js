// <video> check with --root <OMORI www>: MV-style DOM video over a cleared WebGL canvas, the movie's
// own soundtrack as clock, timeupdate count, ended event; plus texImage2D(video) into a texture.
const MOVIE = globalThis.__powerboatTestMovie || "movies/bookcase_animation_final.webm";
const canvas = document.createElement("canvas");
canvas.width = 640; canvas.height = 480;
document.body.appendChild(canvas);
const gl = canvas.getContext("webgl");
const v = document.createElement("video");
let updates = 0;
v.addEventListener("timeupdate", () => updates++);
v.onloadeddata = () => {
  console.log("loadeddata", v.videoWidth + "x" + v.videoHeight, "duration", v.duration.toFixed(2), "readyState", v.readyState);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
  console.log("texImage2D(video) err", gl.getError());
  v.play();
};
v.onerror = () => console.log("video error", v.error && v.error.message);
v.onended = () => {
  console.log("ended at", v.currentTime.toFixed(2), "timeupdates", updates, "id after end", v._powerboatVideoId);
  if (!globalThis.__replayed) { globalThis.__replayed = true; v.play().then(() => console.log("replay started, id", v._powerboatVideoId, "duration", v.duration.toFixed(2))); setTimeout(() => window.close(), 3000); }
};
document.body.appendChild(v);
v.src = MOVIE;
let last = 0;
function loop(now) {
  gl.clearColor(0.1, 0.2, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  if (now - last > 2000) { last = now; console.log("t", (now / 1000).toFixed(1), "video", v.currentTime.toFixed(2), "paused", v.paused, "updates", updates); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
