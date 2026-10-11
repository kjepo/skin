#!/usr/bin/env python3
"""Build the plugin's icons from icon.png.

The white background is made transparent (flood fill from the corners), and
the sampler circles on the face are redrawn larger and outlined so they still
read when the illustration is shown small in the panel.

    python3 tools/make_icons.py   # writes plugin/icons/*.png
"""
import os

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


def redraw_circles(img):
    px = img.load()
    draw = ImageDraw.Draw(img)
    for cx, cy in CIRCLES:
        skin = px[cx, cy - OLD_RADIUS - 6]  # just outside the old ring
        draw.ellipse([cx - OLD_RADIUS - 2, cy - OLD_RADIUS - 2, cx + OLD_RADIUS + 2, cy + OLD_RADIUS + 2], fill=skin)

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
    img = Image.open(SRC).convert("RGBA")
    redraw_circles(img)
    for xy in [(0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)]:
        ImageDraw.floodfill(img, xy, (255, 255, 255, 0), thresh=40)
    img = img.crop(img.getbbox())
    side = max(img.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    os.makedirs(OUT, exist_ok=True)
    for name, px in SIZES.items():
        square.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"), optimize=True)
    print(f"wrote {', '.join(SIZES)} to plugin/icons/")


if __name__ == "__main__":
    main()
