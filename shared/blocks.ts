/**
 * Building with your own hands, paid for in Earth Tokens.
 *
 * Earth already had a build system: propose a structure, your owner consents,
 * the Build Inspector reviews it, the Treasury takes a fee, and a scaffold goes
 * up over real construction time. That is right for a HOUSE. It is absurd for a
 * fence post.
 *
 * So this is the other half: a citizen - or the human holding their wheel -
 * placing single blocks on their own land, immediately, one at a time, paying
 * for each one out of their own purse. Tokens stop being a scoreboard and start
 * being the thing you spend to change the world, which is what the whole
 * economy was for.
 *
 * The reason this needs a rulebook at all is that a world anyone can build in
 * degrades by default. Not through malice - through a thousand small
 * reasonable-at-the-time decisions. One floating cube, one tower that dwarfs
 * the town hall, one wall across somebody's front door, and the place stops
 * looking like somewhere people live. Every rule below exists to stop one
 * specific way that happens, and each one is stated as a refusal a citizen can
 * read and understand.
 *
 * What is deliberately NOT here: no way to build on land you do not hold, no
 * way to reach public ground (that is what civic approval is for), and no
 * refund on removal. A refund would make place-and-remove a free action, and a
 * free action is one a loop will take a million times.
 */

/** The materials Earth will let a citizen place, and what each one costs. */
export const BLOCK_PALETTE = {
  plank:   { price: 4,  label: 'Timber plank',  hard: true },
  stone:   { price: 6,  label: 'Cut stone',     hard: true },
  brick:   { price: 8,  label: 'Clay brick',    hard: true },
  glass:   { price: 12, label: 'Glass pane',    hard: true },
  thatch:  { price: 3,  label: 'Thatch',        hard: true },
  lantern: { price: 20, label: 'Lantern',       hard: false },
  flowers: { price: 2,  label: 'Flower box',    hard: false },
  path:    { price: 2,  label: 'Paving',        hard: false },
} as const;

export type BlockMaterial = keyof typeof BLOCK_PALETTE;

/** Is this a material Earth recognises? Never trust the word on the wire. */
export function isBlockMaterial(value: unknown): value is BlockMaterial {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BLOCK_PALETTE, value);
}

export function blockCost(kind: BlockMaterial): number {
  return BLOCK_PALETTE[kind].price;
}

/**
 * How high a citizen may stack their own blocks.
 *
 * Four, because the civic buildings crown at roughly five and a town where
 * anybody can out-build the town hall reads as a junkyard rather than a place
 * with a centre. This is an aesthetic law, and it is enforced like any other.
 */
export const BLOCK_HEIGHT_CAP = 4;

/** What the Kernel knows about one tile, reduced to what building cares about. */
export type TileFacts = {
  /** Does the builder hold the plot this tile sits on? */
  ownPlot: boolean;
  /** Shared ground: roads belong to everyone, so nobody may narrow one. */
  road: boolean;
  /** Ground a person could stand on. Water, trees and the void are not. */
  standable: boolean;
  /** A doorway or the tile in front of one. These stay open, always. */
  reserved: boolean;
  /** A standing structure already occupies this tile. */
  structure: boolean;
  /** How many citizen-placed blocks are already stacked here. */
  stack: number;
};

export type Verdict = { ok: true; cost: number } | { ok: false; why: string };

/**
 * May this block be placed?
 *
 * Ordered so the most useful refusal comes first: a builder who is standing
 * somewhere they may not build should be told that, not told they are poor.
 */
export function placementVerdict(
  kind: unknown,
  level: unknown,
  tile: TileFacts,
  balance: number,
): Verdict {
  if (!isBlockMaterial(kind)) return { ok: false, why: 'Earth has no such material' };
  if (!Number.isInteger(level)) return { ok: false, why: 'a block sits on a whole level' };
  const height = level as number;

  if (!tile.ownPlot) return { ok: false, why: 'you may only build on land you hold' };
  if (tile.road) return { ok: false, why: 'the road belongs to everyone and stays clear' };
  if (!tile.standable) return { ok: false, why: 'there is no ground to build on here' };
  if (tile.reserved) return { ok: false, why: 'a doorway has to stay open' };
  if (tile.structure) return { ok: false, why: 'a building already stands here' };

  // Every block rests on the ground or on the block below it. This single rule
  // is what keeps a built world from filling up with cubes hanging in the air.
  if (height !== tile.stack + 1) {
    return tile.stack === 0
      ? { ok: false, why: 'the first block of a column sits on the ground' }
      : { ok: false, why: `this column is ${tile.stack} high, so the next block goes at ${tile.stack + 1}` };
  }
  if (height > BLOCK_HEIGHT_CAP) {
    return { ok: false, why: `nothing a citizen builds rises above ${BLOCK_HEIGHT_CAP} blocks` };
  }

  const cost = blockCost(kind);
  if (balance < cost) {
    return { ok: false, why: `${BLOCK_PALETTE[kind].label} costs ${cost} Earth Tokens and you hold ${balance}` };
  }
  return { ok: true, cost };
}

/**
 * May this block be taken back down?
 *
 * Only the top of a column, and only your own, so removing never leaves a
 * floating remainder - the same rule as placing, read backwards.
 */
export function removalVerdict(
  level: unknown,
  tile: Pick<TileFacts, 'ownPlot' | 'stack'>,
): { ok: true } | { ok: false; why: string } {
  if (!Number.isInteger(level)) return { ok: false, why: 'a block sits on a whole level' };
  if (!tile.ownPlot) return { ok: false, why: 'you may only unbuild on land you hold' };
  if (tile.stack === 0) return { ok: false, why: 'there is nothing here to take down' };
  if (level !== tile.stack) return { ok: false, why: 'take the top block first, or the rest would hang in the air' };
  return { ok: true };
}

/**
 * Does a block at this height stop a walker?
 *
 * Lanterns, flower boxes and paving are things you walk past and over. Walls
 * are not. The renderer and the pathfinder both need one answer to this, so it
 * lives here rather than being decided twice.
 */
export function blocksWalking(kind: BlockMaterial): boolean {
  return BLOCK_PALETTE[kind].hard;
}
