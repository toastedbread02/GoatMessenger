#!/usr/bin/env python3
"""Billy v2 — regenerate the mascot assets from the new sticker-style photo.

Source: updated.png at the repo root (3072x4096 RGBA, subject already cut out
with a soft white sticker edge). Emits:

    docs/billy.png        mascot cut-out for the Billy section (<=760px tall)
    docs/billy-round.png  square 512 avatar used by the 404 circle
    docs/favicon-32.png   favicon from the *app icon* (build/icon-1024.png)
    docs/app-icon-180.png apple-touch icon from the app icon

No rembg needed this time: the subject is already cleanly matted, so v2 only
trims stray low-alpha haze, evens out the white edge, and resizes.
"""
import os
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'updated.png')
ICON = os.path.join(ROOT, 'build', 'icon-1024.png')
IMG_DOCS = os.path.join(ROOT, 'docs')


def with_outline(im, outline_px, blur_edge=1.0):
    """Crisp uniform white ring under the subject, merging with its own edge."""
    alpha = im.getchannel('A').filter(ImageFilter.GaussianBlur(blur_edge))
    im2 = im.copy()
    im2.putalpha(alpha)
    if outline_px % 2 == 0:
        outline_px += 1
    grown = alpha.filter(ImageFilter.MaxFilter(outline_px)).filter(ImageFilter.GaussianBlur(0.8))
    white = Image.new('RGBA', im.size, (255, 255, 255, 255))
    white.putalpha(grown)
    white.alpha_composite(im2)
    return white


def clean_edge(im, floor=6):
    """Zero out near-invisible alpha so no ghost haze survives the resize."""
    a = im.getchannel('A')
    a = a.point(lambda v: 0 if v <= floor else v)
    im = im.copy()
    im.putalpha(a)
    return im


cut = Image.open(SRC).convert('RGBA')

# 1. tidy edge + crop to the subject
alpha = cut.getchannel('A').filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(2.0))
box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
if box:
    cut = cut.crop(box)
cut = clean_edge(cut)

# 2. parchment cut-out for the Billy section (matches the old 760px scale)
mascot = cut.copy()
mascot.thumbnail((760, 760), Image.LANCZOS)
mascot = with_outline(mascot, outline_px=11)
mascot.save(os.path.join(IMG_DOCS, 'billy.png'), optimize=True)

# 3. square avatar for the 404 circle
round_img = cut.copy()
round_img.thumbnail((640, 640), Image.LANCZOS)
round_img = with_outline(round_img, outline_px=15)
w, h = round_img.size
side = min(w, h)
round_img = round_img.crop(((w - side) // 2, 0, (w + side) // 2, side)) if h > w else round_img
round_img = round_img.resize((512, 512), Image.LANCZOS)
round_img.save(os.path.join(IMG_DOCS, 'billy-round.png'), optimize=True)

# 4. favicons from the improved app icon (not from the photo)
icon = Image.open(ICON).convert('RGBA')
icon.resize((32, 32), Image.LANCZOS).save(os.path.join(IMG_DOCS, 'favicon-32.png'), optimize=True)
icon.resize((180, 180), Image.LANCZOS).save(os.path.join(IMG_DOCS, 'app-icon-180.png'), optimize=True)

for name in ('billy.png', 'billy-round.png', 'favicon-32.png', 'app-icon-180.png'):
    p = os.path.join(IMG_DOCS, name)
    print(f'{name:22s} {os.path.getsize(p):>9,} bytes')
