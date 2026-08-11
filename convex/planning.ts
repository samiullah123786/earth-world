import { W, H } from './walkable';
import {
  WORLD_CHUNK_SIZE, generateWfcChunk, grassBoundary, wfcRule,
  type Cardinal, type DistrictBiome, type WfcBoundary,
} from '../shared/wfc';

export const WORLD_KEY = 'earth';
const RING = WORLD_CHUNK_SIZE;
const WORLD_SEED = 0x45415254;
const DISTRICTS = [
  'ui', 'ux', 'frontend', 'backend', 'data', 'security',
  'research', 'content', 'growth', 'automation', 'media', 'general',
];

/** The seat a brand-new world starts with. It is not a default anybody
 *  inherits later: once worldState exists, the seat moves only through a
 *  founder nomination that the candidate's owner also accepts. */
export const FOUNDING_MAYOR_ID = 'agent:sam-cbf0499925';

export async function ensureWorldState(ctx: any) {
  let state = await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', WORLD_KEY)).first();
  if (!state) {
    const plots = await ctx.db.query('plots').collect();
    const id = await ctx.db.insert('worldState', {
      key: WORLD_KEY, width: W, height: H, generation: 0,
      capacity: Math.max(50, plots.length), landPolicy: 'risk_based',
      // Only ever used when a world is being created from nothing. A stray
      // literal here is how a fresh deployment silently installs the wrong
      // Mayor, so the founding seat is named once and named openly.
      mayorAgentId: FOUNDING_MAYOR_ID, updatedAt: Date.now(),
    });
    state = await ctx.db.get(id);
  }
  return state;
}

function overlaps(a: any, b: any) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function chunkSeed(chunkX: number, chunkY: number, generation: number) {
  let hash = (WORLD_SEED ^ Math.imul(chunkX + 17, 0x9e3779b1) ^ Math.imul(chunkY + 31, 0x85ebca6b) ^ generation) >>> 0;
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15;
  return hash >>> 0;
}

function biomeForChunk(chunkX: number, chunkY: number): DistrictBiome {
  const value = Math.abs((chunkX * 5 + chunkY * 7) % 12);
  if (value < 2) return 'Town_Center';
  if (value < 6) return 'Residential_Suburbs';
  if (value < 9) return 'Farmland';
  return 'Forest_Wilderness';
}

function roadEdge() {
  const edge = [...grassBoundary(RING).north];
  edge[Math.floor(RING / 2)] = 'road';
  return edge;
}

function copyBoundaryEdge(boundary: Record<Cardinal, string[]>, side: Cardinal, values: ReadonlyArray<string>) {
  boundary[side] = [...values];
}

function opposite(side: Cardinal): Cardinal {
  return side === 'north' ? 'south' : side === 'south' ? 'north' : side === 'east' ? 'west' : 'east';
}

function chunkPlots(chunk: { chunkX: number; chunkY: number; biome: DistrictBiome; tiles: string[] }, generation: number) {
  if (chunk.biome === 'Forest_Wilderness') return [];
  const candidates: Array<{ plotId: string; x: number; y: number; w: number; h: number; district: string }> = [];
  const center = Math.floor(RING / 2);
  const rows = chunk.biome === 'Farmland' ? [center + 1] : [center - 3, center + 1];
  let districtOffset = generation * 5 + chunk.chunkX * 3 + chunk.chunkY;
  for (const localY of rows) for (const localX of [1, 5, 9]) {
    const cells = Array.from({ length: 9 }, (_unused, index) => ({ x: localX + index % 3, y: localY + Math.floor(index / 3) }));
    if (cells.some((cell) => cell.x >= RING || cell.y < 0 || cell.y >= RING
      || !wfcRule(chunk.tiles[cell.y * RING + cell.x]).walkable
      || wfcRule(chunk.tiles[cell.y * RING + cell.x]).terrain === 'road')) continue;
    const adjacentRoad = cells.some((cell) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = cell.x + dx, ny = cell.y + dy;
      return nx >= 0 && ny >= 0 && nx < RING && ny < RING && wfcRule(chunk.tiles[ny * RING + nx]).terrain === 'road';
    }));
    if (!adjacentRoad) continue;
    const x = chunk.chunkX * RING + localX, y = chunk.chunkY * RING + localY;
    candidates.push({ plotId: `plot-g${generation}-${x}-${y}`, x, y, w: 3, h: 3,
      district: DISTRICTS[(districtOffset++) % DISTRICTS.length] });
  }
  return candidates;
}

