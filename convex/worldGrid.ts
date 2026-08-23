import { H, W } from './tiledFounding';
import { walkableInWorld, type WorldBounds } from './pathfinding';
import { WORLD_CHUNK_SIZE } from '../shared/wfc';
import { normalizeTiledChunk } from '../shared/tiled-world';
import { EARTHFORGE_ASSETS, earthForgeAssetFor, earthForgeSiteContract } from '../shared/earthforge';
import { encodeChunkRows } from '../shared/voxel';
import { EARTH_MAP } from './earthMapData';

/**
 * Terrain chunks, cached per isolate and keyed by the world's own size.
 *
 * Every chunk carries a thousand tile strings, and the ambient tick loaded
 * ALL of them every five seconds - the read that finally tipped the tick into
 * "too many system operations", freezing the town. Terrain only changes when
 * the world grows, so the key is the boundary itself: a new ring invalidates
 * the cache immediately, and nothing else can go stale. Builds stay live
 * because a house may rise at any moment.
 */
let cachedChunks: { key: string; rows: any[] } | null = null;


/**
 * The terrain letter at any tile, reading the same cached chunks walkability
 * reads.
 *
 * Walkability answers "may a person stand here", which folds terrain and
 * buildings into one boolean and cannot tell water apart from a wall. Placing
 * a block needs to know WHICH, so it can refuse for the honest reason. Sharing
 * the cache rather than opening a second one matters: loading every chunk on
 * every tick is the exact read that once froze the town.
 */
export async function loadTerrainLetters(ctx: any, bounds: WorldBounds) {
  const chunkKey = `${bounds.width}x${bounds.height}`;
  const chunks: any[] = cachedChunks?.key === chunkKey
    ? cachedChunks.rows
    : await ctx.db.query('worldChunks').collect().then((rows: any[]) => {
        cachedChunks = { key: chunkKey, rows };
        return rows;
      });
  // Live expansion chunks win over the bundled base map, the same precedence
  // every renderer applies.
  const overlay = new Map<number, string>();
  for (const chunk of chunks) {
    const layers = chunk.tiled?.layers;
    if (!layers) continue;
    const rows = encodeChunkRows(layers, chunk.size);
    for (let dz = 0; dz < chunk.size; dz++) {
      for (let dx = 0; dx < chunk.size; dx++) {
        overlay.set((chunk.chunkY * chunk.size + dz) * 100_000 + (chunk.chunkX * chunk.size + dx), rows[dz][dx]);
      }
    }
  }
  return (x: number, y: number): string => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= bounds.width || ty >= bounds.height) return '.';
    const live = overlay.get(ty * 100_000 + tx);
    if (live) return live;
    if (ty < EARTH_MAP.height && tx < EARTH_MAP.width) return EARTH_MAP.rows[ty][tx] ?? '.';
    return '.';
  };
}

export async function loadWorldWalkability(ctx: any, bounds: WorldBounds) {
  const chunkKey = `${bounds.width}x${bounds.height}`;
  const [chunks, builds, plots] = await Promise.all([
    cachedChunks?.key === chunkKey
      ? Promise.resolve(cachedChunks.rows)
      : ctx.db.query('worldChunks').collect().then((rows: any[]) => {
          cachedChunks = { key: chunkKey, rows };
          return rows;
        }),
    ctx.db.query('builds').collect(),
    ctx.db.query('plots').collect(),
  ]);
  const chunkMap = new Map(chunks.map((chunk: any) => [`${chunk.chunkX},${chunk.chunkY}`, chunk]));
  const dynamicBlocked = new Set<string>();
  const plotsById = new Map(plots.map((plot: any) => [plot.plotId, plot]));
  for (const build of builds) {
    // Only a structure that actually stands can block a tile. Asking which
    // states DO stand - rather than listing the ones that do not - means the
    // next state added to this enum cannot silently reintroduce this bug, which
    // is exactly how a razed building came to block its own replacement.
    if (build.state !== 'building' && build.state !== 'built') continue;
    if (build.x === undefined || build.y === undefined) continue;
    const explicitAsset = EARTHFORGE_ASSETS[String(build.blueprint?.earthForge?.assetId ?? '')];
    const kind = build.buildId === 'build:earth-bank' ? 'bank' : String(build.blueprint?.kind ?? build.structure);
    const resolved = explicitAsset ? { asset: explicitAsset } : earthForgeAssetFor(kind, build.buildId);
    const plot: any = plotsById.get(build.plotId);
    // A home's site contract is given the whole PARCEL, and lays out the house
    // and its yard inside that: for a three-by-three plot it returns collision
    // on the two north rows and puts the entry on the third. So this already
    // agrees with homeRect - passing homeRect in instead would describe the
    // house as one row shorter than it is drawn, and put a walk-through facade
    // across the back wall of every home in the town.
    const siteWidth = resolved?.asset.kind === 'home' && plot ? plot.w : Number(build.w ?? resolved?.asset.footprint[0] ?? 1);
    const siteHeight = resolved?.asset.kind === 'home' && plot ? plot.h : Number(build.h ?? resolved?.asset.footprint[1] ?? 1);
    const collision = resolved
      ? earthForgeSiteContract(resolved.asset, siteWidth, siteHeight).collision.map(([x, y]) => ({ x, y }))
      : Array.isArray(build.blueprint?.collision) ? build.blueprint.collision : [];
    for (const cell of collision) {
      const x = build.x + Number(cell.x), y = build.y + Number(cell.y);
      if (Number.isInteger(x) && Number.isInteger(y)) dynamicBlocked.add(`${x},${y}`);
    }
  }
  return (x: number, y: number) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= bounds.width || ty >= bounds.height || dynamicBlocked.has(`${tx},${ty}`)) return false;
    if (tx < W && ty < H) return walkableInWorld(tx, ty, bounds);
    const chunkX = Math.floor(tx / WORLD_CHUNK_SIZE), chunkY = Math.floor(ty / WORLD_CHUNK_SIZE);
    const chunk: any = chunkMap.get(`${chunkX},${chunkY}`);
    if (!chunk) return walkableInWorld(tx, ty, bounds);
    const localX = tx - chunkX * chunk.size, localY = ty - chunkY * chunk.size;
    const tiled = normalizeTiledChunk(chunk);
    return tiled.layers.CollisionLayer[localY * chunk.size + localX] === 0;
  };
}
