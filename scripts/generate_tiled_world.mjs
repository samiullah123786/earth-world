import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collisionSource = await readFile(path.join(root, 'convex', 'tiledFounding.ts'), 'utf8');
const rowsMatch = collisionSource.match(/export const ROWS(?::[^=]+)? = (\[[\s\S]*?\]);/);
if (!rowsMatch) throw new Error('Could not read the founding collision rows');
const rows = JSON.parse(rowsMatch[1]);
const height = rows.length;
const width = rows[0]?.length ?? 0;
if (!width || rows.some((row) => row.length !== width || /[^01]/.test(row))) {
  throw new Error('Founding collision rows are malformed');
}

const MAP_WIDTH = 256;
const MAP_HEIGHT = 256;
const TILE = 32;
const GID = {
  grass: 16,
  cobbleFill: 69,
  treeFirst: 75,
  waterFirst: 37,
  // The canopy sheet's dense centre tile, used at ground level as undergrowth.
  forestFloor: 75 + 7,
  trunkFirst: 200,
  bridgeFirst: 230,
};

/**
 * The LPC terrain sheets are 3 wide by 6 tall, and that layout is a contract,
 * not a coincidence: rows two to four are a nine-slice, and the bottom row is
 * plain fill. Painting every cell with the single centre tile - which is what
 * the first version of this generator did - throws away the whole reason the
 * sheet is shaped that way, and the result reads as a flat green bedsheet.
 */
const slice = (first) => ({
  topLeft: first + 6, top: first + 7, topRight: first + 8,
  left: first + 9, centre: first + 10, right: first + 11,
  bottomLeft: first + 12, bottom: first + 13, bottomRight: first + 14,
  fill: [first + 15, first + 16, first + 17],
});
const WATER = slice(GID.waterFirst);
const GRASS_FILL = [GID.grass, GID.grass + 1, GID.grass + 2];

/** Stable per-cell variation: the same tile every time, never a shimmer. */
const vary = (x, y, salt) => {
  let h = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x79b1, 0xc2b2ae35) ^ Math.imul(salt, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0);
};

/** Which nine-slice tile edges a cell, given which neighbours share its region. */
const sliceTile = (region, inRegion, x, y, salt) => {
  const north = inRegion(x, y - 1), south = inRegion(x, y + 1);
  const west = inRegion(x - 1, y), east = inRegion(x + 1, y);
  if (north && south && west && east) return region.fill[vary(x, y, salt) % region.fill.length];
  if (!north && !west) return region.topLeft;
  if (!north && !east) return region.topRight;
  if (!south && !west) return region.bottomLeft;
  if (!south && !east) return region.bottomRight;
  if (!north) return region.top;
  if (!south) return region.bottom;
  if (!west) return region.left;
  return region.right;
};

const blank = () => new Array(MAP_WIDTH * MAP_HEIGHT).fill(0);
const ground = blank();
const collision = blank();
const overhead = blank();
const at = (x, y) => y * MAP_WIDTH + x;
const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height || rows[y][x] === '1';

for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  ground[at(x, y)] = GRASS_FILL[vary(x, y, 11) % GRASS_FILL.length];
}

/**
 * The river, put back.
 *
 * The founding map's collision grid records only that a cell is impassable, so
 * the migration to Tiled kept the river's SHAPE - every tile of it still blocks
 * - while losing the fact that it was water at all, and the map came out an
 * unbroken green field with mysteriously unwalkable stripes through it. The
 * mask below is recovered from the original hand-authored map, and the water
 * sheet's own nine-slice draws its banks, so the river reads as a river again
 * without a single collision cell moving.
 */
const terrain = JSON.parse(readFileSync(new URL('./founding-terrain.json', import.meta.url), 'utf8'));
const kindAt = (x, y) => (x >= 0 && y >= 0 && x < terrain.width && y < terrain.height
  ? terrain.rows[y][x] : '.');
const isWater = (x, y) => kindAt(x, y) === 'w';
const isForest = (x, y) => kindAt(x, y) === 'f';
// The sheet's nine-slice edges are deliberately part-transparent so they can
// be laid OVER a base terrain, and the ground layer has room for exactly one
// tile per cell - so an edge tile here would show the void through its corners
// rather than grass. Until there is a terrain overlay layer to hold them, the
// river is drawn from the sheet's opaque fill row: solid water, honest edges.
/**
 * The collision layer, drawn.
 *
 * It shipped invisible and filled with a grass tile - a pure mask - which is
 * why the world had nothing standing in it: the only visible layers were the
 * ground under everything and the canopies above it, with the entire middle of
 * the world blank. The engine spec always called this layer "walls, furniture";
 * this makes it so. Every blocked cell now carries the art of the thing that
 * blocks it, which also means the mask can never drift from what a player sees:
 * if you can see it, it stops you, and if it stops you, you can see it.
 */
