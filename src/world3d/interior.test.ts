import { describe, expect, it } from 'vitest';
import { doorTile, inside, interiorSize, isInterior, wallTiles } from './interior';
import { structureVoxels } from '../../shared/voxel';

const house = { x: 10, y: 20, w: 5, h: 4 };

describe('the doorway', () => {
  it('sits in the middle of the south face', () => {
    expect(doorTile(house)).toEqual({ x: 12, y: 23 });
  });

  /**
   * The load-bearing test of this whole module. The Kernel describes the same
   * building in shared/voxel.ts, and if the two disagree about where the door
   * is, the renderer walls up an opening the world says is open - and a citizen
   * routed through it walks into a wall.
   */
  it('agrees with the Kernel about where the gap in the wall is', () => {
    for (const build of [house, { x: 0, y: 0, w: 3, h: 3 }, { x: 7, y: 2, w: 6, h: 5 }]) {
      const door = doorTile(build);
      const walls = structureVoxels(build).filter((voxel) => voxel.kind === 'wall');
      const occupied = new Set(walls.map((voxel) => `${voxel.x},${voxel.z}`));
      expect(occupied.has(`${door.x},${door.y}`)).toBe(false);
      // And every other edge tile IS walled, so the door is the only way in.
      for (const tile of wallTiles(build)) {
        expect(occupied.has(`${tile.x},${tile.y}`)).toBe(true);
      }
    }
  });
});

describe('the wall ring', () => {
  it('covers every edge tile except the door', () => {
    const tiles = wallTiles(house);
    // A 5x4 ring is 2*5 + 2*4 - 4 corners = 14 tiles, less the doorway.
    expect(tiles).toHaveLength(13);
    expect(tiles.some((tile) => tile.x === 12 && tile.y === 23)).toBe(false);
  });

  it('leaves the inside completely open', () => {
    const tiles = new Set(wallTiles(house).map((tile) => `${tile.x},${tile.y}`));
    for (let y = house.y + 1; y < house.y + house.h - 1; y++) {
      for (let x = house.x + 1; x < house.x + house.w - 1; x++) {
        expect(tiles.has(`${x},${y}`)).toBe(false);
      }
    }
  });

  it('walls a one-tile-deep building without sealing its door', () => {
    const shed = { x: 4, y: 4, w: 3, h: 1 };
    const door = doorTile(shed);
    expect(wallTiles(shed).some((tile) => tile.x === door.x && tile.y === door.y)).toBe(false);
    expect(wallTiles(shed)).toHaveLength(2);
  });
});

describe('inside and outside', () => {
  it('knows a point within the footprint from one beyond it', () => {
    expect(inside(house, 12, 21)).toBe(true);
    expect(inside(house, 10, 20)).toBe(true);
    expect(inside(house, 15, 21)).toBe(false);
    expect(inside(house, 12, 24)).toBe(false);
  });

  it('separates the room from the walls around it', () => {
    expect(isInterior(house, 11, 21)).toBe(true);
    expect(isInterior(house, 10, 21)).toBe(false);
  });
});

describe('how much room there is to furnish', () => {
  it('measures the floor inside the walls', () => {
    expect(interiorSize(house)).toEqual({ w: 3, h: 2 });
  });

  it('gives a three-by-three exactly one tile of floor', () => {
    expect(interiorSize({ x: 0, y: 0, w: 3, h: 3 })).toEqual({ w: 1, h: 1 });
  });

  it('reports no room at all rather than a negative one', () => {
    expect(interiorSize({ x: 0, y: 0, w: 2, h: 1 })).toEqual({ w: 0, h: 0 });
  });
});
