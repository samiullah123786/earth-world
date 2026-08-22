import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { ensureWorldState } from './planning';
import { normalizeTiledChunk, TILED_MAP_VERSION } from '../shared/tiled-world';
import { homeRect, overlaps, placeOnPlot } from '../shared/homestead';
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

/**
 * Re-lay every homestead that overlaps itself.
 *
 * The fix in shared/homestead.ts stops NEW builds colliding; it does nothing
 * for the nineteen overlapping pairs already standing, where a garden and a
 * bench sat inside the home they belong to because every structure was placed
 * at the plot's own corner.
 *
 * This walks each plot, gives the dwelling the plot less its yard, and hands
 * every other structure a free rectangle - oldest first, so the arrangement a
 * citizen has lived with the longest is the one that keeps its place. Nothing
 * is deleted and no owner loses a structure: only footprints move, and only
 * within ground that citizen already owns.
 */
export const relayHomesteads = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const plots = await ctx.db.query('plots').collect();
    let inspected = 0, moved = 0, stuck = 0;
    const changes: Array<{ buildId: string; from: string; to: string }> = [];

    for (const plot of plots) {
      if (!plot.ownerAgentId) continue;
      const builds = (await ctx.db.query('builds')
        .withIndex('plotId', (q) => q.eq('plotId', plot.plotId)).collect())
        .filter((build) => build.state !== 'razed' && typeof build.x === 'number')
        .sort((left, right) => left.createdAt - right.createdAt);
      if (builds.length < 2) continue;
      inspected += builds.length;

      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const build of builds) {
        const kind = build.blueprint?.kind ?? build.structure;
        const isHome = kind === 'home';
        const want = isHome
          ? homeRect(plot)
          : placeOnPlot(plot, build.structure, { w: build.w ?? 1, h: build.h ?? 1 }, placed);
        if (!want) {
          // Nowhere legal to stand: the parcel is genuinely full. Leaving the
          // structure where it is beats moving it somewhere worse, and
          // deleting somebody's building is never this migration's call - so
          // it goes to the Build Inspector as care work, which is exactly the
          // path this world already has for "something on the map is wrong".
          stuck += 1;
          placed.push({ x: build.x!, y: build.y!, w: build.w ?? 1, h: build.h ?? 1 });
          if (!dryRun) {
            const ticketId = `ticket:overlap-${build.buildId.replace(/^build:/, '')}`;
            const already = await ctx.db.query('careTickets')
              .withIndex('ticketId', (q) => q.eq('ticketId', ticketId)).first();
            if (!already) {
              await ctx.db.insert('careTickets', {
                ticketId, reporterId: 'kernel:land-registry', category: 'build',
                x: build.x!, y: build.y!,
                summary: `${build.structure} on ${plot.plotId} stands on other structures and the parcel `
                  + 'has no free ground left. It needs razing, resizing, or a larger plot - '
                  + 'the land registry will not move or delete a building on its own.',
                state: 'open', createdAt: Date.now(), updatedAt: Date.now(),
              });
            }
          }
          continue;
        }
        const same = build.x === want.x && build.y === want.y
          && (build.w ?? 1) === want.w && (build.h ?? 1) === want.h;
        if (!same) {
          changes.push({
            buildId: build.buildId,
            from: `${build.x},${build.y} ${build.w}x${build.h}`,
            to: `${want.x},${want.y} ${want.w}x${want.h}`,
          });
          if (!dryRun) {
            const blueprint = build.blueprint
              ? {
                ...build.blueprint,
                offsetX: want.x - plot.x, offsetY: want.y - plot.y,
                w: want.w, h: want.h,
              }
              : build.blueprint;
            await ctx.db.patch(build._id, {
              x: want.x, y: want.y, w: want.w, h: want.h, blueprint,
            });
          }
          moved += 1;
        }
        placed.push(want);
      }
    }

    // Prove the outcome rather than asserting it: count what still overlaps.
    const after = (await ctx.db.query('builds').collect())
      .filter((build) => build.state !== 'razed' && typeof build.x === 'number')
      .map((build) => ({ x: build.x!, y: build.y!, w: build.w ?? 1, h: build.h ?? 1 }));
    let remaining = 0;
    for (let i = 0; i < after.length; i++) {
      for (let j = i + 1; j < after.length; j++) if (overlaps(after[i], after[j])) remaining += 1;
    }
    return { ok: true, dryRun: Boolean(dryRun), inspected, moved, stuck, remaining, changes: changes.slice(0, 12) };
  },
});
