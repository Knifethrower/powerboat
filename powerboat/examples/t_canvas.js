// Canvas 2D checks against MV's use: image -> canvas -> getImageData (Bitmap.getPixel for
// window-skin palette colours), fillRect alpha, text metrics. Run with --root <MV game www>.
const img = new Image();
img.onload = () => {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  c.width = img.width; c.height = img.height;
  ctx.drawImage(img, 0, 0);
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  console.log("Window.png", img.width + "x" + img.height);
  for (let n = 0; n < 8; n++) console.log("textColor(" + n + ")", JSON.stringify(px(96 + (n % 8) * 12 + 6, 144 + Math.floor(n / 8) * 12 + 6)));
  console.log("corner", JSON.stringify(px(0, 0)), "bg", JSON.stringify(px(48, 48)));
  const c2 = document.createElement("canvas");
  const x2 = c2.getContext("2d");
  c2.width = 4; c2.height = 4;
  x2.fillStyle = "rgba(255, 0, 0, 0.5)"; x2.fillRect(0, 0, 4, 4);
  console.log("half red", JSON.stringify(Array.from(x2.getImageData(1, 1, 1, 1).data)));
  x2.clearRect(0, 0, 4, 4);
  x2.fillStyle = "#00ff00"; x2.fillRect(1, 1, 2, 2);
  console.log("green in, out", JSON.stringify(Array.from(x2.getImageData(1, 1, 1, 1).data)), JSON.stringify(Array.from(x2.getImageData(0, 0, 1, 1).data)));
  x2.font = "bold 28px GameFont";
  console.log("measure", x2.measureText("Hello").width, "font", x2.font);
  window.close();
};
img.onerror = () => { console.log("image failed"); window.close(); };
img.src = "img/system/Window.png";
