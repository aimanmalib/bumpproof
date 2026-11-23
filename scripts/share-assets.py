#!/usr/bin/env python3
"""Writes the report site's favicon and link-preview image into docs/assets/.

1. favicon.ico: the brand mark from brand/logo-512.png at 16, 32 and 48 px.
2. og.png: the top of the real home page (docs/images/screenshot-desktop.png, a Chromium capture of the
   published site), cropped to 1200 x 630 for link previews. Kept under the size limit below, because chat
   apps drop a preview image that is too large.

`bumpproof report` copies both with the rest of docs/assets/ and writes the tags that point to them.
Needs Pillow. Usage:
  python3 scripts/share-assets.py
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "assets")
OG_SIZE = (1200, 630)
OG_MAX_BYTES = 300_000


def favicon():
    logo = Image.open(os.path.join(ROOT, "brand", "logo-512.png")).convert("RGBA")
    path = os.path.join(OUT, "favicon.ico")
    logo.save(path, sizes=[(16, 16), (32, 32), (48, 48)])
    return path


def og_image():
    shot = Image.open(os.path.join(ROOT, "docs", "images", "screenshot-desktop.png")).convert("RGB")
    w = shot.width
    h = round(w * OG_SIZE[1] / OG_SIZE[0])
    if h > shot.height:
        sys.exit("screenshot is shorter than a %d:%d crop" % OG_SIZE)
    card = shot.crop((0, 0, w, h)).resize(OG_SIZE, Image.LANCZOS)
    path = os.path.join(OUT, "og.png")
    card.save(path, optimize=True)
    if os.path.getsize(path) > OG_MAX_BYTES:
        card.quantize(colors=128).save(path, optimize=True)
    size = os.path.getsize(path)
    if size > OG_MAX_BYTES:
        sys.exit("og.png is %d bytes, over %d" % (size, OG_MAX_BYTES))
    return path


if __name__ == "__main__":
    for p in (favicon(), og_image()):
        print("%s %d bytes" % (os.path.relpath(p, ROOT), os.path.getsize(p)))
