// Phaser 3 and 4 test scene: 20 labeled panels, one per engine feature, in a 640x480 FIT game.
// window.RENDERER picks WEBGL or CANVAS (set by the index_*.html).
const PW = 128, PH = 120;
const panel = (i) => ({ x: (i % 5) * PW, y: Math.floor(i / 5) * PH, cx: (i % 5) * PW + PW / 2, cy: Math.floor(i / 5) * PH + PH / 2 + 6 });
const P4 = Phaser.VERSION[0] === "4";
const isGL = () => game.renderer.type === Phaser.WEBGL;

class TestScene extends Phaser.Scene {
  constructor() { super("test"); }

  preload() {
    const l = this.load;
    l.on("loaderror", (f) => T.fail("load-" + f.key, f.url));
    l.on("filecomplete", (key) => T.pass("load-" + key));
    l.spritesheet("sheet", "assets/sheet.png", { frameWidth: 32, frameHeight: 32 });
    l.atlas("atlas", "assets/atlas.png", "assets/atlas.json");
    l.image("tiles", "assets/tiles.png");
    l.tilemapTiledJSON("map", "assets/map.json");
    l.bitmapFont("font", "assets/font.png", "assets/font.xml");
    l.json("data", "assets/data.json");
    l.text("note", "assets/note.txt");
    l.audio("beep", ["assets/beep.ogg", "assets/beep.mp3"]);
    l.video("clip", "assets/clip.webm");
  }

