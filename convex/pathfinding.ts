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

// South-border forest continuation: the founding map cuts two canopy masses at
// y=47 (frames 470-477). Their EXACT missing rows (computed from the tileset's
// own graphic, clamped to its visually verified bottom edge at tileset row 14)
// are drawn beyond the border by the client from this same table. These cells
// are canopy, so they block movement. Nothing else is planted within 4 tiles of
// the founding border, so nothing can overlap the continuation.
export const SOUTH_CONTINUATION: Record<number, number[]> = { 23: [515, 560, 605, 650], 24: [516, 561, 606, 651], 25: [517, 562, 607, 652], 26: [518, 563, 608, 653], 27: [519, 564, 609, 654], 28: [520, 565, 610, 655], 29: [521, 566, 611, 656], 30: [522, 567, 612], 32: [515, 560, 605, 650], 33: [516, 561, 606, 651], 34: [517, 562, 607, 652], 35: [518, 563, 608, 653], 36: [519, 564, 609, 654], 37: [520, 565, 610, 655], 38: [521, 566, 611, 656], 39: [522, 567, 612] };

// SE-corner forest (objmap fill frame 367) is cut in a straight line at the
// east border (y=34-47) and south border (x=52-63). The founding map's own
// 367 forests end against grass with IRREGULAR silhouettes (verified: 85+
// interior endings, no fringe frame). So the mass continues outward with a
// deterministic stair-step taper. Client draws 367 there; these cells block.
export function seForestCont(x: number, y: number) {
  const inEast = x >= W && y >= 34 && y < H;
  const inSouth = y >= H && x >= 52 && x < W;
  const inCorner = x >= W && y >= H;
  if (inEast) return x - (W - 1) <= 2 + (wildHash(0, y, 41) % 4);
  if (inSouth) return y - (H - 1) <= 2 + (wildHash(x, 0, 43) % 4);
  if (inCorner) {
    const de = 2 + (wildHash(0, 47, 41) % 4), ds = 2 + (wildHash(63, 0, 43) % 4);
    return (x - (W - 1)) + (y - (H - 1)) <= Math.min(de, ds) + 1;
  }
  return false;
}

export function southContinuationBlocked(x: number, y: number) {
  const frames = SOUTH_CONTINUATION[x];
  if (!frames) return false;
  const r = y - H;
  return r >= 0 && r < frames.length;
}

export function isTreeAnchor(x: number, y: number) {
  if (x < W && y < H) return false;
  const d = Math.max(Math.max(0, x - (W - 1)), Math.max(0, y - (H - 1)));
  if (d <= 6) return false;
  return isGroveCell(x, y) && wildHash(x, y, 11) % 23 === 0;
}

// A tree's canopy center (2x2) blocks movement; continuation canopy blocks too.
export function wildBlocked(x: number, y: number) {
  if (southContinuationBlocked(x, y) || seForestCont(x, y)) return true;
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
