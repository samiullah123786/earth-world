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

This script bakes the result into one atlas so the whole town still costs one
draw call: N skins in a grid, and the renderer picks a cell per citizen with an
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

# Sixty-four skins in an eight-by-eight grid. Sixty-four is not a limit on
# distinct citizens - it is how many DIFFERENT LOOKS exist before two people
# start sharing one, and at 128 pixels a cell the whole sheet is a single
# 1024-pixel texture that any phone will hold.
GRID = 8
CELL = 128


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


def is_structural(rgb) -> bool:
    """Background, outlines, whites and near-blacks. Never recoloured."""
    _, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
    return s < 0.16 or v < 0.22


def reskin(base: Image.Image, seed: str) -> Image.Image:
    """Rotate one base skin's clothing hues by a deterministic amount."""
    nxt = stream(seed)
    shift = nxt(360) / 360.0
    # A second, smaller turn so trousers do not always match the shirt.
    split = nxt(140) / 360.0
    lift = 0.84 + nxt(36) / 100.0

    out = base.convert('RGB')
    pixels = out.load()
    width, height = out.size
    seen = {}
    for y in range(height):
        for x in range(width):
            rgb = pixels[x, y]
            hit = seen.get(rgb)
            if hit is None:
                if is_structural(rgb) or is_skin(rgb):
                    hit = rgb
                else:
                    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
                    # Darker colours are trousers and shoes more often than
                    # shirts, so they take the second turn. Crude; reads right.
                    turn = shift if v > 0.42 else (shift + split) % 1.0
                    # Slightly DESATURATED, not boosted. The world's palette is
                    # built on four muted hue anchors, and a cast in neon pink
                    # walking past it reads as two projects stapled together.
                    r, g, b = colorsys.hsv_to_rgb((h + turn) % 1.0,
                                                  min(1.0, s * 0.88),
                                                  min(1.0, v * lift))
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
    origins = []
    for index in range(count):
        seed = f'skin:{index:03d}'
        # The first eighteen cells are Kenney's originals, untouched. Anything
        # generated should have to beat the hand-drawn version, not replace it
        # silently.
        source = Image.open(os.path.join(BASE, bases[index % len(bases)]))
        cell = source if index < len(bases) else reskin(source, seed)
        atlas.paste(cell.convert('RGB').resize((CELL, CELL), Image.NEAREST),
                    ((index % GRID) * CELL, (index // GRID) * CELL))
        origins.append(bases[index % len(bases)][:-4] if index < len(bases) else f'gen-{seed}')

    os.makedirs(OUT_DIR, exist_ok=True)
    atlas.save(os.path.join(OUT_DIR, 'skins.png'), optimize=True)
    with open(os.path.join(OUT_DIR, 'skins.json'), 'w', encoding='utf-8') as handle:
        json.dump({'grid': GRID, 'cell': CELL, 'count': count,
                   'hand_drawn': len(bases), 'origins': origins}, handle, indent=1)

    size = os.path.getsize(os.path.join(OUT_DIR, 'skins.png'))
    print(f'{count} skins ({len(bases)} original, {count - len(bases)} generated)')
    print(f'atlas {atlas.size[0]}x{atlas.size[1]}  {size // 1024} KB  ->  {OUT_DIR}/skins.png')


if __name__ == '__main__':
    main()
