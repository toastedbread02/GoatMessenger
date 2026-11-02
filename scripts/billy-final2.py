#!/usr/bin/env python3
"""Final Billy pass, v3: keep the precise rembg fur edges, erase bar junk zones.

Works from /tmp/billy-raw2.png. Exclusions are explicit hard-edged zones in
that image's pixel space (995x1500). Then: brighten slightly, white outline,
emit docs/billy.png, docs/billy-round.png, docs/favicon-32.png.
"""
import os
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open("/tmp/billy-raw2.png").convert("RGBA")

# Avoid too-small saves; also who needs 1500px of white space outside the goat.


def erase(keep_alpha, zones):
    for quad in zones:
        ImageDraw.Draw(keep_alpha).polygon(quad, fill=0)


a = src.getchannel("A").copy()
erase(a, [
    # thin rod overlapping the right horn's outer edge
    [(700, 480), (700, 55), (745, 50), (745, 480)],
    # gray wash + right-edge junk
    [(830, 0), (995, 0), (995, 1500), (830, 1500)],
    # hard-cropped neck at bottom left
    [(0, 640), (325, 640), (325, 1500), (0, 1500)],
    # crop tail
    [(0, 1085), (995, 1085), (995, 1500), (0, 1500)],
])

out_alpha = src.getchannel("A").point(lambda v: 0)
out = Image.new("RGBA", src.size, (0, 0, 0, 0))
base_rgb = src.convert("RGB")
merged = Image.merge("RGBA", (*base_rgb.split(), a))
merged.putalpha(a)

bbox = merged.getbbox()
merged = merged.crop(bbox)

soft_alpha = merged.getchannel("A").filter(ImageFilter.GaussianBlur(1.0))
merged.putalpha(soft_alpha)


def with_outline(im, outline_px=None, max_side=None, blur_edge=1.0):
    if max_side:
        im = im.copy()
        im.thumbnail((max_side, max_side), Image.LANCZOS)
    alpha = im.getchannel("A").filter(ImageFilter.GaussianBlur(blur_edge))
    im2 = im.copy()
    im2.putalpha(alpha)
    if outline_px is None:
        outline_px = 11
    if outline_px % 2 == 0:
        outline_px += 1
    grown = alpha.filter(ImageFilter.MaxFilter(outline_px)).filter(ImageFilter.GaussianBlur(0.8))
    white = Image.new("RGBA", im.size, (255, 255, 255, 255))
    white.putalpha(grown)
    white.alpha_composite(im2)
    return white


os.makedirs(f"{ROOT}/docs", exist_ok=True)
with_outline(merged.copy(), max_side=760).save(f"{ROOT}/docs/billy.png", optimize=True)
round_avatar = with_outline(merged.copy(), outline_px=17)
# center-crop to square for the avatar
w, h = round_avatar.size
side = min(w, h)
box = ((w - side) // 2, max(0, (h - side) // 2 - 60), (w + side) // 2, max(0, (h - side) // 2 - 60) + side)
round_avatar = round_avatar.crop(box).resize((512, 512), Image.LANCZOS)
round_avatar.save(f"{ROOT}/docs/billy-round.png", optimize=True)
fav = round_avatar.resize((32, 32), Image.LANCZOS)
fav.save(f"{ROOT}/docs/favicon-32.png", optimize=True)
print("done:", *[(f, os.path.getsize(f"{ROOT}/docs/{f}")) for f in ("billy.png", "billy-round.png", "favicon-32.png")])
