#!/usr/bin/env python3
"""从正式版图标生成带右下角 DEV 角标的开发版图标。"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "src-tauri" / "icons" / "dev"

FONT_CANDIDATES = [
    Path(r"C:\Windows\Fonts\segoeuib.ttf"),
    Path(r"C:\Windows\Fonts\arialbd.ttf"),
    Path(r"C:\Windows\Fonts\segoeui.ttf"),
    Path(r"C:\Windows\Fonts\arial.ttf"),
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]


def add_dev_badge(img: Image.Image) -> Image.Image:
    w, h = img.size
    out = img.copy()
    draw = ImageDraw.Draw(out)
    bw = max(int(w * 0.48), 14)
    bh = max(int(h * 0.22), 8)
    margin = max(int(w * 0.04), 1)
    x1, y1 = w - margin - bw, h - margin - bh
    x2, y2 = w - margin, h - margin
    r = max(int(bh * 0.28), 1)
    draw.rounded_rectangle([x1, y1, x2, y2], radius=r, fill=(16, 185, 129, 255))

    text = "DEV"
    font = None
    font_path: str | None = None
    for cand in FONT_CANDIDATES:
        if not cand.exists():
            continue
        try:
            font = ImageFont.truetype(str(cand), size=max(int(bh * 0.72), 7))
            font_path = str(cand)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    while tw > bw - max(2, w // 32) and getattr(font, "size", 10) > 6 and font_path:
        font = ImageFont.truetype(font_path, size=getattr(font, "size", 10) - 1)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

    tx = x1 + (bw - tw) / 2 - bbox[0]
    ty = y1 + (bh - th) / 2 - bbox[1]
    draw.text((tx, ty), text, fill=(255, 255, 255, 255), font=font)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    base = Image.open(SRC).convert("RGBA")

    for name, size in {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }.items():
        img = add_dev_badge(base.resize((size, size), Image.Resampling.LANCZOS))
        img.save(OUT / name)
        print(f"wrote {OUT / name}")

    ico_images = [
        add_dev_badge(base.resize((s, s), Image.Resampling.LANCZOS))
        for s in (16, 24, 32, 48, 64, 128, 256)
    ]
    ico_path = OUT / "icon.ico"
    ico_images[0].save(
        ico_path,
        format="ICO",
        sizes=[(im.width, im.height) for im in ico_images],
        append_images=ico_images[1:],
    )
    print(f"wrote {ico_path}")


if __name__ == "__main__":
    main()
