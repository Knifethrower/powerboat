// Construct 3 data.json without its animation frames (src/c3frames.rs): the project parsed whole and the project parsed
// without frames, with every animation's frames read back from the file by offset, must be identical (compared as
// JSON.stringify output). Each placeholder's frame count and sheet list are checked against the frames it stands for.
// Prints the sizes and times.
//   powerboat --root <game> --script examples/t_c3_frames.js --secs 60
const FILE = "data.json";
const ops = Deno.core.ops;
const load = (f) => new Promise((ok, fail) => {
  const x = new XMLHttpRequest();
  x.open("GET", f);
  x.responseType = "arraybuffer";
  x.onload = () => ok(new Uint8Array(x.response));
  x.onerror = () => fail(new Error("load " + f));
  x.send();
});
(async () => {
  const u8 = await load(FILE);
  const path = __powerboat.resolvePath(FILE);
  let t = performance.now();
  const stripped = ops.op_c3_strip_frames(path, u8);
  const tStrip = performance.now() - t;
  if (!stripped) { console.log("RESULT SKIP: no frames to take out of " + FILE); return; }
  t = performance.now();
  const whole = JSON.parse(Deno.core.decode(u8));
  const tWhole = performance.now() - t;
  t = performance.now();
  const lazy = JSON.parse(Deno.core.decode(stripped));
  const tLazy = performance.now() - t;
  let animations = 0, frames = 0, bad = 0, tRead = 0;
  for (const type of lazy.project[3]) {
    if (!type[7]) continue;
    for (const anim of type[7]) {
      const l = anim[7];
      if (!l.length || typeof l[0] !== "number") continue;
      t = performance.now();
      const raw = JSON.parse(ops.op_powerboat_read_range(path, l[1], l[2]));
      tRead += performance.now() - t;
      const sheets = [];
      for (const fr of raw) if (!sheets.some((s) => s[0] === fr[0])) sheets.push([fr[0], fr[1]]);
      const want = sheets.flat();
      if (raw.length !== l[3] || JSON.stringify(want) !== JSON.stringify(l.slice(4))) {
        bad++;
        console.log("placeholder differs: " + anim[0] + " " + JSON.stringify(l).slice(0, 200));
      }
      anim[7] = raw;
      animations++;
      frames += raw.length;
    }
  }
  const same = JSON.stringify(whole) === JSON.stringify(lazy);
  console.log(`c3 frames: ${(u8.length / 1048576).toFixed(1)} -> ${(stripped.length / 1048576).toFixed(1)} MB, ${frames} frames in ${animations} animations; strip ${tStrip.toFixed(0)} ms, parse whole ${tWhole.toFixed(0)} ms, parse stripped ${tLazy.toFixed(0)} ms, read back ${tRead.toFixed(0)} ms`);
  console.log(`RESULT ${same && !bad ? "PASS" : "FAIL"}: ${same ? "identical" : "DIFFERENT"}, ${bad} bad placeholders`);
})().catch((e) => console.log("RESULT FAIL", e && (e.stack || e)));
