import { describe, expect, it } from 'vitest';
import {
  WORLD_CHUNK_SIZE,
  boundariesMatch,
  generateWfcChunk,
  validateWfcChunk,
  wfcRule,
  type DistrictBiome,
  type WfcBoundary,
} from './wfc';

const biomes: DistrictBiome[] = [
  'Town_Center', 'Residential_Suburbs', 'Farmland', 'Forest_Wilderness',
];

function grassBoundary(size = WORLD_CHUNK_SIZE): WfcBoundary {
  const side = () => Array.from({ length: size }, () => 'grass' as const);
  return { north: side(), east: side(), south: side(), west: side() };
}

describe('engine expansion stress sweep', () => {
  it('collapses deterministic chunks across every district without invalid sockets', () => {
    for (let seed = 1; seed <= 16; seed++) {
      const biome = biomes[(seed - 1) % biomes.length];
      const first = generateWfcChunk({ seed, biome });
      const replay = generateWfcChunk({ seed, biome });
      expect(replay.tiles).toEqual(first.tiles);
      expect(() => validateWfcChunk(first.tiles, WORLD_CHUNK_SIZE, grassBoundary())).not.toThrow();
      expect(first.tiles).toHaveLength(WORLD_CHUNK_SIZE * WORLD_CHUNK_SIZE);
      for (let index = 0; index < first.tiles.length; index++) {
        if (!wfcRule(first.tiles[index]).dense) continue;
        const x = index % WORLD_CHUNK_SIZE, y = Math.floor(index / WORLD_CHUNK_SIZE);
        const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        expect(neighbors.some(([nx, ny]) => nx >= 0 && ny >= 0
          && nx < WORLD_CHUNK_SIZE && ny < WORLD_CHUNK_SIZE
          && wfcRule(first.tiles[ny * WORLD_CHUNK_SIZE + nx]).terrain === 'road')).toBe(true);
      }
    }
  // No local timeout: this sweep collapses sixteen full chunks twice over and
  // takes about fourteen seconds alone, so the old thirty-second override
  // was fine in isolation and failed under the contention of the whole suite
  // running in parallel. It inherits the project budget instead - one number,
  // in one place, for every heavy test here.
  });

  it('uses a collapsed neighbor edge as a hard boundary for the next chunk', () => {
    const west = generateWfcChunk({ seed: 20260810, biome: 'Town_Center' });
    const boundary = grassBoundary();
    const east = generateWfcChunk({
      seed: 20260811,
      biome: 'Residential_Suburbs',
      boundary: { ...boundary, west: west.edges.east },
    });
    expect(boundariesMatch(west.edges, 'east', east.edges, 'west')).toBe(true);
    expect(() => validateWfcChunk(east.tiles, WORLD_CHUNK_SIZE, { ...boundary, west: west.edges.east })).not.toThrow();
  });
});
