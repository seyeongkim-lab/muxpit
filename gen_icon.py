"""Generate muxpit app icons."""
from PIL import Image, ImageDraw, ImageFont
import os

SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background: rounded rectangle with gradient-like color
    pad = max(1, size // 16)
    r = max(4, size // 6)
    # Dark blue-purple background matching Catppuccin Mocha
    draw.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=r,
        fill=(30, 30, 46, 255),  # #1e1e2e
        outline=(137, 180, 250, 255),  # #89b4fa
        width=max(1, size // 32),
    )

    # Draw "W" letter
    try:
        font_size = int(size * 0.45)
        font = ImageFont.truetype("consola.ttf", font_size)
    except (OSError, IOError):
        font_size = int(size * 0.45)
        font = ImageFont.load_default()

    text = "W"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2
    ty = (size - th) // 2 - bbox[1]
    draw.text((tx, ty), text, fill=(137, 180, 250, 255), font=font)

    # Small terminal cursor block at bottom-right
    cursor_size = max(2, size // 10)
    cx = size - pad - cursor_size - max(2, size // 8)
    cy = size - pad - cursor_size - max(2, size // 8)
    draw.rectangle(
        [cx, cy, cx + cursor_size, cy + cursor_size],
        fill=(245, 224, 220, 255),  # #f5e0dc cursor color
    )

    return img


def main():
    icon_dir = os.path.join("src-tauri", "icons")
    os.makedirs(icon_dir, exist_ok=True)

    images = {}
    for name, size in SIZES.items():
        img = make_icon(size)
        path = os.path.join(icon_dir, name)
        img.save(path, "PNG")
        images[name] = img
        print(f"  Created {path} ({size}x{size})")

    # Generate ICO (contains multiple sizes)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [make_icon(s) for s in ico_sizes]
    ico_path = os.path.join(icon_dir, "icon.ico")
    ico_images[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[1:],
    )
    print(f"  Created {ico_path} (ICO with {len(ico_sizes)} sizes)")

    print("Done!")


if __name__ == "__main__":
    main()
