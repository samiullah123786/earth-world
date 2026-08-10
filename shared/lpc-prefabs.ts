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

function placementKey(assetId: string, xOffset: number, yOffset: number) {
  return `${assetId}@${xOffset},${yOffset}`;
}

// The published earth-skill before this refactor placed the garden bench one
// cell farther east. Accept that exact signed catalog shape and translate it
// to the canonical prefab; arbitrary client-authored placement arrays remain
// rejected. This keeps existing installations compatible without returning
// build authority to clients.
const LEGACY_PLACEMENT_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  community_garden: [
    placementKey('plowed_dirt', 0, 0), placementKey('crop_stage_1', 1, 0),
    placementKey('wooden_fence', 2, 0), placementKey('water_barrel', 0, 1),
    placementKey('crop_stage_2', 1, 1), placementKey('wooden_bench', 2, 1),
  ].sort(),
};

export function matchLegacyPlacements(rawPlacements: unknown): LpcPrefab | null {
  if (!Array.isArray(rawPlacements)) return null;
  const submitted: string[] = [];
  for (const raw of rawPlacements) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const assetId = typeof row.assetId === 'string'
      ? row.assetId
      : typeof row.tile === 'string'
        ? row.tile
        : typeof row.prop === 'string'
          ? row.prop
          : null;
    const xOffset = Number(row.xOffset), yOffset = Number(row.yOffset);
    if (!assetId || !whole(xOffset) || !whole(yOffset)) return null;
    submitted.push(placementKey(assetId, xOffset, yOffset));
  }
  submitted.sort();
  const canonical = Object.values(LPC_PREFABS).find((prefab) => {
    const canonical = prefab.placements.map((placement) => placementKey(placement.assetId, placement.xOffset, placement.yOffset)).sort();
    return canonical.length === submitted.length && canonical.every((key, index) => key === submitted[index]);
  });
  if (canonical) return canonical;
  const alias = Object.entries(LEGACY_PLACEMENT_ALIASES).find(([_prefabId, keys]) =>
    keys.length === submitted.length && keys.every((key, index) => key === submitted[index]));
  return alias ? LPC_PREFABS[alias[0]] ?? null : null;
}
