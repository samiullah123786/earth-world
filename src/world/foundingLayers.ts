import type { WorldRenderLayer } from './layering';

// The founding map predates the three-layer renderer and stores roofs,
// canopies, flowers and grass tufts together in bgtiles[1]. Deciding which of
// those may be drawn above a citizen used to be a hand-kept list of frame
// numbers, and it failed in the only direction that matters: a frame nobody
// had inspected yet defaulted to overhead, so every unlisted plant, stump and
// mushroom rendered on top of the people walking past it. The list only ever
// grew when somebody noticed a citizen disappearing.
//
// The map already knows the answer, and knows it for tiles nobody has looked
// at. In a top-down view a sprite is drawn upward from its base, and its base
// is where the author put collision: you cannot walk into a tent, but you can
// walk behind its roof. So a decoration is standing up - and may occlude - when
// it IS collision, or when it rests directly on decoration that is. Anything
// else is lying on the ground, and the ground can never hide anyone.
//
// This is strictly wider than the old list and never narrower: all seventeen
// tiles that list had verified by eye still resolve to ground. What changed is
// that the next tile added to this map is classified correctly on its own.

// The wilderness generator scatters these verified frames across new terrain,
// so they stay exported by name. They are no longer the definition of what
// counts as ground - position is.
export const FOUNDING_GROUND_FLOWER_FRAMES = [278, 279, 280, 934, 935, 936, 937] as const;
export const FOUNDING_GROUND_TUFT_FRAMES = [889, 890, 891] as const;
export const FOUNDING_GROUND_ACCENT_FRAMES = [896, 938] as const;

export const FOUNDING_GROUND_DECORATION_FRAMES = [
  ...FOUNDING_GROUND_FLOWER_FRAMES,
  ...FOUNDING_GROUND_TUFT_FRAMES,
  ...FOUNDING_GROUND_ACCENT_FRAMES,
] as const;

export type FoundingObjectMap = ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
export type FoundingDecorationPlane = ReadonlyArray<ReadonlyArray<number>>;

const EMPTY = -1;

/** Does this tile carry collision? Off-map counts as solid. */
export function tileIsSolid(objmap: FoundingObjectMap, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return true;
  let inside = false;
  for (const layer of objmap) {
    const column = layer[x];
    if (!column) continue;
    const tile = column[y];
    if (tile === undefined) continue;
    inside = true;
    if (tile !== EMPTY) return true;
  }
  return !inside;
}

/** Can a citizen stand here? The inverse of collision, named for the caller. */
export function tileIsStandable(objmap: FoundingObjectMap, x: number, y: number): boolean {
  return !tileIsSolid(objmap, x, y);
}

function hasDecoration(decor: FoundingDecorationPlane, x: number, y: number): boolean {
  const tile = decor[x]?.[y];
  return tile !== undefined && tile !== EMPTY;
}

/**
 * Is the decoration on this tile part of something standing up?
 *
 * True when the tile is collision, or when the decoration continues onto
 * collision immediately below - the tent roof whose peak is deliberately
 * walkable so a citizen can pass behind it. One step is the whole reach: a
 * sprite's occluding mass sits on its own footprint, and a decoration two
 * tiles clear of any collision is a separate thing lying on the grass.
 */
export function decorationIsStanding(
  objmap: FoundingObjectMap,
  decor: FoundingDecorationPlane,
  x: number,
  y: number,
): boolean {
  if (tileIsSolid(objmap, x, y)) return true;
  return hasDecoration(decor, x, y + 1) && tileIsSolid(objmap, x, y + 1);
}

export function foundingDecorationLayer(
  objmap: FoundingObjectMap,
  decor: FoundingDecorationPlane,
  x: number,
  y: number,
): Extract<WorldRenderLayer, 'ground' | 'overhead'> {
  return decorationIsStanding(objmap, decor, x, y) ? 'overhead' : 'ground';
}
