// powerboat JS environment, part 13: what RPG Maker MZ needs beyond MV (main.rs sets POWERBOAT_MZ=1 when the game
// folder has js/rmmz_core.js). Also for MZ: element.classList (00_env.js), the load event after boot-time XHRs
// (40_web.js) and IndexedDB (81_storage.js).
"use strict";
(() => {
  if (Deno.core.ops.op_powerboat_env("POWERBOAT_MZ") !== "1") return;
  // js/libs/vorbisdecoder.js is MZ's OGG decoder for browsers that cannot play OGG (Safari): WebAssembly on a
  // Worker it starts as soon as it loads, which stopped the boot here ("Worker is not defined"). MZ uses it only
  // when <audio>.canPlayType says no to Vorbis (Utils.canPlayOgg); the runtime says yes and decodes OGG natively
  // through decodeAudioData, streaming long tracks. So the file is left out; its load event still fires, which
  // main.js counts before it starts the game.
  __powerboat.skipScript = (src) => /(^|\/)libs\/vorbisdecoder\.js$/i.test(String(src).replace(/[?#].*$/, ""));
  console.log("powerboat: RPG Maker MZ layer on (vorbisdecoder.js left out: OGG is decoded natively)");
})();
