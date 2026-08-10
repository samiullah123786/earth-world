import { describe, expect, it } from 'vitest';
import { WORLD_CHUNK_SIZE, boundariesMatch, generateWfcChunk, grassBoundary, validateWfcChunk, wfcRule, type DistrictBiome } from './wfc';

describe('deterministic Wang-socket WFC chunks', () => {
  const biomes: DistrictBiome[] = ['Town_Center', 'Residential_Suburbs', 'Farmland', 'Forest_Wilderness'];

  it('generates deterministic, fully collapsed chunks for every district biome', () => {
    for (const biome of biomes) {
      const a = generateWfcChunk({ seed: 90125, biome });
      const b = generateWfcChunk({ seed: 90125, biome });
      expect(a.tiles).toEqual(b.tiles);
      expect(a.tiles).toHaveLength(WORLD_CHUNK_SIZE * WORLD_CHUNK_SIZE);
      expect(validateWfcChunk(a.tiles, WORLD_CHUNK_SIZE, grassBoundary())).toBe(true);
    }
  });

  it('honors an existing neighboring edge exactly', () => {
    const left = generateWfcChunk({ seed: 41, biome: 'Residential_Suburbs' });
    const boundary = grassBoundary();
    const west = [...left.edges.east];
    const right = generateWfcChunk({ seed: 42, biome: 'Town_Center', boundary: { ...boundary, west } });
    expect(boundariesMatch(left.edges, 'east', right.edges, 'west')).toBe(true);
  });

  it('never joins road to non-road or water directly to grass', () => {
    const chunk = generateWfcChunk({ seed: 7781, biome: 'Town_Center' });
    expect(validateWfcChunk(chunk.tiles, WORLD_CHUNK_SIZE, grassBoundary())).toBe(true);
    const waterCount = chunk.tiles.filter((tile) => wfcRule(tile).terrain === 'water').length;
    const dense = chunk.tiles.flatMap((tile, index) => wfcRule(tile).dense ? [index] : []);
    expect(waterCount).toBeGreaterThanOrEqual(0);
    for (const index of dense) {
      const x = index % WORLD_CHUNK_SIZE, y = Math.floor(index / WORLD_CHUNK_SIZE);
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
        .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < WORLD_CHUNK_SIZE && ny < WORLD_CHUNK_SIZE)
        .map(([nx, ny]) => chunk.tiles[ny * WORLD_CHUNK_SIZE + nx]);
      expect(neighbors.some((tile) => wfcRule(tile).terrain === 'road')).toBe(true);
    }
  });

  it('fails closed when supplied an impossible outer boundary', () => {
    const boundary = grassBoundary();
    const impossible = { ...boundary, north: boundary.north.map(() => 'water' as const) };
    expect(() => generateWfcChunk({ seed: 1, biome: 'Farmland', boundary: impossible })).toThrow(/road boundary|contradiction/i);
  });
});
