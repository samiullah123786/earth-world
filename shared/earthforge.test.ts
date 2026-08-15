import { describe, expect, it } from 'vitest';
import { assertEarthForgeCatalog, EARTHFORGE_ASSETS, EARTHFORGE_SYSTEM, earthForgeAssetFor, semanticIntent, semanticIntentForAsset } from './earthforge';

describe('EarthForge semantic catalog', () => {
  it('is internally valid and purpose-specific', () => {
    expect(assertEarthForgeCatalog()).toBe(true);
    expect(earthForgeAssetFor('bank', 'build:earth-bank')?.id).toBe('bank_rotunda');
    expect(earthForgeAssetFor('home', 'build:earth-bank')?.id).not.toBe('bank_rotunda');
    expect(earthForgeAssetFor('data_center', 'build:data')?.id).toBe('data_center');
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
});