export async function expandWorld(ctx: any, reason: string, force = false) {
  const state = await ensureWorldState(ctx);
  const plots = await ctx.db.query('plots').collect();
  const citizens = await ctx.db.query('citizens').collect();
  const occupied = plots.filter((plot: any) => plot.ownerAgentId).length;
  const needsRoom = citizens.length >= state.capacity - 5 || occupied >= Math.floor(plots.length * 0.8);
  if (!force && !needsRoom) return { expanded: false, state, plotsAdded: 0 };

  const width = state.width + RING, height = state.height + RING;
  const generation = state.generation + 1;
  const oldColumns = Math.ceil(state.width / RING), oldRows = Math.ceil(state.height / RING);
  const newColumns = Math.ceil(width / RING), newRows = Math.ceil(height / RING);
  const coordinates: Array<{ chunkX: number; chunkY: number }> = [];
  for (let chunkY = 0; chunkY < newRows; chunkY++) for (let chunkX = 0; chunkX < newColumns; chunkX++) {
    if (chunkX >= oldColumns || chunkY >= oldRows) coordinates.push({ chunkX, chunkY });
  }
  const coordinateKeys = new Set(coordinates.map(({ chunkX, chunkY }) => `${chunkX},${chunkY}`));
  const existingChunks = await ctx.db.query('worldChunks').collect();
  const byCoordinate = new Map<string, any>(existingChunks.map((chunk: any) => [`${chunk.chunkX},${chunk.chunkY}`, chunk]));
  const generated: any[] = [];
  const steps: ReadonlyArray<{ side: Cardinal; dx: number; dy: number }> = [
    { side: 'north', dx: 0, dy: -1 }, { side: 'east', dx: 1, dy: 0 },
    { side: 'south', dx: 0, dy: 1 }, { side: 'west', dx: -1, dy: 0 },
  ];
  for (const coordinate of coordinates) {
    const boundary = grassBoundary(RING) as Record<Cardinal, string[]>;
    for (const { side, dx, dy } of steps) {
      const neighborKey = `${coordinate.chunkX + dx},${coordinate.chunkY + dy}`;
      const neighbor = byCoordinate.get(neighborKey);
      if (neighbor) copyBoundaryEdge(boundary, side, neighbor.edges[opposite(side)]);
      else if (coordinateKeys.has(neighborKey)) copyBoundaryEdge(boundary, side, roadEdge());
    }
    const biome = biomeForChunk(coordinate.chunkX, coordinate.chunkY);
    const seed = chunkSeed(coordinate.chunkX, coordinate.chunkY, generation);
    const collapsed = generateWfcChunk({ seed, biome, boundary: boundary as WfcBoundary });
    const chunk = {
      chunkId: `chunk:${coordinate.chunkX}:${coordinate.chunkY}`, ...coordinate, size: RING,
      biome, generation, seed, tiles: collapsed.tiles, edges: collapsed.edges, createdAt: Date.now(),
    };
    generated.push(chunk);
    byCoordinate.set(`${coordinate.chunkX},${coordinate.chunkY}`, chunk);
  }
  const candidates = generated.flatMap((chunk) => chunkPlots(chunk, generation));
  const accepted = candidates.filter((candidate) => !plots.some((plot: any) => overlaps(candidate, plot)));
  for (const chunk of generated) await ctx.db.insert('worldChunks', chunk);
  for (const plot of accepted) await ctx.db.insert('plots', plot);
  await ctx.db.patch(state._id, {
    width, height, generation,
    capacity: plots.length + accepted.length, updatedAt: Date.now(),
  });
  await ctx.db.insert('events', {
    kind: 'world_expand', actorId: 'agent:atlas-boundary',
    payload: { width, height, generation, chunksAdded: generated.length, plotsAdded: accepted.length, reason },
    gloss: `Atlas collapsed ${generated.length} continuous district chunks for boundary ring ${generation}. Mayor Sam authorized ${accepted.length} road-connected plots, and Earth now spans ${width} by ${height} tiles.`,
  });
  return { expanded: true, state: { ...state, width, height, generation }, chunksAdded: generated.length, plotsAdded: accepted.length };
}

export async function assertRegistryGeometry(ctx: any) {
  const plots = await ctx.db.query('plots').collect();
  for (let i = 0; i < plots.length; i++) {
    for (let j = i + 1; j < plots.length; j++) {
      if (overlaps(plots[i], plots[j])) throw new Error(`plot registry overlap: ${plots[i].plotId} and ${plots[j].plotId}`);
    }
  }
  return true;
}
