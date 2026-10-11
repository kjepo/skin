#!/usr/bin/env python3
"""Generate Lab target tables for the skin-tone presets.

Lee Varis (Skin, 2nd ed., ch. 3) states skin targets as CMY ratios read from
Photoshop's Info panel with U.S. Web Coated (SWOP) v2 as the CMYK space. Those
numbers only mean something relative to that profile, so we resolve them once,
here, into Lab (D50) targets: for every lightness L we find the (a*, b*) whose
SWOP separation has the preset's M/Y and C/Y ratios. The plugin then works in
Lab and is independent of the user's CMYK colour settings.

Requires LittleCMS's `transicc` (brew install little-cms2) and the Adobe SWOP
profile (installed with Photoshop).

    python3 tools/gen_presets.py   # writes plugin/core/preset-tables.js and test/fixtures/book.json
"""
import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILES = "/Library/Application Support/Adobe/Color/Profiles/Recommended"
SWOP = os.path.join(PROFILES, "USWebCoatedSWOP.icc")
ADOBE_RGB = os.path.join(PROFILES, "AdobeRGB1998.icc")

# Ratios are calibrated against the "good" Info-panel readouts in the book:
#   Caucasian  17/40/50 (fig 3.20), 10/33/40 (3.23 mother)
#   Child       4/20/23 (3.23), 7/21/27 (3.27)
#   Dark       34/70/70/24 (3.24)  - "M = Y is about as much magenta as I would tolerate"
#   Asian      20/45/59 (3.25)     - "more yellow; the trick is to not let it get too yellow"
# mOverY = M/Y, cOverY = C/Y. The rule is a midtone rule: below ~L60 SWOP moves
# density into K, and holding CMY ratios there demands implausibly saturated
# shadows. The runtime therefore trusts the tables' chroma only within
# MIDTONE_BAND, holds hue constant below it, and caps chroma at CHROMA_HEADROOM
# times the most saturated "good" book sample for the preset.
PRESETS = {
    "caucasian": {"label": "Caucasian", "mOverY": 0.82, "cOverY": 0.30},
    "child": {"label": "Child", "mOverY": 0.84, "cOverY": 0.22},
    "asian": {"label": "Asian", "mOverY": 0.77, "cOverY": 0.33},
    "dark": {"label": "Dark / African", "mOverY": 0.96, "cOverY": 0.47},
}
MIDTONE_BAND = (60, 92)
CHROMA_HEADROOM = 1.15

L_RANGE = range(55, 97)  # 1-unit steps; the runtime clamps outside this
A_RANGE = [x * 0.5 for x in range(-10, 101)]  # -5 .. 50
B_RANGE = [x * 0.5 for x in range(-10, 111)]  # -5 .. 55

BOOK_GOOD = {
    "fig3.20 caucasian": ("caucasian", (17, 40, 50, 1)),
    "fig3.23 mother": ("caucasian", (10, 33, 40, 0)),
    "fig3.23 child": ("child", (4, 20, 23, 0)),
    "fig3.27 girl highlight": ("child", (7, 21, 27, 0)),
    "fig3.24 dark": ("dark", (34, 70, 70, 24)),
    "fig3.25 asian": ("asian", (20, 45, 59, 1)),
}
BOOK_BAD = {
    "fig3.26 girl highlight (too yellow)": ("child", (1, 26, 40, 0)),
    "fig3.26 girl shadow (too yellow)": ("child", (37, 50, 79, 16)),
    "fig3.28 baby (too red)": ("child", (3, 58, 47, 0)),
}


def transicc(src, dst, rows, flags=()):
    """Run rows of numbers through LittleCMS, relative colorimetric + BPC (Photoshop's default)."""
    inp = "".join(" ".join(f"{v:.4f}" for v in r) + "\n" for r in rows)
    res = subprocess.run(
        ["transicc", "-t1", "-b", "-n", "-i", src, "-o", dst, *flags],
        input=inp, capture_output=True, text=True, check=True,
    )
    out = []
    for line in res.stdout.splitlines():
        parts = line.split()
        try:
            out.append([float(p) for p in parts])
        except ValueError:
            continue  # banner lines
    if len(out) != len(rows):
        sys.exit(f"transicc returned {len(out)} rows for {len(rows)} inputs")
    return out


def smooth(rows, radius=2):
    """Moving average over L to remove the 0.5-unit grid quantisation."""
    out = []
    for i, (L, _a, _b) in enumerate(rows):
        win = rows[max(0, i - radius): i + radius + 1]
        out.append([L, round(sum(r[1] for r in win) / len(win), 2), round(sum(r[2] for r in win) / len(win), 2)])
    return out


