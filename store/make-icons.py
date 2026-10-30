# Draws the extension's PNG icons from the same shapes as extension/keeper.svg.
# Usage: python store/make-icons.py
# The 128 px icon has 96 px of art and 16 px of clear space per side, as the Chrome Web Store asks.
from pathlib import Path

from PIL import Image, ImageDraw

TILE = (63, 57, 232, 255)  # #3f39e8
GLYPH = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SMOOTH = 8  # drawn this many times larger, then scaled down for clean edges


def art(size, window=(3, 3.5, 13, 12.5), pane=(4.5, 7, 11.5, 11)):
    """The tile and window at `size` px, in keeper.svg's 16-unit grid."""
    big = size * SMOOTH
    unit = big / 16
    box = lambda x0, y0, x1, y1: [round(v * unit) - (i > 1) for i, v in enumerate((x0, y0, x1, y1))]
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(3.5 * unit), fill=TILE)
    draw.rectangle(box(*window), fill=GLYPH)
    draw.rectangle(box(*pane), fill=TILE)  # below the window's title bar
    return image.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    # On whole pixels at toolbar size, so the 1 px frame stays sharp.
    art(16, window=(3, 3, 13, 13), pane=(4, 7, 12, 12)).save(OUT / "icon-16.png", optimize=True)
    for size in (32, 48):
        art(size).save(OUT / f"icon-{size}.png", optimize=True)
    icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    icon.paste(art(96), (16, 16))
    icon.save(OUT / "icon-128.png", optimize=True)


if __name__ == "__main__":
    main()
