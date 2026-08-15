"""Compile the complete EarthForge Pixel Habitat visual set.

The runtime never needs Pillow or Blender: generated PNGs are committed. Run
this after ``generate_earthforge_assets.py`` so the smooth Blender source
renders are reduced to the same hard pixel sampling as the 32px world.

Usage:
  python scripts/generate_earthforge_pixel_world.py
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "assets" / "earthforge" / "terrain"
PROPS = ROOT / "public" / "assets" / "earthforge" / "props"
BUILDINGS = ROOT / "public" / "assets" / "earthforge" / "buildings"

INK = (31, 39, 42, 255)
GRASS = (63, 126, 68, 255)
GRASS_DARK = (43, 96, 54, 255)
GRASS_LIGHT = (91, 150, 77, 255)
DIRT = (151, 116, 74, 255)
DIRT_DARK = (112, 82, 55, 255)
DIRT_LIGHT = (184, 147, 91, 255)
WATER = (48, 116, 132, 255)
WATER_DARK = (34, 82, 106, 255)
WATER_LIGHT = (83, 159, 164, 255)
STONE = (169, 161, 132, 255)
STONE_DARK = (111, 111, 99, 255)
STONE_LIGHT = (201, 193, 158, 255)
WOOD = (119, 72, 39, 255)
WOOD_DARK = (71, 44, 29, 255)
WOOD_LIGHT = (164, 105, 52, 255)
LEAF = (39, 111, 55, 255)
LEAF_DARK = (25, 70, 42, 255)
LEAF_LIGHT = (73, 149, 69, 255)


def tile_texture(kind: str, variant: int) -> Image.Image:
    palette = {
        "grass": (GRASS, GRASS_DARK, GRASS_LIGHT),
        "dirt": (DIRT, DIRT_DARK, DIRT_LIGHT),
        "water": (WATER, WATER_DARK, WATER_LIGHT),
        "stone": (STONE, STONE_DARK, STONE_LIGHT),
    }
    base, dark, light = palette[kind]
    image = Image.new("RGBA", (32, 32), base)
    draw = ImageDraw.Draw(image)
    rng = random.Random(0xEA47 + variant * 97 + sum(map(ord, kind)))
    if kind == "stone":
        draw.rectangle((0, 0, 31, 31), fill=STONE_DARK)
        offset = 0 if variant % 2 == 0 else 7
        for row, y in enumerate(range(-8, 40, 10)):
            x_shift = (offset + row * 11) % 18 - 9
            for x in range(x_shift, 40, 18):
                draw.rounded_rectangle((x, y, x + 15, y + 7), radius=2, fill=STONE)
                draw.line((x + 2, y + 1, x + 12, y + 1), fill=STONE_LIGHT, width=1)
        return image
    if kind == "water":
        for y in (5, 15, 25):
            shift = rng.randrange(-5, 5)
            draw.rectangle((shift, y, shift + 12, y + 1), fill=WATER_LIGHT)
            draw.rectangle((shift + 17, y + 4, shift + 29, y + 5), fill=WATER_DARK)
        return image
    for _ in range(22 if kind == "grass" else 14):
        x, y = rng.randrange(1, 30), rng.randrange(1, 30)
        color = light if rng.random() > 0.48 else dark
        if kind == "grass":
            draw.line((x, y + 2, x + (1 if rng.random() > 0.5 else -1), y), fill=color, width=1)
            if rng.random() > 0.72:
                draw.point((x + 1, y + 2), fill=color)
        else:
            draw.rectangle((x, y, x + rng.randrange(1, 4), y + 1), fill=color)
    return image


def atlas(path: Path, columns: int, rows: int, kind: str):
    image = Image.new("RGBA", (columns * 32, rows * 32), (0, 0, 0, 0))
    for index in range(columns * rows):
        image.paste(tile_texture(kind, index), ((index % columns) * 32, (index // columns) * 32))
    image.save(path)


def tree_macro(seed: int) -> Image.Image:
    small = Image.new("RGBA", (48, 48), (0, 0, 0, 0))
    draw = ImageDraw.Draw(small)
    rng = random.Random(seed)
    draw.ellipse((5, 34, 43, 43), fill=(21, 47, 36, 105))
    masses = [(12, 23, 14), (24, 17, 16), (34, 25, 13), (22, 29, 17), (31, 13, 11)]
    for index, (x, y, radius) in enumerate(masses):
        jitter = rng.randrange(-2, 3)
        color = LEAF_DARK if index < 2 else LEAF
        draw.ellipse((x - radius + jitter, y - radius, x + radius + jitter, y + radius), fill=color)
    for _ in range(20):
        x, y = rng.randrange(10, 39), rng.randrange(7, 34)
        draw.rectangle((x, y, x + 1, y + 1), fill=LEAF_LIGHT if rng.random() > 0.35 else GRASS_LIGHT)
    return small.resize((96, 96), Image.Resampling.NEAREST)


def trees_and_trunks():
    trees = Image.new("RGBA", (192, 224), (0, 0, 0, 0))
    trees.alpha_composite(tree_macro(71), (0, 0))
    trees.alpha_composite(tree_macro(109), (96, 0))
    trees.save(OUTPUT / "trees.png")

    trunks = Image.new("RGBA", (192, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(trunks)
    for column, lean in ((1, 0), (4, 2)):
        x = column * 32
        draw.rectangle((x + 13 + lean, 8, x + 20 + lean, 31), fill=WOOD_DARK)
        draw.rectangle((x + 15 + lean, 8, x + 18 + lean, 31), fill=WOOD_LIGHT)
        draw.rectangle((x + 11 + lean, 32, x + 22 + lean, 57), fill=WOOD)
        draw.rectangle((x + 14 + lean, 32, x + 18 + lean, 57), fill=WOOD_LIGHT)
        draw.rectangle((x + 7, 55, x + 15, 60), fill=WOOD_DARK)
        draw.rectangle((x + 19, 54, x + 27, 60), fill=WOOD_DARK)
    trunks.save(OUTPUT / "trunks.png")


def bridges():
    image = Image.new("RGBA", (192, 224), (0, 0, 0, 0))
    for index in range(42):
        x, y = (index % 6) * 32, (index // 6) * 32
        tile = Image.new("RGBA", (32, 32), WOOD)
        draw = ImageDraw.Draw(tile)
        for plank in range(0, 32, 8):
            draw.line((0, plank, 31, plank), fill=WOOD_DARK, width=2)
            draw.line((2, plank + 2, 29, plank + 2), fill=WOOD_LIGHT)
        draw.rectangle((1, 0, 3, 31), fill=WOOD_DARK)
        draw.rectangle((28, 0, 30, 31), fill=WOOD_DARK)
        image.alpha_composite(tile, (x, y))
    image.save(OUTPUT / "bridges.png")


def structure_tiles():
    """Compatibility atlas for the dormant Tiled house GID range.

    Semantic buildings render as atomic compositions, but Phaser still needs a
    same-sized texture for every tileset declared by the TMJ. These authored
    wall/roof/window modules ensure a future legacy GID cannot pull LPC pixels
    back into the live habitat while old map files remain readable.
    """
    image = Image.new("RGBA", (288, 224), (0, 0, 0, 0))
    for index in range(63):
        x, y = (index % 9) * 32, (index // 9) * 32
        tile = Image.new("RGBA", (32, 32), (218, 205, 173, 255))
        draw = ImageDraw.Draw(tile)
        mode = index % 7
        if mode in (0, 1):
            tile.paste((50, 104, 92, 255), (0, 0, 32, 32))
            for row in range(0, 32, 7):
                draw.line((0, row, 31, row), fill=(27, 67, 59, 255), width=2)
        elif mode == 2:
            draw.rectangle((9, 5, 23, 31), fill=WOOD_DARK)
            draw.rectangle((12, 8, 20, 31), fill=WOOD)
            draw.point((19, 20), fill=(229, 184, 77, 255))
        elif mode == 3:
            draw.rectangle((5, 6, 26, 25), fill=INK)
            draw.rectangle((8, 9, 23, 22), fill=(245, 203, 137, 255))
            draw.line((15, 9, 15, 22), fill=WOOD_DARK, width=2)
            draw.line((8, 15, 23, 15), fill=WOOD_DARK, width=2)
        elif mode == 4:
            for beam in (3, 27):
                draw.rectangle((beam, 0, beam + 3, 31), fill=WOOD)
        elif mode == 5:
            tile = tile_texture("stone", index)
        else:
            tile = tile_texture("dirt", index)
        image.alpha_composite(tile, (x, y))
    image.save(OUTPUT / "structures.png")


def crops():
    image = Image.new("RGBA", (160, 32), (0, 0, 0, 0))
    for stage in range(5):
        tile = tile_texture("dirt", stage)
        draw = ImageDraw.Draw(tile)
        for x in (7, 16, 25):
            height = stage * 3
            if stage:
                draw.line((x, 25, x, 25 - height), fill=LEAF_DARK, width=2)
                draw.rectangle((x - 3, 20 - height // 2, x - 1, 22 - height // 2), fill=LEAF)
                draw.rectangle((x + 1, 17 - height // 2, x + 3, 19 - height // 2), fill=LEAF_LIGHT)
                if stage == 4:
                    draw.rectangle((x - 1, 10, x + 2, 13), fill=(226, 177, 67, 255))
        image.alpha_composite(tile, (stage * 32, 0))
    image.save(OUTPUT / "crops.png")


def props():
    rock = Image.new("RGBA", (48, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rock)
    draw.ellipse((4, 23, 44, 30), fill=(23, 42, 42, 100))
    draw.polygon([(5, 24), (10, 13), (19, 8), (27, 17), (35, 11), (43, 24)], fill=STONE_DARK)
    draw.polygon([(10, 13), (19, 8), (17, 20), (5, 24)], fill=STONE)
    draw.polygon([(27, 17), (35, 11), (43, 24), (31, 25)], fill=STONE_LIGHT)
    rock.resize((96, 64), Image.Resampling.NEAREST).save(PROPS / "rock_cluster.png")

    orchard = Image.new("RGBA", (48, 56), (0, 0, 0, 0))
    draw = ImageDraw.Draw(orchard)
    draw.ellipse((7, 46, 42, 53), fill=(22, 42, 34, 90))
    draw.rectangle((21, 25, 26, 49), fill=WOOD)
    draw.rectangle((23, 25, 25, 49), fill=WOOD_LIGHT)
    for box, color in [((7, 10, 30, 34), LEAF_DARK), ((19, 6, 42, 31), LEAF), ((13, 1, 34, 25), LEAF_LIGHT)]:
        draw.ellipse(box, fill=color)
    for x, y in ((15, 16), (29, 12), (34, 21), (22, 25)):
        draw.rectangle((x, y, x + 2, y + 2), fill=(193, 74, 52, 255))
    orchard.resize((96, 112), Image.Resampling.NEAREST).save(PROPS / "orchard_tree.png")

    logs = Image.new("RGBA", (48, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(logs)
    draw.ellipse((4, 23, 44, 29), fill=(22, 42, 34, 90))
    for index, y in enumerate((20, 15, 10)):
        draw.rounded_rectangle((8 + index * 3, y, 39 - index * 3, y + 7), radius=3, fill=WOOD)
        draw.ellipse((33 - index * 3, y, 40 - index * 3, y + 7), fill=WOOD_LIGHT)
        draw.point((36 - index * 3, y + 3), fill=WOOD_DARK)
    logs.resize((96, 64), Image.Resampling.NEAREST).save(PROPS / "log_pile.png")


def pixelate_buildings():
    for path in BUILDINGS.glob("*.png"):
        source = Image.open(path).convert("RGBA")
        small = source.resize((128, 128), Image.Resampling.LANCZOS)
        alpha = small.getchannel("A")
        rgb = small.convert("RGB").quantize(colors=40, method=Image.Quantize.MEDIANCUT).convert("RGB")
        rgba = Image.merge("RGBA", (*rgb.split(), alpha.point(lambda value: round(value / 32) * 32 if value < 224 else 255)))
        rgba.resize(source.size, Image.Resampling.NEAREST).save(path)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    PROPS.mkdir(parents=True, exist_ok=True)
    atlas(OUTPUT / "grass.png", 3, 6, "grass")
    atlas(OUTPUT / "dirt.png", 3, 6, "dirt")
    atlas(OUTPUT / "water.png", 3, 6, "water")
    atlas(OUTPUT / "stone_paths.png", 4, 5, "stone")
    trees_and_trunks()
    bridges()
    structure_tiles()
    crops()
    props()
    pixelate_buildings()
    print("EARTHFORGE_PIXEL_WORLD_READY")


if __name__ == "__main__":
    main()
