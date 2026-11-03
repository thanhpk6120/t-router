#!/usr/bin/env python3
"""Regenerate the subset Material Symbols font used by the dashboard.

The upstream `material-symbols` package ships all 4004 icons as one 3.9 MB
woff2, and `outlined.css` pulls that file into the global stylesheet — so every
page (including the login screen) downloaded it before the first icon could
paint. The UI only ever renders the icon names written into `src/`, so this
script keeps those glyphs plus the letter glyphs the icon ligatures are built
from, pins the unused variation axes (opsz is always 24, GRAD always 0) and
writes a ~60 KB woff2 to `src/app/fonts/`.

`layout_closure` must stay off: the icon names are rendered as ligatures, so the
subsetter would otherwise close over every name that the retained alphabet can
spell — which is the entire font again.

Regenerate after adding a new icon, otherwise the new icon falls back to its
literal name:

    python -m venv .tmp-fontenv
    .tmp-fontenv/Scripts/python -m pip install fonttools brotli
    .tmp-fontenv/Scripts/python scripts/build-icon-subset.py
"""

import io
import pathlib
import re
import sys

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
except ImportError:  # pragma: no cover - operator hint
    sys.exit("fonttools is required: pip install fonttools brotli")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SOURCE_FONT = ROOT / "node_modules" / "material-symbols" / "material-symbols-outlined.woff2"
OUT_DIR = SRC / "app" / "fonts"
OUT_FONT = OUT_DIR / "material-symbols-outlined-subset.woff2"

# Every value the UI pins in `font-variation-settings` for these icons.
PINNED_AXES = {"opsz": 24, "GRAD": 0}

# `"rocket_launch"`, `'rocket_launch'` and `icon = "rocket_launch"` all match.
QUOTED = re.compile(r"""["'`]([A-Za-z0-9_]{1,60})["'`]""")
# `<span className="material-symbols-outlined">rocket_launch</span>`
JSX_TEXT = re.compile(r">\s*([A-Za-z0-9_]{2,40})\s*<")

# Icon ligatures are spelled with these glyphs; without them GSUB has nothing to
# substitute and every icon renders as its literal name.
BASE_GLYPHS = (
    set("abcdefghijklmnopqrstuvwxyz")
    | {f"digit_{n}" for n in ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine")}
    | {"underscore", "period", "space", ".notdef"}
)


def collect_names():
    quoted, jsx = set(), set()
    for path in SRC.rglob("*.js"):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        quoted.update(QUOTED.findall(text))
        jsx.update(JSX_TEXT.findall(text))
    return quoted, jsx


def main():
    if not SOURCE_FONT.exists():
        sys.exit(f"missing source font: {SOURCE_FONT}")

    font = TTFont(SOURCE_FONT)
    available = {name.split(".")[0] for name in font.getGlyphOrder()}
    quoted, jsx = collect_names()
    wanted = ((quoted | jsx) & available) | BASE_GLYPHS

    options = subset.Options()
    options.layout_features = ["*"]
    options.layout_closure = False
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.flavor = None

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(glyphs=sorted(wanted))
    subsetter.subset(font)

    # Subset first: instancing drops variation deltas that subsetting still has to walk.
    font = instancer.instantiateVariableFont(font, PINNED_AXES, inplace=True)
    font.flavor = "woff2"

    buffer = io.BytesIO()
    font.save(buffer, reorderTables=False)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FONT.write_bytes(buffer.getvalue())

    before = SOURCE_FONT.stat().st_size
    after = OUT_FONT.stat().st_size
    print(f"icons kept: {len(wanted - BASE_GLYPHS)}/{len(available)}")
    print(f"{SOURCE_FONT.name}: {before / 1024:.0f} KB -> {OUT_FONT.name}: {after / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
