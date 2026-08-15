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
      if (tileId.startsWith('road_')) expect(tiled.layers.GroundLayer[index]).toBe(TILED_GIDS.cobbleFill);
    });
  }, 20_000);

  it('stamps only complete 3x3 LPC tree macros, never isolated canopy fragments', () => {
    const tiled = tiledChunkForWfc(new Array(25).fill('forest'), 5);
    const canopy = tiled.layers.OverheadLayer.filter((gid) => gid > 0);
    expect(canopy).toHaveLength(9);
    const validMacroTiles = new Set([
      TILED_GIDS.treeFirst, TILED_GIDS.treeFirst + 1, TILED_GIDS.treeFirst + 2,
      TILED_GIDS.treeFirst + 3, TILED_GIDS.treeFirst + 4, TILED_GIDS.treeFirst + 5,
      TILED_GIDS.treeFirst + 6, TILED_GIDS.treeFirst + 7, TILED_GIDS.treeFirst + 8,
      TILED_GIDS.treeFirst + 9, TILED_GIDS.treeFirst + 10, TILED_GIDS.treeFirst + 11,
      TILED_GIDS.treeFirst + 12, TILED_GIDS.treeFirst + 13, TILED_GIDS.treeFirst + 14,
      TILED_GIDS.treeFirst + 15, TILED_GIDS.treeFirst + 16, TILED_GIDS.treeFirst + 17,
    ]);
    expect(canopy.every((gid) => validMacroTiles.has(gid))).toBe(true);
  });

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
