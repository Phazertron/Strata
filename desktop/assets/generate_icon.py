"""
Generates placeholder tray icons from the Strata accent colour.
Run once before building; replace the output files with a real icon when ready.

    python desktop/assets/generate_icon.py

Produces:
    desktop/assets/icon.png   — 256x256 RGBA (pystray + macOS)
    desktop/assets/icon.ico   — multi-size ICO (Windows)
    desktop/assets/icon.icns  — macOS ICNS bundle (macOS only, requires iconutil)
"""
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

OUT = Path(__file__).parent
ACCENT = (99, 102, 241)     # Strata indigo — matches --accent in style.css

def make_base(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    margin = size // 8
    # Rounded square background
    d.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 5,
        fill=(*ACCENT, 255),
    )
    # Simple "S" lettermark centred
    font_size = int(size * 0.55)
    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except OSError:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), "S", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(
        ((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]),
        "S",
        font=font,
        fill=(255, 255, 255, 255),
    )
    return img


def build_png() -> Path:
    img = make_base(256)
    path = OUT / "icon.png"
    img.save(path, "PNG")
    print(f"  ✓ {path}")
    return path


def build_ico() -> Path:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [make_base(s).convert("RGBA") for s in sizes]
    path = OUT / "icon.ico"
    frames[0].save(path, format="ICO", sizes=[(s, s) for s in sizes],
                   append_images=frames[1:])
    print(f"  ✓ {path}")
    return path


def build_icns(png_path: Path) -> None:
    """macOS only — requires iconutil (ships with Xcode CLT)."""
    if sys.platform != "darwin":
        print("  - icon.icns skipped (macOS only)")
        return
    import subprocess, tempfile, shutil
    iconset = Path(tempfile.mkdtemp()) / "Strata.iconset"
    iconset.mkdir()
    specs = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    for name, size in specs.items():
        make_base(size).save(iconset / name, "PNG")
    out_icns = OUT / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out_icns)], check=True)
    shutil.rmtree(iconset.parent)
    print(f"  ✓ {out_icns}")


if __name__ == "__main__":
    print("Generating Strata icons…")
    png = build_png()
    build_ico()
    build_icns(png)
    print("Done. Replace these files with a real icon before publishing.")
