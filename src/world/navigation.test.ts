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
});
