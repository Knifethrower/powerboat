// Canvas 2D fast-path check: the same drawing with POWERBOAT_C2D_FAST=0 (tiny-skia only) and default must
// give the same pixels. Prints a checksum and the differing-pixel count against a stored reference.
//   powerboat --script t_blit.js --secs 1     (run twice: POWERBOAT_C2D_FAST=0 writes /tmp/t_blit.ref)
(() => {
  const W = 160, H = 96;
  const src = document.createElement("canvas");
  src.width = 64; src.height = 32;
  const s = src.getContext("2d");
  // A sprite sheet with soft (premultiplied) edges and an opaque core.
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const a = ((x * 7 + y * 13) % 256) / 255;
    s.fillStyle = `rgba(${(x * 4) & 255},${(y * 8) & 255},${(x * y) & 255},${a.toFixed(3)})`;
    s.fillRect(x, y, 1, 1);
  }
  s.fillStyle = "rgb(250,40,10)"; s.fillRect(20, 8, 12, 12);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "rgb(30,60,90)"; g.fillRect(0, 0, W, H);
  // near-identity CTM, as an ImpactJS game's
  g.setTransform(1.00000001, 0, 0, 0.99999999, 0.0000002, 0);
  g.drawImage(src, 0, 0, 32, 32, 3, 4, 32, 32);
  g.drawImage(src, 16, 0, 48, 32, -10, 50, 48, 32);          // clipped left and bottom
  g.globalAlpha = 0.6; g.drawImage(src, 0, 0, 64, 32, 100, 2, 64, 32); g.globalAlpha = 1;   // clipped right
  g.save(); g.translate(80, 0); g.scale(-1, 1);                 // mirrored
  g.drawImage(src, 8, 0, 40, 24, 2, 40, 40, 24);
  g.drawImage(src, 0, 0, 64, 32, -70, 60, 64, 32);              // mirrored and clipped
  g.restore();
  g.globalCompositeOperation = "lighter"; g.drawImage(src, 0, 0, 30, 30, 50, 10, 30, 30);
  g.globalCompositeOperation = "destination-out"; g.globalAlpha = 0.5; g.drawImage(src, 0, 0, 20, 20, 60, 60, 20, 20);
  g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
  g.fillStyle = "rgba(255,255,0,0.35)"; g.fillRect(10, 70, 60, 20);
  g.globalAlpha = 0.5; g.fillStyle = "rgb(0,200,255)"; g.fillRect(120, 60, 50, 50); g.globalAlpha = 1;
  // 2x zoom with smoothing off (an ImpactJS game's camera zoom), partly off the right edge; a zoomed fill.
  g.imageSmoothingEnabled = false;
  g.setTransform(2, 0, 0, 2, 0, 0);
  g.drawImage(src, 4, 2, 20, 14, 30, 30, 20, 14);
  g.drawImage(src, 0, 0, 24, 16, 68, 2, 24, 16);
  g.globalCompositeOperation = "lighter"; g.drawImage(src, 0, 0, 10, 10, 5, 2, 10, 10); g.globalCompositeOperation = "source-over";
  g.fillStyle = "rgba(255,0,128,0.4)"; g.fillRect(2, 38, 30, 6);
  g.clearRect(33, 31, 6, 4);
  // Fractional zoom (an ImpactJS game's camera zooming in), and a stretched image under it, partly off the edges.
  g.setTransform(1.731, 0, 0, 1.731, 3.25, -2.6);
  g.drawImage(src, 3, 1, 30, 20, 40, 8, 30, 20);
  g.drawImage(src, 0, 0, 64, 32, 70, 30, 45, 22);
  g.globalAlpha = 0.7; g.drawImage(src, 10, 4, 20, 20, -4, 40, 20, 20); g.globalAlpha = 1;
  g.fillStyle = "rgba(20,220,90,0.5)"; g.fillRect(12.3, 30.6, 17.2, 9.9);
  g.clearRect(50.4, 2.2, 7.7, 5.3);
  // Fractional source rect at a scale just above 1 with alpha (an ImpactJS game's full-screen overlays in battle).
  g.setTransform(1.0004, 0, 0, 1.0004, 0.3, 0.2);
  g.globalAlpha = 0.6; g.drawImage(src, 2.4, 1.7, 40.5, 20.25, 100.2, 50.6, 40.5, 20.25); g.globalAlpha = 1;
  // Vertically flipped at a fractional scale, and a negative destination width.
  g.setTransform(1.0004, 0, 0, -1.25, 0.3, 90.4);
  g.globalAlpha = 0.8; g.drawImage(src, 1.5, 0.5, 30, 20, 20.3, 10.1, 30, 20); g.globalAlpha = 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(src, 0, 0, 24, 16, 150.5, 2.25, -24, 16);
  // Unit scale at sub-pixel offsets (an ImpactJS game's camera between pixels): a source with empty, opaque and soft
  // 16-px blocks; source-over, alpha, lighter, half a pixel, and off the top-left edge.
  const big = document.createElement("canvas");
  big.width = 96; big.height = 64;
  const b = big.getContext("2d");
  b.drawImage(src, 0, 0, 64, 32, 32, 32, 64, 32);
  b.fillStyle = "rgb(10,200,40)"; b.fillRect(0, 0, 48, 20);
  g.setTransform(1, 0, 0, 1, 0.37, -0.61);
  g.drawImage(big, 35, 3, 57, 50, -1, -1, 57, 50);
  g.globalAlpha = 0.6; g.drawImage(big, 10, 20, 80, 40, 70.4, 40.7, 80, 40); g.globalAlpha = 1;
  g.globalCompositeOperation = "lighter"; g.drawImage(big, 0, 0, 40, 30, 110.6, 5.5, 40, 30); g.globalCompositeOperation = "source-over";
  // (Not at exactly half a pixel: an edge on a pixel center, or centers on texel edges, are ties that
  // blit_nearest and tiny-skia break apart.)
  g.setTransform(1.00000001, 0, 0, 0.99999999, 0.45, 0.25);
  g.drawImage(big, 20.5, 10, 40, 30, 60, 2, 40, 30);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const px = g.getImageData(0, 0, W, H).data;
  let sum = 0;
  for (let i = 0; i < px.length; i++) sum = (sum * 31 + px[i]) >>> 0;
  const fast = Deno.core.ops.op_powerboat_env("POWERBOAT_C2D_FAST") !== "0";
  const ref = "/tmp/t_blit.ref";
  if (!fast) {
    Deno.core.ops.op_powerboat_write_bytes(ref, new Uint8Array(px), false);
    console.log(`t_blit: reference (tiny-skia only) checksum ${sum}`);
  } else {
    let diff = 0, max = 0, first = -1;
    try {
      const r = new Uint8Array(Deno.core.ops.op_powerboat_read_bytes(ref));
      for (let i = 0; i < px.length; i++) { const d = Math.abs(px[i] - r[i]); if (d) { diff++; if (first < 0) first = i; } if (d > max) max = d; }
      console.log(`t_blit: fast checksum ${sum}; ${diff} channel values differ from the reference, max ${max}` + (first >= 0 ? `, first at pixel ${first >> 2} (${(first >> 2) % W},${Math.floor((first >> 2) / W)})` : ""));
    } catch (e) { console.log("t_blit: no reference (" + e + "); checksum " + sum); }
  }
  setTimeout(() => globalThis.close && globalThis.close(), 100);
})();
