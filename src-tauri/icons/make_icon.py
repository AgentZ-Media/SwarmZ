#!/usr/bin/env python3
"""Render the SwarmZ app-icon source (icon-source-1024.png).

The brand mark from the Vibe v3 design system: the hexagon (clip-path
polygon 25% 3%, 75% 3%, 98% 50%, 75% 97%, 25% 97%, 2% 50%) filled with the
135° accent gradient (#f0567c -> color-mix(acc 55%, #401020)) plus a soft
radial highlight (the Conductor-orb light at 35%/30%), carrying the white
bolt polygon (13 2, 4 14, 11 14, 9.5 22, 20 10, 13 10 in a 24-viewbox).

Regenerate the full Tauri icon set afterwards:

    python3 src-tauri/icons/make_icon.py
    pnpm tauri icon src-tauri/icons/icon-source-1024.png

and the webview favicons:

    magick src-tauri/icons/icon-source-1024.png -resize 64x64 public/favicon.png
    magick src-tauri/icons/icon-source-1024.png -resize 180x180 \
      -background "#09090c" -flatten public/apple-touch-icon.png

Only dependency: Pillow.
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

S = 1024  # output size
SS = 4  # supersample factor for the polygon masks

ACC = (240, 86, 124)  # --acc #f0567c
DEEP_MIX = (64, 16, 32)  # #401020


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float):
    """color-mix(in srgb, a t*100%, b) — t is a's share."""
    return tuple(round(a[i] * t + b[i] * (1 - t)) for i in range(3))


ACC_DEEP = mix(ACC, DEEP_MIX, 0.55)  # gradient end (--acc-deep)

# The hexagon's bounding box on the canvas (margin keeps the mark breathing
# like a macOS icon grid would).
MARGIN = 92
BOX = (MARGIN, MARGIN, S - MARGIN, S - MARGIN)
BW = BOX[2] - BOX[0]
BH = BOX[3] - BOX[1]

HEX_REL = [(0.25, 0.03), (0.75, 0.03), (0.98, 0.50), (0.75, 0.97), (0.25, 0.97), (0.02, 0.50)]
HEX_PTS = [(BOX[0] + x * BW, BOX[1] + y * BH) for x, y in HEX_REL]

# Bolt: 24-viewbox polygon, scaled to ~52% of the hexagon box, centered.
BOLT_24 = [(13, 2), (4, 14), (11, 14), (9.5, 22), (20, 10), (13, 10)]
BOLT_SIZE = 0.52 * BW
BOLT_OFF_X = BOX[0] + (BW - BOLT_SIZE) / 2
BOLT_OFF_Y = BOX[1] + (BH - BOLT_SIZE) / 2
BOLT_PTS = [(BOLT_OFF_X + x / 24 * BOLT_SIZE, BOLT_OFF_Y + y / 24 * BOLT_SIZE) for x, y in BOLT_24]


def polygon_mask(points: list[tuple[float, float]]) -> Image.Image:
    """Anti-aliased L-mask via supersampling."""
    big = Image.new("L", (S * SS, S * SS), 0)
    ImageDraw.Draw(big).polygon([(x * SS, y * SS) for x, y in points], fill=255)
    return big.resize((S, S), Image.LANCZOS)


def gradient_fill() -> Image.Image:
    """135° linear gradient across the hexagon box + soft radial highlight."""
    img = Image.new("RGB", (S, S))
    px = img.load()
    # highlight center at 35%/30% of the box (the Conductor-orb light)
    hx = BOX[0] + 0.35 * BW
    hy = BOX[1] + 0.30 * BH
    hr = 0.85 * BW  # highlight falloff radius
    span = float(BW + BH)
    for y in range(S):
        for x in range(S):
            # gradient coordinate along the 135deg diagonal, clamped to the box
            t = ((x - BOX[0]) + (y - BOX[1])) / span
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
            r = ACC[0] + (ACC_DEEP[0] - ACC[0]) * t
            g = ACC[1] + (ACC_DEEP[1] - ACC[1]) * t
            b = ACC[2] + (ACC_DEEP[2] - ACC[2]) * t
            # radial highlight (adds up to 14% white near the hot spot)
            d = ((x - hx) ** 2 + (y - hy) ** 2) ** 0.5
            if d < hr:
                a = 0.14 * (1.0 - d / hr)
                r += (255 - r) * a
                g += (255 - g) * a
                b += (255 - b) * a
            px[x, y] = (int(r), int(g), int(b))
    return img


def main() -> None:
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(gradient_fill(), (0, 0), polygon_mask(HEX_PTS))

    bolt_mask = polygon_mask(BOLT_PTS)
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    out.paste(white, (0, 0), bolt_mask)

    dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon-source-1024.png")
    out.save(dest)
    print(f"wrote {dest}")


if __name__ == "__main__":
    main()
