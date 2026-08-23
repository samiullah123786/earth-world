/**
 * Building by hand, on the Kernel side.
 *
 * Two very different callers reach this code: an autonomous agent deciding to
 * lay a block, and a human holding that agent's wheel and clicking on the
 * ground. They must obey exactly the same rules, because the entire premise of
 * takeover is that possession changes who decides the next act and never which
 * acts are legal. So the rules live here, once, and both paths call in.
 *
 * The rulebook itself is pure and lives in shared/blocks.ts, tested without a
 * world running. This module is only the part that has to ask the database.
 */

import { BLOCK_PALETTE, type BlockMaterial, placementVerdict, removalVerdict } from '../shared/blocks';
import { loadTerrainLetters } from './worldGrid';
import { balanceOf, payToTreasury } from './economy';
import { ensureWorldState } from './planning';

/**
 * How far a citizen can reach to set a block down.
 *
 * Five tiles, so building feels like building rather than like editing a
 * spreadsheet of the world from wherever you happen to be standing. It is what
 * makes hand-building physical: to change somewhere, you go there.
 */
export const BUILD_REACH = 5;

/** Ground a citizen could set a block on. Water, trees and the void are not. */
const BUILDABLE_LETTERS = new Set(['g', 'd', 'c', 'u']);

/**
 * Everything the building rulebook needs to know about one tile.
 */
export async function tileFactsFor(
  ctx: any, agentId: string, x: number, y: number,
  bounds: { width: number; height: number },
) {
  const [plots, builds, column, letterAt] = await Promise.all([
    ctx.db.query('plots').collect(),
    ctx.db.query('builds').collect(),
    ctx.db.query('placedBlocks').withIndex('column', (q: any) => q.eq('x', x).eq('y', y)).collect(),
    loadTerrainLetters(ctx, bounds),
  ]);
  const plot = plots.find((row: any) =>
    x >= row.x && x < row.x + row.w && y >= row.y && y < row.y + row.h);
  const letter = letterAt(x, y);
  const standing = builds.filter((build: any) =>
    (build.state === 'built' || build.state === 'building') && typeof build.x === 'number');
  const structure = standing.some((build: any) =>
    x >= build.x && x < build.x + (build.w ?? 1) && y >= build.y && y < build.y + (build.h ?? 1));

  // Doorways stay open. Both the threshold itself and the tile you step
  // through it from, because sealing either one entombs whoever lives there -
  // which is not hypothetical: the Mason was once walled into his own build
  // site by a structure that completed on his tile.
  let reserved = false;
  for (const build of standing) {
    const entry = build.blueprint?.entry;
    const ex = build.x + Number(entry?.x ?? Math.floor((build.w ?? 1) / 2));
    const ey = build.y + Number(entry?.y ?? Math.max(0, (build.h ?? 1) - 1));
    if (x === ex && (y === ey || y === ey + 1)) { reserved = true; break; }
  }

  return {
    plot,
    column,
    facts: {
      ownPlot: Boolean(plot && plot.ownerAgentId === agentId),
      road: letter === 'r',
      // A structure standing here proves the ground under it is buildable, so
      // the refusal comes from the structure rule and reads honestly.
      standable: structure || BUILDABLE_LETTERS.has(letter),
      reserved,
      structure,
      stack: column.length,
    },
  };
}

/** The shared preamble: the world's size, and whether this tile is reachable. */
async function approach(ctx: any, citizen: any, x: number, y: number) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('a block sits on a whole tile');
  const world = await ensureWorldState(ctx);
  const bounds = { width: world.width, height: world.height };
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
    throw new Error('that is beyond the edge of the world');
  }
  // Where the body actually is right now, not where its route ends.
  const now = Date.now();
  const span = Math.max(1, (citizen.t1 ?? now) - (citizen.t0 ?? now));
  const progress = Math.min(1, Math.max(0, (now - (citizen.t0 ?? now)) / span));
  const at = {
    x: (citizen.fx ?? citizen.tx) + ((citizen.tx - (citizen.fx ?? citizen.tx)) * progress),
    y: (citizen.fy ?? citizen.ty) + ((citizen.ty - (citizen.fy ?? citizen.ty)) * progress),
  };
  if (Math.hypot(at.x - x, at.y - y) > BUILD_REACH) {
    throw new Error(`walk closer; you can build within ${BUILD_REACH} tiles of where you stand`);
  }
  return bounds;
}

/**
 * Set one block down, paid for out of the citizen's own purse.
 *
 * `sourceId` is the caller's idempotency key. Both call sites pass something
 * the world already refuses to replay - a signed act's nonce, or the tile and
 * the moment for a click - so one intent can never pay twice.
 */
export async function placeBlock(
  ctx: any, citizen: any,
  input: { x: number; y: number; level: number; kind: unknown },
  sourceId: string,
) {
  const { x, y, level } = input;
  const agentId = citizen.agentId;
  const bounds = await approach(ctx, citizen, x, y);
  const { plot, facts } = await tileFactsFor(ctx, agentId, x, y, bounds);
  const balance = await balanceOf(ctx, agentId);
  const verdict = placementVerdict(input.kind, level, facts, balance);
  if (!verdict.ok) throw new Error(verdict.why);
  const material = BLOCK_PALETTE[input.kind as BlockMaterial];

  await payToTreasury(ctx, {
    fromAgentId: agentId, amount: verdict.cost, kind: 'build_fee',
    reason: `${citizen.name} placed ${material.label} at (${x}, ${y}).`,
    sourceId,
  });
  await ctx.db.insert('placedBlocks', {
    x, y, level, kind: String(input.kind), plotId: plot.plotId, ownerAgentId: agentId,
    paid: verdict.cost, placedAt: Date.now(),
  });
  await ctx.db.patch(citizen._id, { activity: `laying ${material.label.toLowerCase()}` });
  return {
    ok: true as const, placed: { x, y, level, kind: input.kind },
    paid: verdict.cost, balance: balance - verdict.cost,
  };
}

/**
 * Take one block back down. Nothing is refunded.
 *
 * A place-and-remove that paid back would be a free action, and a free action
 * is one a loop takes a million times.
 */
export async function removeBlock(
  ctx: any, citizen: any, input: { x: number; y: number; level: number },
) {
  const { x, y, level } = input;
  const bounds = await approach(ctx, citizen, x, y);
  const { column, facts } = await tileFactsFor(ctx, citizen.agentId, x, y, bounds);
  const verdict = removalVerdict(level, facts);
  if (!verdict.ok) throw new Error(verdict.why);
  const top = column.find((row: any) => row.level === level);
  if (!top) throw new Error('there is nothing here to take down');
  // Whoever holds the land clears the land, including blocks a previous holder
  // left behind - it is their parcel now.
  await ctx.db.delete(top._id);
  await ctx.db.patch(citizen._id, { activity: 'clearing blocks by hand' });
  return { ok: true as const, removed: { x, y, level, kind: top.kind }, refunded: 0 };
}
