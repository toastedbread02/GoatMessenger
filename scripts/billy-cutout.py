#!/usr/bin/env python3
"""Process Billy's real photos for the GoatMessenger site.

1. Downscale the three originals with sips-speed alternatives (PIL).
2. Auto-cutout the subject with rembg (u2net), keep the two best shots:
   a portrait cutout (docs/billy.png) and the barn photo (docs/billy-photo.jpg).
3. Paint a clean white outline around the cutout (morphological dilate of the
   alpha, minus the alpha itself), so the mascot reads on light and dark.
4. Produce the 1:1 avatar-ish crop used by the 404 circle.

All local, no network beyond the one-time u2net model download.
"""
import os, sys, time
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = [
    ("build/photos/1000016982.jpg", "head-on at the gate"),   # cleanest face, chosen for the cutout
    ("build/photos/1000016981.jpg", "chewing at the trough"),
    ("build/photos/1000016984.jpg", "extreme close-up"),
]

def log(*a):
    print(*a, flush=True, file=sys.stderr)

time0 = time.time()
from rembg import remove, new_session   # noqa: E402
session = new_session("u2net")
log(f"model ready at {time.time()-time0:.0f}s")

def best_cutout(src_path):
    img = Image.open(src_path)
    img.thumbnail((2400, 3200), Image.LANCZOS)
    cut = remove(img, session=session, alpha_matting=False)
    return img, cut

source, cut = best_cutout(os.path.join(ROOT, SRC[0][0]))
bbox = cut.getbbox()
cut = cut.crop(bbox)
log(f"cutout {cut.size} at {time.time()-time0:.0f}s")

# tight portrait: Billy's head/shoulders read best square
w, h = cut.size
side = int(h * 0.62)
persq = cut.crop((max(0, (w - side) // 2), 0, max(0, (w - side) // 2) + min(side, w), h))

def white_outline(src, radius=7):
    """Return src pasted on a white 3px halo (dilated alpha minus alpha)."""
    if radius not in white_outline.cache:
        small = src.resize((src.width // 4 or 1, src.height // 4 or 1), Image.BILINEAR)
        a = small.getchannel("A")
        grown = a.filter(ImageFilter.MaxFilter(5))
        halo = grown.point(lambda v: 255 if v > 8 else 0).resize(src.size, Image.BILINEAR)
        white_outline.cache[radius] = halo
    halo = white_outline.cache[radius]
    base = Image.new("RGBA", src.size, (255, 255, 255, 0))
    base.paste((255, 255, 255, 255), mask=halo)
    base.alpha_composite(src)
    return base
white_outline.cache = {}

# main mascot file: cutout with white outline
out = white_outline(cut.resize((1400, int(1400 * cut.height / cut.width)), Image.LANCZOS))
out.save(os.path.join(ROOT, "docs", "billy.png"), optimize=True)
log(f"docs/billy.png {out.size} at {time.time()-time0:.0f}s")

# round-card variant for the 404 page (square, tight crop, outline)
sq = white_outline(persq.resize((900, 900), Image.LANCZOS)).crop((0, 0, 900, 860))
sq.save(os.path.join(ROOT, "docs", "billy-round.png"), optimize=True)
log(f"docs/billy-round.png {sq.size} at {time.time()-time0:.0f}s")

# barn photo for the "Meet Billy" section: honest, unedited, just small
photo = Image.open(os.path.join(ROOT, SRC[0][0]))
photo.thumbnail((1600, 2133), Image.LANCZOS)
photo.save(os.path.join(ROOT, "docs", "billy-photo.jpg"), quality=82, optimize=True, progressive=True)
log(f"docs/billy-photo.jpg {photo.size} at {time.time()-time0:.0f}s")
print("ALL DONE")
