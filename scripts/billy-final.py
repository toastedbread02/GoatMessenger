#!/usr/bin/env python3
"""Final Billy pass: hand-traced polygon mask over the best candidate.

The u2net model can't separate the headlock bars from Billy's head, so we trace
the head outline manually on /tmp/billy-candidate-2.png (coordinates in that
image's pixel space), cut to the polygon, soften the edge, add the white
outline, and emit every shape the site needs:

  docs/billy.png        – mascot (max 720px tall)
  docs/billy-round.png  – round avatar (512) for the profile preview
  docs/favicon-32.png   – favicon (32)
  docs/favicon.ico?     – skipped; PNG favicons are fine everywhere now
  docs/billy-photo.jpg  – untouched real photo (kept from the first pass)
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Pointer-polygon around Billy's head on /tmp/billy-candidate-2.png (641x1100).
# Clockwise: left-horn tip -> horn right edge -> poll -> right side of the face
# -> muzzle -> chin -> left cheek -> ear tip -> back up the horn's left edge.
POLYGON = [
    (150, 28), (245, 85), (255, 200), (248, 380), (215, 455),  # left horn
    (310, 438), (400, 452), (418, 560), (405, 650),            # poll + right side
    (375, 755), (360, 830),                                    # cheek
    (330, 890), (285, 1010), (215, 1048),                      # muzzle bottom
    (120, 1040), (62, 975), (55, 850), (90, 690), (95, 560),   # left cheek/face
    (85, 520), (45, 430), (18, 360), (60, 330), (125, 350),    # ear + tag bulge
    (150, 400), (135, 430),                                    # ear joins head
    (95, 380), (55, 300), (40, 180),                           # horn left edge
]

src = Image.open("/tmp/billy-candidate-2.png").convert("RGBA")


def cut(out_path, side=None, outline_side=13):
    mask = Image.new("L", src.size, 0)
    ImageDraw.Draw(mask).polygon(POLYGON, fill=255)
    cut = src.copy()
    cut.putalpha(mask)
    bbox = cut.getbbox()
    cut = cut.crop(bbox)
    if side:
        cut.thumbnail((side, side), Image.LANCZOS)
    white = Image.new("RGBA", cut.size, (255, 255, 255, 255))
    white.putalpha(cut.getchannel("A").filter(ImageFilter.MaxFilter(outline_side)).filter(ImageFilter.GaussianBlur(1.0)))
    white.alpha_composite(cut)
    white.save(out_path, optimize=True)
    print("saved", out_path, white.size)


cut(f"{ROOT}/docs/billy.png", side=720)
cut("/tmp/billy-small.png", side=512, outline_side=15)

# Round avatar: re-cut large, center-squash the polygon mask into a square first.
for out, size in ((f"{ROOT}/docs/billy-round.png", 512), (f"{ROOT}/docs/favicon-32.png", 32)):
    mask = Image.new("L", src.size, 0)
    ImageDraw.Draw(mask).polygon(POLYGON, fill=255)
    cut_img = src.copy()
    cut_img.putalpha(mask)
    cut_img = cut_img.crop(cut_img.getbbox())
    cut_img.thumbnail((1024, 1024), Image.LANCZOS)
    pad = max(cut_img.size)
    sq = Image.new("RGBA", (pad, pad), (0, 0, 0, 0))
    off = ((pad - cut_img.width) // 2, (pad - cut_img.height) // 2)
    sq.alpha_composite(cut_img, off)
    small = sq.resize((size, size), Image.LANCZOS)
    small.save(out, optimize=True)
    print("saved", out, small.size)
print("ALL DONE")
