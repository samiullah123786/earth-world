'use node';
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
      const collapsed = generateWfcChunk({ seed: work.seed, biome: work.biome, boundary: work.boundary });
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
