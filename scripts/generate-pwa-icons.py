#!/usr/bin/env python3
"""Generate the PWA icon set in static/icons/ from static/logo.png.

Outputs (all square PNGs):
  - icon-192.png, icon-512.png       purpose "any"  (transparent corners, as designed)
  - maskable-512.png                 purpose "maskable": logo on a solid pink square.
    The circle in the logo is the same pink, so the OS mask crop is invisible and
    the globe glyph stays inside the 80% safe zone.
  - apple-touch-icon-180.png         opaque (iOS composites alpha over black at the
    corners); corners are masked away by iOS anyway.

Pink is sampled from the logo itself so the icon set never drifts from the brand.
Requires Pillow: python3 -m pip install pillow
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'static' / 'logo.png'
OUT = ROOT / 'static' / 'icons'


def logo_pink(logo: Image.Image) -> tuple[int, int, int, int]:
	"""Solid brand pink from the circle body (near the top, fully opaque)."""
	px = logo.getpixel((logo.width // 2, 16))
	return (px[0], px[1], px[2], 255)


def on_pink(logo: Image.Image, size: int) -> Image.Image:
	canvas = Image.new('RGBA', (size, size), logo_pink(logo))
	part = logo.resize((size, size), Image.LANCZOS)
	canvas.alpha_composite(part)
	return canvas


def plain(logo: Image.Image, size: int) -> Image.Image:
	return logo.resize((size, size), Image.LANCZOS)


def main() -> None:
	logo = Image.open(SRC).convert('RGBA')
	OUT.mkdir(parents=True, exist_ok=True)
	targets = {
		'icon-192.png': plain(logo, 192),
		'icon-512.png': plain(logo, 512),
		'maskable-512.png': on_pink(logo, 512),
		'apple-touch-icon-180.png': on_pink(logo, 180)
	}
	for name, img in targets.items():
		img.save(OUT / name, 'PNG', optimize=True)
		print(f'{name}: {img.width}x{img.height}')


if __name__ == '__main__':
	main()
