"""
Build the citizen skin atlas.

Kenney's eighteen Blocky Characters share ONE mesh and ONE UV layout - identical
topology on nodes named head, torso, arm-left, arm-right, leg-left, leg-right.
Every difference between them lives in a single 1024-pixel texture, and that
texture is a labelled template: Kenney wrote "Head", "Torso", "Arm (left)" into
the image because it is meant for people to draw their own skins on.

So a citizen's face does not have to be picked from a list of eighteen. It can
be GENERATED from their agent id - stable forever, unique in practice, and
impossible to claim, which is the rule every other fact in this world already
follows.

This bakes the result into one atlas so the whole town still costs six draw
calls: N skins in a grid, and the renderer picks a cell per citizen with an
instanced UV offset. Run it when the palette or the cell count changes; the
output is committed, so a browser never generates anything.

    python tools/skinsmith.py

Writes public/models/citizen/skins.png and skins.json.
"""
import colorsys
import hashlib
import json
import os

from PIL import Image

BASE = 'assets/kenney/blocky/Models/GLB format/Textures'
OUT_DIR = 'public/models/citizen'

# TWO HUNDRED AND FIFTY-SIX PIXELS A CELL, and this is the number that was wrong.
#
# The first atlas packed each skin into 128 pixels, which sounded generous
# against a 1024-pixel source until you look at where the face actually is: the
# head occupies about a third of the sheet, so a face rendered at 128 gets
# roughly forty pixels and an EYE gets four. Four pixels is not an eye. Every
# citizen in the town had their features smeared into a blob, which is exactly
# what it looked like.
#
# At 256 the head gets ninety pixels and an eye gets seven, which reads. The
# cost is a 3072-pixel sheet instead of a 2048-pixel one.
CELL = 256

# Twelve by twelve: 144 skins.
#
# Fewer than the 256 this briefly had, and deliberately - readable faces are
# worth more than a bigger number nobody can tell apart. Raising either is one
# constant and a re-run; what it costs is texture memory, never draw calls,
# because the whole cast shares this one sheet however many people are in town.
GRID = 12


def stream(seed: str):
    """A stable stream of numbers from a string. The same seed, forever."""
    digest = hashlib.sha256(seed.encode()).digest()
    cursor = 0

    def nxt(modulo: int) -> int:
        nonlocal cursor
        value = digest[cursor % len(digest)] | (digest[(cursor + 1) % len(digest)] << 8)
        cursor += 2
        return value % modulo
    return nxt


def is_skin(rgb) -> bool:
    """
    Roughly: is this a human skin tone?

    Deliberately generous. A false positive costs one clothing colour left
    alone; a false negative is a citizen with a green face, which is a great
    deal more noticeable.
    """
    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
    return 0.02 <= h <= 0.13 and 0.12 <= s <= 0.72 and v >= 0.35


def is_hair(rgb) -> bool:
    """Hair and beards: browns and greys darker than skin, above the outlines."""
    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
    return 0.22 <= v <= 0.58 and s <= 0.55 and (h <= 0.12 or h >= 0.92 or s < 0.14)


def is_structural(rgb) -> bool:
    """Background, outlines, whites and near-blacks. Never recoloured."""
    _, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
    return v < 0.18 or (s < 0.06 and v > 0.9)


