import type { EarthForgeAsset, EarthForgeVisualPass } from '../../shared/earthforge';
import { assertTileInteger, tileOrigin } from './grid';
import { semanticStructureDepth, type WorldRenderLayer } from './layering';

export type EarthForgeRenderPass = Readonly<{
  pass: EarthForgeVisualPass;
  textureKey: string;
  image: string;
  layer: WorldRenderLayer;
  x: number;
  y: number;
  origin: readonly [number, number];
  displaySize: number;
  depth: number;
  blend: 'normal' | 'add';
}>;

export function earthForgeTextureKey(assetId: string, pass: EarthForgeVisualPass) {
  if (!/^[a-z0-9_]+$/.test(assetId)) throw new Error('EarthForge asset ids must be canonical slugs');
  return `earthforge-${assetId}-${pass}`;
}

/**
 * Convert a canonical visual bundle into Phaser placements. Every square pass
 * shares the same display size and scale, so the approved silhouette cannot
 * stretch or drift while Phaser downsamples it with linear filtering.
 */
export function earthForgeRenderPlan(
  assetId: string,
  asset: EarthForgeAsset,
  originX: number,
  originY: number,
  logicalWidth = asset.footprint[0],
  logicalHeight = asset.footprint[1],
  displayTiles = logicalWidth + 1,
): readonly EarthForgeRenderPass[] {
  const x = tileOrigin(assertTileInteger(originX, 'EarthForge origin x'))
    + Math.round(assertTileInteger(logicalWidth, 'EarthForge logical width') * 32 / 2);
  const y = tileOrigin(assertTileInteger(originY, 'EarthForge origin y')
    + assertTileInteger(logicalHeight, 'EarthForge logical height'));
  const displaySize = assertTileInteger(displayTiles, 'EarthForge display tile span') * 32;
  const placement = { x, y, origin: asset.anchor, displaySize } as const;
  // Migrated founding records retain smaller proven footprints. Clamp the
  // canonical entry row to their south edge so a 3x3 home cannot sort as if
  // its doorway were two rows beyond the stored building.
  const effectiveSortRow = Math.min(asset.layers.sortRow, Math.max(0, logicalHeight - 1));
  const facadeDepth = semanticStructureDepth(originY, effectiveSortRow + 1);
  return [
    { pass: 'ground', textureKey: earthForgeTextureKey(assetId, 'ground'), image: asset.layers.ground,
      layer: 'ground', ...placement, depth: 0, blend: 'normal' },
    { pass: 'midground', textureKey: earthForgeTextureKey(assetId, 'midground'), image: asset.layers.midground,
      layer: 'midground', ...placement, depth: facadeDepth, blend: 'normal' },
    { pass: 'overhead', textureKey: earthForgeTextureKey(assetId, 'overhead'), image: asset.layers.overhead,
      layer: 'overhead', ...placement, depth: 0, blend: 'normal' },
    { pass: 'emissive', textureKey: earthForgeTextureKey(assetId, 'emissive'), image: asset.layers.emissive,
      layer: 'overhead', ...placement, depth: 1, blend: 'add' },
  ] as const;
}
