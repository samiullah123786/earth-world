import { H, W } from './walkable';
import { walkableInWorld, type WorldBounds } from './pathfinding';
import { WORLD_CHUNK_SIZE, wfcRule } from '../shared/wfc';
import { foundingEdgeContinuationBlocked } from '../shared/founding-edge';

export async function loadWorldWalkability(ctx: any, bounds: WorldBounds) {
  const [chunks, builds] = await Promise.all([
    ctx.db.query('worldChunks').collect(),
    ctx.db.query('builds').collect(),
  ]);
  const chunkMap = new Map(chunks.map((chunk: any) => [`${chunk.chunkX},${chunk.chunkY}`, chunk]));
  const dynamicBlocked = new Set<string>();
  for (const build of builds) {
    if (build.state === 'planned' || build.state === 'razed' || build.x === undefined || build.y === undefined) continue;
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
    // Hand-authored canopy/cliff pixels continue over the old southeast
    // border. This fixed boundary mask takes precedence over persisted chunks.
    if (foundingEdgeContinuationBlocked(tx, ty)) return false;
    const chunkX = Math.floor(tx / WORLD_CHUNK_SIZE), chunkY = Math.floor(ty / WORLD_CHUNK_SIZE);
    const chunk: any = chunkMap.get(`${chunkX},${chunkY}`);
    if (!chunk) return walkableInWorld(tx, ty, bounds);
    const localX = tx - chunkX * chunk.size, localY = ty - chunkY * chunk.size;
    const tileId = chunk.tiles[localY * chunk.size + localX];
    return Boolean(tileId && wfcRule(tileId).walkable);
  };
}