let waterPainted = 0, forestPainted = 0;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  if (!blocked(x, y)) continue;
  if (isWater(x, y)) {
    collision[at(x, y)] = WATER.fill[vary(x, y, 23) % WATER.fill.length];
    waterPainted += 1;
  } else {
    // Undergrowth at eye level; the canopy pass lays crowns over the top.
    collision[at(x, y)] = GID.forestFloor;
    forestPainted += 1;
  }
}

// A small number of deliberate avenues connect the existing neighborhoods.
// Connector cells are painted only where the authoritative founding grid is
// walkable, so the road never advertises a route the Kernel will refuse.
const avenueCells = new Set();
// Where an avenue meets the river it becomes a bridge, and the direction it
// was travelling decides which way the planks run.
const bridgeCells = new Map();
const line = (x0, y0, x1, y1) => {
  let x = x0, y = y0;
  const vertical = x0 === x1;
  while (true) {
    if (isWater(x, y)) bridgeCells.set(`${x},${y}`, vertical);
    else if (!blocked(x, y)) avenueCells.add(`${x},${y}`);
    if (x === x1 && y === y1) break;
    if (x !== x1) x += Math.sign(x1 - x);
    else y += Math.sign(y1 - y);
  }
};
line(32, 0, 32, 47);
line(0, 24, 63, 24);
line(14, 38, 63, 38);
line(22, 24, 22, 47);
line(46, 9, 46, 42);
line(32, 14, 46, 14);
for (const key of avenueCells) {
  const [x, y] = key.split(',').map(Number);
  ground[at(x, y)] = GID.cobbleFill;
}

/**
 * Bridges, and the crossings they open.
 *
 * The river splits the founding map in two, and every avenue that reached it
 * simply stopped - the road ended at the water with nothing there, because the
 * generator skipped any cell it could not walk on. A town with a river through
 * the middle needs somewhere to cross it.
 *
 * This is a deliberate change to what the world allows, not a repaint: the
 * cells below stop blocking. That is the point of a bridge. It only ever makes
 * ground MORE walkable, so no route that worked before can break, and the
 * change is idempotent - a crossing that is already open stays open.
 */
const BRIDGE_DECK_HORIZONTAL = GID.bridgeFirst + 28;
const BRIDGE_DECK_VERTICAL = GID.bridgeFirst + 19;
let bridgesLaid = 0;
for (const [key, vertical] of bridgeCells) {
  const [x, y] = key.split(',').map(Number);
  ground[at(x, y)] = vertical ? BRIDGE_DECK_VERTICAL : BRIDGE_DECK_HORIZONTAL;
  collision[at(x, y)] = 0;
  rows[y] = `${rows[y].slice(0, x)}0${rows[y].slice(x + 1)}`;
  bridgesLaid += 1;
}

// Complete 3x3 LPC tree compositions, never isolated canopy fragments. Only
// fully blocked 3x3 regions qualify, so visual mass and Kernel collision agree.
// The canopy sheet is six tiles wide and carries more than one tree. Using
// only the first of them made every wood on Earth the same shrub, repeated.
const treeVariants = [0, 3].map((column) => [
  GID.treeFirst + column + 0, GID.treeFirst + column + 1, GID.treeFirst + column + 2,
  GID.treeFirst + column + 6, GID.treeFirst + column + 7, GID.treeFirst + column + 8,
  GID.treeFirst + column + 12, GID.treeFirst + column + 13, GID.treeFirst + column + 14,
]);
const occupied = new Set();
let trunksPlanted = 0;
for (let y = 0; y <= height - 3; y += 2) for (let x = 0; x <= width - 3; x += 2) {
  const cells = Array.from({ length: 9 }, (_unused, index) => ({ x: x + index % 3, y: y + Math.floor(index / 3) }));
  if (!cells.every((cell) => blocked(cell.x, cell.y) && !occupied.has(`${cell.x},${cell.y}`)
    && !isWater(cell.x, cell.y))) continue;
  const variant = vary(x, y, 37) % treeVariants.length;
  const treeTiles = treeVariants[variant];
  cells.forEach((cell, index) => {
    overhead[at(cell.x, cell.y)] = treeTiles[index];
    occupied.add(`${cell.x},${cell.y}`);
  });
  // A trunk, one tile wide and two tall, under the middle of the crown.
  const trunkTop = GID.trunkFirst + (variant === 0 ? 1 : 4);
  collision[at(x + 1, y + 1)] = trunkTop;
  collision[at(x + 1, y + 2)] = trunkTop + 6;
  trunksPlanted += 1;
}

const properties = (values) => Object.entries(values).map(([name, value]) => ({
  name,
  type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
  value,
}));

