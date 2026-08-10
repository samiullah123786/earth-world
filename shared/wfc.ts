export const WORLD_CHUNK_SIZE = 16 as const;

export type DistrictBiome = 'Town_Center' | 'Residential_Suburbs' | 'Farmland' | 'Forest_Wilderness';
export type EdgeSocket = 'grass' | 'road' | 'water';
export type Cardinal = 'north' | 'east' | 'south' | 'west';
export type WfcBoundary = Readonly<Record<Cardinal, ReadonlyArray<EdgeSocket>>>;

export type WfcTileRule = Readonly<{
  id: string;
  sockets: Readonly<Record<Cardinal, EdgeSocket>>;
  weight: number;
  walkable: boolean;
  dense?: boolean;
  terrain: 'grass' | 'road' | 'water' | 'shore' | 'forest' | 'field' | 'plot';
  biomes?: ReadonlyArray<DistrictBiome>;
}>;

const sockets = (north: EdgeSocket, east: EdgeSocket, south: EdgeSocket, west: EdgeSocket) => ({ north, east, south, west });
const ALL_BIOMES: DistrictBiome[] = ['Town_Center', 'Residential_Suburbs', 'Farmland', 'Forest_Wilderness'];

export const WFC_TILE_RULES: ReadonlyArray<WfcTileRule> = [
  { id: 'grass', sockets: sockets('grass', 'grass', 'grass', 'grass'), weight: 34, walkable: true, terrain: 'grass', biomes: ALL_BIOMES },
  { id: 'forest', sockets: sockets('grass', 'grass', 'grass', 'grass'), weight: 14, walkable: false, terrain: 'forest', biomes: ['Forest_Wilderness', 'Residential_Suburbs'] },
  { id: 'field', sockets: sockets('grass', 'grass', 'grass', 'grass'), weight: 18, walkable: true, terrain: 'field', biomes: ['Farmland'] },
  { id: 'town_plot', sockets: sockets('grass', 'grass', 'grass', 'grass'), weight: 8, walkable: true, dense: true, terrain: 'plot', biomes: ['Town_Center', 'Residential_Suburbs'] },
  { id: 'water', sockets: sockets('water', 'water', 'water', 'water'), weight: 4, walkable: false, terrain: 'water', biomes: ALL_BIOMES },
  { id: 'shore_n', sockets: sockets('grass', 'water', 'water', 'water'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_e', sockets: sockets('water', 'grass', 'water', 'water'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_s', sockets: sockets('water', 'water', 'grass', 'water'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_w', sockets: sockets('water', 'water', 'water', 'grass'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_ne', sockets: sockets('grass', 'grass', 'water', 'water'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_es', sockets: sockets('water', 'grass', 'grass', 'water'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_sw', sockets: sockets('water', 'water', 'grass', 'grass'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_wn', sockets: sockets('grass', 'water', 'water', 'grass'), weight: 2, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'road_ns', sockets: sockets('road', 'grass', 'road', 'grass'), weight: 4, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_ew', sockets: sockets('grass', 'road', 'grass', 'road'), weight: 4, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_ne', sockets: sockets('road', 'road', 'grass', 'grass'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_es', sockets: sockets('grass', 'road', 'road', 'grass'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_sw', sockets: sockets('grass', 'grass', 'road', 'road'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_wn', sockets: sockets('road', 'grass', 'grass', 'road'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_end_n', sockets: sockets('road', 'grass', 'grass', 'grass'), weight: 1, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_end_e', sockets: sockets('grass', 'road', 'grass', 'grass'), weight: 1, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_end_s', sockets: sockets('grass', 'grass', 'road', 'grass'), weight: 1, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_end_w', sockets: sockets('grass', 'grass', 'grass', 'road'), weight: 1, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_cross', sockets: sockets('road', 'road', 'road', 'road'), weight: 1, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
];

const RULE_BY_ID = new Map(WFC_TILE_RULES.map((rule) => [rule.id, rule]));
const opposite: Record<Cardinal, Cardinal> = { north: 'south', east: 'west', south: 'north', west: 'east' };
const directions: ReadonlyArray<Readonly<{ side: Cardinal; dx: number; dy: number }>> = [
  { side: 'north', dx: 0, dy: -1 }, { side: 'east', dx: 1, dy: 0 },
  { side: 'south', dx: 0, dy: 1 }, { side: 'west', dx: -1, dy: 0 },
];

export function wfcRule(tileId: string): WfcTileRule {
  const rule = RULE_BY_ID.get(tileId);
  if (!rule) throw new Error(`unknown WFC tile ${tileId}`);
  return rule;
}

function rng(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function grassBoundary(size: number = WORLD_CHUNK_SIZE): WfcBoundary {
  const edge = () => Array.from({ length: size }, () => 'grass' as const);
  return { north: edge(), east: edge(), south: edge(), west: edge() };
}

function boundaryFilter(rule: WfcTileRule, x: number, y: number, size: number, boundary: WfcBoundary) {
  return (y > 0 || rule.sockets.north === boundary.north[x])
    && (x < size - 1 || rule.sockets.east === boundary.east[y])
    && (y < size - 1 || rule.sockets.south === boundary.south[x])
    && (x > 0 || rule.sockets.west === boundary.west[y]);
}

function weightedOrder(values: string[], random: () => number) {
  const pool = [...values];
  const ordered: string[] = [];
  while (pool.length) {
    const total = pool.reduce((sum, id) => sum + wfcRule(id).weight, 0);
    let cursor = random() * total;
    let selected = 0;
    for (let index = 0; index < pool.length; index++) {
      cursor -= wfcRule(pool[index]).weight;
      if (cursor <= 0) { selected = index; break; }
    }
    ordered.push(pool.splice(selected, 1)[0]);
  }
  return ordered;
}

function propagate(domains: Array<Set<string>>, size: number): boolean {
  const queue = Array.from({ length: domains.length }, (_unused, index) => index);
  while (queue.length) {
    const index = queue.shift()!;
    const x = index % size, y = Math.floor(index / size);
    for (const { side, dx, dy } of directions) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const neighborIndex = ny * size + nx;
      const allowed = new Set<string>();
      for (const neighborId of domains[neighborIndex]) {
        const neighbor = wfcRule(neighborId);
        if ([...domains[index]].some((id) => wfcRule(id).sockets[side] === neighbor.sockets[opposite[side]])) {
          allowed.add(neighborId);
        }
      }
      if (!allowed.size) return false;
      if (allowed.size !== domains[neighborIndex].size) {
        domains[neighborIndex] = allowed;
        queue.push(neighborIndex);
      }
    }
  }
  return true;
}

function solve(domains: Array<Set<string>>, size: number, random: () => number, budget: { nodes: number }): Array<Set<string>> | null {
  if (++budget.nodes > 30_000 || !propagate(domains, size)) return null;
  let choice = -1;
  for (let index = 0; index < domains.length; index++) {
    const count = domains[index].size;
    if (count > 1 && (choice < 0 || count < domains[choice].size)) choice = index;
  }
  if (choice < 0) return domains;
  for (const tileId of weightedOrder([...domains[choice]], random)) {
    const branch = domains.map((domain) => new Set(domain));
    branch[choice] = new Set([tileId]);
    const solved = solve(branch, size, random, budget);
    if (solved) return solved;
  }
  return null;
}

function roadSkeleton(size: number, boundary: WfcBoundary) {
  const center = Math.floor(size / 2);
  const fixed = new Map<number, string>();
  for (let x = 0; x < size; x++) fixed.set(center * size + x, 'road_ew');
  for (let y = 0; y < size; y++) fixed.set(y * size + center, 'road_ns');
  fixed.set(center * size + center, 'road_cross');
  fixed.set(center * size, boundary.west[center] === 'road' ? 'road_ew' : 'road_end_e');
  fixed.set(center * size + size - 1, boundary.east[center] === 'road' ? 'road_ew' : 'road_end_w');
  fixed.set(center, boundary.north[center] === 'road' ? 'road_ns' : 'road_end_s');
  fixed.set((size - 1) * size + center, boundary.south[center] === 'road' ? 'road_ns' : 'road_end_n');
  return fixed;
}

export function generateWfcChunk(options: {
  seed: number;
  biome: DistrictBiome;
  size?: number;
  boundary?: WfcBoundary;
}): { tiles: string[]; edges: WfcBoundary; backtrackNodes: number } {
  const size = options.size ?? WORLD_CHUNK_SIZE;
  if (!Number.isInteger(size) || size < 4 || size > 32) throw new Error('WFC chunk size must be a whole number from 4 to 32');
  const boundary = options.boundary ?? grassBoundary(size);
  for (const side of Object.keys(boundary) as Cardinal[]) {
    if (boundary[side].length !== size) throw new Error(`WFC ${side} boundary must contain ${size} sockets`);
  }
  const available = WFC_TILE_RULES.filter((rule) => !rule.biomes || rule.biomes.includes(options.biome));
  const domains = Array.from({ length: size * size }, (_unused, index) => {
    const x = index % size, y = Math.floor(index / size);
    return new Set(available.filter((rule) => boundaryFilter(rule, x, y, size, boundary)).map((rule) => rule.id));
  });
  for (const [index, tileId] of roadSkeleton(size, boundary)) {
    if (!domains[index].has(tileId)) throw new Error(`road boundary cannot place ${tileId}`);
    domains[index] = new Set([tileId]);
  }
  const budget = { nodes: 0 };
  const solved = solve(domains, size, rng(options.seed), budget);
  if (!solved) throw new Error(`WFC contradiction after ${budget.nodes} backtracking nodes`);
  const tiles = solved.map((domain) => [...domain][0]);
  // Density is a second-order rule: a plot is retained only when an adjacent
  // resolved Wang tile exposes a road socket. Replacing it with grass cannot
  // violate sockets because both plot and grass have grass on every edge.
  for (let index = 0; index < tiles.length; index++) {
    if (!wfcRule(tiles[index]).dense) continue;
    const x = index % size, y = Math.floor(index / size);
    const besideRoad = directions.some(({ dx, dy }) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < size && ny < size && wfcRule(tiles[ny * size + nx]).terrain === 'road';
    });
    if (!besideRoad) tiles[index] = 'grass';
  }
  const edges = chunkEdges(tiles, size);
  validateWfcChunk(tiles, size, boundary);
  return { tiles, edges, backtrackNodes: budget.nodes };
}

export function chunkEdges(tiles: ReadonlyArray<string>, size: number = WORLD_CHUNK_SIZE): WfcBoundary {
  if (tiles.length !== size * size) throw new Error('chunk tile count does not match its size');
  return {
    north: Array.from({ length: size }, (_unused, x) => wfcRule(tiles[x]).sockets.north),
    east: Array.from({ length: size }, (_unused, y) => wfcRule(tiles[y * size + size - 1]).sockets.east),
    south: Array.from({ length: size }, (_unused, x) => wfcRule(tiles[(size - 1) * size + x]).sockets.south),
    west: Array.from({ length: size }, (_unused, y) => wfcRule(tiles[y * size]).sockets.west),
  };
}

export function validateWfcChunk(tiles: ReadonlyArray<string>, size: number, boundary?: WfcBoundary) {
  if (tiles.length !== size * size) throw new Error('chunk tile count does not match its size');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rule = wfcRule(tiles[y * size + x]);
    if (x + 1 < size && rule.sockets.east !== wfcRule(tiles[y * size + x + 1]).sockets.west) {
      throw new Error(`WFC east/west mismatch at ${x},${y}`);
    }
    if (y + 1 < size && rule.sockets.south !== wfcRule(tiles[(y + 1) * size + x]).sockets.north) {
      throw new Error(`WFC north/south mismatch at ${x},${y}`);
    }
    if (rule.dense) {
      const adjacentRoad = directions.some(({ dx, dy }) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < size && ny < size && wfcRule(tiles[ny * size + nx]).terrain === 'road';
      });
      if (!adjacentRoad) throw new Error(`dense plot at ${x},${y} is not beside a road`);
    }
  }
  if (boundary) {
    const edges = chunkEdges(tiles, size);
    for (const side of Object.keys(edges) as Cardinal[]) {
      if (edges[side].some((socket, index) => socket !== boundary[side][index])) throw new Error(`WFC ${side} boundary mismatch`);
    }
  }
  return true;
}

export function boundariesMatch(a: WfcBoundary, sideA: Cardinal, b: WfcBoundary, sideB: Cardinal) {
  return a[sideA].length === b[sideB].length && a[sideA].every((socket, index) => socket === b[sideB][index]);
}
