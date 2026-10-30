# Re-saves the store screenshots as pixels only: no metadata, no alpha channel, as the store asks.
# Usage: python store/clean-shots.py
from pathlib import Path

from PIL import Image

for path in (Path(__file__).resolve().parent / "screenshots").glob("*.png"):
    with Image.open(path) as shot:
        image = shot.convert("RGB")
    clean = Image.new("RGB", image.size)
    clean.paste(image)
    clean.save(path, optimize=True)
    print(path.name, clean.size, clean.mode)
