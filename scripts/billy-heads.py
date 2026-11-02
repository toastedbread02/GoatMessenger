#!/usr/bin/env python3
"""Second pass: tight head crops -> cutout -> largest-component cleanup.

The u2net model keeps the gate bars when Billy is photographed through his
headlock, so we crop to the head first and then drop every alpha blob that is
not part of the biggest connected shape (the head itself). Saves the three
candidates for visual review; the winning one gets copied into docs/.
"""
import os, sys, time
from PIL import Image, ImageFilter
import numpy as np
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# fractional head boxes in each original, measured from downscaled previews
HEADS = {
    "build/photos/1000016982.jpg": (0.20, 0.05, 0.84, 0.80),
    "build/photos/1000016981.jpg": (0.10, 0.10, 0.75, 0.85),
    "build/photos/1000016984.jpg": (0.02, 0.02, 0.98, 0.90),
}

def log(*a):
    print(*a, flush=True, file=sys.stderr)

time0 = time.time()
from rembg import remove, new_session  # noqa: E402
session = new_session("u2net")
log(f"model ready {time.time()-time0:.0f}s")

def largest_component(alpha_mask):
    a = np.asarray(alpha_mask)
    filled, n = ndimage.label(a > 12)
    if n <= 1:
        return a
    sizes = ndimage.sum(a > 12, filled, range(1, n + 1))
    keep = (np.argmax(sizes) + 1)
    out = np.where(filled == keep, a, 0)
    return out

def clean_and_outline(cut, out_path, side=None):
    # largest component only
    a = largest_component(cut.getchannel("A")).astype("uint8")
    keep = Image.fromarray(a.astype("uint8"), "L")
    cut.putalpha(keep)
    bbox = cut.getbbox()
    cut = cut.crop(bbox)
    if side:
        cut.thumbnail((side, side), Image.LANCZOS)
    # soften the hard mask edge slightly, then white halo
    alpha = cut.getchannel("A").filter(ImageFilter.GaussianBlur(1.2))
    cut.putalpha(alpha)
    grown = alpha.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(1.0))
    white = Image.new("RGBA", cut.size, (255, 255, 255, 255))
    base = Image.new("RGBA", cut.size, (0, 0, 0, 0))
    base.paste((255, 255, 255, 255), mask=grown)
    base.alpha_composite(cut)
    base.save(out_path, optimize=True)
    log(f"saved {out_path} {base.size}")

names = list(HEADS)
for name in names:
    img = Image.open(os.path.join(ROOT, "build/photos", name))
    W, H = img.size
    crop = img.crop((int(HEADS[name][0] * W), int(HEADS[name][1] * H),
                     int(HEADS[name][2] * W), int(HEADS[name][3] * H)))
    crop.thumbnail((1500, 1500), Image.LANCZOS)
    cut = remove(crop, session=session)
    idx = names.index(name) + 1
    clean_and_outline(cut, f"/tmp/billy-candidate-{idx}.png", side=1100)
    log(f"done {name} at {time.time()-time0:.0f}s")
print("ALL DONE")
