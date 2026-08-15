import { describe, expect, it } from 'vitest';
import { DynamicNavigationGrid } from './navigation';

describe('dynamic EasyStar grid', () => {
  it('updates collision immediately when a Tiled chunk is inserted', () => {
    const grid = new DynamicNavigationGrid();
    grid.rebuild(8, 4, () => false);
    expect(grid.route(0, 1, 7, 1)).not.toBeNull();
    grid.putCollisionChunk(3, 0, 1, 4, [16, 16, 16, 16]);
    expect(grid.route(0, 1, 7, 1)).toBeNull();
    grid.putCollisionChunk(3, 0, 1, 4, [16, 16, 0, 16]);
    expect(grid.route(0, 1, 7, 1)).not.toBeNull();
  });

  it('reapplies dynamic structure cells after terrain chunk insertion', () => {
    const grid = new DynamicNavigationGrid();
    grid.rebuild(6, 3, () => false);
    grid.putCollisionChunk(0, 0, 6, 3, new Array(18).fill(0));
    grid.blockCells([{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }]);
    expect(grid.route(0, 1, 5, 1)).toBeNull();
    expect(grid.diagnostics().blocked).toBe(3);
  });
});
