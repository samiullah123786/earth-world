import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { ensureWorldState } from './planning';
import { normalizeTiledChunk, TILED_MAP_VERSION } from '../shared/tiled-world';
import { EARTHFORGE_SYSTEM, semanticIntent } from '../shared/earthforge';

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
    const needsUpgrade = (chunk: typeof chunks[number]) => !chunk.tiled || chunk.tiled.version !== TILED_MAP_VERSION;
    const pending = chunks.filter(needsUpgrade).slice(0, 16);
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
    const remaining = chunks.filter(needsUpgrade).length - pending.length;
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
      current: chunks.filter((chunk) => chunk.tiled?.version === TILED_MAP_VERSION).length,
      legacy: chunks.filter((chunk) => chunk.tiled?.version !== TILED_MAP_VERSION).length,
    };
  },
});

/**
 * Attach an agent-readable semantic render intent to legacy build rows without
 * rewriting their ownership, history, footprint or source blueprint. The
 * renderer can switch immediately and an older client can still read the LPC
 * fields during a rolling deployment.
 */
export const migrateEarthForgeBuilds = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureWorldState(ctx);
    const builds = await ctx.db.query('builds').collect();
    const pending = builds.filter((build) => {
      const kind = build.buildId === 'build:earth-bank' ? 'bank' : String(build.blueprint?.kind ?? build.structure);
      return build.state !== 'razed' && !build.blueprint?.earthForge && Boolean(semanticIntent(kind, build.buildId));
    }).slice(0, 24);
    for (const build of pending) {
      const kind = build.buildId === 'build:earth-bank' ? 'bank' : String(build.blueprint?.kind ?? build.structure);
      const earthForge = semanticIntent(kind, build.buildId);
      if (!earthForge) continue;
      await ctx.db.patch(build._id, {
        blueprint: { ...(build.blueprint ?? { name: build.structure, kind }), renderSystem: EARTHFORGE_SYSTEM, earthForge },
      });
    }
    const remaining = builds.filter((build) => {
      const kind = build.buildId === 'build:earth-bank' ? 'bank' : String(build.blueprint?.kind ?? build.structure);
      return build.state !== 'razed' && !build.blueprint?.earthForge && Boolean(semanticIntent(kind, build.buildId));
    }).length - pending.length;
    if (remaining > 0) await ctx.scheduler.runAfter(0, (internal as any).migrations.migrateEarthForgeBuilds, {});
    return { migrated: pending.length, remaining: Math.max(0, remaining), system: EARTHFORGE_SYSTEM };
  },
});
