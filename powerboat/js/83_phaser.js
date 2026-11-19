// Engine fixes for Phaser 2 (and CE), every game, no visible change: run right after the engine's script.
// Pools of dead sprites cost nothing in the picture but were walked on every logic step, and Phaser runs up
// to 3 of those per drawn frame when it falls behind (Frauki's Adventure: 3125 particles in 145 emitters, 37
// alive). A dead child's preUpdate only notes its old position and returns; its postUpdate and
// updateTransform do nothing that shows. POWERBOAT_PHASER_FIXES=0 switches this off (A/B runs, bisecting).
(() => {
  const g = globalThis;
  let done = false;
  __powerboat.phaserFixes = () => {
    if (done || !g.Phaser || !g.Phaser.Group || !g.PIXI) return;
    done = true;
    if (!/^2\./.test(String(g.Phaser.VERSION)) || Deno.core.ops.op_powerboat_env("POWERBOAT_PHASER_FIXES") === "0") return;
    const G = g.Phaser.Group.prototype;
    const DOC = g.PIXI.DisplayObjectContainer && g.PIXI.DisplayObjectContainer.prototype;
    if (!DOC) return;
    // Same order and removal handling as Phaser's own walks (preUpdate's order gives renderOrderID, which input
    // priority goes by). Giving each big group its own copy of these, to keep the load sites polymorphic, gained
    // nothing: the megamorphic loads are mostly in the children's shared methods (NOTES.md).
    G.preUpdate = function () {
      if (this.pendingDestroy) { this.destroy(); return false; }
      if (!this.exists || !this.parent.exists) { this.renderOrderID = -1; return false; }
      const c = this.children;
      for (let i = 0; i < c.length;) {
        const o = c[i];
        if (o.exists === false && !o.pendingDestroy) { i++; continue; }
        o.preUpdate();
        if (this === o.parent) i++;
      }
      return true;
    };
    G.postUpdate = function () {
      if (this.fixedToCamera) {
        const cam = this.game.camera;
        this.x = (cam.view.x + this.cameraOffset.x) / cam.scale.x;
        this.y = (cam.view.y + this.cameraOffset.y) / cam.scale.y;
      }
      const c = this.children;
      for (let i = 0; i < c.length; i++) {
        const o = c[i];
        if (o.exists !== false) o.postUpdate();
      }
    };
    G.updateTransform = function () {
      if (!this.visible) return;
      this.displayObjectUpdateTransform();
      if (this._cacheAsBitmap) return;
      const c = this.children;
      for (let i = 0; i < c.length; i++) {
        const o = c[i];
        if (o.visible) o.updateTransform();
      }
    };
    // An emitter with no live particle does nothing per child at all. Every way back to life goes through the
    // exists setter (reset, revive, direct), which also sets visible, so a dead particle never draws. Children
    // that aren't Particles, or a changed child count, turn the shortcut off until the next full look.
    const Pt = g.Phaser.Particle, E = g.Phaser.Particles && g.Phaser.Particles.Arcade && g.Phaser.Particles.Arcade.Emitter;
    let existsDesc = null;
    for (let p = Pt && Pt.prototype; p && !existsDesc; p = Object.getPrototypeOf(p)) existsDesc = Object.getOwnPropertyDescriptor(p, "exists");
    if (E && existsDesc && existsDesc.set) {
      Object.defineProperty(Pt.prototype, "exists", {
        configurable: true, get: existsDesc.get,
        set(v) { existsDesc.set.call(this, v); if (v && this.parent) this.parent._powerboatLive = true; },
      });
      const EP = E.prototype, idle = (e) => e._powerboatLive === false && e.children.length === e._powerboatLen;
      EP.preUpdate = function () {
        if (this.pendingDestroy) { this.destroy(); return false; }
        if (!this.exists || !this.parent.exists) { this.renderOrderID = -1; return false; }
        if (idle(this)) return true;
        const c = this.children;
        let live = false, plain = true;
        for (let i = 0; i < c.length;) {
          const o = c[i];
          if (!(o instanceof Pt)) plain = false;
          if (o.exists || o.pendingDestroy) {
            live = true;
            o.preUpdate();
            if (this !== o.parent) continue;
          }
          i++;
        }
        this._powerboatLive = live || !plain;
        this._powerboatLen = c.length;
        return true;
      };
      EP.postUpdate = function () {
        if (!idle(this) || this.fixedToCamera) G.postUpdate.call(this);
      };
      const eUpdate = EP.update;
      EP.update = function () {
        // Phaser's update resets the counts (.count up to 2.8, .counts in CE), looks at the clock only when on.
        if (idle(this) && !this.on) { const n = this.counts || this.count; n.emitted = 0; n.failed = 0; return; }
        eUpdate.call(this);
      };
      EP.updateTransform = function () {
        if (idle(this) && this.visible && !this._cacheAsBitmap) this.displayObjectUpdateTransform();
        else G.updateTransform.call(this);
      };
      const rGL = DOC._renderWebGL, rC = EP._renderCanvas;
      const bare = (e) => idle(e) && !e._mask && !e._filters && !e._cacheAsBitmap;
      EP._renderWebGL = function (s) { if (!bare(this)) rGL.call(this, s); };
      EP._renderCanvas = function (s) { if (!bare(this)) rC.call(this, s); };
    }
    // Each flush of the sprite batch overwrites the start of one 2000-sprite buffer (192 KB) while the frame's earlier
    // draws still use it, so GL drivers copy all of it per flush. New storage of just the flush's bytes costs next to
    // nothing. Frauki's Adventure, about 28 flushes of 2-3 sprites a frame: 7-9 ms on the RG Cube XX, 14 on the Smart Pro.
    const SB = g.PIXI.WebGLSpriteBatch && g.PIXI.WebGLSpriteBatch.prototype, GLP = g.WebGLRenderingContext && g.WebGLRenderingContext.prototype;
    if (SB && GLP) {
      const flush = SB.flush, sub = GLP.bufferSubData;
      let inFlush = false;
      SB.flush = function () {
        inFlush = true;
        try { flush.call(this); } finally { inFlush = false; }
      };
      GLP.bufferSubData = function (target, offset, data) {
        if (inFlush && offset === 0 && target === this.ARRAY_BUFFER) this.bufferData(target, data, this.STREAM_DRAW);
        else sub.call(this, target, offset, data);
      };
    }
    // Phaser walks the whole display tree twice per logic step: at the end of Stage.postUpdate, and at the end of
    // Game.updateLogic. Only plugin postUpdates run in between, so without one the second walk changes nothing.
    // Frauki's Adventure: about 1.5 ms per step, Smart Pro 34.8-36.5 -> 42.2-42.5 fps.
    const St = g.Phaser.Stage && g.Phaser.Stage.prototype;
    if (St && /stage\.updateTransform\(\)/.test(String(g.Phaser.Game.prototype.updateLogic))) {
      const post = St.postUpdate, walk = St.updateTransform;
      let fresh = false;
      St.postUpdate = function () {
        post.call(this);
        const ps = this.game.plugins.plugins;
        fresh = true;
        for (let i = 0; i < ps.length; i++) if (ps[i].hasPostUpdate) fresh = false;
      };
      St.updateTransform = function () {
        if (fresh) { fresh = false; return; }
        walk.call(this);
      };
    }
    // Tile layers scroll by shifting their canvas. Phaser's scratch canvas route (taken here, as on Safari) is two
    // clears and two whole-layer blits per layer and frame, 11-13 of Frauki's 15 ms when walking on the RG Cube XX;
    // its other route, "copy" onto the canvas itself, is a row move in the runtime (Canvas2D::shift_in_place).
    if (g.Phaser.TilemapLayer) {
      g.Phaser.TilemapLayer.prototype.shiftCanvas = function (ctx, x, y) {
        const cv = ctx.canvas, w = cv.width - Math.abs(x), h = cv.height - Math.abs(y);
        ctx.save();
        ctx.globalCompositeOperation = "copy";
        ctx.drawImage(cv, x < 0 ? -x : 0, y < 0 ? -y : 0, w, h, x < 0 ? 0 : x, y < 0 ? 0 : y, w, h);
        ctx.restore();
      };
    }
    console.log("powerboat: Phaser " + g.Phaser.VERSION + " engine fixes on");
  };
})();
