import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { ensureWorldState } from './planning';
import { normalizeTiledChunk } from '../shared/tiled-world';

/**
 * Rolling V5 migration. Old WFC rows stay readable during deployment, then
 * gain their native Tiled payload in bounded batches. No map reset and no
 * partial world-state rewrite is required.
 */
export const migrateTiledChunks = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureWorldState(ctx);
    const chunks = await ctx.db.query('worldChunks').collect();
    const pending = chunks.filter((chunk) => !chunk.tiled).slice(0, 16);
    for (const chunk of pending) {
      const normalized = normalizeTiledChunk(chunk as any);
      await ctx.db.patch(chunk._id, { tiled: {
        ...normalized,
        layers: {
          GroundLayer: [...normalized.layers.GroundLayer],
          CollisionLayer: [...normalized.layers.CollisionLayer],
          OverheadLayer: [...normalized.layers.OverheadLayer],
        },
        objects: [...normalized.objects],
      } });
    }
    const remaining = chunks.filter((chunk) => !chunk.tiled).length - pending.length;
    if (remaining > 0) {
      await ctx.scheduler.runAfter(0, (internal as any).migrations.migrateTiledChunks, {});
    }
    return { migrated: pending.length, remaining: Math.max(0, remaining) };
  },
});

export const tiledMigrationStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const chunks = await ctx.db.query('worldChunks').collect();
    return {
      total: chunks.length,
      tiled: chunks.filter((chunk) => Boolean(chunk.tiled)).length,
      legacy: chunks.filter((chunk) => !chunk.tiled).length,
    };
  },
});
