// Lazy short sounds check (audio.rs Packed::lazy + the LAZY cache): decodes a set of short WebM/Opus
// effects with decodeAudioData, then plays each one alone and reports when it ended against its
// duration (a sound whose samples were dropped waits for the audio-stream thread, so it may end a
// block or two late, never early or cut), plus a checksum of the samples read back through
// getChannelData. Run once with POWERBOAT_AUDIO_LAZY_MB=1 (almost everything dropped) and once with
// POWERBOAT_AUDIO_LAZY=0 (all kept, as before): the checksums must match and every sound must end.
//   powerboat --root <Moonstone Island game> --script examples/t_lazy_audio.js --secs 40
const FILES = [
  "media/PlayerWalk/SFX_Player_Footstep_Carpet_01.webm",
  "media/PlayerWalk/SFX_Player_Footstep_Carpet_02.webm",
  "media/Battle/SFX_Battle_Attack_Bite.webm",
  "media/Battle/SFX_Battle_Attack_Blue_Ball.webm",
  "media/Battle/SFX_Battle_Attack_Blue_Bolt.webm",
  "media/Battle/SFX_Battle_Attack_Dark_Mirror.webm",
  "media/Atmo/SFX_Env_Magic_Mirror_Enter.webm",
  "media/Atmo/SFX_Env_Magic_Mirror_Leave.webm",
  "media/Cinematic/SFX_Cin_Intro_Storm.webm",
  "media/Cinematic/SFX_Cin_Intro_Fall.webm",
];
const ctx = new AudioContext();
const load = (f) => new Promise((ok, fail) => {
  const x = new XMLHttpRequest();
  x.open("GET", f);
  x.responseType = "arraybuffer";
  x.onload = () => ctx.decodeAudioData(x.response, ok, fail);
  x.onerror = fail;
  x.send();
});
const sum = (b) => {
  let s = 0;
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 7) s += Math.abs(d[i]); }
  return s.toFixed(3);
};
(async () => {
  const bufs = [];
  for (const f of FILES) bufs.push(await load(f));
  console.log("decoded", bufs.length, "sounds; external audio", (Deno.core.ops.op_audio_bytes() / 1048576).toFixed(1), "MB");
  let late = 0, bad = 0;
  for (let i = 0; i < bufs.length; i++) {
    const b = bufs[i];
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    const ended = new Promise((ok) => { src.onended = () => ok(ctx.currentTime); });
    src.start(0);
    const t1 = await Promise.race([ended, new Promise((ok) => setTimeout(() => ok(-1), (b.duration + 3) * 1000))]);
    const over = t1 < 0 ? NaN : t1 - t0 - b.duration;
    if (t1 < 0 || over < -0.05) bad++;
    if (over > 0.1) late++;
    console.log(`play ${FILES[i].split("/").pop()}: ${b.numberOfChannels}ch ${b.duration.toFixed(2)} s, ended ${t1 < 0 ? "NEVER" : (over >= 0 ? "+" : "") + (over * 1000).toFixed(0) + " ms vs duration"}`);
  }
  // Two at once, the second one long dropped (decoded first).
  const a = ctx.createBufferSource(), c = ctx.createBufferSource();
  a.buffer = bufs[bufs.length - 1]; c.buffer = bufs[0];
  a.connect(ctx.destination); c.connect(ctx.destination);
  const both = Promise.all([new Promise((ok) => { a.onended = ok; }), new Promise((ok) => { c.onended = ok; })]);
  a.start(0); c.start(0);
  await Promise.race([both, new Promise((ok) => setTimeout(ok, 8000))]);
  console.log("two at once: ended");
  console.log("checksums", bufs.map(sum).join(" "));
  console.log(`RESULT ${bad === 0 ? "PASS" : "FAIL"}: ${bufs.length} sounds, ${bad} cut or never ended, ${late} more than 100 ms late; external audio after reads ${(Deno.core.ops.op_audio_bytes() / 1048576).toFixed(1)} MB`);
})().catch((e) => console.log("RESULT FAIL", e && (e.stack || e.message || e)));
