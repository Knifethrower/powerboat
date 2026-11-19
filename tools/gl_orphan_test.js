// Test only (POWERBOAT_PATCHES): every bufferSubData at offset 0 gives the buffer new storage of just those bytes. NOT safe in
// general (a buffer's tail is lost); here to see whether a game's GL waits come from overwriting buffers in use.
(function () {
  const G = WebGLRenderingContext.prototype, sub = G.bufferSubData;
  G.bufferSubData = function (target, offset, data) {
    if (offset === 0) this.bufferData(target, data, this.STREAM_DRAW);
    else sub.call(this, target, offset, data);
  };
  console.log("powerboat test: bufferSubData at 0 -> bufferData");
})();
