// Phaser 2 (CE) test scene: the same 20 panels as scene3.js where Phaser 2 has the feature.
// window.RENDERER picks WEBGL or CANVAS (set by the index_*.html).
const PW = 128, PH = 120;
const panel = (i) => ({ x: (i % 5) * PW, y: Math.floor(i / 5) * PH, cx: (i % 5) * PW + PW / 2, cy: Math.floor(i / 5) * PH + PH / 2 + 6 });
let tweenMoved = false, ts, cursors, marker, statusText, tweened, tweenStartX, balls, beep, videoObj, inputText, ballWalls;
const isGL = () => game.renderType === Phaser.WEBGL;

function preload() {
  const l = game.load;
  l.onFileError.add((key, f) => T.fail("load-" + key, f && f.url));
  l.onFileComplete.add((prog, key, ok) => { if (ok) T.pass("load-" + key); });
  l.spritesheet("sheet", "assets/sheet.png", 32, 32);
  l.atlasJSONHash("atlas", "assets/atlas.png", "assets/atlas.json");
  l.image("tiles", "assets/tiles.png");
  l.tilemap("map", "assets/map.json", null, Phaser.Tilemap.TILED_JSON);
  l.bitmapFont("font", "assets/font.png", "assets/font.xml");
  l.json("data", "assets/data.json");
  l.text("note", "assets/note.txt");
  l.audio("beep", ["assets/beep.ogg", "assets/beep.mp3"]);
  l.video("clip", "assets/clip.webm");
}

