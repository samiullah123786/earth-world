/**
 * Everything the world can be built out of, and the rules for choosing it.
 *
 * The renderer used to carry hardcoded arrays of file paths, which worked while
 * there were twelve of them and stopped working the moment the question became
 * "what should a new district look like?". This is the answer to that question:
 * a catalogue of every asset, what each one IS, and what may stand where.
 *
 * Two properties matter more than the contents.
 *
 * IT IS DETERMINISTIC. Nothing here rolls dice. Every choice is a pure function
 * of an identifier the Kernel already owns - a build id, an agent id, a tile
 * coordinate - so a house looks the same to every viewer, on every machine,
 * forever, and a district laid this afternoon is identical for everyone who
 * looks at it. This is not a rendering nicety. It is the same rule the rest of
 * the world runs on: what you see is derived from something checkable, never
 * from something somebody chose.
 *
 * AND IT REFUSES BAD COMBINATIONS. A catalogue that let anything stand anywhere
 * would produce a world with market stalls in the woods and pine trees in the
 * plaza. Every entry declares where it belongs, and the picker only ever offers
 * what fits - so the variety is wide and never incoherent.
 */

/** Where an asset is allowed to stand. */
export type Habitat =
  | 'plot'        // inside somebody's parcel
  | 'meadow'      // open grass, away from roads
  | 'verge'       // the shoulder of a road
  | 'wood'        // where the map says there are trees
  | 'civic';      // the plaza and public ground

export type AssetKind = 'home' | 'civic' | 'tree' | 'flora' | 'garden';

export type Asset = {
  /** Stable id. Never renumber these - a home's identity is built on them. */
  id: string;
  kind: AssetKind;
  /** Where the file lives, under public/. */
  url: string;
  habitats: Habitat[];
  /** Roughly how tall it stands, in tiles, for scaling across kits. */
  height: number;
  /** How often it is chosen relative to its siblings. */
  weight: number;
  tags: string[];
};

const home = (index: number, tags: string[], weight = 1): Asset => ({
  id: `home-${String.fromCharCode(97 + index)}`,
  kind: 'home',
  url: `/models/home/${String.fromCharCode(97 + index)}.glb`,
  habitats: ['plot'],
  height: 2,
  weight,
  tags,
});

const civic = (index: number, tags: string[], weight = 1): Asset => ({
  id: `civic-${String.fromCharCode(97 + index)}`,
  kind: 'civic',
  url: `/models/civic/${String.fromCharCode(97 + index)}.glb`,
  habitats: ['plot', 'civic'],
  height: 3,
  weight,
  tags,
});

const tree = (index: number, tags: string[], height: number, weight = 1): Asset => ({
  id: `tree-${index}`,
  kind: 'tree',
  url: `/models/tree/${index}.glb`,
  habitats: ['wood', 'meadow'],
  height,
  weight,
  tags,
});

const flora = (index: number, tags: string[], height: number, weight = 1): Asset => ({
  id: `flora-${index}`,
  kind: 'flora',
  url: `/models/flora/${index}.glb`,
  habitats: ['meadow', 'verge', 'wood'],
  height,
  weight,
  tags,
});

const garden = (index: number, tags: string[], weight = 1): Asset => ({
  id: `garden-${index}`,
  kind: 'garden',
  url: `/models/garden/${index}.glb`,
  habitats: ['plot', 'civic'],
  height: 0.8,
  weight,
  tags,
});

/**
 * The catalogue.
 *
 * Weights are the only editorial judgement in this file, and they are here
 * rather than in the renderer because "how often should a palm tree appear"
 * is a question about the world, not about drawing.
 */
