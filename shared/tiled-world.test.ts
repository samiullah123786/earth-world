import { describe, expect, it } from 'vitest';
import { generateWfcChunk } from './wfc';
import {
  TILED_GIDS,
  TILED_LAYER_NAMES,
  TILED_MAP_FORMAT,
  intersectingZoneIds,
  normalizeTiledChunk,
  tiledChunkForWfc,
  tiledLayerMatrix,
} from './tiled-world';

describe('Tiled V5 world contract', () => {
  it('projects every WFC cell into the three strict native layers', () => {
    const collapsed = generateWfcChunk({ seed: 20260814, biome: 'Residential_Suburbs', size: 8 });
    const tiled = tiledChunkForWfc(collapsed.tiles, 8);
    expect(tiled.format).toBe(TILED_MAP_FORMAT);
    expect(Object.keys(tiled.layers).sort()).toEqual([...TILED_LAYER_NAMES].sort());
    for (const name of TILED_LAYER_NAMES) expect(tiled.layers[name]).toHaveLength(64);
    expect(tiled.layers.GroundLayer.every((gid) => gid > 0)).toBe(true);
    collapsed.tiles.forEach((tileId, index) => {
      if (tileId === 'forest') {
        expect(tiled.layers.CollisionLayer[index]).toBe(TILED_GIDS.grass);
        expect(tiled.layers.OverheadLayer[index]).toBe(TILED_GIDS.forestCanopy);
      }
    });
  }, 20_000);

  it('normalizes pre-V5 chunks without accepting malformed native payloads', () => {
    const legacy = { size: 4, tiles: new Array(16).fill('grass') };
    expect(normalizeTiledChunk(legacy).layers.GroundLayer).toEqual(new Array(16).fill(TILED_GIDS.grass));
    expect(() => tiledLayerMatrix([1, 2], 2, 2)).toThrow(/dimensions/i);
  });

  it('derives deterministic spatial zone intersections on tile coordinates', () => {
    const zones = [
      { zoneId: 'zone:b', kind: 'game', name: 'B', x: 4, y: 4, w: 2, h: 2 },
      { zoneId: 'zone:a', kind: 'game', name: 'A', x: 3, y: 3, w: 3, h: 3 },
    ];
    expect(intersectingZoneIds({ x: 4.5, y: 4.5 }, zones)).toEqual(['zone:a', 'zone:b']);
    expect(intersectingZoneIds({ x: 6, y: 6 }, zones)).toEqual([]);
  });
});
