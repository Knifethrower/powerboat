// Result log shared by the Phaser test scenes. Every line starts with "T " so the run script can
// pull them out of the runtime's console output; the page also runs unchanged in a real browser.
window.T = {
  results: {},
  log(state, name, detail) {
    if (this.results[name] && this.results[name].state === state) return;
    this.results[name] = { state, detail };
    console.log("T " + state + " " + name + (detail !== undefined ? " : " + detail : ""));
  },
  pass(name, detail) { this.log("PASS", name, detail); },
  fail(name, detail) { this.log("FAIL", name, detail); },
  info(name, detail) { console.log("T INFO " + name + " : " + detail); },
  // Runs one panel's setup; a throw fails that panel and leaves the others running.
  check(name, fn) {
    try {
      const r = fn();
      if (r === false) this.fail(name, "returned false"); else this.pass(name, typeof r === "string" ? r : undefined);
    } catch (e) { this.fail(name, (e && e.message) + (e && e.stack ? " @ " + String(e.stack).split("\n")[1] : "")); }
  },
  finish() {
    const all = Object.values(this.results);
    console.log("T SUMMARY pass=" + all.filter((r) => r.state === "PASS").length + " fail=" + all.filter((r) => r.state === "FAIL").length);
    if (window.__powerboat) window.close();
  },
};
window.addEventListener("error", (e) => T.fail("uncaught", e.message + " " + (e.filename || "") + ":" + (e.lineno || "")));
window.addEventListener("unhandledrejection", (e) => T.fail("unhandled-rejection", e.reason && e.reason.message));

// Electron apps with nodeIntegration (Frauki's Adventure): messages to the main process mustn't throw.
if (window.__powerboat) T.check("electron-ipc", () => {
  const ipc = require("electron").ipcRenderer;
  ipc.send("achievement", "X");
  return ipc.on("fullscreen-changed", () => {}) === ipc && typeof ipc.send === "function";
});

// Phaser 2's tile layer scroll: "copy" onto the canvas itself moves the rect, overlap included, and clears the rest.
T.check("canvas-self-copy", () => {
  const cv = document.createElement("canvas"); cv.width = 40; cv.height = 30;
  const c = cv.getContext("2d", { willReadFrequently: true });
  const at = (x, y) => Array.from(c.getImageData(x, y, 1, 1).data).join(",");
  c.fillStyle = "rgb(255,0,0)"; c.fillRect(0, 0, 40, 30);
  c.fillStyle = "rgb(0,255,0)"; c.fillRect(10, 10, 4, 4);
  c.save(); c.globalCompositeOperation = "copy"; c.drawImage(cv, 0, 0, 36, 28, 4, 2, 36, 28); c.restore();
  const got = [at(15, 13), at(13, 13), at(1, 15), at(20, 0), at(30, 20)].join(" ");
  const want = "0,255,0,255 255,0,0,255 0,0,0,0 0,0,0,0 255,0,0,255";
  if (got !== want) throw new Error(got + " != " + want);
});

// Formats and browser features Phaser probes, independent of Phaser.
T.probeAudio = async function () {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  T.info("audio-context", "state=" + ctx.state + " rate=" + ctx.sampleRate);
  const el = document.createElement("audio");
  for (const [ext, type] of [["ogg", 'audio/ogg; codecs="vorbis"'], ["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["wav", 'audio/wav; codecs="1"']]) {
    const can = el.canPlayType ? el.canPlayType(type) : "(no canPlayType)";
    let dec = "not tried";
    try {
      const ab = await (await fetch("assets/beep." + ext)).arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      dec = "ok " + buf.duration.toFixed(2) + "s";
    } catch (e) { dec = "FAILED " + (e && e.message); }
    T.log(/^ok/.test(dec) && can ? "PASS" : "FAIL", "audio-format-" + ext, "canPlayType='" + can + "' decode=" + dec);
  }
};

// Keys and mouse arrive from the run script (xdotool); gamepads from a device run.
T.watchInput = function () {
  window.addEventListener("keydown", (e) => T.info("dom-keydown", e.code + " key=" + e.key + " keyCode=" + e.keyCode));
  window.addEventListener("gamepadconnected", (e) => T.pass("dom-gamepadconnected", e.gamepad && e.gamepad.id));
  T.info("gamepad-api", "getGamepads=" + typeof (navigator.getGamepads) + " list=" + (navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean).length : "-"));
};
if (window.__powerboat) {
  let rafs = 0;
  (function count() { rafs++; requestAnimationFrame(count); })();
  setInterval(() => T.info("heartbeat", "t=" + (performance.now() / 1000).toFixed(1) + " rafs=" + rafs + " frame=" + (window.game && game.loop ? game.loop.frame + " running=" + game.loop.running + " sleep=" + game.loop.inFocus : "-")), 1000);
}
