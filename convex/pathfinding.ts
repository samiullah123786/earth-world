import EasyStar from 'easystarjs';
import { H, ROWS, W, walkable } from './walkable';

export type GridPoint = { x: number; y: number };

export type WorldBounds = { width: number; height: number };

// Land beyond the founding map is WILDERNESS: open meadow, organic groves of
// COMPLETE trees (4x3 canopy, stamped whole), and a forest-continuation band so
// the founding map's edge forests flow outward instead of slicing off. Citizens
// civilize this land later. The client renders from IDENTICAL math below, so
// what the eye sees is exactly what the pathfinder walks.
export function wildHash(x: number, y: number, salt: number) {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0);
}

export function isGroveCell(x: number, y: number) {
  return wildHash(Math.floor(x / 6), Math.floor(y / 6), 7) % 100 < 30;
}

// Forest continuation: within 3 tiles outside the founding rect, where the
// nearest founding edge cell is blocked terrain (its forests), trees continue.
export function isEdgeForest(x: number, y: number) {
  const dx = Math.max(0, x - (W - 1)), dy = Math.max(0, y - (H - 1));
  const d = Math.max(dx, dy);
  if (d < 1 || d > 3) return false;
  const ex = Math.min(x, W - 1), ey = Math.min(y, H - 1);
  if (walkable(ex, ey)) return false;
  return wildHash(x, y, 31) % 4 === 0;
}

export function isTreeAnchor(x: number, y: number) {
  if (x < W && y < H) return false;
  if (isGroveCell(x, y) && wildHash(x, y, 11) % 23 === 0) return true;
  return isEdgeForest(x, y);
}

// A tree's canopy center (2x2) blocks movement; anchor sits at canopy center.
export function wildBlocked(x: number, y: number) {
  return isTreeAnchor(x, y) || isTreeAnchor(x - 1, y) || isTreeAnchor(x, y - 1) || isTreeAnchor(x - 1, y - 1);
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
