import { describe, expect, it } from 'vitest';
import { classifyGid, encodeChunkRows, scaffoldVoxels, structureClearHeight, structureVoxels, terrainLetter } from './voxel';

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

describe('the construction site', () => {
  it('is deterministic, and stands inside its own footprint', () => {
    const site = { x: 5, y: 9, w: 4, h: 3 };
    expect(scaffoldVoxels(site)).toEqual(scaffoldVoxels({ ...site }));
    for (const voxel of scaffoldVoxels(site)) {
      expect(voxel.x).toBeGreaterThanOrEqual(5);
      expect(voxel.x).toBeLessThanOrEqual(8);
      expect(voxel.z).toBeGreaterThanOrEqual(9);
      expect(voxel.z).toBeLessThanOrEqual(11);
    }
  });

  it('raises a post at every corner and closes the top ring', () => {
    const voxels = scaffoldVoxels({ x: 0, y: 0, w: 3, h: 3 });
    for (const [cx, cz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) {
      expect(voxels.some((voxel) => voxel.kind === 'post' && voxel.x === cx && voxel.z === cz && voxel.y === 1)).toBe(true);
    }
    // The ring: every rim cell carries a beam at the top level.
    for (let dx = 0; dx < 3; dx++) {
      expect(voxels.some((voxel) => voxel.y === 3 && voxel.x === dx && voxel.z === 0)).toBe(true);
      expect(voxels.some((voxel) => voxel.y === 3 && voxel.x === dx && voxel.z === 2)).toBe(true);
    }
  });

  it('refuses a degenerate footprint', () => {
    expect(scaffoldVoxels({ x: 0, y: 0, w: 0, h: 2 })).toEqual([]);
  });
});

describe('what demolition must clear', () => {
  it('always reaches above the tallest voxel a structure can place', () => {
    // The invariant that keeps ruins impossible: for every footprint, the
    // clear height exceeds every wall, window, roof and scaffold voxel.
    // Clearing less leaves a floating roof tip - the one ruin worse than
    // the building.
    for (let w = 1; w <= 8; w++) {
      for (let h = 1; h <= 8; h++) {
        const tallest = Math.max(
          0,
          ...structureVoxels({ x: 0, y: 0, w, h }).map((voxel) => voxel.y),
          ...scaffoldVoxels({ x: 0, y: 0, w, h }).map((voxel) => voxel.y),
        );
        expect(structureClearHeight(w, h)).toBeGreaterThan(tallest - 1);
        expect(structureClearHeight(w, h)).toBeGreaterThanOrEqual(tallest);
      }
    }
  });
});
