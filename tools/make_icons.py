"""
Regenerate the PWA icons.

    python mobile/tools/make_icons.py

The mark is a slab seen in perspective with a vein running through it and a
camera aperture in the corner — legible at 48px on a home screen, which is
the only size that really matters.
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (27, 29, 33, 255)
SLAB = (240, 161, 58, 255)
SLAB_DARK = (198, 126, 36, 255)
VEIN = (255, 232, 200, 255)
LENS = (238, 241, 245, 255)

OUT = Path(__file__).resolve().parent.parent / "icons"
SS = 4  # supersample factor for clean edges


def _draw_mark(draw: ImageDraw.ImageDraw, size: int, inset: float) -> None:
    """The slab + aperture mark, centred, occupying ``1 - 2*inset`` of size."""
    m = size * inset
    w = size - 2 * m

    # Slab face: a rectangle sheared into perspective.
    top_lift = w * 0.10
    face = [
        (m, m + top_lift * 1.6),
        (m + w, m),
        (m + w, m + w * 0.74),
        (m, m + w * 0.74 + top_lift * 1.6),
    ]
    draw.polygon(face, fill=SLAB)

    # Front edge — gives the slab thickness, which is the whole point of it.
    edge = w * 0.085
    draw.polygon(
        [
            (m, m + w * 0.74 + top_lift * 1.6),
            (m + w, m + w * 0.74),
            (m + w, m + w * 0.74 + edge),
            (m, m + w * 0.74 + top_lift * 1.6 + edge),
        ],
        fill=SLAB_DARK,
    )

    # Veining, because a blank rectangle reads as a card, not as stone. Keep
    # it a single sweeping diagonal with one branch — a zigzag across the
    # middle reads as a line chart at icon size, which is exactly wrong.
    draw.line(
        [
            (m + w * 0.06, m + w * 0.62),
            (m + w * 0.34, m + w * 0.44),
            (m + w * 0.62, m + w * 0.33),
            (m + w * 0.97, m + w * 0.11),
        ],
        fill=VEIN,
        width=max(1, int(w * 0.05)),
        joint="curve",
    )
    draw.line(
        [
            (m + w * 0.45, m + w * 0.62),
            (m + w * 0.62, m + w * 0.45),
            (m + w * 0.80, m + w * 0.40),
        ],
        fill=VEIN,
        width=max(1, int(w * 0.022)),
        joint="curve",
    )

    # Camera aperture, bottom-left, overlapping the slab corner.
    r = w * 0.20
    cx, cy = m + w * 0.20, m + w * 0.80
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BG)
    draw.ellipse(
        [cx - r * 0.62, cy - r * 0.62, cx + r * 0.62, cy + r * 0.62],
        fill=LENS,
    )


def render(size: int, inset: float, radius_frac: float) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if radius_frac > 0:
        draw.rounded_rectangle([0, 0, big - 1, big - 1],
                               radius=int(big * radius_frac), fill=BG)
    else:
        draw.rectangle([0, 0, big, big], fill=BG)

    _draw_mark(draw, big, inset)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # "any" icons: rounded tile, generous mark.
    render(192, 0.16, 0.22).save(OUT / "icon-192.png")
    render(512, 0.16, 0.22).save(OUT / "icon-512.png")
    # "maskable": full bleed, mark inside the 80% safe circle.
    render(512, 0.26, 0.0).save(OUT / "icon-maskable-512.png")
    # Favicon for the browser tab.
    render(32, 0.12, 0.18).save(OUT / "favicon-32.png")
    print("wrote icons to", OUT)


if __name__ == "__main__":
    main()
