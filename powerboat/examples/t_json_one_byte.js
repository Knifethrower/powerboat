// One-byte JSON decode check (src/ops.rs json_one_byte via 40_web.js __powerboat.decodeJson): every JSON file given is
// parsed from the plain UTF-8 decode and from the escaped one-byte text; the two results must be identical
// (compared as JSON.stringify output). Prints parse times and whether the escaped text was needed.
//   powerboat --root <game> --script examples/t_json_one_byte.js --secs 60     (files: globalThis.__jsonFiles or
//   the defaults below, paths relative to the root)
const FILES = globalThis.__jsonFiles || ["data.json", "Data/Dialogues/stringsDialogue.json", "Data/achievements.json", "Data/Dialogues/strings_social_artist.json"];
const load = (f) => new Promise((ok, fail) => {
  const x = new XMLHttpRequest();
  x.open("GET", f);
  x.responseType = "arraybuffer";
  x.onload = () => ok(new Uint8Array(x.response));
  x.onerror = () => fail(new Error("load " + f));
  x.send();
});
(async () => {
  let bad = 0;
  for (const f of FILES) {
    const u8 = await load(f);
    let t = performance.now();
    const a = JSON.parse(Deno.core.decode(u8));
    const tPlain = performance.now() - t;
    const escaped = Deno.core.ops.op_json_one_byte(u8);
    t = performance.now();
    const b = JSON.parse(__powerboat.decodeJson(u8));
    const tOne = performance.now() - t;
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) bad++;
    console.log(`json ${f}: ${(u8.length / 1048576).toFixed(1)} MB, escaped text ${escaped == null ? "not needed" : (escaped.length / 1048576).toFixed(1) + " MB"}, parse plain ${tPlain.toFixed(0)} ms, one-byte path ${tOne.toFixed(0)} ms, ${same ? "same" : "DIFFERENT"}`);
  }
  console.log(`RESULT ${bad ? "FAIL" : "PASS"}: ${FILES.length} files, ${bad} different`);
})().catch((e) => console.log("RESULT FAIL", e && (e.stack || e)));
