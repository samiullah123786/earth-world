import { describe, expect, it } from 'vitest';
import { classifyGid, encodeChunkRows, structureVoxels, terrainLetter } from './voxel';

describe('reading the ground layer', () => {
  it('maps each tileset range to its terrain, at the boundaries', () => {
    // The ranges are firstgid-ordered. A boundary off by one paints a river
    // of cobbles or a road of water, so each edge is pinned exactly.
    expect(classifyGid(0)).toBe('empty');
    expect(classifyGid(15)).toBe('empty');
    expect(classifyGid(16)).toBe('grass');
    expect(classifyGid(33)).toBe('grass');
    expect(classifyGid(34)).toBe('dirt');
    expect(classifyGid(37)).toBe('dirt');
    expect(classifyGid(38)).toBe('water');
    expect(classifyGid(68)).toBe('water');
    expect(classifyGid(69)).toBe('road');
    expect(classifyGid(74)).toBe('road');
    expect(classifyGid(75)).toBe('canopy');
    expect(classifyGid(179)).toBe('canopy');
    expect(classifyGid(180)).toBe('crop');
    expect(classifyGid(199)).toBe('crop');
    expect(classifyGid(200)).toBe('trunk');
    expect(classifyGid(4096)).toBe('trunk');
  });
});

describe('extruding a structure', () => {
  const cottage = { x: 10, y: 20, w: 4, h: 3, structure: 'home' };

  it('is deterministic, because every viewer must build the same house', () => {
    expect(structureVoxels(cottage)).toEqual(structureVoxels({ ...cottage }));
  });

  it('builds hollow walls with a doorway the citizen could walk through', () => {
    const voxels = structureVoxels(cottage);
    const walls = voxels.filter((voxel) => voxel.kind === 'wall');
    // The south-centre column carries no wall blocks at either level.
    const doorColumn = walls.filter((voxel) => voxel.x === 12 && voxel.z === 22);
    expect(doorColumn).toHaveLength(0);
    // Interior stays open: nothing but roof above the centre of the floor.
    expect(voxels.some((voxel) => voxel.kind === 'wall' && voxel.x === 11 && voxel.z === 21)).toBe(false);
  });

  it('caps every footprint with a roof that actually closes', () => {
    const voxels = structureVoxels(cottage);
    const roof = voxels.filter((voxel) => voxel.kind === 'roof');
    expect(roof.length).toBeGreaterThan(0);
    // The lowest roof level covers the full footprint rim and interior,
    // so rain has nowhere in: every floor cell has roof above it.
    for (let dx = 0; dx < 4; dx++) {
      for (let dz = 0; dz < 3; dz++) {
        expect(roof.some((voxel) => voxel.x === 10 + dx && voxel.z === 20 + dz)).toBe(true);
      }
    }
  });

  it('refuses a degenerate footprint rather than building a splinter', () => {
    expect(structureVoxels({ x: 0, y: 0, w: 0, h: 3 })).toEqual([]);
  });
});

describe('the letter code', () => {
  it('gives trees precedence over the ground they stand on', () => {
    expect(terrainLetter(16, 200, 0)).toBe('t');
    expect(terrainLetter(200, 0, 0)).toBe('t');
  });

  it('reads lone canopy as undergrowth, never as a floating tree', () => {
    expect(terrainLetter(16, 0, 75)).toBe('u');
    // ...but never draws a bush on open water.
    expect(terrainLetter(38, 0, 75)).toBe('w');
  });

  it('maps plain ground to its own letters', () => {
    expect(terrainLetter(16, 0, 0)).toBe('g');
    expect(terrainLetter(34, 0, 0)).toBe('d');
    expect(terrainLetter(38, 0, 0)).toBe('w');
    expect(terrainLetter(69, 0, 0)).toBe('r');
    expect(terrainLetter(180, 0, 0)).toBe('c');
    expect(terrainLetter(0, 0, 0)).toBe('.');
  });

  it('encodes a chunk row-major, top row first', () => {
    const size = 2;
    const rows = encodeChunkRows({
      GroundLayer: [16, 38, 69, 0],
      CollisionLayer: [0, 0, 0, 0],
      OverheadLayer: [0, 0, 0, 0],
    }, size);
    expect(rows).toEqual(['gw', 'r.']);
  });
});
