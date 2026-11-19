#!/usr/bin/env python3
# Generates the test scenes' assets (own drawings and tones, nothing from any game):
# sprite sheet, atlas, tileset + Tiled map, BMFont, sounds in four formats, a WebM clip.
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
os.makedirs(out, exist_ok=True)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
COLORS = [(230, 70, 70), (240, 160, 40), (235, 225, 60), (90, 200, 80),
          (60, 190, 200), (70, 110, 230), (150, 80, 220), (230, 90, 180)]


def label(d, box, text, size, fill=(0, 0, 0, 255)):
    f = ImageFont.truetype(FONT, size)
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.text((box[0] + (box[2] - (r - l)) / 2 - l, box[1] + (box[3] - (b - t)) / 2 - t), text, font=f, fill=fill)


# Sprite sheet: 8 frames, 32x32, a numbered disc on transparency.
sheet = Image.new("RGBA", (32 * 8, 32), (0, 0, 0, 0))
d = ImageDraw.Draw(sheet)
for i, c in enumerate(COLORS):
    d.ellipse((i * 32 + 2, 2, i * 32 + 29, 29), fill=c + (255,))
    label(d, (i * 32, 0, 32, 32), str(i), 16)
sheet.save(f"{out}/sheet.png")

# Atlas: four frames at different sizes (JSON hash format, read by every Phaser version).
atlas = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
d = ImageDraw.Draw(atlas)
frames = {}
for name, (x, y, w, h), c in (("red", (0, 0, 64, 64), COLORS[0]), ("green", (64, 0, 64, 32), COLORS[3]),
                              ("blue", (64, 32, 32, 32), COLORS[5]), ("white", (0, 64, 96, 64), (255, 255, 255))):
    d.rounded_rectangle((x + 1, y + 1, x + w - 2, y + h - 2), 6, fill=c + (255,))
    label(d, (x, y, w, h), name[0].upper(), 20)
    frames[name] = {"frame": {"x": x, "y": y, "w": w, "h": h}, "rotated": False, "trimmed": False,
                    "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h}, "sourceSize": {"w": w, "h": h}}
atlas.save(f"{out}/atlas.png")
json.dump({"frames": frames, "meta": {"image": "atlas.png", "size": {"w": 128, "h": 128}, "scale": "1"}},
          open(f"{out}/atlas.json", "w"))

# Tileset 4x2 of 16x16, and a Tiled JSON map with two layers.
tiles = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
d = ImageDraw.Draw(tiles)
for i, c in enumerate(COLORS):
    x, y = (i % 4) * 16, (i // 4) * 16
    d.rectangle((x, y, x + 15, y + 15), fill=c + (255,), outline=(0, 0, 0, 255))
tiles.save(f"{out}/tiles.png")
W, H = 7, 5
ground = [(x + y) % 4 + 1 for y in range(H) for x in range(W)]
top = [(5 + x % 4) if (y == 0 or y == H - 1) else 0 for y in range(H) for x in range(W)]
layer = lambda name, data, id_: {"id": id_, "name": name, "type": "tilelayer", "x": 0, "y": 0, "width": W, "height": H,
                                 "opacity": 1, "visible": True, "data": data}
json.dump({"width": W, "height": H, "tilewidth": 16, "tileheight": 16, "orientation": "orthogonal", "renderorder": "right-down",
           "version": 1.2, "type": "map", "infinite": False, "nextlayerid": 3, "nextobjectid": 1,
           "layers": [layer("ground", ground, 1), layer("top", top, 2)],
           "tilesets": [{"firstgid": 1, "name": "tiles", "image": "tiles.png", "imagewidth": 64, "imageheight": 32,
                         "tilewidth": 16, "tileheight": 16, "tilecount": 8, "columns": 4, "margin": 0, "spacing": 0}]},
          open(f"{out}/map.json", "w"))

# BMFont: white glyphs on transparency, with the XML description (read through DOMParser).
CHARS = "".join(chr(c) for c in range(32, 127))
SIZE, CELL = 14, 16
f = ImageFont.truetype(FONT, SIZE)
font = Image.new("RGBA", (CELL * 16, CELL * 6), (0, 0, 0, 0))
d = ImageDraw.Draw(font)
xml = [f'<font><info face="T" size="{SIZE}"/><common lineHeight="{CELL}" base="{SIZE}" scaleW="{font.width}" scaleH="{font.height}" pages="1"/>',
       '<pages><page id="0" file="font.png"/></pages>', f'<chars count="{len(CHARS)}">']
for i, ch in enumerate(CHARS):
    x, y = (i % 16) * CELL, (i // 16) * CELL
    d.text((x, y), ch, font=f, fill=(255, 255, 255, 255))
    adv = max(1, round(f.getlength(ch)))
    xml.append(f'<char id="{ord(ch)}" x="{x}" y="{y}" width="{CELL}" height="{CELL}" xoffset="0" yoffset="0" xadvance="{adv}" page="0" chnl="15"/>')
xml.append("</chars></font>")
font.save(f"{out}/font.png")
open(f"{out}/font.xml", "w").write("\n".join(xml))

json.dump({"hello": "json loader"}, open(f"{out}/data.json", "w"))
open(f"{out}/note.txt", "w").write("text loader")


def ff(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]
ff(*tone, "-c:a", "libvorbis", f"{out}/beep.ogg")
ff(*tone, "-c:a", "libmp3lame", f"{out}/beep.mp3")
ff(*tone, "-c:a", "aac", f"{out}/beep.m4a")
ff(*tone, f"{out}/beep.wav")
ff("-f", "lavfi", "-i", "testsrc=size=120x68:rate=15:duration=3", "-c:v", "libvpx", "-b:v", "200k", f"{out}/clip.webm")
print("assets in", out)
