import EasyStar from 'easystarjs';
import { H, W, walkable } from './tiledFounding';

export type GridPoint = { x: number; y: number };

export type WorldBounds = { width: number; height: number };
export type Walkability = (x: number, y: number) => boolean;

export function walkableInWorld(x: number, y: number, bounds: WorldBounds = { width: W, height: H }) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= bounds.width || ty >= bounds.height) return false;
  if (tx < W && ty < H) return walkable(tx, ty);
  // Persisted Tiled chunks are applied by loadWorldWalkability. This pure
  // fallback knows only the founding export, so ungenerated in-bounds land is
  // provisionally open rather than inventing a second procedural renderer.
  return true;
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
  if (!isWalkable(tx, ty)) return null;

  // The START is exempt from walkability, and this is a rule, not a mercy: a
  // citizen can be standing somewhere illegal through no fault of their own -
  // the canonical case is a wall completing on the tile they stood on, which
  // entombed the first citizen to have a house built around them (Mason,
  // during the phase-3 smoke test: every move_to and demolish answered "no
  // safe route" forever). You can always step OFF an illegal tile; you just
  // can never step ONTO one.
  if (isWalkable(sx, sy)) return createRouter(bounds, isWalkable).route(sx, sy, tx, ty);
  const escapeAware: Walkability = (x, y) => (x === sx && y === sy) || isWalkable(x, y);
  return createRouter(bounds, escapeAware).route(sx, sy, tx, ty);
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