function create() {
  game.scale.scaleMode = Phaser.ScaleManager.SHOW_ALL;
  game.scale.pageAlignHorizontally = true;
  game.scale.pageAlignVertically = true;
  game.physics.startSystem(Phaser.Physics.ARCADE);
  const add = game.add;
  const names = ["anim", "atlas+tint", "tilemap", "tilesprite", "text", "bitmaptext", "graphics", "mask", "particles",
    "rendertexture", "blend", "canvastexture", "tween", "arcade", "camera(n/a)", "filter", "video", "input", "audio", "status"];

  T.check("anim", () => {
    const p = panel(0), s = add.sprite(p.cx, p.cy, "sheet");
    s.anchor.set(0.5); s.scale.set(2);
    s.animations.add("spin").play(8, true);
  });
  T.check("atlas+tint", () => {
    const p = panel(1);
    const a = add.image(p.x + 40, p.cy - 16, "atlas", "red"); a.anchor.set(0.5); a.scale.set(0.7);
    const b = add.image(p.x + 92, p.cy - 22, "atlas", "green"); b.anchor.set(0.5);
    const c = add.image(p.x + 92, p.cy + 8, "atlas", "blue"); c.anchor.set(0.5); c.angle = 45; c.alpha = 0.6;
    const d = add.image(p.x + 64, p.cy + 36, "atlas", "white"); d.anchor.set(0.5); d.scale.set(0.7, 0.4); d.tint = 0xff4040;
  });
  T.check("tilemap", () => {
    const p = panel(2), map = add.tilemap("map");
    map.addTilesetImage("tiles", "tiles");
    for (const n of ["ground", "top"]) { const l = map.createLayer(n, 112, 80); l.fixedToCamera = false; l.position.set(p.x + 8, p.y + 20); }
  });
  T.check("tilesprite", () => { const p = panel(3); ts = add.tileSprite(p.x + 9, p.y + 24, 110, 90, "tiles"); });
  T.check("text", () => {
    const p = panel(4);
    const a = add.text(p.x + 4, p.y + 18, "Stroke+shadow", { font: "15px Arial", fill: "#ffee66", stroke: "#aa0000", strokeThickness: 3 });
    a.setShadow(2, 2, "#000", 2);
    add.text(p.x + 4, p.y + 42, "Word wrapped text that takes a few lines here", { font: "13px serif", fill: "#aaddff", wordWrap: true, wordWrapWidth: 118 });
    add.text(p.x + 4, p.y + 96, "mono 123", { font: "12px monospace", fill: "#fff", backgroundColor: "#335533" });
    T.info("text-metrics", "w=" + a.width + " h=" + a.height);
    return a.width > 40 && a.height > 10;
  });
  T.check("bitmaptext", () => {
    const p = panel(5);
    add.bitmapText(p.x + 6, p.y + 24, "font", "BMFont abc", 14);
    add.bitmapText(p.x + 6, p.y + 48, "font", "Tinted 123", 18).tint = 0x66ff66;
    return !!game.cache.getBitmapFont("font");
  });
  T.check("graphics", () => {
    const p = panel(6), q = add.graphics(0, 0);
    q.beginFill(0xff8800).drawRect(p.x + 8, p.y + 22, 40, 30).endFill();
    q.lineStyle(3, 0x00ff88, 1).drawCircle(p.x + 90, p.y + 42, 44);
    q.lineStyle(0).beginFill(0x4488ff, 0.8).drawPolygon([p.x + 10, p.y + 110, p.x + 50, p.y + 62, p.x + 60, p.y + 110]).endFill();
    q.lineStyle(2, 0xffffff, 1).moveTo(p.x + 70, p.y + 70).lineTo(p.x + 90, p.y + 110).lineTo(p.x + 120, p.y + 72);
  });
  T.check("mask", () => {
    const p = panel(7), img = add.image(p.cx, p.cy, "atlas", "white");
    img.anchor.set(0.5); img.scale.set(1.2);
    const m = add.graphics(0, 0); m.beginFill(0xffffff).drawCircle(p.cx, p.cy, 68).endFill();
    img.mask = m;
  });
  T.check("particles", () => {
    const p = panel(8), e = add.emitter(p.cx, p.cy, 40);
    e.makeParticles("sheet", [0, 3, 5]);
    e.setXSpeed(-70, 70); e.setYSpeed(-70, 70); e.gravity = 0; e.setScale(0.5, 0, 0.5, 0, 900); e.blendMode = PIXI.blendModes.ADD;
    e.start(false, 900, 40);
  });
  T.check("rendertexture", () => {
    const p = panel(9), rt = add.renderTexture(110, 90, "rt");
    const bg = game.make.graphics(0, 0); bg.beginFill(0x223344).drawRect(0, 0, 110, 90).endFill();
    rt.renderXY(bg, 0, 0);
    const r = game.make.image(0, 0, "atlas", "red"); r.scale.set(0.8); rt.renderXY(r, 8, 8);
    rt.renderXY(game.make.image(0, 0, "atlas", "blue"), 56, 40);
    add.image(p.x + 9, p.y + 24, rt);
  });
  T.check("blend", () => {
    const p = panel(10), m = (x, y, f, mode) => { const i = add.image(p.x + x, p.cy + y, "atlas", f); i.anchor.set(0.5); if (mode !== undefined) i.blendMode = mode; };
    m(44, -8, "red");
    m(74, -8, "green", PIXI.blendModes.ADD);
    m(74, 24, "blue", PIXI.blendModes.MULTIPLY);
    const s = add.image(p.x + 44, p.cy + 28, "sheet", 2); s.anchor.set(0.5); s.blendMode = PIXI.blendModes.SCREEN;
  });
  T.check("canvastexture", () => {
    const p = panel(11), bmd = add.bitmapData(96, 80), c = bmd.ctx;
    const grad = c.createLinearGradient(0, 0, 96, 0);
    grad.addColorStop(0, "#ff0066"); grad.addColorStop(1, "#0066ff");
    c.fillStyle = grad; c.fillRect(0, 0, 96, 40);
    c.fillStyle = "#fff"; c.font = "bold 14px Arial"; c.fillText("canvas", 8, 26);
    c.fillStyle = "#88ff44"; c.beginPath(); c.arc(48, 60, 16, 0, Math.PI * 2); c.fill();
    bmd.update(); bmd.dirty = true;
    const px = bmd.getPixelRGB(2, 2);
    add.image(p.x + 16, p.y + 26, bmd);
    return "pixel " + px.r + "," + px.g + "," + px.b;
  });
  T.check("tween", () => {
    const p = panel(12);
    tweened = add.image(p.x + 24, p.cy, "sheet", 4); tweened.anchor.set(0.5); tweenStartX = tweened.x;
    add.tween(tweened).to({ x: p.x + 104, angle: 360 }, 1000, Phaser.Easing.Sinusoidal.InOut, true, 0, -1, true);
  });
  T.check("arcade", () => {
    const p = panel(13);
    game.physics.arcade.setBounds(p.x + 2, p.y + 18, PW - 4, PH - 20);
    balls = add.physicsGroup();
    [1, 3, 6].forEach((f, i) => {
      const b = balls.create(p.x + 20 + i * 30, p.y + 40, "sheet", f);
      b.body.collideWorldBounds = true; b.body.bounce.set(1); b.body.velocity.set(60 + i * 30, 40 - i * 40);
    });
    ballWalls = true;
  });
  T.check("filter", () => {
    const p = panel(15), s = add.image(p.x + 16, p.y + 26, "atlas", "white");
    if (!isGL()) return "not on Canvas";
    const f = new Phaser.Filter(game, null, ["precision mediump float;", "varying vec2 vTextureCoord;", "uniform sampler2D uSampler;", "void main(){ vec4 c=texture2D(uSampler,vTextureCoord); gl_FragColor=vec4(c.g,c.b,c.r,c.a)*c.a; }"]);
    s.filters = [f];
  });
  T.check("video", () => {
    const p = panel(16);
    videoObj = add.video("clip");
    videoObj.play(true);
    videoObj.addToWorld(p.cx, p.cy, 0.5, 0.5);
  });

  const lines = add.graphics(0, 0); lines.lineStyle(1, 0x667788, 1);
  names.forEach((n, i) => {
    const p = panel(i);
    lines.drawRect(p.x + 0.5, p.y + 0.5, PW - 1, PH - 1);
    add.text(p.x + 4, p.y + 2, n, { font: "11px Arial", fill: "#ffffff" });
  });

  const inp = panel(17);
  inputText = add.text(inp.x + 4, inp.y + 18, "no input", { font: "11px monospace", fill: "#ffff88" });
  marker = add.image(inp.cx, inp.cy + 20, "sheet", 7); marker.anchor.set(0.5); marker.scale.set(0.6);
  cursors = game.input.keyboard.createCursorKeys();
  game.input.keyboard.addCallbacks(null, (e) => { T.pass("key-" + e.code, "phaser keydown"); inputText.text = "key " + e.code; });
  game.input.onDown.add((ptr) => { T.pass("pointerdown", "game " + ptr.x.toFixed(0) + "," + ptr.y.toFixed(0)); inputText.text = "ptr " + ptr.x.toFixed(0) + "," + ptr.y.toFixed(0); });
  game.input.addMoveCallback(() => T.pass("pointermove"));
  game.input.gamepad.start();
  game.input.gamepad.addCallbacks(null, { onConnect: () => T.pass("gamepad-connected") });
  T.log(game.input.gamepad.supported ? "PASS" : "FAIL", "gamepad-plugin", "supported=" + game.input.gamepad.supported);

  const aud = panel(18), at = add.text(aud.x + 4, aud.y + 18, "", { font: "10px monospace", fill: "#ffffff" });
  T.check("audio-play", () => {
    beep = add.audio("beep", 0.2, true);
    T.info("sound", "usingWebAudio=" + game.sound.usingWebAudio + " touchLocked=" + game.sound.touchLocked + " noAudio=" + game.sound.noAudio);
    const go = () => { beep.play(); T.info("sound-play", "ctx=" + (game.sound.context && game.sound.context.state)); };
    if (game.sound.touchLocked) { T.info("sound", "locked; waiting for unlock"); game.sound.onUnlock.addOnce(() => { T.pass("sound-unlocked"); go(); }); } else go();
    at.text = game.sound.usingWebAudio ? "WebAudio" : "no WebAudio";
    return game.sound.usingWebAudio ? "WebAudio" : false;
  });
  const st = panel(19);
  statusText = add.text(st.x + 4, st.y + 18, "", { font: "10px monospace", fill: "#aaffaa" });
  game.time.advancedTiming = true;
  T.pass("create");
  T.info("renderer", (isGL() ? "WEBGL" : "CANVAS") + " phaser " + Phaser.VERSION + " device " + JSON.stringify({ desktop: game.device.desktop, linux: game.device.linux, webGL: game.device.webGL, canvas: game.device.canvas, ogg: game.device.ogg, mp3: game.device.mp3, webAudio: game.device.webAudio, webm: game.device.webmVideo }));
  T.info("scale", "game " + game.width + "x" + game.height + " canvas style " + game.canvas.style.width + "x" + game.canvas.style.height + " margin " + game.canvas.style.marginLeft + "," + game.canvas.style.marginTop + " parent " + game.scale.parentNode + " bounds " + JSON.stringify(game.scale.bounds));
  T.check("storage", () => { localStorage.setItem("phaser-t", "1"); return localStorage.getItem("phaser-t") === "1"; });
  T.check("loaded-data", () => game.cache.getJSON("data").hello === "json loader" && game.cache.getText("note") === "text loader");

  // What js/83_phaser.js must keep from Phaser's own walks.
  T.check("group-walk-order", () => {
    const grp = add.group(), seen = [];
    for (let i = 0; i < 8; i++) {
      const s = grp.create(-50, -50, "tiles");
      const up = s.preUpdate;
      s.preUpdate = function () { seen.push(i); const r = up.call(this); if (i === 2) grp.remove(s); return r; };
    }
    grp.getChildAt(4).kill();
    game.stage.currentRenderOrderID = 1000;
    grp.preUpdate(); grp.update(); grp.postUpdate();
    grp.destroy();
    game.stage.currentRenderOrderID = 0;
    // Forward, nobody missed when a child removes itself; a dead child may or may not be visited.
    if (seen.join() !== "0,1,2,3,5,6,7" && seen.join() !== "0,1,2,3,4,5,6,7") throw new Error("order " + seen.join());
  });
  T.check("group-fixed-camera-scale", () => {
    const grp = add.group(), cam = game.camera, old = cam.scale.x;
    for (let i = 0; i < 8; i++) grp.create(-50, -50, "tiles");
    grp.fixedToCamera = true; grp.cameraOffset.set(10, 20);
    cam.scale.x = cam.scale.y = 2;
    grp.postUpdate(); grp.postUpdate();
    const got = grp.x + "," + grp.y, want = (cam.view.x + 10) / 2 + "," + (cam.view.y + 20) / 2;
    cam.scale.x = cam.scale.y = old;
    grp.destroy();
    if (got !== want) throw new Error(got + " != " + want);
  });
  T.check("emitter-idle-then-live", () => {
    const e = add.emitter(-200, -200, 4);
    e.makeParticles("tiles");
    e.preUpdate(); e.update(); e.postUpdate(); e.updateTransform();
    e.preUpdate(); e.update(); e.postUpdate(); e.updateTransform();
    e.start(true, 1000, null, 2);
    const alive = e.children.filter((c) => c.exists).length;
    e.preUpdate(); e.update(); e.postUpdate(); e.updateTransform();
    const moved = e.children.filter((c) => c.exists).length;
    e.destroy();
    if (alive !== 2 || moved !== 2) throw new Error("alive " + alive + " after a step " + moved);
  });
  // Alternating textures: every sprite is a flush of its own, each must draw its own vertices.
  T.check("batch-flushes-draw-right", () => {
    if (game.renderType !== Phaser.WEBGL) return true;
    const gl = game.renderer.gl, res = game.renderer.resolution || 1, want = [[255, 0, 0], [0, 0, 255], [255, 0, 0], [0, 0, 255], [0, 255, 0]];
    const made = want.map((c, i) => {
      const bmd = game.make.bitmapData(8, 8);
      bmd.fill(c[0], c[1], c[2]);
      const s = game.make.sprite(i * 8, 0, bmd);
      game.stage.addChild(s);
      return { s, bmd };
    });
    game.stage.updateTransform();
    game.renderer.render(game.stage);
    const got = want.map((_, i) => {
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor((i * 8 + 4) * res), Math.floor(game.renderer.height - 4 * res), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0], px[1], px[2]];
    });
    made.forEach((m) => { m.s.destroy(); m.bmd.destroy(); });
    if (String(got) !== String(want)) throw new Error(JSON.stringify(got));
  });

  // One transform walk per logic step: a move shows in world coordinates by the next step, also when moved from a
  // plugin's postUpdate, which runs after the stage's walk.
  const walkProbe = add.sprite(-300, -300, "tiles"), plugProbe = add.sprite(-300, -300, "tiles");
  const lateMover = game.plugins.add(Phaser.Plugin);
  lateMover.hasPostUpdate = false;
  game.time.events.add(2000, () => { walkProbe.x = -277; });
  game.time.events.add(2100, () => {
    lateMover.hasPostUpdate = true;
    lateMover.postUpdate = () => { plugProbe.x = -255; };
  });
  game.time.events.add(2500, () => {
    const parentX = walkProbe.parent.worldTransform.tx, sx = walkProbe.parent.worldTransform.a;
    T.log(walkProbe.worldTransform.tx === parentX + sx * -277 ? "PASS" : "FAIL", "transform-after-step", "tx=" + walkProbe.worldTransform.tx);
    T.log(plugProbe.worldTransform.tx === parentX + sx * -255 ? "PASS" : "FAIL", "transform-plugin-postupdate", "tx=" + plugProbe.worldTransform.tx);
    game.plugins.remove(lateMover);
    T.log(tweenMoved || tweened.x !== tweenStartX ? "PASS" : "FAIL", "tween-moves", "x=" + tweened.x.toFixed(1));
    T.log(balls.getChildAt(0).body.velocity.getMagnitude() > 0 ? "PASS" : "FAIL", "arcade-moves");
    T.log(beep && beep.isPlaying ? "PASS" : "FAIL", "audio-playing", "isPlaying=" + (beep && beep.isPlaying));
    if (videoObj) T.log(videoObj.playing ? "PASS" : "FAIL", "video-playing", "t=" + videoObj.currentTime);
  });
  setTimeout(() => { T.info("fps", game.time.fps); T.finish(); }, window.RUN_MS || 21000);
  T.probeAudio(); T.watchInput();
}

function update() {
  const dt = game.time.elapsedMS;
  if (tweened && tweened.x !== tweenStartX) tweenMoved = true;
  if (ts) { ts.tilePosition.x += dt * 0.02; ts.tilePosition.y += dt * 0.01; }
  if (balls) game.physics.arcade.collide(balls);
  const v = dt * 0.05;
  if (cursors.left.isDown) marker.x -= v; if (cursors.right.isDown) marker.x += v; if (cursors.up.isDown) marker.y -= v; if (cursors.down.isDown) marker.y += v;
  statusText.text = (isGL() ? "WEBGL" : "CANVAS") + "\nPhaser " + Phaser.VERSION + "\nfps " + game.time.fps + "\nt " + (game.time.now / 1000).toFixed(1);
}

window.game = new Phaser.Game({ width: 640, height: 480, renderer: window.RENDERER === "canvas" ? Phaser.CANVAS : Phaser.WEBGL, parent: "game", state: { preload, create, update } });
T.info("boot", "Phaser " + Phaser.VERSION);
