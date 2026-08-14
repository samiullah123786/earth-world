import { describe, expect, it } from 'vitest';
import {
  MIN_WATER_REGION, WORLD_CHUNK_SIZE, chunkAvenues, generateWfcChunk, wfcRule,
  type DistrictBiome, type WfcBoundary,
} from './wfc';

/**
 * What "good terrain" means, stated as checks rather than as an opinion.
 *
 * The faults these pin down all shipped at once and all looked the same from
 * a distance - scattered litter over open country. Each one is a different
 * cause, so each gets its own test.
 */

const SIZE = WORLD_CHUNK_SIZE;
const grassEdge = () => Array.from({ length: SIZE }, () => 'grass' as const);
const OPEN: WfcBoundary = { north: grassEdge(), east: grassEdge(), south: grassEdge(), west: grassEdge() };

function collapse(overrides: Partial<Parameters<typeof generateWfcChunk>[0]> = {}) {
  return generateWfcChunk({
    seed: 0x51ee7, biome: 'Forest_Wilderness', boundary: OPEN,
    origin: { x: 0, y: 0 }, avenues: { northSouth: false, eastWest: false },
    ...overrides,
  });
}

const terrainAt = (tiles: string[], x: number, y: number) => wfcRule(tiles[y * SIZE + x]).terrain;

/** Connected regions of a terrain family, by plain four-way adjacency. */
function regions(tiles: string[], kinds: ReadonlyArray<string>) {
  const seen = new Array<boolean>(tiles.length).fill(false);
  const found: number[][] = [];
  for (let start = 0; start < tiles.length; start++) {
    if (seen[start] || !kinds.includes(wfcRule(tiles[start]).terrain)) continue;
    const region: number[] = [];
    const queue = [start];
    seen[start] = true;
    while (queue.length) {
      const index = queue.pop()!;
      region.push(index);
      const x = index % SIZE, y = Math.floor(index / SIZE);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const neighbor = ny * SIZE + nx;
        if (seen[neighbor] || !kinds.includes(wfcRule(tiles[neighbor]).terrain)) continue;
        seen[neighbor] = true;
        queue.push(neighbor);
      }
    }
    found.push(region);
  }
  return found;
}

describe('generated terrain reads as country, not litter', () => {
  it('leaves no road stub dangling in open ground', () => {
    for (let seed = 0; seed < 12; seed++) {
      const { tiles } = collapse({ seed, avenues: { northSouth: true, eastWest: true } });
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (terrainAt(tiles, x, y) !== 'road') continue;
        const rule = wfcRule(tiles[y * SIZE + x]);
        const onEdge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
        const centre = Math.floor(SIZE / 2);
        // The avenue is allowed to stop at the frontier; nothing else is.
        const onAvenue = x === centre || y === centre;
        const exits = (['north', 'east', 'south', 'west'] as const)
          .filter((side) => rule.sockets[side] === 'road').length;
        if (exits <= 1) expect(onEdge || onAvenue, `stub at ${x},${y} seed ${seed}`).toBe(true);
      }
    }
  }, 60_000);

  it('keeps water in bodies worth the name, never puddles or bare rim', () => {
    for (let seed = 0; seed < 12; seed++) {
      const { tiles } = collapse({ seed, wetness: 1 });
      for (const region of regions(tiles, ['water', 'shore'])) {
        const touchesEdge = region.some((index) => {
          const x = index % SIZE, y = Math.floor(index / SIZE);
          return x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
        });
        if (touchesEdge) continue;
        const core = region.filter((index) => wfcRule(tiles[index]).terrain === 'water').length;
        expect(region.length, `puddle of ${region.length} at seed ${seed}`).toBeGreaterThanOrEqual(MIN_WATER_REGION);
        expect(core, `rim around nothing at seed ${seed}`).toBeGreaterThanOrEqual(4);
        expect(core * 3, `web of shoreline at seed ${seed}`).toBeGreaterThanOrEqual(region.length);
      }
    }
  }, 60_000);

  it('keeps dry country dry and lake country wet', () => {
    const wetTiles = [0, 1, 2, 3].flatMap((seed) => collapse({ seed, wetness: 1 }).tiles);
    const dryTiles = [0, 1, 2, 3].flatMap((seed) => collapse({ seed, wetness: 0 }).tiles);
    const share = (tiles: string[]) =>
      tiles.filter((tile) => ['water', 'shore'].includes(wfcRule(tile).terrain)).length / tiles.length;
    expect(share(dryTiles)).toBeLessThan(0.02);
    expect(share(wetTiles)).toBeGreaterThan(share(dryTiles));
  }, 60_000);

  it('grows trees in groves rather than sprinkling them one by one', () => {
    const { tiles } = collapse({ seed: 7, woodedness: 1, biome: 'Forest_Wilderness' });
    const trees = regions(tiles, ['forest']);
    expect(trees.length, 'a wood should exist at all').toBeGreaterThan(0);
    const planted = trees.reduce((sum, region) => sum + region.length, 0);
    const lonely = trees.filter((region) => region.length === 1).length;
    // A grove of one is a stray. Most trees should stand with other trees.
    expect(lonely / trees.length).toBeLessThan(0.5);
    expect(planted / tiles.length).toBeGreaterThan(0.05);
  });

  it('lays farmland in worked parcels', () => {
    const { tiles } = collapse({ seed: 3, biome: 'Farmland' });
    const parcels = regions(tiles, ['field']);
    expect(parcels.length).toBeGreaterThan(0);
    const biggest = Math.max(...parcels.map((region) => region.length));
    expect(biggest, 'a farm is bigger than a window box').toBeGreaterThanOrEqual(8);
  });

  it('never builds over ground that must stay clear', () => {
    const keepClear = [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 }];
    for (let seed = 0; seed < 8; seed++) {
      const { tiles } = collapse({ seed, wetness: 1, woodedness: 1, keepClear });
      for (const cell of keepClear) {
        const rule = wfcRule(tiles[cell.y * SIZE + cell.x]);
        expect(rule.walkable, `(${cell.x},${cell.y}) blocked at seed ${seed}`).toBe(true);
        expect(rule.terrain).toBe('grass');
      }
    }
  }, 60_000);

  it('puts avenues on every third chunk line and nowhere else', () => {
    expect(chunkAvenues(1, 1)).toEqual({ northSouth: true, eastWest: true });
    expect(chunkAvenues(2, 3)).toEqual({ northSouth: false, eastWest: false });
    // Two neighbours must always agree about the seam they share.
    for (let chunkX = -4; chunkX < 8; chunkX++) {
      expect(chunkAvenues(chunkX, 5).northSouth).toBe(chunkAvenues(chunkX, 9).northSouth);
    }
    const quiet = collapse({ avenues: chunkAvenues(0, 0) }).tiles;
    expect(quiet.filter((tile) => wfcRule(tile).terrain === 'road')).toHaveLength(0);
  });

  it('still agrees with a neighbour that was laid before it', () => {
    const west = collapse({ seed: 21, avenues: { northSouth: false, eastWest: true } });
    const east = generateWfcChunk({
      seed: 22, biome: 'Farmland', origin: { x: SIZE, y: 0 },
      avenues: { northSouth: false, eastWest: true },
      boundary: { ...OPEN, west: west.edges.east },
    });
    expect(east.edges.west).toEqual(west.edges.east);
  });
});
