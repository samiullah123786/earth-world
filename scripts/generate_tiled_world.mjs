import { readFile, mkdir, writeFile } from 'node:fs/promises';
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
  cobbleLeft: 63,
  cobbleMiddle: 64,
  cobbleRight: 65,
  treeFirst: 75,
};

const blank = () => new Array(MAP_WIDTH * MAP_HEIGHT).fill(0);
const ground = blank();
const collision = blank();
const overhead = blank();
const at = (x, y) => y * MAP_WIDTH + x;
const blocked = (x, y) => x < 0 || y < 0 || x >= width || y >= height || rows[y][x] === '1';

for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  ground[at(x, y)] = GID.grass;
  if (blocked(x, y)) collision[at(x, y)] = GID.grass;
}

// A small number of deliberate avenues connect the existing neighborhoods.
// Connector cells are painted only where the authoritative founding grid is
// walkable, so the road never advertises a route the Kernel will refuse.
const avenueCells = new Set();
const line = (x0, y0, x1, y1) => {
  let x = x0, y = y0;
  while (true) {
    if (!blocked(x, y)) avenueCells.add(`${x},${y}`);
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
  ground[at(x, y)] = [GID.cobbleLeft, GID.cobbleMiddle, GID.cobbleRight][(x + y) % 3];
}

// Complete 3x3 LPC tree compositions, never isolated canopy fragments. Only
// fully blocked 3x3 regions qualify, so visual mass and Kernel collision agree.
const treeTiles = [
  GID.treeFirst + 0, GID.treeFirst + 1, GID.treeFirst + 2,
  GID.treeFirst + 6, GID.treeFirst + 7, GID.treeFirst + 8,
  GID.treeFirst + 12, GID.treeFirst + 13, GID.treeFirst + 14,
];
const occupied = new Set();
for (let y = 0; y <= height - 3; y += 2) for (let x = 0; x <= width - 3; x += 2) {
  const cells = Array.from({ length: 9 }, (_unused, index) => ({ x: x + index % 3, y: y + Math.floor(index / 3) }));
  if (!cells.every((cell) => blocked(cell.x, cell.y) && !occupied.has(`${cell.x},${cell.y}`))) continue;
  cells.forEach((cell, index) => {
    overhead[at(cell.x, cell.y)] = treeTiles[index];
    occupied.add(`${cell.x},${cell.y}`);
  });
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
  properties: properties({ mapFormat: 'tiled-v1', mapVersion: 1, foundingWidth: width, foundingHeight: height }),
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
