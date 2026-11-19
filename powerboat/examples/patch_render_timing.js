// Diagnostic patch (POWERBOAT_PATCHES): where PIXI's render time goes, per frame, every 150 frames.
// Outer timers only: renderer.render, FilterManager.pushFilter/popFilter, getBounds calls.
(function () {
  var r = { render: 0, push: 0, pop: 0, bounds: 0, pushes: 0, boundCalls: 0, frames: 0, filtersBy: {} };
  function wrap(owner, name, field, countField) {
    var f = owner && owner[name];
    if (typeof f !== 'function') return;
    owner[name] = function () {
      var t = performance.now();
      var out = f.apply(this, arguments);
      r[field] += performance.now() - t;
      if (countField) r[countField]++;
      return out;
    };
  }
  wrap(PIXI.WebGLRenderer.prototype, 'render', 'render');
  wrap(PIXI.Container.prototype, 'getBounds', 'bounds', 'boundCalls');
  var fmDone = false;
  function wrapFilterManager(fm) {
    if (fmDone || !fm) return;
    fmDone = true;
    var proto = Object.getPrototypeOf(fm);
    wrap(proto, 'pushFilter', 'push', 'pushes');
    wrap(proto, 'popFilter', 'pop');
    var push = proto.pushFilter;
    proto.pushFilter = function (target, filters) {
      var key = (target && target.constructor && target.constructor.name) + (target && target.filterArea ? '+area' : '') + ':' + filters.map(function (f) { return f.constructor.name; }).join(',');
      r.filtersBy[key] = (r.filtersBy[key] || 0) + 1;
      return push.apply(this, arguments);
    };
  }
  var render = PIXI.WebGLRenderer.prototype.render;
  PIXI.WebGLRenderer.prototype.render = function () {
    wrapFilterManager(this.filterManager);
    var out = render.apply(this, arguments);
    if (++r.frames >= 150) {
      var n = r.frames;
      console.log('[timing] per frame: render ' + (r.render / n).toFixed(2) + ' ms, pushFilter ' + (r.push / n).toFixed(2) + ' ms (' + (r.pushes / n).toFixed(1) + ' calls), popFilter ' + (r.pop / n).toFixed(2) + ' ms, getBounds ' + (r.bounds / n).toFixed(2) + ' ms (' + (r.boundCalls / n).toFixed(1) + ' calls)');
      var fb = Object.keys(r.filtersBy).map(function (k) { return k + ' x' + (r.filtersBy[k] / n).toFixed(1); });
      console.log('[timing] filters: ' + fb.join(' | '));
      r = { render: 0, push: 0, pop: 0, bounds: 0, pushes: 0, boundCalls: 0, frames: 0, filtersBy: {} };
    }
    return out;
  };
})();
