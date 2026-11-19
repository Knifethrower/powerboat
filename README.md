# Powerboat

Formerly RMMV Native (crate and binary `rmmv-native`, the Construct copy `c3native`), renamed 2026-11-19 with no
old-name fallbacks: environment variables `RMMV_*` are now `POWERBOAT_*`, log lines start with `[powerboat]`, the
code cache folder is `<game>/.powerboat-cache`, transcoded videos are `<name>.powerboat.webm`, and test installs
live in `<ports>/.powerboat`.

The HTML5 runtime for PortMaster handhelds: V8 (JIT) plus native implementations of only the web APIs
HTML5 games use (WebGL 1 on GLES, Canvas 2D, Web Audio, WebM and MP4 video, a page DOM, the NW.js/Node
slice), in one Rust binary. It began as a browser-free RPG Maker MV runtime for OMORI. Since 2026-11-01 it
is the one runtime for RPG Maker MV and MZ, Construct 2 and 3, Phaser 2 to 4 and NW.js 2D pages such as
ImpactJS games.

Status (2026-11-07): `master` is the one runtime. A status audit passed on the
PC and four handhelds:
- RG Cube XX and TrimUI Smart Pro (Knulli)
- R36S 2GB (dArkOS)
- Retroid Pocket 5 (ROCKNIX, Adreno)

The RG353V (dArkOS) ran MV and OMORI in October. First runs on muOS (TrimUI Brick), ROCKNIX with Panfrost
(RG-34XXSP) and AmberELEC (RG552) passed on 2026-11-08.

Games run so far:
- RPG Maker MV: OMORI and an MV test game.
- RPG Maker MZ: Modern Times Rock'n'Roll (title, intro, first map; RG Cube XX about 30 fps).
- Construct 3: Moonstone Island, Janosik, Solitaire Holiday, Paperman, Very Unserious Game, Tsvetok, Aye Leon,
  Cloudberry Abyss, Yapori Advance, BOD Efsanesi: Pars.
- Construct 2: Hypnospace Outlaw, The Next Penelope, Topzerah.
- Phaser 2: Frauki's Adventure.
- NW.js page: an ImpactJS game.

Not done:
- Packaging (M6): two decisions are open.
- Playing and listening by hand on the current build.
- The WaveShaper, Convolver and DynamicsCompressor nodes (they pass sound through).

Files:

- `powerboat/` - the runtime crate:
  - `src/main.rs` window, GLES context, frame loop, code cache, V8 flags, malloc tuning, engine detection
  - `src/ops.rs` core ops (files, events, env); `src/casepath.rs` case-insensitive path fallback
  - `src/mem.rs` memory readings: `process.memoryUsage()`, `process.resourceUsage()`, `performance.memory`
  - `src/gl.rs` WebGL; `src/glthread.rs` GL calls on a thread of their own (opt-in);
    `src/progcache.rs` GL program binary cache
  - `src/canvas.rs` + `src/fonts.rs` Canvas 2D (tiny-skia, ttf-parser, direct blit paths, deferred
    drawing thread); `src/upload.rs` + `src/present.rs` 2D page upload and present threads;
    `src/fpsmeter.rs` frame counter
  - `src/image.rs` images; `src/crop.rs` sprite-sheet cropping; `src/c3frames.rs` Construct 3
    animation frames built on first use
  - `src/audio.rs` Web Audio mixer (node graph); `src/opus.rs` Opus
  - `src/video.rs` + `src/vpx.rs` WebM (libvpx) and MP4 (OpenH264); `src/yuvgl.rs` YUV to RGBA on the
    GPU; `src/hwdec.rs` hardware decoding through libpmhwdec (loaded at run time if present);
    `src/transcode.rs` + `src/enc_shim.c` `--transcode-videos`
  - `js/` the browser environment, in load order: 00_env (window, events, timers, rAF, keys,
    Gamepad API), 10_webgl, 20_dom (scripts, Image), 30_canvas2d, 40_web (XHR, fetch, Blob, storage,
    fonts, index.html boot), 50_audio, 60_node (Node/NW.js layer + MV fixes), 70_video, 79_webpage
    (page DOM for Construct exports and NW.js pages), 80_construct (Construct 2/3 support and engine
    patches), 81_storage (IndexedDB slice), 82_forms (form elements), 83_phaser (Phaser 2 fixes),
    84_rmmz (RPG Maker MZ)
  - `examples/` small checks: m0 (clear), m1_pixi (PIXI sprites), t_canvas, t_audio, t_video, t_fbo,
    t_json_one_byte, t_lazy_audio and more
