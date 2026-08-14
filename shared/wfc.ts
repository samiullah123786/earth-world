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
  // Open water outweighs its own rim eight to one. The old weights ran the
  // other way, so the solver built shorelines that enclosed almost nothing and
  // the map filled with rings of bank around a puddle. A lake should be mostly
  // lake; the pruning pass below then deletes whatever is still too small.
  { id: 'water', sockets: sockets('water', 'water', 'water', 'water'), weight: 16, walkable: false, terrain: 'water', biomes: ALL_BIOMES },
  { id: 'shore_n', sockets: sockets('grass', 'water', 'water', 'water'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_e', sockets: sockets('water', 'grass', 'water', 'water'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_s', sockets: sockets('water', 'water', 'grass', 'water'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_w', sockets: sockets('water', 'water', 'water', 'grass'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_ne', sockets: sockets('grass', 'grass', 'water', 'water'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_es', sockets: sockets('water', 'grass', 'grass', 'water'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_sw', sockets: sockets('water', 'water', 'grass', 'grass'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'shore_wn', sockets: sockets('grass', 'water', 'water', 'grass'), weight: 1, walkable: false, terrain: 'shore', biomes: ALL_BIOMES },
  { id: 'road_ns', sockets: sockets('road', 'grass', 'road', 'grass'), weight: 4, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_ew', sockets: sockets('grass', 'road', 'grass', 'road'), weight: 4, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_ne', sockets: sockets('road', 'road', 'grass', 'grass'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_es', sockets: sockets('grass', 'road', 'road', 'grass'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_sw', sockets: sockets('grass', 'grass', 'road', 'road'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  { id: 'road_wn', sockets: sockets('road', 'grass', 'grass', 'road'), weight: 2, walkable: true, terrain: 'road', biomes: ALL_BIOMES },
  // A dead end is legal but almost never wanted: left to its own devices the
  // solver scattered two-tile stubs across open country, which is what made
  // new land read as litter rather than as a place. Banning them outright
  // makes every road a loop and sends the solver into seconds of backtracking,
  // so they stay cheap here and the dangling ones are eroded after collapse.
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

export type TileWeight = (tileId: string) => number;

function weightedOrder(values: string[], random: () => number, weightOf: TileWeight) {
  const pool = [...values];
  const ordered: string[] = [];
  while (pool.length) {
    const total = pool.reduce((sum, id) => sum + weightOf(id), 0);
    let cursor = random() * total;
    let selected = 0;
    for (let index = 0; index < pool.length; index++) {
      cursor -= weightOf(pool[index]);
      if (cursor <= 0) { selected = index; break; }
    }
    ordered.push(pool.splice(selected, 1)[0]);
  }
  return ordered;
}

/**
 * How likely each tile is HERE, as opposed to anywhere.
 *
 * A solver decides one cell from its neighbours and has no way to know that
 * the region wants to be a wood, or a dry plain, or lake country. Left with a
 * single global weight per tile it spreads every feature evenly, which is why
 * ponds appeared at the same size and the same spacing in every chunk. The
 * fields below are sampled at a wavelength of several chunks, so a run of
 * chunks agrees about being wet or wooded and the collapse only decides where
 * inside that region each shoreline falls.
 *
 * Nothing is ever weighted to zero. A neighbour already laid may have promised
 * water at this seam, and a rule that cannot be chosen at all turns that
 * promise into a contradiction; a rule weighted at a fortieth of grass simply
 * never appears unless the seam demands it.
 */
export function tileWeightFor(options: {
  biome: DistrictBiome; wetness?: number; woodedness?: number; avenues?: Avenues;
}): TileWeight {
  const wetness = Math.min(1, Math.max(0, options.wetness ?? 0.5));
  const woodedness = Math.min(1, Math.max(0, options.woodedness ?? 0.5));
  const avenues = options.avenues ?? { northSouth: true, eastWest: true };
  const served = avenues.northSouth || avenues.eastWest;
  return (tileId: string) => {
    const rule = wfcRule(tileId);
    if (rule.terrain === 'water' || rule.terrain === 'shore') {
      // Dry country keeps a trace so a lake can still cross into it.
      return rule.weight * (0.04 + wetness * wetness * 1.6);
    }
    if (rule.terrain === 'road') {
      // A road exists to get somewhere. Chunks with no avenue through them are
      // open country, and the solver used to fill them with closed loops of
      // road serving nothing - legal, since a loop has no dead end to prune,
      // and pure litter. Side streets belong where there is a street to join.
      if (!served) return rule.weight * 0.02;
      return rule.weight * (options.biome === 'Town_Center' ? 1.4
        : options.biome === 'Residential_Suburbs' ? 0.8 : 0.25);
    }
    if (rule.terrain === 'forest') {
      const reach = options.biome === 'Forest_Wilderness' ? 2.6 : 1;
      return rule.weight * (0.25 + woodedness * reach);
    }
    return rule.weight;
  };
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

function solve(
  domains: Array<Set<string>>, size: number, random: () => number,
  budget: { nodes: number }, weightOf: TileWeight,
): Array<Set<string>> | null {
  if (++budget.nodes > 30_000 || !propagate(domains, size)) return null;
  let choice = -1;
  for (let index = 0; index < domains.length; index++) {
    const count = domains[index].size;
    if (count > 1 && (choice < 0 || count < domains[choice].size)) choice = index;
  }
  if (choice < 0) return domains;
  for (const tileId of weightedOrder([...domains[choice]], random, weightOf)) {
    const branch = domains.map((domain) => new Set(domain));
    branch[choice] = new Set([tileId]);
    const solved = solve(branch, size, random, budget, weightOf);
    if (solved) return solved;
  }
  return null;
}

/**
 * Where a chunk carries a public road, and in which direction.
 *
 * Every chunk used to be given a full crossroads through its middle. Sixteen
 * tiles apart in both directions, that is not a street plan, it is a lattice:
 * it drew the generator's own chunk grid across the countryside and was the
 * loudest artificial thing on the new map. Avenues now fall on every third
 * chunk line, so most chunks carry no road at all and the ones that do form
 * long continuous streets.
 *
 * The rule reads only the chunk's own coordinates, so two neighbours always
 * agree about the seam between them without consulting each other.
 */
export const AVENUE_SPACING = 3;
export function chunkAvenues(chunkX: number, chunkY: number) {
  const on = (value: number) => ((value % AVENUE_SPACING) + AVENUE_SPACING) % AVENUE_SPACING === 1;
  return { northSouth: on(chunkX), eastWest: on(chunkY) };
}

export type Avenues = Readonly<{ northSouth: boolean; eastWest: boolean }>;

function roadSkeleton(size: number, boundary: WfcBoundary, avenues: Avenues) {
  const center = Math.floor(size / 2);
  const fixed = new Map<number, string>();
  if (avenues.eastWest) for (let x = 0; x < size; x++) fixed.set(center * size + x, 'road_ew');
  if (avenues.northSouth) for (let y = 0; y < size; y++) fixed.set(y * size + center, 'road_ns');
  if (avenues.eastWest && avenues.northSouth) fixed.set(center * size + center, 'road_cross');
  if (avenues.eastWest) {
    fixed.set(center * size, boundary.west[center] === 'road' ? 'road_ew' : 'road_end_e');
    fixed.set(center * size + size - 1, boundary.east[center] === 'road' ? 'road_ew' : 'road_end_w');
  }
  if (avenues.northSouth) {
    fixed.set(center, boundary.north[center] === 'road' ? 'road_ns' : 'road_end_s');
    fixed.set((size - 1) * size + center, boundary.south[center] === 'road' ? 'road_ns' : 'road_end_n');
  }
  return fixed;
}

/**
 * The one road tile for each set of directions the road actually leaves by.
 * The vocabulary has no T-junction, which is why a three-way mask cannot
 * occur and is not listed.
 */
const ROAD_BY_EXITS = new Map<number, string>([
  [0b1111, 'road_cross'],
  [0b1010, 'road_ns'], [0b0101, 'road_ew'],
  [0b1100, 'road_ne'], [0b0110, 'road_es'], [0b0011, 'road_sw'], [0b1001, 'road_wn'],
  [0b1000, 'road_end_n'], [0b0100, 'road_end_e'], [0b0010, 'road_end_s'], [0b0001, 'road_end_w'],
]);
const EXIT_BIT: Record<Cardinal, number> = { north: 0b1000, east: 0b0100, south: 0b0010, west: 0b0001 };

/**
 * Erode road branches that lead nowhere, the way dead ends are pruned from a
 * maze: a road cell reached by only one other road cell is deleted, and the
 * deletion repeats until only through-routes, loops and protected cells
 * remain. The avenue laid by the skeleton is protected, so a street can still
 * end honestly at the frontier - what cannot survive is a stub in a meadow.
 *
 * Deleting a cell changes which way its neighbour leaves, so each surviving
 * road tile is re-chosen from the exits it actually still has.
 */
function trimRoadDeadEnds(tiles: string[], size: number, protectedCells: ReadonlySet<number>): number {
  const isRoad = (index: number) => wfcRule(tiles[index]).terrain === 'road';
  const exitsOf = (index: number) => {
    const x = index % size, y = Math.floor(index / size);
    let mask = 0;
    for (const { side, dx, dy } of directions) {
      if (wfcRule(tiles[index]).sockets[side] !== 'road') continue;
      const nx = x + dx, ny = y + dy;
      // A road leaving the chunk is a promise to the neighbour, so it counts
      // as a connection and can never be eroded away.
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) { mask |= EXIT_BIT[side]; continue; }
      const neighbor = ny * size + nx;
      if (isRoad(neighbor) && wfcRule(tiles[neighbor]).sockets[opposite[side]] === 'road') mask |= EXIT_BIT[side];
    }
    return mask;
  };
  const reword = () => {
    for (let index = 0; index < tiles.length; index++) {
      if (!isRoad(index)) continue;
      const replacement = ROAD_BY_EXITS.get(exitsOf(index));
      if (replacement) tiles[index] = replacement;
    }
  };
  // Erode one tip at a time. Erasing a whole layer at once can cut the last
  // link of a cell that must stay, and the vocabulary has no tile for a road
  // that leaves in no direction - which is exactly how a seam mismatch got
  // written into a chunk that had validated a moment earlier.
  let removed = 0;
  for (let pass = 0; pass < tiles.length; pass++) {
    let victim = -1;
    for (let index = 0; index < tiles.length && victim < 0; index++) {
      if (!isRoad(index)) continue;
      const exits = exitsOf(index);
      const isTip = exits === 0 || (exits & (exits - 1)) === 0;
      if (!isTip) continue;
      // An orphan has nothing left to protect and must go whatever it is.
      if (exits !== 0) {
        if (protectedCells.has(index)) continue;
        const x = index % size, y = Math.floor(index / size);
        const unsafe = directions.some(({ side, dx, dy }) => {
          if (wfcRule(tiles[index]).sockets[side] !== 'road') return false;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) return false;
          const neighbor = ny * size + nx;
          if (!isRoad(neighbor)) return false;
          const left = exitsOf(neighbor) & ~EXIT_BIT[opposite[side]];
          // Never take the last road away from a cell that has to keep one.
          if (left === 0) return protectedCells.has(neighbor);
          // A crossroads losing one arm would need a T-junction, and the
          // vocabulary has none. Leave that arm where it is.
          return !ROAD_BY_EXITS.has(left);
        });
        if (unsafe) continue;
      }
      victim = index;
    }
    if (victim < 0) break;
    tiles[victim] = 'grass';
    removed += 1;
    reword();
  }
  return removed;
}

/**
 * Give woods and farmland a shape.
 *
 * Grass, forest, field and plot all show grass on every side, so the solver is
 * free to put any of them anywhere - and being free, it sprinkled them one
 * cell at a time. Sixty single trees spread evenly over a chunk is not a wood,
 * and sixty single crop squares is not a farm; both read as litter, which is
 * exactly what they looked like.
 *
 * These features carry no adjacency information, so nothing is lost by
 * deciding them outside the collapse - and outside it, they can be given the
 * scale they actually have. A coarse hash picks which blocks of land are
 * grove or parcel, and a second hash ragged-edges the blocks so they are not
 * squares. This is the same grove rule the hand-tuned wilderness pass uses at
 * the founding border, which is the part of the generated map that already
 * looked right.
 *
 * Only ground is ever rewritten. Roads, water and shoreline carry sockets that
 * neighbours depend on, and a plot is answerable to the density rule, so all
 * of them are left exactly as the collapse left them.
 */
const GROVE_BLOCK = 5;
const PARCEL_BLOCK = 4;

function blockHash(bx: number, by: number, salt: number) {
  let h = (Math.imul(bx + 0x9e37, 0x85ebca6b) ^ Math.imul(by + 0x79b1, 0xc2b2ae35) ^ Math.imul(salt, 0x27d4eb2f)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0) / 0x1_0000_0000;
}

export function shapeGroundFeatures(options: {
  tiles: string[];
  size: number;
  origin: { x: number; y: number };
  biome: DistrictBiome;
  woodedness: number;
  keepClear?: ReadonlySet<number>;
}) {
  const { tiles, size, origin, biome, woodedness } = options;
  const keepClear = options.keepClear ?? new Set<number>();
  // How much of the district is wooded at all, before grove shape is applied.
  const groveChance = biome === 'Forest_Wilderness' ? 0.16 + woodedness * 0.26
    : biome === 'Residential_Suburbs' ? 0.06 + woodedness * 0.1
      : 0.03 + woodedness * 0.05;
  const parcelChance = biome === 'Farmland' ? 0.42 : 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = y * size + x;
    if (keepClear.has(index)) continue;
    const terrain = wfcRule(tiles[index]).terrain;
    if (terrain !== 'grass' && terrain !== 'forest' && terrain !== 'field') continue;
    const worldX = origin.x + x, worldY = origin.y + y;
    // Groves and parcels are keyed on world position, so a wood that starts in
    // one chunk carries on into the next instead of stopping at the seam.
    const grove = blockHash(Math.floor(worldX / GROVE_BLOCK), Math.floor(worldY / GROVE_BLOCK), 17) < groveChance;
    const parcel = blockHash(Math.floor(worldX / PARCEL_BLOCK), Math.floor(worldY / PARCEL_BLOCK), 29) < parcelChance;
    if (grove && blockHash(worldX, worldY, 31) < 0.66) tiles[index] = 'forest';
    else if (parcel) tiles[index] = 'field';
    else tiles[index] = 'grass';
  }
}

/** A lake smaller than this is a puddle, and puddles read as noise. */
export const MIN_WATER_REGION = 10;
/** A loop of road shorter than this leads nowhere worth walking. */
export const MIN_ROAD_REGION = 8;

/**
 * Delete features too small to mean anything, and only those.
 *
 * Adjacency alone cannot say "make lakes big": the solver decides one cell at
 * a time and a legal three-tile pond is as valid as a legal thirty-tile one.
 * The standard answer is to let it collapse freely and then measure connected
 * regions, erasing the ones under a threshold - the same minimum-region pass
 * used to clean cave generators.
 *
 * Erasing a WHOLE region is what keeps the chunk legal. Every feature tile
 * shows grass on the sides that face out of its region, so once the entire
 * region is grass, every edge it had with the rest of the chunk is grass to
 * grass. A region touching the chunk border with a live socket is left alone
 * whatever its size: the neighbour has already been promised that seam.
 */
export function pruneStrayFeatures(
  tiles: string[],
  size: number,
  boundary: WfcBoundary,
  protectedCells: ReadonlySet<number> = new Set(),
): number {
  let removed = trimRoadDeadEnds(tiles, size, protectedCells);
  const visited = new Array<boolean>(tiles.length).fill(false);
  const at = (x: number, y: number) => tiles[y * size + x];
  for (let start = 0; start < tiles.length; start++) {
    if (visited[start]) continue;
    const socket: EdgeSocket | null = wfcRule(tiles[start]).terrain === 'water' || wfcRule(tiles[start]).terrain === 'shore'
      ? 'water'
      : wfcRule(tiles[start]).terrain === 'road' ? 'road' : null;
    if (!socket) continue;
    const region: number[] = [];
    const queue = [start];
    visited[start] = true;
    let pinned = false;
    let core = 0;
    while (queue.length) {
      const index = queue.pop()!;
      region.push(index);
      const x = index % size, y = Math.floor(index / size);
      const rule = wfcRule(tiles[index]);
      if (rule.terrain === 'water' || rule.terrain === 'road') core += 1;
      for (const { side, dx, dy } of directions) {
        if (rule.sockets[side] !== socket) continue;
        const nx = x + dx, ny = y + dy;
        // A live socket pointing off the chunk is a promise to the neighbour.
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) { pinned = true; continue; }
        const neighbor = ny * size + nx;
        if (visited[neighbor] || wfcRule(at(nx, ny)).sockets[opposite[side]] !== socket) continue;
        visited[neighbor] = true;
        queue.push(neighbor);
      }
    }
    if (pinned) continue;
    const floor = socket === 'water' ? MIN_WATER_REGION : MIN_ROAD_REGION;
    // Size alone is not enough. A lake can sprawl into a thin web of shoreline
    // that is large in total and yet nowhere more than a tile of open water
    // wide - big enough to pass a size check and still read as scattered
    // litter. A real body of water is mostly water, so the bank has to be
    // earning its place: at least a third of the region, and never a ring
    // around nothing.
    const substantial = region.length >= floor && core >= 4 && core * 3 >= region.length;
    if (substantial) continue;
    for (const index of region) tiles[index] = 'grass';
    removed += region.length;
  }
  // Sockets are checked here; the density rule is not, because erasing a road
  // is exactly what can orphan a plot beside it and the caller re-runs that
  // rule immediately afterwards.
  if (removed) validateWfcChunk(tiles, size, boundary, { density: false });
  return removed;
}

export function generateWfcChunk(options: {
  seed: number;
  biome: DistrictBiome;
  size?: number;
  boundary?: WfcBoundary;
  /** Regional fields, 0..1. Omitted means "middling", the old behaviour. */
  wetness?: number;
  woodedness?: number;
  /** Which public roads cross this chunk. Omitted means both, as before. */
  avenues?: Avenues;
  /** Where this chunk sits in the world, so groves cross its seams. */
  origin?: { x: number; y: number };
  /**
   * Cells that must come out as plain walkable ground, given in chunk-local
   * coordinates. Land somebody already owns is not the generator's to
   * redecorate: re-laying terrain under a standing house cannot be allowed to
   * put a lake where the front door is. Pinning them before the collapse -
   * rather than painting over the result - keeps every socket honest.
   */
  keepClear?: ReadonlyArray<{ x: number; y: number }>;
}): { tiles: string[]; edges: WfcBoundary; backtrackNodes: number } {
  const size = options.size ?? WORLD_CHUNK_SIZE;
  if (!Number.isInteger(size) || size < 4 || size > 32) throw new Error('WFC chunk size must be a whole number from 4 to 32');
  const boundary = options.boundary ?? grassBoundary(size);
  for (const side of Object.keys(boundary) as Cardinal[]) {
    if (boundary[side].length !== size) throw new Error(`WFC ${side} boundary must contain ${size} sockets`);
  }
  // Weight zero means "never chosen freely" - the avenue caps below still
  // place those tiles by name where the world genuinely ends.
  const available = WFC_TILE_RULES.filter((rule) => rule.weight > 0 && (!rule.biomes || rule.biomes.includes(options.biome)));
  const domains = Array.from({ length: size * size }, (_unused, index) => {
    const x = index % size, y = Math.floor(index / size);
    return new Set(available.filter((rule) => boundaryFilter(rule, x, y, size, boundary)).map((rule) => rule.id));
  });
  const clear = new Set<number>();
  for (const cell of options.keepClear ?? []) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= size || cell.y >= size) continue;
    const index = cell.y * size + cell.x;
    if (!domains[index].has('grass')) throw new Error(`cannot keep (${cell.x},${cell.y}) clear against this boundary`);
    domains[index] = new Set(['grass']);
    clear.add(index);
  }
  const skeleton = roadSkeleton(size, boundary, options.avenues ?? { northSouth: true, eastWest: true });
  for (const [index, tileId] of skeleton) {
    const x = index % size, y = Math.floor(index / size);
    if (!boundaryFilter(wfcRule(tileId), x, y, size, boundary)) throw new Error(`road boundary cannot place ${tileId}`);
    domains[index] = new Set([tileId]);
  }
  const budget = { nodes: 0 };
  const weightOf = tileWeightFor({ ...options, avenues: options.avenues });
  const solved = solve(domains, size, rng(options.seed), budget, weightOf);
  if (!solved) throw new Error(`WFC contradiction after ${budget.nodes} backtracking nodes`);
  const tiles = solved.map((domain) => [...domain][0]);
  // Measure and erase strays before the density rule runs, so a plot is never
  // kept beside a road that is about to be deleted. The avenue is protected:
  // it is the one road that is meant to reach the frontier and stop.
  pruneStrayFeatures(tiles, size, boundary, new Set(skeleton.keys()));
  if (options.origin) {
    shapeGroundFeatures({
      tiles, size, origin: options.origin, biome: options.biome,
      woodedness: Math.min(1, Math.max(0, options.woodedness ?? 0.5)),
      keepClear: clear,
    });
  }
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

export function validateWfcChunk(
  tiles: ReadonlyArray<string>,
  size: number,
  boundary?: WfcBoundary,
  options: { density?: boolean } = {},
) {
  const checkDensity = options.density !== false;
  if (tiles.length !== size * size) throw new Error('chunk tile count does not match its size');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rule = wfcRule(tiles[y * size + x]);
    if (x + 1 < size && rule.sockets.east !== wfcRule(tiles[y * size + x + 1]).sockets.west) {
      throw new Error(`WFC east/west mismatch at ${x},${y}`);
    }
    if (y + 1 < size && rule.sockets.south !== wfcRule(tiles[(y + 1) * size + x]).sockets.north) {
      throw new Error(`WFC north/south mismatch at ${x},${y}`);
    }
    if (rule.dense && checkDensity) {
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
