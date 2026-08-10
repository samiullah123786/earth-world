export const LPC_GRID_SIZE = 32 as const;

export type TilePoint = Readonly<{ x: number; y: number }>;
export type PixelPoint = Readonly<{ x: number; y: number }>;

function assertFinite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

export function assertTileInteger(value: number, label = 'tile coordinate'): number {
  assertFinite(value, label);
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole tile`);
  return value;
}

export function assertTilePoint(point: TilePoint, label = 'tile point'): TilePoint {
  assertTileInteger(point.x, `${label}.x`);
  assertTileInteger(point.y, `${label}.y`);
  return point;
}

export function assertGridSize(value: number): asserts value is typeof LPC_GRID_SIZE {
  if (value !== LPC_GRID_SIZE) {
    throw new Error(`LPC world grid must be ${LPC_GRID_SIZE}px; received ${value}px`);
  }
}

export function tileOrigin(value: number): number {
  return assertTileInteger(value) * LPC_GRID_SIZE;
}

export function tileCenter(value: number): number {
  return tileOrigin(value) + LPC_GRID_SIZE / 2;
}

export function tilePointOrigin(point: TilePoint): PixelPoint {
  assertTilePoint(point);
  return { x: tileOrigin(point.x), y: tileOrigin(point.y) };
}

export function tilePointCenter(point: TilePoint): PixelPoint {
  assertTilePoint(point);
  return { x: tileCenter(point.x), y: tileCenter(point.y) };
}

/**
 * Logical route interpolation may be sub-tile, but world sprites always land
 * on an integer physical pixel. This prevents texture filtering seams without
 * turning smooth movement into tile-by-tile teleportation.
 */
export function renderRoutePoint(point: TilePoint): PixelPoint {
  assertFinite(point.x, 'route point.x');
  assertFinite(point.y, 'route point.y');
  return {
    x: Math.round(point.x * LPC_GRID_SIZE + LPC_GRID_SIZE / 2),
    y: Math.round(point.y * LPC_GRID_SIZE + LPC_GRID_SIZE / 2),
  };
}

export function structureSortAnchor(tileY: number, footprintHeight = 1): number {
  assertTileInteger(tileY, 'structure tile y');
  assertTileInteger(footprintHeight, 'structure footprint height');
  if (footprintHeight < 1) throw new Error('structure footprint height must be positive');
  return tileOrigin(tileY + footprintHeight);
}

export function assertIntegerPixel(point: PixelPoint, label = 'pixel point'): PixelPoint {
  assertTileInteger(point.x, `${label}.x`);
  assertTileInteger(point.y, `${label}.y`);
  return point;
}
