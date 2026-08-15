import { W, H } from './tiledFounding';
import {
  WORLD_CHUNK_SIZE, chunkAvenues, generateWfcChunk, grassBoundary, wfcRule,
  type Cardinal, type DistrictBiome, type WfcBoundary,
} from '../shared/wfc';
import { TILED_LAYER_NAMES, TILED_MAP_FORMAT, TILED_MAP_VERSION, TILED_TILE_SIZE, tiledChunkForWfc } from '../shared/tiled-world';
import { EARTHFORGE_SYSTEM } from '../shared/earthforge';

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
      mapFormat: TILED_MAP_FORMAT, mapVersion: TILED_MAP_VERSION,
      tileSize: TILED_TILE_SIZE, mapLayers: [...TILED_LAYER_NAMES],
      architectureSystem: EARTHFORGE_SYSTEM,
      // Only ever used when a world is being created from nothing. A stray
      // literal here is how a fresh deployment silently installs the wrong
      // Mayor, so the founding seat is named once and named openly.
      mayorAgentId: FOUNDING_MAYOR_ID, updatedAt: Date.now(),
    });
    state = await ctx.db.get(id);
  }
  if (state && (state.mapFormat !== TILED_MAP_FORMAT || state.mapVersion !== TILED_MAP_VERSION
    || state.architectureSystem !== EARTHFORGE_SYSTEM)) {
    await ctx.db.patch(state._id, {
      mapFormat: TILED_MAP_FORMAT, mapVersion: TILED_MAP_VERSION,
      tileSize: TILED_TILE_SIZE, mapLayers: [...TILED_LAYER_NAMES],
      architectureSystem: EARTHFORGE_SYSTEM, updatedAt: Date.now(),
    });
    state = { ...state, mapFormat: TILED_MAP_FORMAT, mapVersion: TILED_MAP_VERSION,
      tileSize: TILED_TILE_SIZE, mapLayers: [...TILED_LAYER_NAMES], architectureSystem: EARTHFORGE_SYSTEM };
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

/** Smooth value noise over the chunk lattice, in 0..1. */
function fieldNoise(chunkX: number, chunkY: number, wavelength: number, salt: number) {
  const at = (ix: number, iy: number) => {
    let h = (Math.imul(ix + 0x1f1f, 0x9e3779b1) ^ Math.imul(iy + 0x2c2c, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
  };
  const fx = chunkX / wavelength, fy = chunkY / wavelength;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const sx = ease(tx), sy = ease(ty);
  const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
  const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

/**
 * Which kind of district a chunk becomes.
 *
 * This used to be `(chunkX * 5 + chunkY * 7) % 12`, which lays biomes in
 * diagonal stripes one chunk wide: a farm, then woods, then a town centre,
 * repeating forever with no region larger than a single chunk. Terrain
 * generators cannot invent structure at a scale bigger than the window they
 * decide in, so the structure has to be handed to them - a low-frequency field
 * decides the district and the collapse only fills in its detail.
 *
 * Two things shape the field. Settlement falls away with distance from the
 * founding town, so Earth reads outward as streets, then homes, then farms,
 * then wilderness rather than a shuffled patchwork. Smooth noise then bends
 * that ring so the boundary wanders instead of drawing a circle.
 */
function biomeForChunk(chunkX: number, chunkY: number): DistrictBiome {
  const townX = 30 / RING, townY = 20 / RING;
  const distance = Math.hypot(chunkX - townX, chunkY - townY);
  const settlement = Math.max(0, 1 - distance / 5) * 0.75 + fieldNoise(chunkX, chunkY, 2.5, 101) * 0.45;
  if (settlement > 0.82) return 'Town_Center';
  if (settlement > 0.62) return 'Residential_Suburbs';
  // Beyond the houses the land is worked where it is fertile and wild where
  // it is not, in patches several chunks across.
  return fieldNoise(chunkX, chunkY, 3, 202) > 0.47 ? 'Farmland' : 'Forest_Wilderness';
}

/**
 * The regional fields handed to the collapse. Lake country and deep woods are
 * several chunks across, and the sharp curve on wetness keeps most of Earth
 * dry so the water that does appear is worth walking to.
 */
function terrainFields(chunkX: number, chunkY: number) {
  const wet = fieldNoise(chunkX, chunkY, 3.5, 303);
  return {
    wetness: Math.max(0, (wet - 0.55) / 0.45) ** 1.5,
    woodedness: fieldNoise(chunkX, chunkY, 2.5, 404),
  };
}

/**
 * The seam a chunk shares with a neighbour that has not been laid yet.
 *
 * It used to promise a road on every seam, which is half of why the finished
 * map wore a lattice. The promise now follows the same avenue rule the
 * collapse itself uses, and both sides of a seam read the rule from the same
 * coordinates, so they cannot disagree.
 */
function seamEdge(side: Cardinal, chunkX: number, chunkY: number) {
  const avenues = chunkAvenues(chunkX, chunkY);
  const carries = side === 'north' || side === 'south' ? avenues.northSouth : avenues.eastWest;
  const edge = [...grassBoundary(RING).north];
  if (carries) edge[Math.floor(RING / 2)] = 'road';
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
      else if (coordinateKeys.has(neighborKey)) copyBoundaryEdge(boundary, side, seamEdge(side, coordinate.chunkX, coordinate.chunkY));
    }
    const biome = biomeForChunk(coordinate.chunkX, coordinate.chunkY);
    const seed = chunkSeed(coordinate.chunkX, coordinate.chunkY, generation);
    const collapsed = generateWfcChunk({
    seed, biome, boundary: boundary as WfcBoundary,
    ...terrainFields(coordinate.chunkX, coordinate.chunkY),
    avenues: chunkAvenues(coordinate.chunkX, coordinate.chunkY),
    origin: { x: coordinate.chunkX * RING, y: coordinate.chunkY * RING },
  });
    const chunk = {
      chunkId: `chunk:${coordinate.chunkX}:${coordinate.chunkY}`, ...coordinate, size: RING,
      biome, generation, seed, tiles: collapsed.tiles, edges: collapsed.edges,
      tiled: tiledChunkForWfc(collapsed.tiles, RING), createdAt: Date.now(),
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

/**
 * Plan a ring without building it. Returns the chunk coordinates the ring
 * needs; the caller stores them and lays one per scheduled step.
 */
export async function planExpansion(ctx: any, reason: string, force = false) {
  const state = await ensureWorldState(ctx);
  if (state.pendingExpansion) return { planned: false, alreadyRunning: true, state };
  const plots = await ctx.db.query('plots').collect();
  const citizens = await ctx.db.query('citizens').collect();
  const occupied = plots.filter((plot: any) => plot.ownerAgentId).length;
  const needsRoom = citizens.length >= state.capacity - 5 || occupied >= Math.floor(plots.length * 0.8);
  if (!force && !needsRoom) return { planned: false, state };

  const width = state.width + RING, height = state.height + RING;
  const generation = state.generation + 1;
  const oldColumns = Math.ceil(state.width / RING), oldRows = Math.ceil(state.height / RING);
  const newColumns = Math.ceil(width / RING), newRows = Math.ceil(height / RING);
  const remaining: Array<{ chunkX: number; chunkY: number }> = [];
  for (let chunkY = 0; chunkY < newRows; chunkY++) for (let chunkX = 0; chunkX < newColumns; chunkX++) {
    if (chunkX >= oldColumns || chunkY >= oldRows) remaining.push({ chunkX, chunkY });
  }
  await ctx.db.patch(state._id, {
    pendingExpansion: { generation, width, height, reason, remaining, startedAt: Date.now() },
    updatedAt: Date.now(),
  });
  return { planned: true, chunks: remaining.length, generation, width, height };
}

/**
 * Lay ONE chunk of the pending ring. Terrain continuity is preserved exactly
 * as before: each chunk copies the edges of whichever neighbours already
 * exist, and chunks laid earlier in this ring are read back from the database.
 */
export async function expansionStep(ctx: any) {
  const state = await ensureWorldState(ctx);
  const pending = state.pendingExpansion;
  if (!pending) return { done: true, laid: 0 };
  if (!pending.remaining.length) return await commitExpansion(ctx, state, pending);

  const [coordinate, ...rest] = pending.remaining;
  const existingChunks = await ctx.db.query('worldChunks').collect();
  const byCoordinate = new Map<string, any>(existingChunks.map((chunk: any) => [`${chunk.chunkX},${chunk.chunkY}`, chunk]));
  const plannedKeys = new Set(pending.remaining.map(({ chunkX, chunkY }: any) => `${chunkX},${chunkY}`));
  const steps: ReadonlyArray<{ side: Cardinal; dx: number; dy: number }> = [
    { side: 'north', dx: 0, dy: -1 }, { side: 'east', dx: 1, dy: 0 },
    { side: 'south', dx: 0, dy: 1 }, { side: 'west', dx: -1, dy: 0 },
  ];
  const boundary = grassBoundary(RING) as Record<Cardinal, string[]>;
  for (const { side, dx, dy } of steps) {
    const neighborKey = `${coordinate.chunkX + dx},${coordinate.chunkY + dy}`;
    const neighbor = byCoordinate.get(neighborKey);
    if (neighbor) copyBoundaryEdge(boundary, side, neighbor.edges[opposite(side)]);
    else if (plannedKeys.has(neighborKey)) copyBoundaryEdge(boundary, side, seamEdge(side, coordinate.chunkX, coordinate.chunkY));
  }
  const biome = biomeForChunk(coordinate.chunkX, coordinate.chunkY);
  const seed = chunkSeed(coordinate.chunkX, coordinate.chunkY, pending.generation);
  const collapsed = generateWfcChunk({
    seed, biome, boundary: boundary as WfcBoundary,
    ...terrainFields(coordinate.chunkX, coordinate.chunkY),
    avenues: chunkAvenues(coordinate.chunkX, coordinate.chunkY),
    origin: { x: coordinate.chunkX * RING, y: coordinate.chunkY * RING },
  });
  if (!byCoordinate.has(`${coordinate.chunkX},${coordinate.chunkY}`)) {
    await ctx.db.insert('worldChunks', {
      chunkId: `chunk:${coordinate.chunkX}:${coordinate.chunkY}`, ...coordinate, size: RING,
      biome, generation: pending.generation, seed, tiles: collapsed.tiles, edges: collapsed.edges,
      tiled: tiledChunkForWfc(collapsed.tiles, RING),
      createdAt: Date.now(),
    });
  }
  await ctx.db.patch(state._id, {
    pendingExpansion: { ...pending, remaining: rest }, updatedAt: Date.now(),
  });
  return { done: rest.length === 0, laid: 1, remaining: rest.length };
}

/** The ring is complete: add its plots and grow the boundary, once. */
async function commitExpansion(ctx: any, state: any, pending: any) {
  const plots = await ctx.db.query('plots').collect();
  const ringChunks = (await ctx.db.query('worldChunks').collect())
    .filter((chunk: any) => chunk.generation === pending.generation);
  const candidates = ringChunks.flatMap((chunk: any) => chunkPlots(chunk, pending.generation));
  const accepted = candidates.filter((candidate: any) => !plots.some((plot: any) => overlaps(candidate, plot)));
  for (const plot of accepted) await ctx.db.insert('plots', plot);
  await ctx.db.patch(state._id, {
    width: pending.width, height: pending.height, generation: pending.generation,
    capacity: plots.length + accepted.length, pendingExpansion: undefined, updatedAt: Date.now(),
  });
  await ctx.db.insert('events', {
    kind: 'world_expand', actorId: 'agent:atlas-boundary',
    payload: { width: pending.width, height: pending.height, generation: pending.generation,
      chunksAdded: ringChunks.length, plotsAdded: accepted.length, reason: pending.reason },
    gloss: `Atlas finished boundary ring ${pending.generation}: ${accepted.length} road-connected plots opened, and Earth now spans ${pending.width} by ${pending.height} tiles.`,
  });
  return { done: true, committed: true, plotsAdded: accepted.length, width: pending.width, height: pending.height };
}

/**
 * The next chunk to lay, with the boundary it must match - read by index, so
 * this stays inside the Kernel's one-second query budget.
 */
export async function nextExpansionWork(ctx: any) {
  const state = await ensureWorldState(ctx);
  const pending = state.pendingExpansion;
  if (!pending) return { pending: false as const };
  if (!pending.remaining.length) return { pending: true as const, ready: true as const };
  const coordinate = pending.remaining[0];
  const plannedKeys = new Set(pending.remaining.map(({ chunkX, chunkY }: any) => `${chunkX},${chunkY}`));
  const boundary = grassBoundary(RING) as Record<Cardinal, string[]>;
  const steps: ReadonlyArray<{ side: Cardinal; dx: number; dy: number }> = [
    { side: 'north', dx: 0, dy: -1 }, { side: 'east', dx: 1, dy: 0 },
    { side: 'south', dx: 0, dy: 1 }, { side: 'west', dx: -1, dy: 0 },
  ];
  for (const { side, dx, dy } of steps) {
    const nx = coordinate.chunkX + dx, ny = coordinate.chunkY + dy;
    const neighbor = await ctx.db.query('worldChunks')
      .withIndex('coordinates', (q: any) => q.eq('chunkX', nx).eq('chunkY', ny)).first();
    if (neighbor) copyBoundaryEdge(boundary, side, neighbor.edges[opposite(side)]);
    else if (plannedKeys.has(`${nx},${ny}`)) copyBoundaryEdge(boundary, side, seamEdge(side, coordinate.chunkX, coordinate.chunkY));
  }
  return {
    pending: true as const, ready: false as const, coordinate,
    generation: pending.generation, remaining: pending.remaining.length,
    biome: biomeForChunk(coordinate.chunkX, coordinate.chunkY),
    seed: chunkSeed(coordinate.chunkX, coordinate.chunkY, pending.generation),
    boundary,
    // The ring is laid from an action, so the regional plan has to travel
    // with the work item; the action must never re-derive it and drift.
    ...terrainFields(coordinate.chunkX, coordinate.chunkY),
    avenues: chunkAvenues(coordinate.chunkX, coordinate.chunkY),
    origin: { x: coordinate.chunkX * RING, y: coordinate.chunkY * RING },
  };
}

/**
 * Every chunk that exists, in the order terrain has to be re-laid: north and
 * west first, so each one is conditioned on neighbours already rewritten.
 */
export async function relayCoordinates(ctx: any) {
  const chunks = await ctx.db.query('worldChunks').collect();
  const coordinates = chunks
    .map((chunk: any) => ({ chunkX: chunk.chunkX, chunkY: chunk.chunkY }))
    .sort((a: any, b: any) => (a.chunkY - b.chunkY) || (a.chunkX - b.chunkX));
  return { coordinates, total: coordinates.length };
}

/**
 * Everything needed to re-lay one existing chunk.
 *
 * The seams differ from a fresh ring in one way that matters: neighbours to
 * the north and west have already been rewritten, so their new edges are
 * copied, while neighbours to the south and east still hold old terrain whose
 * edges are about to change. Reading those would pin the new chunk to terrain
 * that is on its way out, so they take the avenue rule instead - the same
 * promise the not-yet-laid neighbour will keep when its own turn comes.
 */
export async function relayWorkFor(ctx: any, chunkX: number, chunkY: number) {
  const chunk = await ctx.db.query('worldChunks')
    .withIndex('coordinates', (q: any) => q.eq('chunkX', chunkX).eq('chunkY', chunkY)).first();
  if (!chunk) return { found: false as const };
  const state = await ensureWorldState(ctx);
  const boundary = grassBoundary(RING) as Record<Cardinal, string[]>;
  const steps: ReadonlyArray<{ side: Cardinal; dx: number; dy: number; rewritten: boolean }> = [
    { side: 'north', dx: 0, dy: -1, rewritten: true }, { side: 'west', dx: -1, dy: 0, rewritten: true },
    { side: 'south', dx: 0, dy: 1, rewritten: false }, { side: 'east', dx: 1, dy: 0, rewritten: false },
  ];
  for (const { side, dx, dy, rewritten } of steps) {
    const nx = chunkX + dx, ny = chunkY + dy;
    const neighbor = await ctx.db.query('worldChunks')
      .withIndex('coordinates', (q: any) => q.eq('chunkX', nx).eq('chunkY', ny)).first();
    if (!neighbor) continue;
    if (rewritten) copyBoundaryEdge(boundary, side, neighbor.edges[opposite(side)]);
    else copyBoundaryEdge(boundary, side, seamEdge(side, chunkX, chunkY));
  }
  // Land anyone owns, and the ground under anything standing, stays clear.
  const originX = chunkX * RING, originY = chunkY * RING;
  const keepClear: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  const add = (worldX: number, worldY: number) => {
    const x = worldX - originX, y = worldY - originY;
    if (x < 0 || y < 0 || x >= RING || y >= RING) return;
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    keepClear.push({ x, y });
  };
  for (const plot of await ctx.db.query('plots').collect()) {
    for (let dy = 0; dy < plot.h; dy++) for (let dx = 0; dx < plot.w; dx++) add(plot.x + dx, plot.y + dy);
  }
  for (const build of await ctx.db.query('builds').collect()) {
    if (build.state === 'razed' || build.x === undefined || build.y === undefined) continue;
    const width = Number(build.w ?? build.blueprint?.w ?? 1), height = Number(build.h ?? build.blueprint?.h ?? 1);
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) add(build.x + dx, build.y + dy);
  }
  for (const venue of await ctx.db.query('venues').collect()) {
    if (Number.isInteger(venue.x) && Number.isInteger(venue.y)) add(venue.x, venue.y);
  }
  return {
    found: true as const,
    biome: biomeForChunk(chunkX, chunkY),
    seed: chunkSeed(chunkX, chunkY, state.generation),
    boundary,
    ...terrainFields(chunkX, chunkY),
    avenues: chunkAvenues(chunkX, chunkY),
    origin: { x: originX, y: originY },
    keepClear,
  };
}

/** Overwrite one chunk's terrain in place. The ring plan is untouched. */
export async function storeRelaidChunk(ctx: any, chunk: {
  chunkX: number; chunkY: number; biome: DistrictBiome; tiles: string[]; edges: any;
}) {
  const existing = await ctx.db.query('worldChunks')
    .withIndex('coordinates', (q: any) => q.eq('chunkX', chunk.chunkX).eq('chunkY', chunk.chunkY)).first();
  if (!existing) return { stored: false };
  await ctx.db.patch(existing._id, {
    biome: chunk.biome, tiles: chunk.tiles, edges: chunk.edges,
    tiled: tiledChunkForWfc(chunk.tiles, Math.sqrt(chunk.tiles.length)),
  });
  return { stored: true };
}

/** Store one collapsed chunk and advance the ring. Pure writes, no compute. */
export async function saveExpansionChunk(ctx: any, chunk: any) {
  const state = await ensureWorldState(ctx);
  const pending = state.pendingExpansion;
  if (!pending) return { stored: false };
  const already = await ctx.db.query('worldChunks')
    .withIndex('coordinates', (q: any) => q.eq('chunkX', chunk.chunkX).eq('chunkY', chunk.chunkY)).first();
  const canonical = { ...chunk, tiled: tiledChunkForWfc(chunk.tiles, chunk.size) };
  if (already) await ctx.db.patch(already._id, canonical);
  else await ctx.db.insert('worldChunks', { ...canonical, createdAt: Date.now() });
  await ctx.db.patch(state._id, {
    pendingExpansion: {
      ...pending,
      remaining: pending.remaining.filter((item: any) =>
        !(item.chunkX === chunk.chunkX && item.chunkY === chunk.chunkY)),
    },
    updatedAt: Date.now(),
  });
  return { stored: true };
}

export async function finishExpansion(ctx: any) {
  const state = await ensureWorldState(ctx);
  if (!state.pendingExpansion) return { done: true, committed: false };
  return await commitExpansion(ctx, state, state.pendingExpansion);
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
