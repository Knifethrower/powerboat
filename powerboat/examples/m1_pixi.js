// M1 exit check: PIXI 4 (OMORI's pixi.js 4.8.9, copied next to this file) renders textured sprites
// and a Graphics shape through the WebGL binding. Logs fps once a second. Run with --root pointing
// at the folder holding pixi.js and sprite.png (tools/pcbuild.sh / tools/device_m1.sh stage it).
__powerboat.loadScript("pixi.js");
console.log("PIXI", PIXI.VERSION, "webgl supported:", PIXI.utils.isWebGLSupported());

const W = window.innerWidth, H = window.innerHeight;
const canvas = document.createElement("canvas");
canvas.width = W; canvas.height = H;
document.body.appendChild(canvas);
const renderer = new PIXI.WebGLRenderer(W, H, { view: canvas, backgroundColor: 0x203040, antialias: false, transparent: false });
console.log("renderer", renderer.width + "x" + renderer.height, "maxTextures", renderer.maxTextures, "vao", !!renderer.gl.getExtension("OES_vertex_array_object"));

const stage = new PIXI.Container();
const tex = PIXI.Texture.fromImage("sprite.png");
const sprites = [];
const N = 100;
for (let i = 0; i < N; i++) {
  const s = new PIXI.Sprite(tex);
  s.anchor.set(0.5);
  s.x = Math.random() * W; s.y = Math.random() * H;
  s.scale.set(0.25 + Math.random() * 0.5);
  s._vx = (Math.random() - 0.5) * 4; s._vy = (Math.random() - 0.5) * 4;
  s._vr = (Math.random() - 0.5) * 0.05;
  s.tint = 0xffffff;
  stage.addChild(s);
  sprites.push(s);
}
const gfx = new PIXI.Graphics();
gfx.beginFill(0xff8800, 0.8).drawRect(20, 20, 120, 60).endFill();
gfx.lineStyle(4, 0x00ff88, 1).drawCircle(W - 80, 80, 40);
stage.addChild(gfx);

// A masked sprite exercises the stencil path PIXI uses for masks.
const masked = new PIXI.Sprite(tex);
masked.x = W / 2 - 96; masked.y = H / 2 - 96;
const mask = new PIXI.Graphics();
mask.beginFill(0xffffff).drawCircle(W / 2, H / 2, 60).endFill();
masked.mask = mask;
stage.addChild(mask); stage.addChild(masked);

let frames = 0, last = performance.now();
function loop(now) {
  for (const s of sprites) {
    s.x += s._vx; s.y += s._vy; s.rotation += s._vr;
    if (s.x < 0 || s.x > W) s._vx = -s._vx;
    if (s.y < 0 || s.y > H) s._vy = -s._vy;
  }
  gfx.rotation = now / 4000;
  renderer.render(stage);
  frames++;
  if (now - last >= 1000) {
    console.log("fps " + (frames * 1000 / (now - last)).toFixed(1) + " err " + renderer.gl.getError() + " tex " + tex.baseTexture.width + "x" + tex.baseTexture.height);
    frames = 0; last = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.addEventListener("keydown", (e) => { if (e.keyCode === 27) window.close(); });
console.log("m1_pixi.js loaded");