def reskin(base: Image.Image, seed: str) -> Image.Image:
    """
    One citizen's skin, from one base and one seed.

    Three independent moves, because varying only the clothing produced a
    hundred and forty-four people who were plainly the same eighteen faces in
    different shirts:

      CLOTHING turns freely. Any hue, and a second smaller turn for the darker
      colours so trousers do not always match the shirt.

      SKIN shifts a little. Warmer or cooler, lighter or darker, but never off
      the range of human complexions - a face is the one thing here that must
      not go green.

      HAIR turns within the range hair comes in: black through brown to fair,
      plus the greys. Not blue.
    """
    nxt = stream(seed)
    cloth_turn = nxt(360) / 360.0
    cloth_split = nxt(140) / 360.0
    cloth_lift = 0.84 + nxt(36) / 100.0
    skin_warm = (nxt(60) - 30) / 3000.0          # +/- 0.01 in hue
    skin_depth = 0.82 + nxt(40) / 100.0          # 0.82 .. 1.22 in value
    hair_hue = 0.02 + nxt(90) / 1000.0           # 0.02 .. 0.11, hair browns
    hair_depth = 0.7 + nxt(60) / 100.0
    grey_hair = nxt(100) < 14

    out = base.convert('RGB')
    pixels = out.load()
    width, height = out.size
    seen = {}
    for y in range(height):
        for x in range(width):
            rgb = pixels[x, y]
            hit = seen.get(rgb)
            if hit is None:
                h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
                if is_structural(rgb):
                    hit = rgb
                elif is_skin(rgb):
                    r, g, b = colorsys.hsv_to_rgb(
                        max(0.015, min(0.14, h + skin_warm)),
                        min(0.78, s * 1.02),
                        max(0.3, min(0.99, v * skin_depth)))
                    hit = (int(r * 255), int(g * 255), int(b * 255))
                elif is_hair(rgb):
                    r, g, b = colorsys.hsv_to_rgb(
                        hair_hue,
                        0.04 if grey_hair else min(0.6, s * 1.1),
                        max(0.14, min(0.86, v * (1.35 if grey_hair else hair_depth))))
                    hit = (int(r * 255), int(g * 255), int(b * 255))
                else:
                    # Darker colours are trousers and shoes more often than
                    # shirts, so they take the second turn. Crude; reads right.
                    turn = cloth_turn if v > 0.42 else (cloth_turn + cloth_split) % 1.0
                    # Slightly DESATURATED, not boosted. The world's palette is
                    # built on four muted hue anchors, and a cast in neon pink
                    # walking past it reads as two projects stapled together.
                    r, g, b = colorsys.hsv_to_rgb((h + turn) % 1.0,
                                                  min(1.0, s * 0.88),
                                                  min(1.0, v * cloth_lift))
                    hit = (int(r * 255), int(g * 255), int(b * 255))
                seen[rgb] = hit
            pixels[x, y] = hit
    return out


def main() -> None:
    bases = sorted(f for f in os.listdir(BASE) if f.endswith('.png'))
    if not bases:
        raise SystemExit(f'no base skins in {BASE} - download the Blocky pack first')

    count = GRID * GRID
    atlas = Image.new('RGB', (GRID * CELL, GRID * CELL), (0, 0, 0))
    catalogue = []
    for index in range(count):
        seed = f'skin:{index:03d}'
        origin = bases[index % len(bases)]
        # The first eighteen cells are Kenney's originals, untouched. Anything
        # generated should have to beat the hand-drawn version, not silently
        # replace it.
        source = Image.open(os.path.join(BASE, origin))
        cell = source if index < len(bases) else reskin(source, seed)
        atlas.paste(cell.convert('RGB').resize((CELL, CELL), Image.LANCZOS),
                    ((index % GRID) * CELL, (index // GRID) * CELL))
        catalogue.append({
            'slot': index,
            'origin': origin[:-4],
            'kind': 'original' if index < len(bases) else 'generated',
            'seed': None if index < len(bases) else seed,
        })

    os.makedirs(OUT_DIR, exist_ok=True)
    atlas.save(os.path.join(OUT_DIR, 'skins.png'), optimize=True)
    with open(os.path.join(OUT_DIR, 'skins.json'), 'w', encoding='utf-8') as handle:
        json.dump({
            'grid': GRID, 'cell': CELL, 'count': count,
            'handDrawn': len(bases),
            'note': 'A citizen wears the slot at hash(agentId) % count. See tools/skinsmith.py.',
            'skins': catalogue,
        }, handle, indent=1)

    size = os.path.getsize(os.path.join(OUT_DIR, 'skins.png'))
    print(f'{count} skins ({len(bases)} original, {count - len(bases)} generated)')
    print(f'atlas {atlas.size[0]}x{atlas.size[1]}  {size // 1024} KB  ->  {OUT_DIR}/skins.png')


if __name__ == '__main__':
    main()
