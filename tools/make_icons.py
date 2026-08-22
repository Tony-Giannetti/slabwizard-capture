"""
Regenerate the PWA icons from the SlabWizard app icon.

    python mobile/tools/make_icons.py

The source of truth is ``ui/icons/slabwizardicon.png`` (the wizard-hat +
saw-blade mark the desktop app uses), shipped VERBATIM — the launcher
icons are the mark itself on its own transparency, not a tile featuring
it. The one exception is the maskable variant: Android crops it to a
circle/squircle, so it alone gets the dark ground and a safe-zone inset
(otherwise launchers paint a white disc behind the transparency).
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (27, 29, 33, 255)

MOBILE = Path(__file__).resolve().parent.parent
SOURCE = MOBILE.parent / "ui" / "icons" / "slabwizardicon.png"
OUT = MOBILE / "icons"


def verbatim(size: int) -> Image.Image:
    """The mark as-is, transparent background, full bleed."""
    return Image.open(SOURCE).convert("RGBA").resize(
        (size, size), Image.LANCZOS)


def maskable(size: int, inset: float = 0.21) -> Image.Image:
    """The mark inside the 80% safe circle on the app's dark ground."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle([0, 0, size, size], fill=BG)
    mark_px = int(round(size * (1.0 - 2.0 * inset)))
    mark = Image.open(SOURCE).convert("RGBA").resize(
        (mark_px, mark_px), Image.LANCZOS)
    offset = (size - mark_px) // 2
    img.alpha_composite(mark, (offset, offset))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    verbatim(192).save(OUT / "icon-192.png")
    verbatim(512).save(OUT / "icon-512.png")
    maskable(512).save(OUT / "icon-maskable-512.png")
    verbatim(32).save(OUT / "favicon-32.png")
    print("wrote icons to", OUT)


if __name__ == "__main__":
    main()
