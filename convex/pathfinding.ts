import EasyStar from 'easystarjs';
import { H, ROWS, W, walkable } from './walkable';

export type GridPoint = { x: number; y: number };

export type WorldBounds = { width: number; height: number };

// Land beyond the founding map is WILDERNESS, not a copy of the town: open
// meadow with organic tree groves and nothing man-made. Citizens civilize it
// later by claiming plots. The client renders from the identical functions
// below, so what the eye sees is exactly what the pathfinder walks.
export function wildHash(x: number, y: number, salt: number) {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0);
}

// Groves cluster in roughly a third of 6x6 cells, so meadows stay open.
export function isGroveCell(x: number, y: number) {
  return wildHash(Math.floor(x / 6), Math.floor(y / 6), 7) % 100 < 34;
}

export function isTreeAnchor(x: number, y: number) {
  return isGroveCell(x, y) && wildHash(x, y, 11) % 17 === 0;
}

// A tree blocks its trunk row: the anchor tile and one tile either side.
export function wildBlocked(x: number, y: number) {
  return isTreeAnchor(x, y) || isTreeAnchor(x - 1, y) || isTreeAnchor(x + 1, y);
}

export function walkableInWorld(x: number, y: number, bounds: WorldBounds = { width: W, height: H }) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= bounds.width || ty >= bounds.height) return false;
  if (tx < W && ty < H) return walkable(tx, ty);
  return !wildBlocked(tx, ty);
}

export function findRoute(
  fromX: number, fromY: number, toX: number, toY: number,
  bounds: WorldBounds = { width: W, height: H },
): GridPoint[] | null {
  const sx = Math.floor(fromX);
  const sy = Math.floor(fromY);
  const tx = Math.floor(toX);
  const ty = Math.floor(toY);
  if (![sx, sy, tx, ty].every(Number.isInteger)) return null;
  if (!walkableInWorld(sx, sy, bounds) || !walkableInWorld(tx, ty, bounds)) return null;

  const grid = Array.from({ length: bounds.height }, (_row, y) =>
    Array.from({ length: bounds.width }, (_cell, x) => walkableInWorld(x, y, bounds) ? 0 : 1),
  );

  const finder = new EasyStar.js();
  finder.setGrid(grid);
  finder.setAcceptableTiles([0]);
  finder.enableSync();
  let result: GridPoint[] | null = null;
  finder.findPath(sx, sy, tx, ty, (path) => {
    result = path?.map(({ x, y }) => ({ x, y })) ?? null;
  });
  finder.calculate();
  return result;
}
