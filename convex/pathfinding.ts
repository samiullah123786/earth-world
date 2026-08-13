import EasyStar from 'easystarjs';
import { H, ROWS, W, walkable } from './walkable';
import { foundingEdgeContinuationBlocked } from '../shared/founding-edge';

export type GridPoint = { x: number; y: number };

export type WorldBounds = { width: number; height: number };
export type Walkability = (x: number, y: number) => boolean;

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

export function isTreeAnchor(x: number, y: number) {
  if (x < W && y < H) return false;
  const d = Math.max(Math.max(0, x - (W - 1)), Math.max(0, y - (H - 1)));
  if (d <= 6) return false;
  return isGroveCell(x, y) && wildHash(x, y, 11) % 23 === 0;
}

// A tree's canopy center (2x2) blocks movement; continuation canopy blocks too.
export function wildBlocked(x: number, y: number) {
  if (foundingEdgeContinuationBlocked(x, y)) return true;
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
  isWalkable: Walkability = (x, y) => walkableInWorld(x, y, bounds),
): GridPoint[] | null {
  const sx = Math.floor(fromX);
  const sy = Math.floor(fromY);
  const tx = Math.floor(toX);
  const ty = Math.floor(toY);
  if (![sx, sy, tx, ty].every(Number.isInteger)) return null;
  if (!isWalkable(sx, sy) || !isWalkable(tx, ty)) return null;

  return createRouter(bounds, isWalkable).route(sx, sy, tx, ty);
}

/**
 * A reusable router: build the walkability grid and the A* engine ONCE, then
 * ask it for as many paths as you like.
 *
 * findRoute used to rebuild both on every call - a 64x48 world is 3,072
 * walkability probes and a fresh EasyStar grid copy per path. The ambient
 * tick asks for up to eight paths per citizen, so eighteen citizens cost
 * roughly 440,000 probes and 144 grid builds every five seconds. That is what
 * pinned the backend's CPU and left a twelve-row query queueing for half a
 * minute. Building once per tick makes the same work a rounding error.
 */
export function createRouter(bounds: WorldBounds, isWalkable: Walkability) {
  const grid = Array.from({ length: bounds.height }, (_row, y) =>
    Array.from({ length: bounds.width }, (_cell, x) => isWalkable(x, y) ? 0 : 1),
  );
  const finder = new EasyStar.js();
  finder.setGrid(grid);
  finder.setAcceptableTiles([0]);
  finder.enableSync();
  return {
    walkable: (x: number, y: number) =>
      y >= 0 && y < bounds.height && x >= 0 && x < bounds.width && grid[y][x] === 0,
    route(fromX: number, fromY: number, toX: number, toY: number): GridPoint[] | null {
      const sx = Math.floor(fromX), sy = Math.floor(fromY);
      const tx = Math.floor(toX), ty = Math.floor(toY);
      if (![sx, sy, tx, ty].every(Number.isInteger)) return null;
      if (sy < 0 || sy >= bounds.height || sx < 0 || sx >= bounds.width) return null;
      if (ty < 0 || ty >= bounds.height || tx < 0 || tx >= bounds.width) return null;
      if (grid[sy][sx] !== 0 || grid[ty][tx] !== 0) return null;
      let result: GridPoint[] | null = null;
      finder.findPath(sx, sy, tx, ty, (path) => {
        result = path?.map(({ x, y }) => ({ x, y })) ?? null;
      });
      finder.calculate();
      return result;
    },
  };
}
