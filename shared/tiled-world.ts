import { wfcRule } from './wfc';

/**
 * The single map wire contract shared by Phaser and the Earth Kernel.
 *
 * GIDs are Tiled global tile IDs. They intentionally match
 * public/assets/maps/agentsearth-v5.tmj; changing a firstgid here without
 * regenerating the TMJ is a schema change, not a visual tweak.
 */
export const TILED_MAP_FORMAT = 'tiled-v1' as const;
export const TILED_MAP_VERSION = 2;
export const TILED_TILE_SIZE = 32;
export const TILED_LAYER_NAMES = ['GroundLayer', 'CollisionLayer', 'OverheadLayer'] as const;
export type TiledLayerName = typeof TILED_LAYER_NAMES[number];

export const TILED_GIDS = {
  grass: 16,            // lpc-grass local tile 15
  dirt: 34,             // lpc-dirt local tile 15
  water: 38,            // lpc-water local tile 1
  cobbleFill: 69,       // fully opaque textured LPC paving; no clipped edge pieces
  treeFirst: 75,
  trunkFirst: 200,
  cropPlowed: 180,
} as const;

export type TiledChunkLayers = Readonly<{
  GroundLayer: number[];
  CollisionLayer: number[];
  OverheadLayer: number[];
}>;

export type TiledChunkPayload = Readonly<{
  format: typeof TILED_MAP_FORMAT;
  version: number;
  width: number;
  height: number;
  layers: TiledChunkLayers;
  objects: ReadonlyArray<TiledSpatialObject>;
}>;

export type TiledSpatialObject = Readonly<{
  id: number;
  name: string;
  type: 'spatial_zone';
  x: number;
  y: number;
  width: number;
  height: number;
  properties: ReadonlyArray<Readonly<{ name: string; type: string; value: string }>>;
}>;

function stableVariant(tileId: string, index: number) {
  let hash = index ^ 0x45d9f3b;
  for (let i = 0; i < tileId.length; i++) hash = Math.imul(hash ^ tileId.charCodeAt(i), 0x45d9f3b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function tiledLayersForWfc(tiles: ReadonlyArray<string>, size: number): TiledChunkLayers {
  if (!Number.isInteger(size) || size < 1 || tiles.length !== size * size) {
    throw new Error('Tiled chunk dimensions must exactly match the collapsed WFC tiles');
  }
  const ground = new Array<number>(tiles.length).fill(TILED_GIDS.grass);
  const collision = new Array<number>(tiles.length).fill(0);
  const overhead = new Array<number>(tiles.length).fill(0);
  for (let index = 0; index < tiles.length; index++) {
    const tileId = tiles[index];
    const rule = wfcRule(tileId);
    if (rule.terrain === 'field') ground[index] = TILED_GIDS.cropPlowed;
    else if (rule.terrain === 'road') ground[index] = TILED_GIDS.cobbleFill;
    else if (rule.terrain === 'water') ground[index] = TILED_GIDS.water;
    else if (rule.terrain === 'shore') ground[index] = TILED_GIDS.dirt;

    if (!rule.walkable) collision[index] = rule.terrain === 'water' ? TILED_GIDS.water
      : rule.terrain === 'shore' ? TILED_GIDS.dirt : TILED_GIDS.grass;
  }

  // A treetop is a 3x3 LPC macro, never a single tile. Greedily stamp only
  // complete groves and leave edge cells as undergrowth; a partial canopy is
  // far more damaging than a slightly open woodland edge.
  const occupied = new Set<number>();
  const treeVariants = [0, 3].map((column) => [
    TILED_GIDS.treeFirst + column + 0, TILED_GIDS.treeFirst + column + 1, TILED_GIDS.treeFirst + column + 2,
    TILED_GIDS.treeFirst + column + 6, TILED_GIDS.treeFirst + column + 7, TILED_GIDS.treeFirst + column + 8,
    TILED_GIDS.treeFirst + column + 12, TILED_GIDS.treeFirst + column + 13, TILED_GIDS.treeFirst + column + 14,
  ]);
  const isForest = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size
    && wfcRule(tiles[y * size + x]).terrain === 'forest';
  for (let y = 0; y <= size - 3; y++) for (let x = 0; x <= size - 3; x++) {
    const cells = Array.from({ length: 9 }, (_unused, offset) => (y + Math.floor(offset / 3)) * size + x + offset % 3);
    if (!cells.every((index) => !occupied.has(index) && isForest(index % size, Math.floor(index / size)))) continue;
    const variant = treeVariants[stableVariant('forest-macro', y * size + x) % treeVariants.length];
    cells.forEach((index, offset) => { overhead[index] = variant[offset]; occupied.add(index); });
    collision[(y + 1) * size + x + 1] = TILED_GIDS.trunkFirst + (variant === treeVariants[0] ? 1 : 4);
    collision[(y + 2) * size + x + 1] = TILED_GIDS.trunkFirst + (variant === treeVariants[0] ? 7 : 10);
  }
  return { GroundLayer: ground, CollisionLayer: collision, OverheadLayer: overhead };
}

export function tiledChunkForWfc(tiles: ReadonlyArray<string>, size: number): TiledChunkPayload {
  return {
    format: TILED_MAP_FORMAT,
    version: TILED_MAP_VERSION,
    width: size,
    height: size,
    layers: tiledLayersForWfc(tiles, size),
    objects: [],
  };
}

export function normalizeTiledChunk(chunk: {
  size: number;
  tiles: ReadonlyArray<string>;
  tiled?: TiledChunkPayload;
}): TiledChunkPayload {
  const candidate = chunk.tiled;
  if (candidate?.format === TILED_MAP_FORMAT
    && candidate.version === TILED_MAP_VERSION
    && candidate.width === chunk.size
    && candidate.height === chunk.size
    && TILED_LAYER_NAMES.every((name) => candidate.layers[name]?.length === chunk.size * chunk.size)) {
    return candidate;
  }
  // Read compatibility for rows created before V5. Every new write persists
  // the native payload; this branch lets a rolling deploy migrate safely.
  return tiledChunkForWfc(chunk.tiles, chunk.size);
}

export function tiledLayerMatrix(data: ReadonlyArray<number>, width: number, height: number): number[][] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) {
    throw new Error('Tiled layer data does not match its declared dimensions');
  }
  return Array.from({ length: height }, (_row, y) => data.slice(y * width, (y + 1) * width));
}

export type SpatialZone = Readonly<{
  zoneId: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}>;

export function intersectingZoneIds(
  position: Readonly<{ x: number; y: number }>,
  zones: ReadonlyArray<SpatialZone>,
): string[] {
  return zones
    .filter((zone) => position.x >= zone.x && position.x < zone.x + zone.w
      && position.y >= zone.y && position.y < zone.y + zone.h)
    .map((zone) => zone.zoneId)
    .sort();
}

export function spatialTransitionKey(agentId: string, zoneId: string, transition: 'enter' | 'exit', at: number) {
  return `${agentId}:${zoneId}:${transition}:${Math.floor(at / 1000)}`;
}