const zones = [
  ['zone:common-field', 'the Common Field', 'farm', 20, 34, 6, 4, 'watering_can'],
  ['zone:north-orchard', 'the North Orchard', 'orchard', 40, 12, 5, 4, 'axe'],
  ['zone:east-woodlot', 'the East Woodlot', 'forest', 52, 26, 5, 5, 'axe'],
  ['zone:south-quarry', 'the South Quarry', 'quarry', 30, 40, 4, 4, 'pickaxe'],
  ['venue:founding-plaza', 'Founding Plaza', 'plaza', 30, 22, 5, 5, 'none'],
  ['venue:maple-park', 'Maple Park', 'park', 37, 36, 5, 5, 'none'],
  ['venue:training-green', 'Training Green', 'minigame', 43, 33, 7, 7, 'none'],
].map(([zoneId, name, kind, x, y, w, h, tool], index) => ({
  id: index + 1,
  name,
  type: 'spatial_zone',
  x: x * TILE,
  y: y * TILE,
  width: w * TILE,
  height: h * TILE,
  rotation: 0,
  visible: true,
  properties: properties({ zoneId, kind, tool }),
}));

const tileset = (firstgid, name, image, imagewidth, imageheight, extra = {}) => ({
  firstgid,
  name,
  tilewidth: TILE,
  tileheight: TILE,
  tilecount: (imagewidth / TILE) * (imageheight / TILE),
  columns: imagewidth / TILE,
  image,
  imagewidth,
  imageheight,
  margin: 0,
  spacing: 0,
  ...extra,
});

const map = {
  compressionlevel: -1,
  height: MAP_HEIGHT,
  infinite: false,
  layers: [
    { id: 1, name: 'GroundLayer', type: 'tilelayer', x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT, opacity: 1, visible: true, data: ground },
    { id: 2, name: 'CollisionLayer', type: 'tilelayer', x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT, opacity: 0, visible: false, data: collision,
      properties: properties({ collisionMetadata: true }) },
    { id: 3, name: 'OverheadLayer', type: 'tilelayer', x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT, opacity: 1, visible: true, data: overhead },
    { id: 4, name: 'InteractiveZones', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: zones },
  ],
  nextlayerid: 5,
  nextobjectid: zones.length + 1,
  orientation: 'orthogonal',
  renderorder: 'right-down',
  tiledversion: '1.11.2',
  tileheight: TILE,
  tilewidth: TILE,
  type: 'map',
  version: '1.10',
  width: MAP_WIDTH,
  properties: properties({ mapFormat: 'tiled-v1', mapVersion: 2, foundingWidth: width, foundingHeight: height }),
  tilesets: [
    tileset(1, 'lpc-grass', '../lpc_framework/world_tiles/terrain/grass.png', 96, 192, {
      tiles: [{ id: 15, properties: properties({ collides: true }) }],
    }),
    tileset(19, 'lpc-dirt', '../lpc_framework/world_tiles/terrain/dirt.png', 96, 192),
    tileset(37, 'lpc-water', '../lpc_framework/world_tiles/terrain/water.png', 96, 192),
    tileset(55, 'lpc-cobble', '../lpc_framework/world_tiles/terrain/castlefloors_outside.png', 128, 160),
    tileset(75, 'lpc-trees', '../lpc_framework/world_tiles/props_outdoor/treetop.png', 192, 224),
    tileset(117, 'lpc-house', '../lpc_framework/world_tiles/architecture/house.png', 288, 224),
    tileset(180, 'lpc-farming', '../lpc_framework/world_tiles/farming/crop_growth.png', 160, 32),
    tileset(200, 'lpc-trunks', '../lpc_framework/world_tiles/props_outdoor/trunk.png', 192, 96),
    tileset(230, 'lpc-bridges', '../lpc_framework/world_tiles/architecture/bridges.png', 192, 224),
  ],
};

const mapsDir = path.join(root, 'public', 'assets', 'maps');
await mkdir(mapsDir, { recursive: true });
await writeFile(path.join(mapsDir, 'agentsearth-v5.tmj'), `${JSON.stringify(map)}\n`, 'utf8');

const generated = `// Generated by scripts/generate_tiled_world.mjs from the founding Tiled collision export.\n`
  + `// The .tmj is the visual/map interchange source; this compact row form is bundled into Convex.\n`
  + `export const TILED_FOUNDING_FORMAT = 'tiled-v1' as const;\n`
  + `export const W = ${width};\nexport const H = ${height};\n`
  + `export const ROWS: readonly string[] = ${JSON.stringify(rows)};\n`
  + `export const walkable = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y)\n`
  + `  && x >= 0 && y >= 0 && x < W && y < H && ROWS[y][x] === '0';\n`;
await writeFile(path.join(root, 'convex', 'tiledFounding.ts'), generated, 'utf8');

console.log(`Generated agentsearth-v5.tmj (${MAP_WIDTH}x${MAP_HEIGHT}) and Convex founding collision (${width}x${height}).`);
console.log(`  water ${waterPainted} · forest ${forestPainted} · trunks ${trunksPlanted} · bridge decks ${bridgesLaid}`);
