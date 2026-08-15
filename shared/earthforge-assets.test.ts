import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import specs from './earthforge-habitat-specs.json';
import sourceLock from './earthforge-source-lock.json';
import { EARTHFORGE_ASSETS, EARTHFORGE_COMPILER_SYSTEM } from './earthforge';

function pngSize(webPath: string): readonly [number, number] {
  const bytes = readFileSync(resolve(process.cwd(), 'public', webPath.replace(/^\//, '').replace(/^assets\//, 'assets/')));
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] as const;
}

function webAssetBytes(webPath: string) {
  return readFileSync(resolve(process.cwd(), 'public', webPath.replace(/^\//, '')));
}

describe('EarthForge compiled asset files', () => {
  it('keeps the safe HabitatSpec boundary closed', () => {
    expect(specs).toMatchObject({ version: 1, system: EARTHFORGE_COMPILER_SYSTEM, gridSize: 32 });
    expect(specs.rules).toMatchObject({
      source: 'catalog-owned-approved-render', runtimeCode: false, externalImages: false, coordinates: 'integer-pixels',
    });
    expect(Object.keys(specs.structures).sort()).toEqual(Object.keys(EARTHFORGE_ASSETS).sort());
    for (const masks of Object.values(specs.structures)) {
      expect([...masks.groundRegions, ...masks.overheadRegions]
        .every((region) => region.length === 4 && region.every(Number.isInteger))).toBe(true);
    }
  });

  it('ships every pass at the exact catalogued size', () => {
    for (const asset of Object.values(EARTHFORGE_ASSETS)) {
      for (const pass of ['ground', 'midground', 'overhead', 'emissive', 'normal'] as const) {
        expect(pngSize(asset.layers[pass])).toEqual(asset.layers.pixelSize);
      }
    }
  });

  it('refuses the previously quantized building sources', () => {
    expect(sourceLock).toMatchObject({ version: 1, sourceRelease: 'c295cb9', policy: 'smooth-pre-quantization-only' });
    expect(Object.keys(sourceLock.sha256).sort()).toEqual(Object.keys(EARTHFORGE_ASSETS).sort());
    for (const [assetId, asset] of Object.entries(EARTHFORGE_ASSETS)) {
      const digest = createHash('sha256').update(webAssetBytes(asset.image)).digest('hex');
      expect(digest, `${assetId} must remain the approved smooth source`).toBe(
        sourceLock.sha256[assetId as keyof typeof sourceLock.sha256],
      );
    }
  });
});
