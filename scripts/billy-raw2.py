#!/usr/bin/env python3
"""Final Billy pass, v2: rembg fur edges + bar-exclusion zones.

The AI cutout is precise on fur but keeps the headlock bars, so instead of
hand-tracing the whole outline we only erase explicit bar zones from the
rembg alpha, then re-add the white outline. Produces docs/billy.png,
docs/billy-round.png and docs/favicon-32.png.
"""
import os, time
from PIL import Image, ImageFilter
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

t0 = time.time()
from rembg import remove, new_session  # noqa: E402
session = new_session("u2net")
print(f"model ready {time.time()-t0:.0f}s", flush=True)

img = Image.open(f"{ROOT}/build/photos/1000016982.jpg")
W, H = img.size
crop = img.crop((0, 0, int(0.84 * W), int(0.95 * H)))  # head crop like billy-heads
crop.thumbnail((1500, 1500), Image.LANCZOS)
cut = remove(crop, session=session)
cut.save("/tmp/billy-raw2.png")
print("raw saved", cut.size, flush=True)
