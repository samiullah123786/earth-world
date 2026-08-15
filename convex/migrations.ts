import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { ensureWorldState } from './planning';
import { normalizeTiledChunk, TILED_MAP_VERSION } from '../shared/tiled-world';
import {
  EARTHFORGE_ASSETS, EARTHFORGE_SITE_SYSTEM, EARTHFORGE_SYSTEM, earthForgeAssetFor, earthForgeSiteContract,
  semanticIntentForAsset,
} from '../shared/earthforge';

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
 * Make legacy visual sites authoritative. Early semantic migration attached an
 * image id but left LPC collision behind (or no collision at all), so routes
 * could cross the newly displayed home. Home sites now occupy their full plot;
 * ownership/history stay untouched while visual, collision and entry geometry
 * are made one contract.
 */
export const migrateEarthForgeBuilds = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureWorldState(ctx);
    const [builds, plots] = await Promise.all([
      ctx.db.query('builds').collect(), ctx.db.query('plots').collect(),
    ]);
    const plotsById = new Map(plots.map((plot: any) => [plot.plotId, plot]));
    const upgradeFor = (build: any) => {
      if (build.state === 'razed') return null;
      const kind = build.buildId === 'build:earth-bank' ? 'bank' : String(build.blueprint?.kind ?? build.structure);
      const explicitId = String(build.blueprint?.earthForge?.assetId ?? '');
      const resolved = EARTHFORGE_ASSETS[explicitId]
        ? { id: explicitId, asset: EARTHFORGE_ASSETS[explicitId] }
        : earthForgeAssetFor(kind, build.buildId);
      if (!resolved) return null;
      const plot: any = plotsById.get(build.plotId);
      const homeSite = resolved.asset.kind === 'home' && plot;
      const w = Number(homeSite ? plot.w : build.w ?? resolved.asset.footprint[0]);
      const h = Number(homeSite ? plot.h : build.h ?? resolved.asset.footprint[1]);
      const site = earthForgeSiteContract(resolved.asset, w, h);
      const earthForge = semanticIntentForAsset(resolved.id, build.buildId);
      const blueprint = {
        ...(build.blueprint ?? { name: resolved.asset.name, kind: resolved.asset.kind }),
        w, h, style: EARTHFORGE_SYSTEM, architecture: 'earthforge',
        siteContract: EARTHFORGE_SITE_SYSTEM,
        assetFramework: EARTHFORGE_SYSTEM, renderSystem: EARTHFORGE_SYSTEM, earthForge,
        entry: { x: site.entry[0], y: site.entry[1] },
        collision: site.collision.map(([x, y]) => ({ x, y })),
      };
      const patch = {
        blueprint, w, h,
        ...(homeSite ? { x: plot.x, y: plot.y } : {}),
      };
      const current = build.blueprint ?? {};
      const matches = build.w === w && build.h === h
        && (!homeSite || (build.x === plot.x && build.y === plot.y))
        && current.siteContract === EARTHFORGE_SITE_SYSTEM
        && current.renderSystem === EARTHFORGE_SYSTEM;
      return matches ? null : { build, patch };
    };
    const upgrades = builds.map(upgradeFor).filter(Boolean) as Array<{ build: any; patch: any }>;
    const pending = upgrades.slice(0, 24);
    for (const { build, patch } of pending) await ctx.db.patch(build._id, patch);
    const remaining = upgrades.length - pending.length;
    if (remaining > 0) await ctx.scheduler.runAfter(0, (internal as any).migrations.migrateEarthForgeBuilds, {});
    return { migrated: pending.length, remaining: Math.max(0, remaining), system: EARTHFORGE_SYSTEM };
  },
});
