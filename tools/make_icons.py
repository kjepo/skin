#!/usr/bin/env python3
"""Build the plugin's icons from icon.png.

The white background is made transparent (flood fill from the corners), and
the sampler circles on the face are redrawn larger and outlined so they still
read when the illustration is shown small in the panel.

The preset buttons use the same face without circles, its skin recoloured to
the "good" book sample for that preset (test/fixtures/book.json, from
tools/gen_presets.py), so each button shows the colour the preset aims for.

    python3 tools/make_icons.py   # writes plugin/icons/*.png
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "icon.png")
OUT = os.path.join(ROOT, "plugin", "icons")

# Sampler circles in icon.png (1254 x 1254): centre and outer radius.
CIRCLES = [(552, 370), (702, 370), (360, 815), (891, 818), (626, 1091)]
OLD_RADIUS = 22

RING_RADIUS = 42  # centre of the white stroke
RING_WIDTH = 13
OUTLINE = 5  # dark edge on each side of the white stroke
DOT_RADIUS = 7
DARK = (59, 34, 25, 255)  # the illustration's hair/line colour
WHITE = (255, 255, 255, 255)
SUPERSAMPLE = 4

SIZES = {"face": 320, "panel": 23, "panel@2x": 46, "plugin": 24, "plugin@2x": 48}

SKIN = (247, 204, 173)  # the illustration's flat skin colour
LINE = (59, 34, 25)  # outlines; anti-aliased skin edges blend toward this
PRESET_SAMPLES = {  # preset -> book sample whose colour its button shows
    "caucasian": "fig3.23 mother",
    "child": "fig3.23 child",
    "asian": "fig3.25 asian",
    "dark": "fig3.24 dark",
}
PRESET_ICON_SIZE = 128

# The Child icon reads younger: bigger eyes, a rounder face, drawn smaller.
EYES = [(455, 615), (795, 615)]  # eye centres in icon.png
EYE_RADIUS = 115  # region magnified around each eye
EYE_ZOOM = 1.3  # magnification at the eye centre
CHILD_SQUASH = 0.86  # height / width scale
CHILD_SCALE = 0.85  # size relative to the adult faces, bottom-aligned


def erase_circles(img):
    px = img.load()
    draw = ImageDraw.Draw(img)
    for cx, cy in CIRCLES:
        skin = px[cx, cy - OLD_RADIUS - 6]  # just outside the old ring
        draw.ellipse([cx - OLD_RADIUS - 2, cy - OLD_RADIUS - 2, cx + OLD_RADIUS + 2, cy + OLD_RADIUS + 2], fill=skin)


def lab_to_srgb(lab):
    """CIE Lab (D50, as ICC/Photoshop use) -> 8-bit sRGB."""
    L, a, b = lab
    fy = (L + 16) / 116
    finv = lambda t: t ** 3 if t ** 3 > 216 / 24389 else (116 * t - 16) / (24389 / 27)
    X, Y, Z = finv(fy + a / 500) * 0.9642, finv(fy), finv(fy - b / 200) * 0.8249
    m = [  # XYZ(D50) -> linear sRGB, Bradford-adapted
        (3.1338561, -1.6168667, -0.4906146),
        (-0.9787684, 1.9161415, 0.0334540),
        (0.0719453, -0.2289914, 1.4052427),
    ]
    out = []
    for r in m:
        v = max(0.0, min(1.0, r[0] * X + r[1] * Y + r[2] * Z))
        v = 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
        out.append(round(v * 255))
    return tuple(out)


def recolour_skin(img, target):
    """Replace skin, including its anti-aliased edges against outlines."""
    px = img.load()
    d = [l - s for l, s in zip(LINE, SKIN)]
    dd = sum(v * v for v in d)
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            p = (r - SKIN[0], g - SKIN[1], b - SKIN[2])
            t = max(0.0, min(1.0, sum(pi * di for pi, di in zip(p, d)) / dd))
            off = sum((pi - t * di) ** 2 for pi, di in zip(p, d)) ** 0.5
            if off < 14 and t < 0.9:
                px[x, y] = tuple(round(tc * (1 - t) + lc * t) for tc, lc in zip(target, LINE)) + (a,)


def magnify(img, centres, radius, zoom):
    """Bulge-warp circular regions (bilinear), fading smoothly to no change at the rim."""
    a = np.asarray(img).astype(np.float32)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    sx, sy = xx.copy(), yy.copy()
    for cx, cy in centres:
        dx, dy = xx - cx, yy - cy
        r = np.sqrt(dx * dx + dy * dy) / radius
        inside = r < 1
        # sample closer to the centre: factor 1/zoom at the centre, 1 at the rim
        f = np.where(inside, 1 / zoom + (1 - 1 / zoom) * r * r * (3 - 2 * r), 1)
        sx = np.where(inside, cx + dx * f, sx)
        sy = np.where(inside, cy + dy * f, sy)
    x0, y0 = np.floor(sx).astype(int), np.floor(sy).astype(int)
    fx, fy = (sx - x0)[..., None], (sy - y0)[..., None]
    x0, y0 = np.clip(x0, 0, w - 2), np.clip(y0, 0, h - 2)
    out = (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy)
           + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA")


def childlike(square):
    """Rounder (vertically squashed) and smaller, bottom-aligned on the same canvas."""
    side = square.width
    w = round(side * CHILD_SCALE)
    h = round(w * CHILD_SQUASH)
    face = square.resize((w, h), Image.LANCZOS)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(face, ((side - w) // 2, side - h))
    return out


def transparent_square(img):
    for xy in [(0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)]:
        ImageDraw.floodfill(img, xy, (255, 255, 255, 0), thresh=40)
    img = img.crop(img.getbbox())
    side = max(img.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return square


def redraw_circles(img):
    erase_circles(img)

    # Draw the new rings on a supersampled layer for smooth edges.
    s = SUPERSAMPLE
    layer = Image.new("RGBA", (img.width * s, img.height * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def ring(cx, cy, r, width, colour):
        d.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], outline=colour, width=width * s)

    def disc(cx, cy, r, colour):
        d.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=colour)

    outer = RING_RADIUS + RING_WIDTH // 2
    for cx, cy in CIRCLES:
        ring(cx, cy, outer + OUTLINE, RING_WIDTH + 2 * OUTLINE, DARK)
        ring(cx, cy, outer, RING_WIDTH, WHITE)
        disc(cx, cy, DOT_RADIUS + OUTLINE // 2 + 1, DARK)
        disc(cx, cy, DOT_RADIUS, WHITE)
    img.alpha_composite(layer.resize(img.size, Image.LANCZOS))


def main():
    os.makedirs(OUT, exist_ok=True)
    img = Image.open(SRC).convert("RGBA")
    redraw_circles(img)
    square = transparent_square(img)
    for name, px in SIZES.items():
        square.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"), optimize=True)

    with open(os.path.join(ROOT, "test", "fixtures", "book.json")) as f:
        book = {s["name"]: s for s in json.load(f)}
    # Recolour at a working size; full resolution is needlessly slow per pixel.
    full = Image.open(SRC).convert("RGBA")
    erase_circles(full)
    adult = full.resize((512, 512), Image.LANCZOS)
    child = magnify(full, EYES, EYE_RADIUS, EYE_ZOOM).resize((512, 512), Image.LANCZOS)
    for key, sample in PRESET_SAMPLES.items():
        face = (child if key == "child" else adult).copy()
        recolour_skin(face, lab_to_srgb(book[sample]["lab"]))
        square = transparent_square(face)
        if key == "child":
            square = childlike(square)
        icon = square.resize((PRESET_ICON_SIZE, PRESET_ICON_SIZE), Image.LANCZOS)
        icon.save(os.path.join(OUT, f"preset-{key}.png"), optimize=True)
    print(f"wrote {', '.join(SIZES)} and preset-* to plugin/icons/")


if __name__ == "__main__":
    main()
