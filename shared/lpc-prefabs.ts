import catalog from './lpc-prefabs.json';
import { LPC_WORLD_ASSETS, type LpcWorldAssetId } from './lpc-assets';

export type LpcRenderLayer = 'ground' | 'midground' | 'overhead';
export type LpcCell = Readonly<{ x: number; y: number }>;
export type LpcPrefabPlacement = Readonly<{
  assetId: LpcWorldAssetId;
  layer: LpcRenderLayer;
  xOffset: number;
  yOffset: number;
}>;
export type LpcPrefab = Readonly<{
  id: string;
  name: string;
  structureType: string;
  width: number;
  height: number;
  entry: LpcCell;
  collision: ReadonlyArray<LpcCell>;
  placements: ReadonlyArray<LpcPrefabPlacement>;
}>;

const groundAssets = new Set<string>([
  'grass', 'dirt_path', 'cobblestone_road', 'sand', 'water', 'wooden_bridge', 'stairs',
  'plowed_dirt', 'seed_plot', 'crop_seeded', 'crop_stage_1', 'crop_stage_2', 'crop_stage_3',
]);
const overheadAssets = new Set<string>(['roof_tile', 'native_tree']);

export function canonicalRenderLayer(assetId: string): LpcRenderLayer {
  if (groundAssets.has(assetId)) return 'ground';
  if (overheadAssets.has(assetId)) return 'overhead';
  return 'midground';
}

function whole(value: number) {
  return Number.isInteger(value) && value >= 0;
}

export function footprintCells(prefab: Pick<LpcPrefab, 'width' | 'height'>): LpcCell[] {
  return Array.from({ length: prefab.width * prefab.height }, (_unused, index) => ({
    x: index % prefab.width,
    y: Math.floor(index / prefab.width),
  }));
}

export function cellsAreContiguous(cells: ReadonlyArray<LpcCell>): boolean {
  if (!cells.length) return false;
  const keys = new Set(cells.map(({ x, y }) => `${x},${y}`));
  const seen = new Set<string>();
  const queue = [cells[0]];
  while (queue.length) {
    const cell = queue.shift()!;
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key) || !keys.has(key)) continue;
    seen.add(key);
    queue.push({ x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y }, { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 });
  }
  return seen.size === keys.size;
}

export function validatePrefab(prefab: LpcPrefab): LpcPrefab {
  if (!prefab.id || !prefab.name) throw new Error('LPC prefab requires an id and name');
  if (!whole(prefab.width) || !whole(prefab.height) || prefab.width < 1 || prefab.height < 1) {
    throw new Error(`${prefab.id} has an invalid footprint`);
  }
  const cells = footprintCells(prefab);
  if (!cellsAreContiguous(cells)) throw new Error(`${prefab.id} footprint is not contiguous`);
  const inside = ({ x, y }: LpcCell) => whole(x) && whole(y) && x < prefab.width && y < prefab.height;
  if (!inside(prefab.entry)) throw new Error(`${prefab.id} entry is outside its footprint`);
  if (prefab.collision.some((cell) => !inside(cell))) throw new Error(`${prefab.id} collision leaves its footprint`);
  if (prefab.collision.some((cell) => cell.x === prefab.entry.x && cell.y === prefab.entry.y)) {
    throw new Error(`${prefab.id} blocks its own entry`);
  }
  const collisionKeys = prefab.collision.map(({ x, y }) => `${x},${y}`);
  if (new Set(collisionKeys).size !== collisionKeys.length) throw new Error(`${prefab.id} repeats collision cells`);
  for (const placement of prefab.placements) {
    const asset = LPC_WORLD_ASSETS[placement.assetId];
    if (!asset) throw new Error(`${prefab.id} references unknown asset ${placement.assetId}`);
    if (placement.layer !== canonicalRenderLayer(placement.assetId)) {
      throw new Error(`${prefab.id}.${placement.assetId} belongs on ${canonicalRenderLayer(placement.assetId)}`);
    }
    if (!whole(placement.xOffset) || !whole(placement.yOffset)
      || placement.xOffset + asset.width > prefab.width || placement.yOffset + asset.height > prefab.height) {
      throw new Error(`${prefab.id}.${placement.assetId} leaves the prefab footprint`);
    }
  }
  return prefab;
}

export const LPC_PREFABS = Object.fromEntries(
  Object.entries(catalog.prefabs).map(([id, raw]) => [id, validatePrefab(raw as LpcPrefab)]),
) as Readonly<Record<string, LpcPrefab>>;

export type LpcPrefabId = keyof typeof catalog.prefabs;

export function requireLpcPrefab(prefabId: string): LpcPrefab {
  const prefab = LPC_PREFABS[prefabId];
  if (!prefab) throw new Error(`unknown LPC prefab: ${prefabId}`);
  return prefab;
}

const STRUCTURE_PREFABS: Readonly<Record<string, string>> = {
  home: 'house_native_3x3', cottage: 'house_native_3x3', extension: 'house_native_3x3',
  garden: 'garden_native_2x1', community_garden: 'community_garden', farm_plot: 'farm_row',
  bench: 'bench_native_2x1', park: 'park', table: 'meeting_table_3x2', meeting_table: 'meeting_table_3x2',
  training_ground: 'training_green_3x3', plaza: 'plaza_fountain_3x3',
  workshop: 'store_wooden', studio: 'store_wooden', hall: 'store_wooden', art: 'store_wooden',
  laptop: 'store_wooden', industry: 'store_wooden', data_center: 'store_wooden',
  industrial_structure: 'bank_lpc_grand', road_segment: 'bank_forecourt',
};

export function prefabForStructure(structure: string): LpcPrefab {
  return requireLpcPrefab(STRUCTURE_PREFABS[structure] ?? 'store_wooden');
}
