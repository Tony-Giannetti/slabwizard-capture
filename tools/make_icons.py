"""
Regenerate the PWA icons from the SlabWizard app icon.

    python mobile/tools/make_icons.py

The source of truth is ``ui/icons/slabwizardicon.png`` (the wizard-hat +
saw-blade mark the desktop app uses), so the phone app and the PC wear the
same face. Each output composites it onto the app's dark tile: launchers
don't handle transparency consistently, and the mark's cyan glow needs the
dark ground to read at 48px on a home screen anyway.
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (27, 29, 33, 255)

MOBILE = Path(__file__).resolve().parent.parent
SOURCE = MOBILE.parent / "ui" / "icons" / "slabwizardicon.png"
OUT = MOBILE / "icons"
SS = 4  # supersample factor for a clean tile-corner radius


def render(size: int, inset: float, radius_frac: float) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if radius_frac > 0:
        draw.rounded_rectangle([0, 0, big - 1, big - 1],
                               radius=int(big * radius_frac), fill=BG)
    else:
        draw.rectangle([0, 0, big, big], fill=BG)

    mark_px = int(round(big * (1.0 - 2.0 * inset)))
    mark = Image.open(SOURCE).convert("RGBA").resize(
        (mark_px, mark_px), Image.LANCZOS)
    offset = (big - mark_px) // 2
    img.alpha_composite(mark, (offset, offset))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # "any" icons: rounded tile, generous mark.
    render(192, 0.10, 0.22).save(OUT / "icon-192.png")
    render(512, 0.10, 0.22).save(OUT / "icon-512.png")
    # "maskable": full bleed, mark inside the 80% safe circle.
    render(512, 0.21, 0.0).save(OUT / "icon-maskable-512.png")
    # Favicon for the browser tab.
    render(32, 0.06, 0.18).save(OUT / "favicon-32.png")
    print("wrote icons to", OUT)


if __name__ == "__main__":
    main()
