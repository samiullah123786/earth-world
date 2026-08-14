'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { generateWfcChunk } from '../shared/wfc';

/**
 * Lay a whole ring, chunk by chunk, from an action.
 *
 * Actions get minutes; mutations get one second. Terrain collapse is pure
 * computation, so it belongs here - the Kernel is asked only for the boundary
 * each chunk must match, and handed the finished tiles to store. A failure
 * anywhere simply leaves the ring pending, and the next run resumes it.
 */
export const layRing = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; laid: number; committed?: boolean }> => {
    let laid = 0;
    for (let step = 0; step < 40; step++) {
      const work: any = await ctx.runQuery(internal.kernel.expansionWork, {});
      if (!work.pending) return { ok: true, laid };
      if (work.ready) {
        const finished: any = await ctx.runMutation(internal.kernel.expansionCommit, {});
        return { ok: true, laid, committed: Boolean(finished.committed) };
      }
      const collapsed = generateWfcChunk({
        seed: work.seed, biome: work.biome, boundary: work.boundary,
        wetness: work.wetness, woodedness: work.woodedness, avenues: work.avenues,
        origin: work.origin,
      });
      await ctx.runMutation(internal.kernel.expansionStore, {
        chunk: {
          chunkId: `chunk:${work.coordinate.chunkX}:${work.coordinate.chunkY}`,
          chunkX: work.coordinate.chunkX, chunkY: work.coordinate.chunkY,
          size: collapsed.tiles.length ? Math.sqrt(collapsed.tiles.length) : 16,
          biome: work.biome, generation: work.generation, seed: work.seed,
          tiles: collapsed.tiles, edges: collapsed.edges,
        },
      });
      laid += 1;
    }
    return { ok: true, laid };
  },
});

/**
 * Re-lay terrain that has already been generated.
 *
 * Fixing the generator only helps land nobody has seen yet; the rings already
 * standing keep whatever the old rules gave them. This walks the existing
 * chunks in the same order the planner lays a ring - north and west first, so
 * every chunk is conditioned on neighbours that have already been re-laid -
 * and rewrites each one under the current rules.
 *
 * Owned ground is pinned clear before the collapse, so no house ends up in a
 * lake and no claimed plot ends up in a wood. A chunk that cannot be re-laid
 * for any reason is left exactly as it was rather than half-written.
 */
export const relayTerrain = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ ok: boolean; relaid: number; skipped: string[] }> => {
    const plan: any = await ctx.runQuery(internal.kernel.relayPlan, {});
    const skipped: string[] = [];
    let relaid = 0;
    for (const coordinate of plan.coordinates.slice(0, limit ?? plan.coordinates.length)) {
      const work: any = await ctx.runQuery(internal.kernel.relayWork, { chunkX: coordinate.chunkX, chunkY: coordinate.chunkY });
      if (!work.found) continue;
      try {
        const collapsed = generateWfcChunk({
          seed: work.seed, biome: work.biome, boundary: work.boundary,
          wetness: work.wetness, woodedness: work.woodedness, avenues: work.avenues,
          origin: work.origin, keepClear: work.keepClear,
        });
        await ctx.runMutation(internal.kernel.relayStore, {
          chunkX: coordinate.chunkX, chunkY: coordinate.chunkY,
          biome: work.biome, tiles: collapsed.tiles, edges: collapsed.edges,
        });
        relaid += 1;
      } catch (error) {
        skipped.push(`${coordinate.chunkX},${coordinate.chunkY}: ${(error as Error).message}`);
      }
    }
    return { ok: true, relaid, skipped };
  },
});
