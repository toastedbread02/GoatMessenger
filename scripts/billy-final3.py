#!/usr/bin/env python3
"""Final Billy pass, v4: color-based bar removal.

The headlock bars are smooth, light, neutral-gray metal — pixel noise (fur/oat
texture) makes them uniquely removable by local color variance + brightness.

  bar mask  = variance below threshold AND brightness above threshold,
              then dilated so rim pixels go too
  keep mask = alpha AND NOT barMask AND NOT the hard junk zones

Works from /tmp/billy-raw2.png (rembg cut). Emits docs/billy.png,
docs/billy-round.png, docs/favicon-32.png.
"""
import os
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open("/tmp/billy-raw2.png").convert("RGBA")
rgb = src.convert("RGB")
a = src.getchannel("A").copy()

# --- 1. light-neutral low-texture metal (the bars) ---
gray = np.asarray(rgb.convert("L"), dtype=np.float32)
mx = rgb.split()
r, g, b = (np.asarray(v, dtype=np.float32) for v in mx)
maxc = np.maximum(np.maximum(r, g), b)
minc = np.minimum(np.minimum(r, g), b)
sat = (maxc - minc) / (maxc + 1e-6)
log = Image.fromarray(gray.astype(np.uint8), "L")
# local variance via box blur difference
blur = log.filter(ImageFilter.GaussianBlur(2.0))
var = np.abs(np.asarray(log, dtype=np.float32) - np.asarray(blur, dtype=np.float32))
barish = ((var < 9.5) & (gray > 145) & (sat < 0.16)).astype(np.uint8) * 255
bar_mask = Image.fromarray(barish, "L").filter(ImageFilter.MaxFilter(15))
# ignore bar-colored pixels that live inside the yellow-ear-tag region
np_bar = np.asarray(bar_mask).copy()
np_bar[390:520, 240:420] = 0  # ear + tag area keeps priority
bar_mask = Image.fromarray(np_bar, "L")

# --- 2. compose final alpha ---
final_alpha = np.minimum(np.asarray(a), 255 - np.asarray(bar_mask))
FA = Image.fromarray(final_alpha, "L")
for quad in [
    [(700, 480), (700, 55), (745, 50), (745, 480)],
    [(830, 0), (995, 0), (995, 1500), (830, 1500)],
    [(0, 640), (325, 640), (325, 1500), (0, 1500)],
    [(0, 1085), (995, 1085), (995, 1500), (0, 1500)],
]:
    ImageDraw.Draw(FA).polygon(quad, fill=0)

merged = Image.new("RGBA", src.size, (0, 0, 0, 0))
merged.paste(rgb, (0, 0), FA)
merged = merged.crop(merged.getbbox())
merged.putalpha(merged.getchannel("A").filter(ImageFilter.GaussianBlur(1.0)))


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


with_outline(merged.copy(), max_side=760).save(f"{ROOT}/docs/billy.png", optimize=True)
round_avatar = with_outline(merged.copy(), outline_px=17)
w, h = round_avatar.size
side = min(w, h)
y0 = max(0, (h - side) // 2)
round_avatar = round_avatar.crop(((w - side) // 2, y0, (w + side) // 2, y0 + side)).resize((512, 512), Image.LANCZOS)
round_avatar.save(f"{ROOT}/docs/billy-round.png", optimize=True)
round_avatar.resize((32, 32), Image.LANCZOS).save(f"{ROOT}/docs/favicon-32.png", optimize=True)
print("done")