def solve_tables():
    grid = [(L, a, b) for L in L_RANGE for a in A_RANGE for b in B_RANGE]
    print(f"separating {len(grid)} Lab points through SWOP…", file=sys.stderr)
    cmyk = transicc("*Lab", SWOP, grid)
    best = {k: {} for k in PRESETS}
    for (L, a, b), (c, m, y, _k) in zip(grid, cmyk):
        if y < 3:
            continue  # ratios are meaningless near paper white / out of gamut
        for key, p in PRESETS.items():
            err = (m / y - p["mOverY"]) ** 2 + (c / y - p["cOverY"]) ** 2
            cur = best[key].get(L)
            if cur is None or err < cur[0]:
                best[key][L] = (err, a, b)
    tables = {}
    for key, rows in best.items():
        tables[key] = smooth([[L, rows[L][1], rows[L][2]] for L in L_RANGE])
        worst = max(rows[L][0] for L in L_RANGE)
        print(f"{key:10s} worst ratio residual {math.sqrt(worst):.3f}", file=sys.stderr)
    return tables


RGB_PROFILES = {
    "sRGB": "*sRGB",
    "Adobe RGB (1998)": ADOBE_RGB,
    "Display P3": "/System/Library/ColorSync/Profiles/Display P3.icc",
    "ProPhoto RGB": os.path.join(PROFILES, "ProPhoto.icm"),
}


def book_fixtures(tables):
    entries = {**{k: (*v, True) for k, v in BOOK_GOOD.items()},
               **{k: (*v, False) for k, v in BOOK_BAD.items()}}
    cmyks = [v[1] for v in entries.values()]
    labs = transicc(SWOP, "*Lab", cmyks)
    # Adobe RGB renderings of the same samples, as the solver would see them.
    rgbs = transicc(SWOP, ADOBE_RGB, cmyks)
    out = []
    for (name, (preset, cmyk, good)), lab, rgb in zip(entries.items(), labs, rgbs):
        out.append({"name": name, "preset": preset, "good": good, "cmyk": list(cmyk),
                    "lab": [round(v, 3) for v in lab],
                    "adobeRgb": [round(v, 3) for v in rgb]})
    return out


def colorspace_fixtures():
    """Reference RGB -> Lab conversions from LittleCMS for testing the JS maths."""
    vals = [0, 8, 37, 64, 100, 128, 150, 180, 211, 240, 255]
    rgbs = [(r, g, b) for r in vals[::2] for g in vals[1::2] for b in vals[::3]]
    rgbs += [(v, v, v) for v in vals]
    out = {}
    for name, path in RGB_PROFILES.items():
        labs = transicc(path, "*Lab", rgbs)
        out[name] = [[list(rgb), [round(v, 4) for v in lab]] for rgb, lab in zip(rgbs, labs)]
    return out


def chroma_caps(fixtures):
    caps = {}
    for f in fixtures:
        if f["good"]:
            c = math.hypot(f["lab"][1], f["lab"][2])
            caps[f["preset"]] = max(caps.get(f["preset"], 0), c)
    return {k: round(v * CHROMA_HEADROOM, 1) for k, v in caps.items()}


def main():
    tables = solve_tables()
    book = book_fixtures(tables)
    caps = chroma_caps(book)
    meta = {k: {"label": p["label"], "mOverY": p["mOverY"], "cOverY": p["cOverY"], "maxChroma": caps[k]}
            for k, p in PRESETS.items()}
    js = [
        "// GENERATED by tools/gen_presets.py - do not edit by hand.",
        "// Lab (D50) skin targets per preset: rows of [L, a*, b*] for integer L.",
        "// Derived from Lee Varis' CMY ratio rules separated through U.S. Web Coated (SWOP) v2.",
        "'use strict';",
        f"const MIDTONE_BAND = {json.dumps(list(MIDTONE_BAND))};",
        f"const PRESET_META = {json.dumps(meta, indent=2)};",
        f"const PRESET_TABLES = {json.dumps(tables, separators=(',', ':'))};",
        "module.exports = { PRESET_META, PRESET_TABLES, MIDTONE_BAND };",
        "",
    ]
    with open(os.path.join(ROOT, "plugin", "core", "preset-tables.js"), "w") as f:
        f.write("\n".join(js))
    fixtures = os.path.join(ROOT, "test", "fixtures")
    os.makedirs(fixtures, exist_ok=True)
    for name, data in (("book.json", book), ("colorspaces.json", colorspace_fixtures())):
        with open(os.path.join(fixtures, name), "w") as f:
            json.dump(data, f, indent=1)
            f.write("\n")
    print("wrote plugin/core/preset-tables.js and test/fixtures/*.json", file=sys.stderr)


if __name__ == "__main__":
    main()
