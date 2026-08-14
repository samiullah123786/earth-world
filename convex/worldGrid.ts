import { H, W } from './tiledFounding';
import { walkableInWorld, type WorldBounds } from './pathfinding';
import { WORLD_CHUNK_SIZE } from '../shared/wfc';
import { normalizeTiledChunk } from '../shared/tiled-world';

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

export async function loadWorldWalkability(ctx: any, bounds: WorldBounds) {
  const chunkKey = `${bounds.width}x${bounds.height}`;
  const [chunks, builds] = await Promise.all([
    cachedChunks?.key === chunkKey
      ? Promise.resolve(cachedChunks.rows)
      : ctx.db.query('worldChunks').collect().then((rows: any[]) => {
          cachedChunks = { key: chunkKey, rows };
          return rows;
        }),
    ctx.db.query('builds').collect(),
  ]);
  const chunkMap = new Map(chunks.map((chunk: any) => [`${chunk.chunkX},${chunk.chunkY}`, chunk]));
  const dynamicBlocked = new Set<string>();
  for (const build of builds) {
    // Only a structure that actually stands can block a tile. Asking which
    // states DO stand - rather than listing the ones that do not - means the
    // next state added to this enum cannot silently reintroduce this bug, which
    // is exactly how a razed building came to block its own replacement.
    if (build.state !== 'building' && build.state !== 'built') continue;
    if (build.x === undefined || build.y === undefined) continue;
    const collision = Array.isArray(build.blueprint?.collision) ? build.blueprint.collision : [];
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
