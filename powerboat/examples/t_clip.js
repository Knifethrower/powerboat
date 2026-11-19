// Canvas 2D clip checks: a clip path filled first (Phaser's GeometryMask on the Canvas renderer does
// save, setTransform, beginPath, arc, clip), then a fill and an image through the clip.
const c = document.createElement("canvas"); c.width = 100; c.height = 100;
const x = c.getContext("2d");
const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data).join(",");
const report = (name, want) => { console.log(name, "center", px(50, 50), "corner", px(2, 2), want); x.clearRect(0, 0, 100, 100); };
x.save(); x.beginPath(); x.arc(50, 50, 20, 0, Math.PI * 2); x.clip(); x.fillStyle = "#f00"; x.fillRect(0, 0, 100, 100); x.restore();
report("plain clip", "(red, clear)");
x.save(); x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = "rgba(255,255,255,1)"; x.beginPath(); x.arc(50, 50, 20, 0, Math.PI * 2, false); x.clip(); x.fillStyle = "#0f0"; x.fillRect(0, 0, 100, 100); x.restore(); x.restore();
report("double save", "(green, clear)");
x.save(); x.beginPath(); x.arc(50, 50, 20, 0, Math.PI * 2); x.clip();
const d = document.createElement("canvas"); d.width = d.height = 100; const y = d.getContext("2d"); y.fillStyle = "#00f"; y.fillRect(0, 0, 100, 100);
x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(d, 0, 0); x.restore(); x.restore();
report("image through clip", "(blue, clear)");
x.save(); x.beginPath(); x.moveTo(30, 30); x.lineTo(70, 30); x.lineTo(70, 70); x.lineTo(30, 70); x.closePath(); x.clip(); x.fillStyle = "#ff0"; x.fillRect(0, 0, 100, 100); x.restore();
report("closed polygon clip", "(yellow, clear)");
x.save(); x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.beginPath(); x.arc(50, 50, 20, 0, Math.PI * 2); x.restore(); x.setTransform(3, 0, 0, 3, 90, 90); x.clip(); x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = "#0ff"; x.fillRect(0, 0, 100, 100); x.restore();
report("path built under another transform", "(cyan, clear)");
x.save(); x.scale(2, 2); x.beginPath(); x.rect(10, 10, 10, 10); x.restore(); x.fillStyle = "#f0f"; x.fill();
console.log("rect built scaled, filled after restore", px(30, 30), px(50, 50), "(magenta, clear)");
window.close();