  create() {
    const scene = this, names = ["anim", "atlas+tint", "tilemap", "tilesprite", "text", "bitmaptext", "graphics", "mask", "particles",
      "rendertexture", "blend", "canvastexture", "tween", "arcade", "camera", "filter/fx", "video", "input", "audio", "status"];
    const g = this.add.graphics().setDepth(100);
    g.lineStyle(1, 0x667788, 1);
    names.forEach((n, i) => {
      const p = panel(i);
      g.strokeRect(p.x + 0.5, p.y + 0.5, PW - 1, PH - 1);
      this.add.text(p.x + 4, p.y + 2, n, { fontFamily: "Arial", fontSize: "11px", color: "#ffffff" }).setDepth(100);
    });

    T.check("anim", () => {
      const p = panel(0);
      this.anims.create({ key: "spin", frames: this.anims.generateFrameNumbers("sheet", { start: 0, end: 7 }), frameRate: 8, repeat: -1 });
      this.add.sprite(p.cx, p.cy, "sheet").setScale(2).play("spin");
    });
    T.check("atlas+tint", () => {
      const p = panel(1);
      this.add.image(p.x + 40, p.cy - 16, "atlas", "red").setScale(0.7);
      this.add.image(p.x + 92, p.cy - 22, "atlas", "green");
      this.add.image(p.x + 92, p.cy + 8, "atlas", "blue").setAngle(45).setAlpha(0.6);
      this.add.image(p.x + 64, p.cy + 36, "atlas", "white").setScale(0.7, 0.4).setTint(0xff4040, 0x40ff40, 0x4040ff, 0xffff40);
    });
    T.check("tilemap", () => {
      const p = panel(2);
      const map = this.make.tilemap({ key: "map" });
      const ts = map.addTilesetImage("tiles", "tiles");
      map.createLayer("ground", ts, p.x + 8, p.y + 20);
      map.createLayer("top", ts, p.x + 8, p.y + 20);
    });
    T.check("tilesprite", () => {
      const p = panel(3);
      this.ts = this.add.tileSprite(p.cx, p.cy, 110, 90, "tiles");
    });
    T.check("text", () => {
      const p = panel(4);
      const a = this.add.text(p.x + 4, p.y + 18, "Stroke+shadow", { fontFamily: "Arial", fontSize: "15px", color: "#ffee66", stroke: "#aa0000", strokeThickness: 3, shadow: { offsetX: 2, offsetY: 2, color: "#000", blur: 2, fill: true } });
      this.add.text(p.x + 4, p.y + 42, "Word wrapped text that takes a few lines here", { fontFamily: "serif", fontSize: "13px", color: "#aaddff", wordWrap: { width: 118 } });
      this.add.text(p.x + 4, p.y + 96, "mono 123", { fontFamily: "monospace", fontSize: "12px", backgroundColor: "#335533", color: "#fff", padding: { x: 2, y: 1 } });
      T.info("text-metrics", "w=" + a.width + " h=" + a.height + " ascent=" + (a.getTextMetrics ? JSON.stringify(a.getTextMetrics()) : "?"));
      return a.width > 40 && a.height > 10;
    });
    T.check("bitmaptext", () => {
      const p = panel(5);
      this.add.bitmapText(p.x + 6, p.y + 24, "font", "BMFont abc", 14);
      this.add.bitmapText(p.x + 6, p.y + 48, "font", "Tinted 123", 18).setTint(0x66ff66);
      return !!this.cache.bitmapFont.get("font");
    });
    T.check("graphics", () => {
      const p = panel(6), q = this.add.graphics();
      q.fillStyle(0xff8800, 1).fillRect(p.x + 8, p.y + 22, 40, 30);
      q.lineStyle(3, 0x00ff88, 1).strokeCircle(p.x + 90, p.y + 42, 22);
      q.fillStyle(0x4488ff, 0.8).fillTriangle(p.x + 10, p.y + 110, p.x + 50, p.y + 62, p.x + 60, p.y + 110);
      q.lineStyle(2, 0xffffff, 1).beginPath().moveTo(p.x + 70, p.y + 70).lineTo(p.x + 90, p.y + 110).lineTo(p.x + 120, p.y + 72).strokePath();
      if (q.fillGradientStyle && isGL()) q.fillGradientStyle(0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 1).fillRect(p.x + 72, p.y + 92, 50, 22);
    });
    T.check("mask", () => {
      const p = panel(7);
      const img = this.add.image(p.cx, p.cy, "atlas", "white").setScale(1.2);
      const shape = this.make.graphics({ add: false }).fillStyle(0xffffff).fillCircle(p.cx, p.cy, 34);
      if (P4 && isGL()) { img.enableFilters().filters.external.addMask(shape); return "Mask filter"; } // setMask is Canvas-only in 4
      img.setMask(shape.createGeometryMask());
      return "geometry mask";
    });
    T.check("particles", () => {
      const p = panel(8);
      this.add.particles(p.cx, p.cy, "sheet", { frame: [0, 3, 5], lifespan: 900, speed: { min: 30, max: 70 }, scale: { start: 0.5, end: 0 }, frequency: 40, blendMode: "ADD" });
    });
    T.check("rendertexture", () => {
      if (!isGL()) { this.add.renderTexture(panel(9).cx, panel(9).cy, 100, 80).fill(0x223344).draw("sheet", 10, 10, 1); return "canvas"; }
      const p = panel(9), rt = this.add.renderTexture(p.cx, p.cy, 110, 90);
      rt.fill(0x223344);
      rt.draw(this.add.image(0, 0, "atlas", "red").setVisible(false).setOrigin(0).setScale(0.8), 8, 8);
      rt.draw(this.add.image(0, 0, "atlas", "blue").setVisible(false).setOrigin(0), 56, 40);
      if (rt.render) rt.render();
    });
    T.check("blend", () => {
      const p = panel(10);
      this.add.image(p.x + 44, p.cy - 8, "atlas", "red");
      this.add.image(p.x + 74, p.cy - 8, "atlas", "green").setBlendMode(Phaser.BlendModes.ADD);
      this.add.image(p.x + 74, p.cy + 24, "atlas", "blue").setBlendMode(Phaser.BlendModes.MULTIPLY);
      this.add.image(p.x + 44, p.cy + 28, "sheet", 2).setBlendMode(Phaser.BlendModes.SCREEN);
    });
    T.check("canvastexture", () => {
      const p = panel(11), ct = this.textures.createCanvas("drawn", 96, 80), c = ct.getContext();
      const grad = c.createLinearGradient(0, 0, 96, 0);
      grad.addColorStop(0, "#ff0066"); grad.addColorStop(1, "#0066ff");
      c.fillStyle = grad; c.fillRect(0, 0, 96, 40);
      c.fillStyle = "#fff"; c.font = "bold 14px Arial"; c.fillText("canvas", 8, 26);
      c.fillStyle = "#88ff44"; c.beginPath(); c.arc(48, 60, 16, 0, Math.PI * 2); c.fill();
      ct.refresh();
      const px = ct.getPixel ? ct.getPixel(2, 2) : null;
      this.add.image(p.cx, p.cy, "drawn");
      return px ? "pixel " + px.r + "," + px.g + "," + px.b : undefined;
    });
    T.check("tween", () => {
      const p = panel(12), s = this.add.image(p.x + 24, p.cy, "sheet", 4);
      this.tweenedTarget = s; this.tweenStartX = s.x;
      this.tweens.add({ targets: s, x: p.x + 104, angle: 360, duration: 1000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    });
    T.check("arcade", () => {
      const p = panel(13);
      const walls = new Phaser.Geom.Rectangle(p.x + 2, p.y + 18, PW - 4, PH - 20);
      this.physics.world.setBounds(walls.x, walls.y, walls.width, walls.height);
      this.balls = this.physics.add.group({ key: "sheet", frame: [1, 3, 6], setXY: { x: p.x + 30, y: p.y + 40, stepX: 30 } });
      this.balls.getChildren().forEach((b, i) => { b.setCollideWorldBounds(true).setBounce(1, 1).setVelocity(60 + i * 30, 40 - i * 40).setCircle(15); });
      this.physics.add.collider(this.balls, this.balls);
    });
    T.check("camera", () => {
      const p = panel(14);
      const cam = this.cameras.add(p.x + 8, p.y + 22, PW - 16, PH - 28);
      cam.setBackgroundColor(0x101820).setZoom(2).centerOn(panel(0).cx, panel(0).cy);
      this.time.delayedCall(800, () => cam.flash(300, 80, 80, 255));
    });
    T.check("filter/fx", () => {
      const p = panel(15);
      const a = this.add.image(p.x + 40, p.cy, "atlas", "blue"), b = this.add.image(p.x + 92, p.cy, "atlas", "red").setScale(0.6);
      if (!isGL()) return "not on Canvas";
      if (a.preFX) { a.preFX.addGlow(0xffff00, 6); b.postFX.addBlur(0, 2, 2, 1.5); return "preFX glow + postFX blur"; }
      if (a.enableFilters) { a.enableFilters().filters.internal.addGlow(0xffff00, 6); b.enableFilters().filters.internal.addBlur(0, 2, 2, 1.5); return "filters glow + blur"; }
      throw new Error("no FX API");
    });
    T.check("video", () => {
      const p = panel(16), v = this.add.video(p.cx, p.cy, "clip");
      v.play(true);
      v.on("error", (_v, e) => T.fail("video-play", e && e.message));
      this.videoObj = v;
    });
    // Input: readouts in the panel and "T" lines for what the run script sends.
    const inp = panel(17), rd = this.add.text(inp.x + 4, inp.y + 18, "no input", { fontFamily: "monospace", fontSize: "11px", color: "#ffff88" });
    this.marker = this.add.image(inp.cx, inp.cy + 20, "sheet", 7).setScale(0.6);
    this.cursors = this.input.keyboard.createCursorKeys();
    this.input.keyboard.on("keydown", (e) => { T.pass("key-" + e.code, "phaser keydown"); rd.setText("key " + e.code); });
    this.input.on("pointerdown", (ptr) => { T.pass("pointerdown", "game " + ptr.x.toFixed(0) + "," + ptr.y.toFixed(0)); rd.setText("ptr " + ptr.x.toFixed(0) + "," + ptr.y.toFixed(0)); });
    this.input.on("pointermove", (ptr) => { T.pass("pointermove"); });
    if (this.input.gamepad) {
      T.pass("gamepad-plugin", "total=" + this.input.gamepad.total);
      this.input.gamepad.on("connected", (pad) => { T.pass("gamepad-connected", pad.id); rd.setText("pad"); });
    } else T.fail("gamepad-plugin", "missing");

    const aud = panel(18), at = this.add.text(aud.x + 4, aud.y + 18, "", { fontFamily: "monospace", fontSize: "10px", color: "#ffffff", wordWrap: { width: 120 } });
    T.check("audio-play", () => {
      const s = this.sound.add("beep", { loop: true, volume: 0.2 });
      const start = () => { const ok = s.play(); T.info("sound-play", "returned " + ok + " locked=" + this.sound.locked + " ctx=" + (this.sound.context && this.sound.context.state)); };
      if (this.sound.locked) { T.info("sound", "locked; waiting for unlock"); this.sound.once("unlocked", () => { T.pass("sound-unlocked"); start(); }); } else start();
      this.beep = s;
      at.setText(this.sound.constructor.name ? (this.sound.context ? "WebAudio" : "HTML5/none") : "");
      return this.sound.context ? "WebAudio" : false;
    });
    const st = panel(19);
    this.statusText = this.add.text(st.x + 4, st.y + 18, "", { fontFamily: "monospace", fontSize: "10px", color: "#aaffaa", wordWrap: { width: 120 } });
    T.pass("create");
    T.info("renderer", (isGL() ? "WEBGL" : "CANVAS") + " phaser " + Phaser.VERSION + " device.os " + JSON.stringify({ desktop: game.device.os.desktop, linux: game.device.os.linux, webGL: game.device.features.webGL, canvas: game.device.features.canvas, ogg: game.device.audio.ogg, mp3: game.device.audio.mp3, webAudio: game.device.audio.webAudio, webm: game.device.video.webm }));
    T.info("scale", "game " + game.scale.gameSize.width + "x" + game.scale.gameSize.height + " display " + game.scale.displaySize.width + "x" + game.scale.displaySize.height + " parent " + game.scale.parentSize.width + "x" + game.scale.parentSize.height + " canvasBounds " + JSON.stringify(game.scale.canvasBounds) + " canvasStyle " + game.canvas.style.width + "x" + game.canvas.style.height + " margin " + game.canvas.style.marginLeft + "," + game.canvas.style.marginTop);
    T.check("storage", () => { localStorage.setItem("phaser-t", "1"); return localStorage.getItem("phaser-t") === "1"; });
    T.check("loaded-data", () => this.cache.json.get("data").hello === "json loader" && this.cache.text.get("note") === "text loader");

    this.time.delayedCall(2500, () => {
      T.log(this.tweenedTarget.x !== this.tweenStartX ? "PASS" : "FAIL", "tween-moves", "x=" + this.tweenedTarget.x.toFixed(1));
      const b = this.balls.getChildren()[0];
      T.log(b.body.velocity.length() > 0 ? "PASS" : "FAIL", "arcade-moves", "v=" + b.body.velocity.length().toFixed(0));
      if (this.beep) T.log(this.beep.isPlaying ? "PASS" : "FAIL", "audio-playing", "isPlaying=" + this.beep.isPlaying + " seek=" + this.beep.seek);
      if (this.videoObj) T.log(this.videoObj.isPlaying() ? "PASS" : "FAIL", "video-playing", "t=" + this.videoObj.getCurrentTime());
    });
    setTimeout(() => { T.info("fps", game.loop.actualFps.toFixed(1)); T.finish(); }, window.RUN_MS || 21000);
    T.probeAudio(); T.watchInput();
  }

  update(time, dt) {
    if (this.ts) { this.ts.tilePositionX += dt * 0.02; this.ts.tilePositionY += dt * 0.01; }
    const c = this.cursors, m = this.marker, v = dt * 0.05;
    if (c.left.isDown) m.x -= v; if (c.right.isDown) m.x += v; if (c.up.isDown) m.y -= v; if (c.down.isDown) m.y += v;
    if (this.statusText) this.statusText.setText((isGL() ? "WEBGL" : "CANVAS") + "\nPhaser " + Phaser.VERSION + "\nfps " + game.loop.actualFps.toFixed(0) + "\nt " + (time / 1000).toFixed(1));
  }
}

window.game = new Phaser.Game({
  type: window.RENDERER === "canvas" ? Phaser.CANVAS : Phaser.WEBGL,
  width: 640, height: 480, backgroundColor: "#202830", parent: "game",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  input: { gamepad: true },
  physics: { default: "arcade", arcade: { gravity: { y: 0 } } },
  scene: TestScene,
});
T.info("boot", "Phaser " + Phaser.VERSION);