export const CATALOGUE: Asset[] = [
  // Dwellings. Twelve suburban houses, weighted toward the plainer ones so a
  // street reads as a street rather than as a showroom.
  home(0, ['suburban', 'pitched'], 3), home(1, ['suburban', 'pitched'], 3),
  home(2, ['suburban', 'flat'], 2), home(3, ['suburban', 'pitched'], 3),
  home(4, ['suburban', 'wide'], 2), home(5, ['suburban', 'narrow'], 2),
  home(6, ['suburban', 'pitched'], 3), home(7, ['suburban', 'flat'], 2),
  home(8, ['suburban', 'tall'], 1), home(9, ['suburban', 'wide'], 2),
  home(10, ['suburban', 'pitched'], 3), home(11, ['suburban', 'tall'], 1),

  // Public and working buildings: the bank, the halls, the workshops.
  civic(0, ['commercial', 'shopfront'], 2), civic(1, ['commercial', 'tall'], 2),
  civic(2, ['commercial', 'wide'], 2), civic(3, ['commercial', 'shopfront'], 2),
  civic(4, ['commercial', 'tall'], 1), civic(5, ['commercial', 'plain'], 2),
  civic(6, ['commercial', 'wide'], 1), civic(7, ['commercial', 'plain'], 2),

  // Woodland. Broadleaf is common, palms are rare, and the tall pines are what
  // give a horizon its shape.
  tree(0, ['broadleaf'], 2.2, 4), tree(1, ['broadleaf', 'oak'], 2.6, 3),
  tree(2, ['broadleaf', 'tall'], 2.9, 2), tree(3, ['broadleaf', 'fat'], 2.1, 3),
  tree(4, ['broadleaf', 'thin'], 2.4, 2), tree(5, ['broadleaf', 'detailed'], 2.5, 2),
  tree(6, ['blocky'], 2.0, 2), tree(7, ['conifer'], 2.6, 3),
  tree(8, ['conifer', 'pine'], 2.8, 3), tree(9, ['conifer', 'pine', 'tall'], 3.2, 2),
  tree(10, ['conifer', 'round'], 2.3, 2), tree(11, ['palm'], 2.7, 1),
  tree(12, ['plateau'], 2.4, 1), tree(13, ['simple'], 2.0, 2),
  tree(14, ['small'], 1.5, 3),

  // What lies on the ground. Rocks and stumps are common; mushrooms are a
  // thing you notice once and remember.
  flora(0, ['rock', 'small'], 0.4, 4), flora(1, ['rock', 'small'], 0.4, 4),
  flora(2, ['rock', 'large'], 0.8, 2), flora(3, ['rock', 'large'], 0.9, 2),
  flora(4, ['stone', 'small'], 0.3, 3), flora(5, ['stone', 'large'], 0.7, 2),
  flora(6, ['stump'], 0.5, 2), flora(7, ['stump', 'square'], 0.5, 2),
  flora(8, ['bush'], 0.7, 4), flora(9, ['bush', 'detailed'], 0.8, 3),
  flora(10, ['flower', 'red'], 0.4, 2), flora(11, ['flower', 'yellow'], 0.4, 2),
  flora(12, ['flower', 'purple'], 0.4, 2), flora(13, ['mushroom'], 0.3, 1),

  // Garden furniture, and the fountain a plaza is built around.
  garden(0, ['fountain', 'centrepiece'], 1),
  garden(1, ['flower'], 3), garden(2, ['flower'], 3), garden(3, ['flower'], 3),
  garden(4, ['grass'], 2), garden(5, ['logs'], 1),
];

/** Everything of one kind that may stand in one place. */
export function assetsFor(kind: AssetKind, habitat: Habitat): Asset[] {
  return CATALOGUE.filter((asset) => asset.kind === kind && asset.habitats.includes(habitat));
}

/**
 * A stable number in [0, 1) from any string.
 *
 * FNV-1a, then two rounds of mixing. The mixing matters: the raw hash of
 * sequential ids like `build:0001` and `build:0002` differs in its low bits
 * only, and a picker taking a modulo of that hands every neighbouring plot the
 * same house.
 */
export function rollOf(seed: string): number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
  state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0;
  return ((state ^ (state >>> 15)) >>> 0) / 4294967296;
}

/**
 * Which asset a thing gets, forever.
 *
 * The seed is whatever identifies the thing in the Kernel - a build id, a tile
 * coordinate - so the answer never changes and never has to be stored. Weighted,
 * so a street is mostly ordinary houses with the occasional tall one rather than
 * an even spread of every model in the catalogue.
 */
export function pick(pool: Asset[], seed: string): Asset | null {
  if (!pool.length) return null;
  const total = pool.reduce((sum, asset) => sum + asset.weight, 0);
  let cursor = rollOf(seed) * total;
  for (const asset of pool) {
    cursor -= asset.weight;
    if (cursor <= 0) return asset;
  }
  return pool[pool.length - 1];
}

/** Which way a thing faces: one of four, from its own id. */
export function facingOf(seed: string): number {
  return Math.floor(rollOf(`${seed}:facing`) * 4) * (Math.PI / 2);
}

/**
 * How likely a tile is to carry a piece of ground detail.
 *
 * Verges get more than open meadow, because a path that has been walked for
 * years gathers things at its edges and the middle of a field does not.
 */
export const DENSITY: Record<Habitat, number> = {
  plot: 0,
  meadow: 0.026,
  verge: 0.07,
  wood: 0.05,
  civic: 0,
};

/** Every distinct file the catalogue refers to, for preloading. */
export function manifest(kind?: AssetKind): string[] {
  const wanted = kind ? CATALOGUE.filter((asset) => asset.kind === kind) : CATALOGUE;
  return [...new Set(wanted.map((asset) => asset.url))];
}
