/**
 * The 3D world's reading of the same map the 2D world draws.
 *
 * This is the load-bearing rule of the migration: there is ONE world, held in
 * the Kernel and in the Tiled map, and the voxel view is another pair of eyes
 * on it - never a second world that could drift. So this module owns the only
 * judgement the renderer makes about terrain (which GID means what) and keeps
 * it pure, so the mapping is pinned by tests instead of by squinting at
 * screenshots.
 *
 * GID ranges follow the tileset order in shared/tiled-world.ts: each tileset's
 * firstgid opens a range that runs to the next firstgid. Water is 38 because
 * the water tileset starts there, not because 38 is special.
 */

import { TILED_GIDS } from './tiled-world';

export type BlockKind =
  | 'empty' | 'grass' | 'dirt' | 'water' | 'road' | 'canopy' | 'crop' | 'trunk';

/** What one ground-layer GID is, in voxel terms. */
export function classifyGid(gid: number): BlockKind {
  if (!gid || gid < 0) return 'empty';
  if (gid >= TILED_GIDS.trunkFirst) return 'trunk';
  if (gid >= TILED_GIDS.cropPlowed) return 'crop';
  if (gid >= TILED_GIDS.treeFirst) return 'canopy';
  if (gid >= TILED_GIDS.cobbleFill) return 'road';
  if (gid >= TILED_GIDS.water) return 'water';
  if (gid >= TILED_GIDS.dirt) return 'dirt';
  if (gid >= TILED_GIDS.grass) return 'grass';
  return 'empty';
}

/** One placed cube, in tile coordinates. y is in blocks above the ground. */
export type Voxel = { x: number; y: number; z: number; kind: string };

/**
 * A building's footprint, extruded the Minecraft way: walls two blocks high,
 * a stepped pyramid roof, a door on the south face. Deterministic from the
 * footprint alone, so every viewer reconstructs the identical structure and
 * nothing about it is stored anywhere.
 */
export function structureVoxels(build: {
  x: number; y: number; w: number; h: number; structure?: string;
}): Voxel[] {
  const { x, y, w, h } = build;
  if (w < 1 || h < 1) return [];
  const out: Voxel[] = [];
  const WALL_H = 2;
  const doorX = x + Math.floor(w / 2);
  const doorZ = y + h - 1;

  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const edge = dx === 0 || dz === 0 || dx === w - 1 || dz === h - 1;
      if (!edge) continue;
      for (let level = 0; level < WALL_H; level++) {
        // The doorway: two air blocks in the middle of the south wall.
        if (x + dx === doorX && y + dz === doorZ) continue;
        out.push({ x: x + dx, y: 1 + level, z: y + dz, kind: 'wall' });
      }
    }
  }
  // Window band on the upper wall course, skipping corners and the door line.
  for (let dx = 1; dx < w - 1; dx++) {
    if (dx % 2 === 1 && x + dx !== doorX) {
      out.push({ x: x + dx, y: 2, z: y, kind: 'window' });
      out.push({ x: x + dx, y: 2, z: y + h - 1, kind: 'window' });
    }
  }

  // The roof steps inward one block per level until nothing is left - which is
  // exactly a pyramid on a square footprint and a ridge on a long one.
  let level = 0;
  let x0 = x, z0 = y, x1 = x + w - 1, z1 = y + h - 1;
  while (x0 <= x1 && z0 <= z1) {
    for (let rz = z0; rz <= z1; rz++) {
      for (let rx = x0; rx <= x1; rx++) {
        const rim = rx === x0 || rz === z0 || rx === x1 || rz === z1;
        if (rim || level === 0) out.push({ x: rx, y: 1 + WALL_H + level, z: rz, kind: 'roof' });
      }
    }
    x0++; z0++; x1--; z1--; level++;
  }
  return out;
}

/* ── The letter code both worlds read ──────────────────────────────────────
   One character per tile: g grass, d dirt, w water, r road, c crop,
   t tree (trunk and canopy), u undergrowth (canopy with no trunk), . void.
   The Luanti terrain data is written in these letters by the exporter, and
   the Kernel encodes live expansion chunks the same way - so the voxel world
   reconstructs base map and new land through one vocabulary. */

const KIND_LETTER: Record<string, string> = {
  grass: 'g', dirt: 'd', water: 'w', road: 'r', crop: 'c', empty: '.',
};

/** The letter for one cell, given all three layers' GIDs. */
export function terrainLetter(groundGid: number, collisionGid: number, overheadGid: number): string {
  const base = classifyGid(groundGid);
  if (classifyGid(collisionGid) === 'trunk' || base === 'trunk') return 't';
  if (classifyGid(overheadGid) === 'canopy' && base !== 'water') return 'u';
  return KIND_LETTER[base] ?? 'g';
}

/** A whole chunk's layers as letter rows, top row first. */
export function encodeChunkRows(
  layers: { GroundLayer: number[]; CollisionLayer: number[]; OverheadLayer: number[] },
  size: number,
): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      row += terrainLetter(
        layers.GroundLayer[index] ?? 0,
        layers.CollisionLayer[index] ?? 0,
        layers.OverheadLayer[index] ?? 0,
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * A construction site, before the walls: four corner posts and a top ring.
 *
 * The 2D world shows in-progress builds; a voxel world that only ever pops
 * finished houses into existence is hiding the most alive thing a town does.
 * Deterministic from the footprint alone, like everything else here.
 */
export function scaffoldVoxels(build: { x: number; y: number; w: number; h: number }): Voxel[] {
  const { x, y, w, h } = build;
  if (w < 1 || h < 1) return [];
  const out: Voxel[] = [];
  const TOP = 3;
  const corners = [
    [x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1],
  ] as const;
  for (const [px, pz] of corners) {
    for (let level = 1; level <= TOP; level++) out.push({ x: px, y: level, z: pz, kind: 'post' });
  }
  // The ring at the top, so the site reads as a frame rather than four sticks.
  for (let dx = 0; dx < w; dx++) {
    out.push({ x: x + dx, y: TOP, z: y, kind: 'beam' });
    out.push({ x: x + dx, y: TOP, z: y + h - 1, kind: 'beam' });
  }
  for (let dz = 1; dz < h - 1; dz++) {
    out.push({ x, y: TOP, z: y + dz, kind: 'beam' });
    out.push({ x: x + w - 1, y: TOP, z: y + dz, kind: 'beam' });
  }
  return out;
}

/**
 * How tall a demolition must clear, for a given footprint.
 *
 * Shared so the Lua port and this file cannot disagree about what "gone"
 * means: the roof steps inward once per level, so the peak rises with the
 * shorter side, and clearing less than this leaves a floating roof tip -
 * the one ruin worse than the building.
 */
export function structureClearHeight(w: number, h: number): number {
  const WALL_H = 2;
  const roofLevels = Math.ceil(Math.min(w, h) / 2);
  return WALL_H + roofLevels + 1;
}
