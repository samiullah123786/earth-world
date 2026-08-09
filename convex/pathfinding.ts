import EasyStar from 'easystarjs';
import { H, ROWS, W, walkable } from './walkable';

export type GridPoint = { x: number; y: number };

const GRID = ROWS.map((row) => [...row].map((cell) => (cell === '0' ? 0 : 1)));

export function findRoute(fromX: number, fromY: number, toX: number, toY: number): GridPoint[] | null {
  const sx = Math.floor(fromX);
  const sy = Math.floor(fromY);
  const tx = Math.floor(toX);
  const ty = Math.floor(toY);
  if (![sx, sy, tx, ty].every(Number.isInteger)) return null;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H || !walkable(tx, ty)) return null;

  const finder = new EasyStar.js();
  finder.setGrid(GRID);
  finder.setAcceptableTiles([0]);
  finder.enableSync();
  let result: GridPoint[] | null = null;
  finder.findPath(sx, sy, tx, ty, (path) => {
    result = path?.map(({ x, y }) => ({ x, y })) ?? null;
  });
  finder.calculate();
  return result;
}