- `docker/` - `Dockerfile` (image `powerboat-cross-base`, Ubuntu 22.04 toolchain + libvpx) and
  `Dockerfile.construct` (adds libopus: `powerboat-cross`, the image the build uses);
  `build.sh` the aarch64 build (`dist/powerboat.aarch64`, `--locked`, linked against Debian 10's
  glibc 2.28 from WSL `~/sysroot-buster`); `build_v8_ptrcomp.sh` V8 from source with pointer
  compression (about 1 h; the archive in WSL `~/.cache/powerboat/v8-ptrcomp-aarch64` is used by
  default).
- `tools/`:
  - PC: `pcbuild.sh` (host build + Xvfb run), `phaser_test.sh`, `t_fbo_check.sh`, `h5bench_pc.sh`
    ([h5bench](https://github.com/Knifethrower/h5bench) pages, a checkout in `$H5BENCH`).
  - Profiling: `v8_ticks_by_symbol.py` (V8 --prof ticks in the binary), `v8_prof_js.py`,
    `gl_frame_prof.js`, `gl_orphan_test.js`.
  - Licenses: `fetch_upstream_licenses.sh` + `collect_licenses.py` write the licenses/ folder; rerun
    them after a dependency or V8 change.
- `tests/phaser/` - Phaser 2, 3 and 4 test scenes (`tools/fetch_phaser.sh`, `make_assets.py`,
  `tools/phaser_test.sh`).
- `tests/audio-demo/` - the mixer listening test (14 scenes).
- `licenses/` - license texts for everything linked into the binary; `fonts/` - the runtime's fonts
  (Liberation, Carlito, Caladea) with their licenses.
- `dist/` - built binaries and device results (not in git).

Usage: `powerboat --game <folder>` (the www folder, the game folder holding it, or a folder holding
one game; boots its index.html), or `--script file.js [--root dir]`.
Options: `--window WxH` (else fullscreen), `--secs N`, `--shot out.ppm --shot-at S`, `--fps N`,
`--no-vsync`, `--font Family=file.ttf`. PortMaster's hotkey (`HOTKEY`: l3, guide, else Select) + Start
quits a game.

Other commands:
- `--transcode-videos <dir>`: an install step. It converts H.264 MP4 videos once into VP9/Opus WebM
  copies (`<name>.mp4.powerboat.webm`), which the runtime then plays instead. Options:
  - `--max-size WxH` (default 1280x720)
  - `--max-fps N` (30; closer frames are dropped)
  - `--kbps N` (600)
  - `--cq N` (33; 0 uses the bitrate instead)
  - `--cpu-used N` (7)
  - `--good`: libvpx's good deadline instead of realtime
  - `--force`: convert again
- `--decode-test <file>`: times the audio decoder alone.
- `--stream-test <file>`: checks the chunks a long sound streams from against a whole decode.

Environment switches (all optional):

| variable | effect |
|---|---|
| `POWERBOAT_INDEX` | HTML file to boot instead of index.html |
| `POWERBOAT_CACHE_DIR` / `POWERBOAT_CODE_CACHE=0` | V8 code cache folder (default `<game>/.powerboat-cache`) / off |
| `POWERBOAT_V8_FLAGS` | extra V8 flags, after the defaults (`--max-valid-polymorphic-map-count=32 --invocation-count-for-turbofan=300 --osr-from-maglev --fast-properties-soft-limit=256`) |
| `POWERBOAT_V8_LOWMEM=1` | smaller V8 heap (`--heap-growing-percent=20 --max-semi-space-size=4`) for a game whose JS heap fills a 1 GB device (Moonstone Island on the Smart Pro: heap 205 -> 163 MB). Not a default: Janosik paid ~6 % fps for memory it did not need |
| `POWERBOAT_GL_THREAD=1` | WebGL's GL calls on a thread of their own, so the JS thread no longer waits in the driver (`src/glthread.rs`; off by default). Moonstone Island: Smart Pro 20 -> 24.5 fps, RG Cube XX 29 -> 32 |
| `POWERBOAT_SWAP_INTERVAL=n` | every shown frame waits n vblanks (2 = an even 30 fps on a 60 Hz panel) where the driver honors it |
| `POWERBOAT_FRAME_PACE=fps` | sleeps before each swap to even out frame times below 60 fps, for drivers that ignore swap interval 2 (Mali on KMS) |
| `POWERBOAT_PRESENT_FILTER=nearest` | the game canvas is scaled to the window without filtering (default linear) |
| `POWERBOAT_MOUSE=0` | mouse events ignored (SDL's, or gptokeyb's stick-as-mouse) |
| `POWERBOAT_FONT_DIR` | folder of the runtime's own fonts (default `fonts/` next to the binary) |
| `POWERBOAT_GL_PROGRAM_CACHE=0` / `=reset` | no GL program binary cache (default: linked programs kept in `<cache>/glprog.bin`, ~2 s off a Construct boot on Mali and PowerVR) / start it over |
| `POWERBOAT_JSON_ONE_BYTE=0` | off: JSON text kept one-byte for V8 (characters above U+00FF as `\u` escapes; half the memory, faster parse) |
| `POWERBOAT_PIPELINE=0` | no pipelined frame (render, flush, then logic) |
| `POWERBOAT_FRAMESKIP=n` | MV render skip limit (game default 3; 0 = draw every frame) |
| `POWERBOAT_RENDERER=game` | let a game use PIXI's Canvas renderer (default: WebGL always) |
| `POWERBOAT_PATCHES=a.js:b.js` | per-game scripts run after all plugins (e.g. OMORI's step patch) |
| `POWERBOAT_KEEP_ZERO_BLUR=1` | keep running BlurFilters at strength 0 (default: skipped) |
| `POWERBOAT_SWAP_ALL=1` | swap even frames that drew nothing |
| `POWERBOAT_FLUID=0` | keep a plugin's frame-locked game speed |
| `POWERBOAT_PHASER_FIXES=0` | off: Phaser 2's dead-sprite and tile-layer shortcuts (`js/83_phaser.js`); for A/B runs and bisecting |
| `POWERBOAT_IMAGE_CACHE_MP` | MV ImageCache cap in megapixels (default 24) |
| `POWERBOAT_PARALLEL_IMAGES` | image requests MV starts at once (default 8) |
| `POWERBOAT_KEEP_IMAGES=1` / `POWERBOAT_SYNC_IMAGES=1` | keep decoded pixels after upload / decode on the main thread |
| `POWERBOAT_MALLOC_TUNE=0` | no glibc mmap threshold / malloc_trim |
| `POWERBOAT_VOLUME` | master volume 0..1 |
| `POWERBOAT_AUDIO_STREAM=0` | decode long audio whole up front (default: files over 30 s stay compressed and play from 3 s chunks; `--stream-test <file>` checks them against a whole decode) |
| `POWERBOAT_AUDIO_LAZY=0` / `POWERBOAT_AUDIO_LAZY_MB=n` | short sounds decoded whole and kept / the budget for decoded short sounds (default: kept compressed, decoded on first play into a 32 MB cache) |
| `POWERBOAT_VPX_THREADS=n` / `POWERBOAT_VP9_ROW_MT=1` | libvpx decoder threads (default 2) / VP9 row multithreading (helps streams without tile columns) |
| `POWERBOAT_C3_LAYER_CLIP=0` / `=2` | Construct 3: no clipping of own-texture layers to their instances' boxes / clip the composite only (default: clear and composite clipped); `POWERBOAT_C3_LAYER_DEBUG=1` prints per-layer coverage |
| `POWERBOAT_C3_SMALL_FX=0` | Construct 3: instance effect chains on full-size render targets (default: object-sized); `POWERBOAT_C3_FX_DEBUG=1` path counts, `POWERBOAT_C3_FX_TRACE=1` rectangles, `POWERBOAT_C3_FX_CHECK=<s>` freezes at game time s and writes the frame drawn both ways (`POWERBOAT_C3_FX_CHECK_DIR`) |
| `POWERBOAT_WEBPAGE=1` | full page DOM (js/79_webpage.js: jQuery-capable DOM, HTML parser, DOMParser, 2D-canvas presenter, page patches); set automatically for NW.js apps whose package.json `main` names their page |
| `POWERBOAT_C2D_FAST=0` / `POWERBOAT_C2D_STATS=1` / `POWERBOAT_C2D_THREADS=n` | Canvas 2D: everything through tiny-skia (picture checks) / draw paths and pixel classes every 3 s / threads for large blits and fills (default 4, 3 when deferred) |
| `POWERBOAT_C2D_DEFER=0` / `=1` / `=each` | Canvas 2D drawn in each op / on its own thread, one frame behind at the 2D page present (default for NW.js 2D pages; off for MV and Construct) / through that thread, waiting after every command (checks). Deferred mode falls back to drawing in each op when the game waits for drawing more than twice per frame for 3 s ([DEFERRED_CANVAS2D.md](DEFERRED_CANVAS2D.md)) |
| `POWERBOAT_SHOW_FPS=1` (or `tr` / `tl` / `bl` / `br`) | on-screen frame counter in that corner (default top right): frames shown in the last second and the slowest frame of that second (src/fpsmeter.rs; one small blit per frame, text redrawn once a second) |
| `POWERBOAT_C2D_GPU_UPLOAD=0` | NW.js 2D pages with deferred Canvas 2D: each finished frame is uploaded on the drawing thread through a second EGL context sharing the main one's textures (four textures, fenced; the main thread only waits in the GPU). `=0`, or a driver without a shared context, uploads on the main thread (src/upload.rs) |
| `POWERBOAT_PAGE_FBO=1` | NW.js 2D pages: draw the page picture into a canvas-sized FBO that is then blitted to the window (the old two-pass path). Default: the presenter's surface is the window, the quad is drawn letterboxed and nearest-scaled in one pass |
| `POWERBOAT_PRESENT_REALLOC=1` | the 2D page presenter reallocates its texture each frame (texImage2D) instead of updating it in place (old path, for comparisons) |
| `POWERBOAT_DATA_DIR=dir` | web storage and the NW.js home (`pm_home`) go to dir instead of the game folder (benches from a copy of a save) |
| `POWERBOAT_C2D_NODRAW=1` | diagnostic: the Canvas 2D drawing thread skips the pixel work (wrong picture), to measure what drawing costs the JS thread through shared cores and memory |
| `POWERBOAT_OP_TIMES=1` | time every Canvas 2D and GL op for the frame report (`canvas 2D ops per frame`, `gl ops per frame`). Off by default: two clock reads per op cost over a microsecond each on the Allwinner A133 (TrimUI Smart Pro) |
| `POWERBOAT_PAGE_PRESENT=main` | 2D pages: the finished frame drawn and swapped on the JS thread (default `thread`; it falls back to `main` by itself when the driver or an overlay needs it) |
| `POWERBOAT_FBO_PER_TEXTURE=0`, `POWERBOAT_C2D_PREFAULT=0`, `POWERBOAT_C2D_SUBPIXEL=0` | off switches: one FBO per render texture (a switch is a bind), large canvases touched up front, sub-pixel unit-scale draws on their own path |
| `POWERBOAT_TIMER_WAIT=0`, `POWERBOAT_GLYPH_CACHE=0` | off switches: timers that fall due before the frame is shown run then (otherwise only at the next frame), cached glyph coverage for solid-color text (otherwise every glyph's outline is filled) |
| `POWERBOAT_C2D_PREFETCH=n` | Canvas 2D blits: rows prefetched ahead of the one being blended (default 2; A/B) |
| `POWERBOAT_C2D_AFFINE=0`, `POWERBOAT_C2D_BANDS=0` | off switches: rotated and smoothly scaled drawImage on the fixed-point blit (otherwise tiny-skia's pattern), runs of 1:1 drawImage calls drawn together band by band on the Canvas 2D threads (`POWERBOAT_C2D_BATCH_DEBUG=1`: a line per run) |
| `POWERBOAT_IMAGE_HOLD_MB=n` | decoded image pixels kept up to n MB (default 8) for a second after their GL upload, so an image uploaded or drawn again soon is not decoded twice; 0 releases at once |
| `POWERBOAT_V8_THROW_TRACE=1` | deno_core's detailed traces of uncaught exceptions and V8 message objects under the frame loop (built for every throw, caught or not); off by default, error reports come from the exception's stack |
| `POWERBOAT_QUERY=a=1&b=2` / `POWERBOAT_GLES2=1` | the page's `location.search` (h5bench's `only=`) / a GLES 2.0 context only (A/B) |
| `POWERBOAT_PAD_MAPPINGS` | extra SDL controller mappings file |
| `POWERBOAT_KEYS="16:z 20:enter"` | scripted key presses (tests) |
| `POWERBOAT_NO_NODE=1` | no require()/process (MV then saves to localStorage) |
| `POWERBOAT_CROP=0` | store images whole (default: sprite sheets cropped cell by cell, `src/crop.rs`) |
| `POWERBOAT_HWDEC=0` / `POWERBOAT_PMHWDEC=path` | no hardware video decoding / libpmhwdec to load (default: next to the binary, then the system path) |
| `POWERBOAT_VIDEO_GPU=0` | video frames converted to RGBA on the CPU instead of the GPU |
| `POWERBOAT_VIDEO_ZEROCOPY=0` / `POWERBOAT_VIDEO_HOLD=0` | hardware frames uploaded instead of imported as dmabufs / copied out of the decoder at once; `POWERBOAT_VIDEO_ZEROCOPY=rgba` / `=nv12` start the import at the RGBA-packed planes / the one NV12 external image |
| `POWERBOAT_VIDEO_DUMP=n` | write the n-th GPU-converted video frame as a quarter-size PPM (`POWERBOAT_VIDEO_DUMP_FILE`) |
| `POWERBOAT_FRAME_DEBUG`, `POWERBOAT_MEM_DEBUG`, `POWERBOAT_BOOT_DEBUG`, `POWERBOAT_CACHE_DEBUG`, `POWERBOAT_AUDIO_DEBUG`, `POWERBOAT_VIDEO_DEBUG`, `POWERBOAT_VIDEO_PROFILE`, `POWERBOAT_PAD_DEBUG`, `POWERBOAT_FORMS_DEBUG`, `POWERBOAT_GL_HIST`, `POWERBOAT_FINISH`, `POWERBOAT_FINISH_RENDER`, `POWERBOAT_FORCE_FBO` | diagnostics (frame debug prints loops/s and drawn fps) |
| `POWERBOAT_C2D_SLOW=cmd_ms[:frame_ms]` | the drawing thread logs Canvas 2D commands and frames slower than that, with their costliest command kinds |
| `POWERBOAT_HEAP_SNAPSHOT=60,120` / `POWERBOAT_HEAP_DIR` | V8 heap snapshots (`heap_<s>.heapsnapshot`, DevTools format) at those seconds / into that folder; stops the game for seconds and needs the heap's size again in memory |
| `POWERBOAT_SHOT_EVERY=s` | a screenshot every s seconds from `--shot-at` on (`<shot>_<t>.ppm`) |
| `POWERBOAT_CONSTRUCT=1`, `POWERBOAT_LAZY_IMAGES=1` | set by the runtime for Construct exports (page DOM + Construct layer; images decoded on first use, pixels dropped after upload) |
| `POWERBOAT_MZ=1` | set by the runtime for RPG Maker MZ games (`js/rmmz_core.js` in the game folder): MZ layer and IndexedDB |

Construct switches (`js/80_construct.js`, Construct exports only):

| variable | effect |
|---|---|
| `CONSTRUCT_RENDER_SCALE=x` | 0 < x < 1: Construct draws at x of the window size and the runtime scales it up (with `POWERBOAT_PRESENT_FILTER=nearest`, Moonstone Island at 0.5 on the Smart Pro: +12 % fps, +36 MB free) |
| `CONSTRUCT_RENDER_UP=1` | render at the project size, so a letterboxed game reaches it (Penelope on the RG Cube XX: about -20 % fps) |
| `CONSTRUCT_LAYOUT_TEXTURE_ON_DEMAND=1` | Construct 3: the layout's own texture only when needed; can leave 1-pixel edge bleed in some games |
| `CONSTRUCT_SPRITEFONT_MIPS=1` | Construct 2: keep SpriteFont mipmaps (default dropped: they drew bars beside letters below the project size) |
| `CONSTRUCT_TEXTURE_POOL_MB=n` / `CONSTRUCT_TEXTURE_POOL=0` | deleted textures kept up to 10 s for re-uploads (default cap: a quarter of available memory, 32-256 MB) / no pool |
| engine patches, on by default, `=0` off | `BATCH_ORPHAN`, `DROP_STALE_PARAMS`, `EVENT_LOOPS`, `FAST_CONDS`, `FAST_TRUNCATE`, `FLAT_BEHAVIORS`, `GROUP_NAMES`, `JSON_PATHS`, `LAZY_FRAMES`, `LOCAL_FRAMES`, `PIN_DIRTY`, `RENDER_CELLS`, `SHARE_POLYS`, `SKIP_EMPTY_LAYERS`, `SKIP_FORCED_TEXTURE`, `SOL_DEFER`, `SOL_DIRTY`, `SOL_LAZY`, `SOL_PERLIST`, `SPRITE_PARK`, `STRING_CACHES`, `ZMOVE_SKIP` (each `CONSTRUCT_` + name). Each patch applies only where the engine's code matches. `=check` on `FAST_CONDS`, `FLAT_BEHAVIORS`, `JSON_PATHS`, `LOCAL_FRAMES`, `PIN_DIRTY`, `SHARE_POLYS`, `SOL_DEFER`, `SOL_LAZY`, `STRING_CACHES` runs the engine's own code too and reports differences; the comments in `js/80_construct.js` say what each one does |
| `CONSTRUCT_LAYER_PATCH_DEBUG=1`, `CONSTRUCT_WRAPPER_DEBUG=1`, `POWERBOAT_C3_FX_CHECK_WALL=1` | diagnostics |

## Performance options for porters

Three kinds, from "nothing to do" to "your call, document it in the port":

1. **Automatic (runtime, every game):** nothing to set; the defaults are the fast paths.
   - Canvas 2D (CPU, `src/canvas.rs`):
     - Direct blits for unscaled and mirrored draws, whole-number zooms, and any other axis-aligned nearest draw (fractional zoom, flips, fractional source rects).
     - Empty/opaque block maps per source, so empty source blocks are skipped and opaque ones copied.
     - Large draws split over 4 threads.
     - The general tiny-skia path is only the fallback.
     - 2D pages (ImpactJS games): drawing on its own thread while the next frame's JS runs (one frame of
       extra latency), switched off by itself for games that read pixels back often.
   - WebGL games (MV, Construct): pipelined frames, image cropping, object-sized effect targets,
     layer clipping, hardware video, the GL program binary cache.
   - Construct 2 and 3: the engine patches in the Construct table (selection lists, event loops,
     behaviors, render passes), animation frames and images built on first use, a texture pool.
   - Memory: short sounds decoded on first play into a 32 MB cache, JSON kept one-byte.
   - Phaser 2: pools of dead sprites and idle emitters skipped per logic step; tile layers scroll with a
     row move (`js/83_phaser.js`, `Canvas2D::shift_in_place`).
   - The off switches in the tables above (`=0`) exist for picture checks and bisecting, not for tuning.
2. **Runtime switches a launcher may set:** these trade something visible or game-specific, so they're
   off by default:
   - `POWERBOAT_FRAMESKIP` (MV): render skips under load.
   - `POWERBOAT_IMAGE_CACHE_MP`: memory against reloads.
   - `POWERBOAT_C2D_THREADS`: fewer threads on hot or weak devices.
   - `POWERBOAT_C2D_DEFER=0`: a 2D page where the extra frame of latency matters more than the frame rate
     (or `=1` to try it on an MV or Construct game: their Canvas 2D work is small, so it rarely helps).
   - `POWERBOAT_FLUID=0`: only when a plugin needs frame-locked speed.
   - `POWERBOAT_GL_THREAD=1`: WebGL games that wait in the driver. Measure it per game and device.
   - `POWERBOAT_V8_LOWMEM=1`: a game whose V8 heap fills a 1 GB device. It costs a little fps.
   - `CONSTRUCT_RENDER_SCALE` + `POWERBOAT_PRESENT_FILTER=nearest`: fewer pixels on fill-bound GPUs
     (PowerVR GE8300).
   - `POWERBOAT_SWAP_INTERVAL=2` / `POWERBOAT_FRAME_PACE=30`: an even 30 fps for a game that can't hold 60.
   - `--transcode-videos` in the port's first-run setup: large H.264 or 60 fps videos made playable.
3. **Per-game patches (`POWERBOAT_PATCHES`, game side):** the porter's own script, shipped with the port.
   - Rules:
     - It changes the game's **own settings defaults** only, never game files.
     - A player's saved choice still wins.
     - The port's README says what it changes and why.
   - Use one when the cost comes from something the game itself offers to lower (render
     resolution, effects quality).
   - Example: an ImpactJS game draws everything with Canvas 2D on the CPU. Its own half-resolution
     option is ~3.5× less to draw, and its game patch makes that the default (title 145 → 41 ms per
     frame on the RG Cube XX before the Canvas 2D work).
   - The runtime doesn't do this for every game (for example, by halving large 2D canvases): that
     would change the picture of games that don't need it.

Measure first: `POWERBOAT_FRAME_DEBUG=1` prints the per-frame split (JS tick, canvas 2D ms, GL ops, upload).
`POWERBOAT_C2D_STATS=1` names the Canvas 2D paths: an `image ctm …` or `image scaled …` line means draws still
go through tiny-skia's slow general path. A V8 `--prof` log (`POWERBOAT_V8_FLAGS`) split with
Construct Native's `tools/v8_tick_split.py` shows where the native time goes.

## Design decisions

- **GPU clock is left to the system.** The runtime and its launchers never pin the GPU (or memory)
  clock; the firmware's devfreq governor decides. Its `simple_ondemand` governor often idles at the
  minimum even when a game waits on the GPU. Pinning helps GPU-bound games:
  - RG Cube XX at 696 MHz: Solitaire Holiday 27 → 41 fps. A 504 MHz floor does nothing.
  - R36S at 520 MHz: Cloudberry Abyss 42 → 46 fps.
  - JavaScript-bound games gain nothing.

  The battery cost outweighs that, so there is no per-game clock option (decided 2026-10-30).
  `GPU_PIN` in Construct Native's device scripts is for measurements only, and they put the
  governor's settings back after each run.

## License

Powerboat's own code is MIT (`LICENSE`). The binary links V8, deno_core, SDL2, libvpx, libopus,
OpenH264 and the Rust crates in `powerboat/Cargo.toml`; their license texts are in `licenses/`. The
fonts in `fonts/` (Liberation, Carlito, Caladea) are under the SIL Open Font License 1.1.
