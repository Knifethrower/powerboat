// WebGL zero-initialization check: a texture made with texImage2D(..., null) must read as transparent black
// (WebGL 1.0, 5.14.8: "initialized to 0"). GLES leaves such storage undefined, and on the TrimUI Brick
// (PowerVR GE8300) it showed earlier contents: Construct 3 creates its text textures empty and fills them a frame
// later, so Janosik's dialogue flashed noise (2026-11-07). Video memory is first filled with random textures that
// are then deleted, so recycled memory has something to show. Every case draws the new texture over the whole
// canvas and counts the non-zero bytes read back.
//   powerboat --script examples/t_tex_null.js --secs 3
const canvas = document.createElement("canvas");
canvas.width = 64;
canvas.height = 64;
document.body.appendChild(canvas);
const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
let fails = 0;
const out = [];
const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 uv; void main(){ uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }"));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }"));
gl.bindAttribLocation(prog, 0, "p");
gl.linkProgram(prog);
gl.useProgram(prog);
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.disable(gl.BLEND);
const params = () => {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};
const draw = (t) => {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const p = new Uint8Array(64 * 64 * 4);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, p);
  let n = 0;
  for (let i = 0; i < p.length; i++) if (p[i]) n++;
  return n;
};
// Fill video memory with random texels, use them, delete them.
const churn = () => {
  let seed = 12345;
  const rnd = new Uint8Array(256 * 256 * 4);
  for (let k = 0; k < 24; k++) {
    for (let i = 0; i < rnd.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; rnd[i] = seed >>> 24; }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, rnd);
    params();
    draw(t);
    gl.deleteTexture(t);
  }
};
const cases = [
  ["rgba 300x40", gl.RGBA, gl.UNSIGNED_BYTE, 300, 40],
  ["rgba 256x256", gl.RGBA, gl.UNSIGNED_BYTE, 256, 256],
  ["rgba 1000x64", gl.RGBA, gl.UNSIGNED_BYTE, 1000, 64],
  ["rgb 127x33", gl.RGB, gl.UNSIGNED_BYTE, 127, 33],
  ["luminance_alpha 61x17", gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, 61, 17],
  ["rgba4444 200x30", gl.RGBA, gl.UNSIGNED_SHORT_4_4_4_4, 200, 30],
];
for (let round = 1; round <= 3; round++) {
  churn();
  for (const [name, fmt, type, w, h] of cases) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, type, null);
    params();
    const n = draw(t);
    // RGB and LUMINANCE_ALPHA read back alpha 255 or 0 by format: black with alpha 1 (RGB) is still zero colour,
    // so only the colour bytes count there.
    const want = 0;
    let got = n;
    if (fmt === gl.RGB) {
      const p = new Uint8Array(64 * 64 * 4);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, p);
      got = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] || p[i + 1] || p[i + 2]) got++;
    }
    if (got !== want) fails++;
    out.push(`t_tex_null: ${got === want ? "PASS" : "FAIL"} round ${round} ${name}: ${got} non-zero`);
    gl.deleteTexture(t);
  }
}
out.push(`t_tex_null: gl errors ${gl.getError()}`);
for (const l of out) console.log(l);
console.log(`t_tex_null: ${fails ? fails + " FAILED" : "all passed"}`);
