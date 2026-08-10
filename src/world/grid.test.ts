import { describe, expect, it } from 'vitest';
import { LPC_GRID_SIZE, assertGridSize, assertTilePoint, renderRoutePoint, structureSortAnchor, tilePointOrigin } from './grid';
import { assertGridAlignedPlacement, citizenDepth, componentRenderContract, isCitizenInFront, midgroundDepth, renderLayerForComponent } from './layering';

describe('strict LPC grid contract', () => {
  it('maps whole tiles to exact 32px origins and rounds only the final route pixel', () => {
    expect(LPC_GRID_SIZE).toBe(32);
    expect(tilePointOrigin({ x: 7, y: 3 })).toEqual({ x: 224, y: 96 });
    expect(renderRoutePoint({ x: 2.25, y: 4.75 })).toEqual({ x: 88, y: 168 });
    expect(Object.values(renderRoutePoint({ x: 1 / 3, y: 2 / 3 })).every(Number.isInteger)).toBe(true);
  });

  it('rejects fractional tiles, mismatched grids, and unaligned structure pixels', () => {
    expect(() => assertTilePoint({ x: 1.5, y: 2 })).toThrow(/whole tile/i);
    expect(() => assertGridSize(16)).toThrow(/32px/i);
    expect(() => assertGridAlignedPlacement(64, 95)).toThrow(/not aligned/i);
  });
});

describe('three-layer depth contract', () => {
  it('classifies terrain, walls, and canopies into distinct planes', () => {
    expect(renderLayerForComponent('grass')).toBe('ground');
    expect(renderLayerForComponent('wood_wall')).toBe('midground');
    expect(renderLayerForComponent('roof_tile')).toBe('overhead');
  });

  it('sorts citizens around a structure foot anchor deterministically', () => {
    const anchor = midgroundDepth(4, 2);
    expect(anchor).toBe(structureSortAnchor(4, 2));
    expect(isCitizenInFront(citizenDepth(anchor - 1), anchor)).toBe(false);
    expect(isCitizenInFront(citizenDepth(anchor + 1), anchor)).toBe(true);
    expect(isCitizenInFront(citizenDepth(anchor), anchor)).toBe(false);
  });

  it('keeps overhead visual bounds out of collision metadata', () => {
    expect(componentRenderContract('native_tree', { width: 3, height: 3, solid: true })).toMatchObject({
      layer: 'overhead', collisionCells: [],
    });
    expect(componentRenderContract('timber_trunk', { width: 1, height: 1, solid: true }).collisionCells).toEqual([{ x: 0, y: 0 }]);
  });
});
