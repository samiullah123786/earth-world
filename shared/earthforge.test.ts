import { describe, expect, it } from 'vitest';
import { assertEarthForgeCatalog, EARTHFORGE_ASSETS, EARTHFORGE_COMPILER_SYSTEM, EARTHFORGE_PROPS, EARTHFORGE_SYSTEM, EARTHFORGE_TERRAIN, EARTHFORGE_VISUAL_SYSTEM, earthForgeAssetFor, semanticIntent, semanticIntentForAsset } from './earthforge';

describe('EarthForge semantic catalog', () => {
  it('is internally valid and purpose-specific', () => {
    expect(assertEarthForgeCatalog()).toBe(true);
    expect(earthForgeAssetFor('bank', 'build:earth-bank')?.id).toBe('bank_rotunda');
    expect(earthForgeAssetFor('home', 'build:earth-bank')?.id).not.toBe('bank_rotunda');
    expect(earthForgeAssetFor('data_center', 'build:data')?.id).toBe('data_center');
  });

  it('publishes one agent-readable visual system for the complete habitat', () => {
    expect(EARTHFORGE_VISUAL_SYSTEM).toBe('earthforge-layered-habitat-v3');
    expect(Object.keys(EARTHFORGE_TERRAIN)).toEqual(expect.arrayContaining([
      'meadow', 'soil', 'water', 'stone_path', 'tree_canopy', 'tree_trunk', 'structure_tiles', 'bridge', 'crops',
    ]));
    expect(Object.keys(EARTHFORGE_PROPS)).toEqual(expect.arrayContaining(['rock_cluster', 'orchard_tree', 'log_pile']));
  });

  it('varies homes deterministically without changing purpose', () => {
    const ids = new Set(Array.from({ length: 24 }, (_, index) => earthForgeAssetFor('home', `home:${index}`)?.id));
    expect(ids).toEqual(new Set(['home_courtyard', 'home_orchard', 'home_timber']));
    expect(earthForgeAssetFor('home', 'home:7')).toEqual(earthForgeAssetFor('home', 'home:7'));
  });

  it('emits agent-readable intent rather than tile coordinates', () => {
    const intent = semanticIntent('workshop', 'build:maker');
    expect(intent).toMatchObject({ system: EARTHFORGE_SYSTEM, purpose: 'workshop', entrance: 'south' });
    expect(intent?.features).toContain('wide-doors');
    expect('placements' in (intent ?? {})).toBe(false);
  });

  it('preserves an explicitly selected authored variant', () => {
    expect(semanticIntentForAsset('home_orchard', 'agent:gardener')).toMatchObject({
      assetId: 'home_orchard', purpose: 'home', system: EARTHFORGE_SYSTEM,
    });
  });

  it('keeps entries clear and all collisions inside footprints', () => {
    for (const asset of Object.values(EARTHFORGE_ASSETS)) {
      const [width, height] = asset.footprint;
      expect(asset.collision.every(([x, y]) => x >= 0 && y >= 0 && x < width && y < height)).toBe(true);
      expect(asset.collision).not.toContainEqual(asset.entry);
    }
  });

  it('publishes native-size layer bundles instead of one sortable square', () => {
    for (const asset of Object.values(EARTHFORGE_ASSETS)) {
      expect(asset.layers.compiler).toBe(EARTHFORGE_COMPILER_SYSTEM);
      expect(asset.layers.pixelSize.every((value) => value % 32 === 0)).toBe(true);
      expect(asset.layers.tileOffset.every(Number.isInteger)).toBe(true);
      expect(asset.layers.ground).not.toBe(asset.layers.midground);
      expect(asset.layers.midground).not.toBe(asset.layers.overhead);
      expect(asset.layers.sortRow).toBe(asset.entry[1]);
    }
  });
});
