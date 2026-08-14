import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { chunkAvenues, generateWfcChunk, WORLD_CHUNK_SIZE, type DistrictBiome, type WfcBoundary } from '../shared/wfc';

/**
 * Not a test: a preview harness. Collapses a block of chunks exactly the way
 * the Kernel does - each conditioned on the neighbours already laid - and
 * writes the tiles out so they can be rendered against the real atlas and
 * looked at. Run with: npx vitest run scripts/preview_chunks.test.ts
 */

const RING = WORLD_CHUNK_SIZE;
const OUT = process.env.PREVIEW_OUT ?? 'preview-chunks.json';

function fieldNoise(chunkX: number, chunkY: number, wavelength: number, salt: number) {
  const at = (ix: number, iy: number) => {
    let h = (Math.imul(ix + 0x1f1f, 0x9e3779b1) ^ Math.imul(iy + 0x2c2c, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
  };
  const fx = chunkX / wavelength, fy = chunkY / wavelength;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const ease = (t: number) => t * t * (3 - 2 * t);
  const sx = ease(fx - x0), sy = ease(fy - y0);
  const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
  const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

function biomeForChunk(chunkX: number, chunkY: number): DistrictBiome {
  const distance = Math.hypot(chunkX - 30 / RING, chunkY - 20 / RING);
  const settlement = Math.max(0, 1 - distance / 5) * 0.75 + fieldNoise(chunkX, chunkY, 2.5, 101) * 0.45;
  if (settlement > 0.82) return 'Town_Center';
  if (settlement > 0.62) return 'Residential_Suburbs';
  return fieldNoise(chunkX, chunkY, 3, 202) > 0.47 ? 'Farmland' : 'Forest_Wilderness';
}

function terrainFields(chunkX: number, chunkY: number) {
  const wet = fieldNoise(chunkX, chunkY, 3.5, 303);
  return {
    wetness: Math.max(0, (wet - 0.55) / 0.45) ** 1.5,
    woodedness: fieldNoise(chunkX, chunkY, 2.5, 404),
  };
}

function seamEdge(side: 'north' | 'east' | 'south' | 'west', chunkX: number, chunkY: number) {
  const avenues = chunkAvenues(chunkX, chunkY);
  const carries = side === 'north' || side === 'south' ? avenues.northSouth : avenues.eastWest;
  const edge = grass() as string[];
  if (carries) edge[Math.floor(RING / 2)] = 'road';
  return edge;
}

function chunkSeed(chunkX: number, chunkY: number, generation: number) {
  let hash = (0x5eed ^ Math.imul(chunkX + 17, 0x9e3779b1) ^ Math.imul(chunkY + 31, 0x85ebca6b) ^ generation) >>> 0;
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15;
  return hash >>> 0;
}

const grass = () => Array.from({ length: RING }, () => 'grass' as const);

it('writes a chunk preview', () => {
  const started = Date.now();
  const COLUMNS = 6, ROWS = 5;
  const laid = new Map<string, { tiles: string[]; edges: WfcBoundary }>();
  const out: any[] = [];
  for (let chunkY = 0; chunkY < ROWS; chunkY++) {
    for (let chunkX = 0; chunkX < COLUMNS; chunkX++) {
      const boundary: Record<string, string[]> = {
        north: grass(), east: grass(), south: grass(), west: grass(),
      };
      const north = laid.get(`${chunkX},${chunkY - 1}`);
      if (north) boundary.north = [...north.edges.south];
      const west = laid.get(`${chunkX - 1},${chunkY}`);
      if (west) boundary.west = [...west.edges.east];
      // Neighbours still to come promise the same seam the planner promises.
      if (chunkY + 1 < ROWS) boundary.south = seamEdge('south', chunkX, chunkY);
      if (chunkX + 1 < COLUMNS) boundary.east = seamEdge('east', chunkX, chunkY);
      const biome = biomeForChunk(chunkX, chunkY);
      const collapsed = generateWfcChunk({
        seed: chunkSeed(chunkX, chunkY, 1), biome, boundary: boundary as unknown as WfcBoundary,
        ...terrainFields(chunkX, chunkY), avenues: chunkAvenues(chunkX, chunkY),
        origin: { x: chunkX * RING, y: chunkY * RING },
      });
      laid.set(`${chunkX},${chunkY}`, collapsed);
      out.push({ chunkX, chunkY, size: RING, biome, tiles: collapsed.tiles });
    }
  }
  const elapsed = Date.now() - started;
  console.log(`laid ${out.length} chunks in ${elapsed}ms (${Math.round(elapsed / out.length)}ms each)`);
  writeFileSync(OUT, JSON.stringify({ columns: COLUMNS, rows: ROWS, size: RING, chunks: out }));
}, 300_000);
