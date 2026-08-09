import EasyStar from 'easystarjs';
import { H, ROWS, W, walkable } from './walkable';

export type GridPoint = { x: number; y: number };

export type WorldBounds = { width: number; height: number };

export function walkableInWorld(x: number, y: number, bounds: WorldBounds = { width: W, height: H }) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= bounds.width || ty >= bounds.height) return false;
  // The hand-authored founding map keeps its river, trees, and buildings.
  // New boundary rings are surveyed open ground until later registries add
  // structures; this makes expansion deterministic and routable.
  return tx >= W || ty >= H ? true : walkable(tx, ty);
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
