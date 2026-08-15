import rawCatalog from './earthforge-catalog.json';

export const EARTHFORGE_SYSTEM = 'earthforge-semantic-v1' as const;
export const EARTHFORGE_VISUAL_SYSTEM = 'earthforge-pixel-habitat-v2' as const;

export type EarthForgeAsset = Readonly<{
  kind: string;
  name: string;
  image: string;
  footprint: readonly [number, number];
  entry: readonly [number, number];
  anchor: readonly [number, number];
  collision: ReadonlyArray<readonly [number, number]>;
  features: ReadonlyArray<string>;
}>;

export type EarthForgeIntent = Readonly<{
  system: typeof EARTHFORGE_SYSTEM;
  assetId: string;
  purpose: string;
  architecturalFamily: string;
  entrance: 'south';
  features: ReadonlyArray<string>;
  seed: number;
}>;

export type EarthForgeTerrainAsset = Readonly<{
  name: string;
  image: string;
  tileset: readonly [number, number];
  layer: 'ground' | 'collision' | 'overhead';
  features: ReadonlyArray<string>;
}>;

export type EarthForgePropAsset = Readonly<{
  name: string;
  image: string;
  footprint: readonly [number, number];
  layer: 'midground';
  features: ReadonlyArray<string>;
}>;

const catalog = rawCatalog as unknown as {
  version: number;
  system: string;
  visualSystem: string;
  assets: Record<string, EarthForgeAsset>;
  terrain: Record<string, EarthForgeTerrainAsset>;
  props: Record<string, EarthForgePropAsset>;
  kindMap: Record<string, string[]>;
};

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function validateAsset(id: string, asset: EarthForgeAsset) {
  const [width, height] = asset.footprint;
  if (!id || !asset.image.startsWith('/assets/earthforge/')) throw new Error(`${id} has an invalid EarthForge image`);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) throw new Error(`${id} has an invalid footprint`);
  if (asset.entry[0] < 0 || asset.entry[0] >= width || asset.entry[1] < 0 || asset.entry[1] >= height) throw new Error(`${id} entry leaves footprint`);
  if (asset.collision.some(([x, y]) => x < 0 || y < 0 || x >= width || y >= height)) throw new Error(`${id} collision leaves footprint`);
  if (asset.collision.some(([x, y]) => x === asset.entry[0] && y === asset.entry[1])) throw new Error(`${id} blocks its entrance`);
  if (!asset.features.length) throw new Error(`${id} needs semantic features`);
  return asset;
}

export const EARTHFORGE_ASSETS = Object.freeze(Object.fromEntries(
  Object.entries(catalog.assets).map(([id, asset]) => [id, validateAsset(id, asset)]),
));

export const EARTHFORGE_TERRAIN = Object.freeze(catalog.terrain);
export const EARTHFORGE_PROPS = Object.freeze(catalog.props);

export function earthForgeAssetFor(kind: string, stableId: string): { id: string; asset: EarthForgeAsset } | undefined {
  const choices = catalog.kindMap[kind] ?? [];
  if (!choices.length) return undefined;
  const id = choices[stableHash(stableId) % choices.length];
  const asset = EARTHFORGE_ASSETS[id];
  return asset ? { id, asset } : undefined;
}

export function semanticIntent(kind: string, stableId: string): EarthForgeIntent | undefined {
  const resolved = earthForgeAssetFor(kind, stableId);
  if (!resolved) return undefined;
  return semanticIntentForAsset(resolved.id, stableId);
}

export function semanticIntentForAsset(assetId: string, stableId: string): EarthForgeIntent | undefined {
  const asset = EARTHFORGE_ASSETS[assetId];
  if (!asset) return undefined;
  return {
    system: EARTHFORGE_SYSTEM,
    assetId,
    purpose: asset.kind,
    architecturalFamily: assetId,
    entrance: 'south',
    features: asset.features,
    seed: stableHash(stableId),
  };
}

export function assertEarthForgeCatalog() {
  if (catalog.system !== EARTHFORGE_SYSTEM || catalog.visualSystem !== EARTHFORGE_VISUAL_SYSTEM || catalog.version !== 1) {
    throw new Error('unsupported EarthForge catalog');
  }
  for (const [id, asset] of [...Object.entries(EARTHFORGE_TERRAIN), ...Object.entries(EARTHFORGE_PROPS)]) {
    if (!id || !asset.image.startsWith('/assets/earthforge/') || !asset.features.length) {
      throw new Error(`${id} has an invalid EarthForge world asset`);
    }
  }
  for (const [kind, ids] of Object.entries(catalog.kindMap)) {
    if (!ids.length || ids.some((id) => !EARTHFORGE_ASSETS[id])) throw new Error(`${kind} maps to an unknown EarthForge asset`);
  }
  return true;
}
