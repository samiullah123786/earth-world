/**
 * The shape of the ground.
 *
 * Earth was a table. Not a metaphor - the terrain had no elevation anywhere in
 * it, not one hill or slope or raised shore, and that single fact did more to
 * make the world read as a diagram than any amount of lighting or palette. A
 * place people live has height in it; a plan view of a place does not.
 *
 * Three constraints shaped how this is done, and they pull against each other:
 *
 * IT MUST BE DETERMINISTIC. The Kernel decides where citizens are in two
 * dimensions and says nothing about the third. So height cannot be data that
 * travels - it has to be a pure function of the tile, computed identically by
 * every viewer and, later, by the Kernel itself if it ever needs to reason
 * about slope. No transfer, no drift, no third source of truth.
 *
 * IT MUST NOT BREAK ANYTHING. Walkability, pathfinding, plot geometry and the
 * whole build system are two-dimensional and correct. Height is a rendering
 * fact laid over them, never a rule. Nothing here can make a legal tile
 * unreachable.
 *
 * IT MUST BE GENTLE WHERE PEOPLE ARE. A long wavelength against a small
 * amplitude gives neighbouring tiles a difference too small to see as a step,
 * while forty tiles away the land has visibly risen. That is the whole trick:
 * rolling country close up, real relief at distance, and no staircase anywhere
 * for a citizen to climb.
 */

/** How far the land rises between its lowest point and its highest, in tiles. */
export const RELIEF = 2.6;

/** The distance over which the land completes one rise and fall. */
export const WAVELENGTH = 46;

/** Hash one lattice point to a stable value in [0, 1). */
function latticeValue(ix: number, iy: number, seed: number): number {
  let state = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed) >>> 0;
  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
  state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0;
  return ((state ^ (state >>> 15)) >>> 0) / 4294967296;
}

/** Smoothstep, so lattice cells meet without a visible crease. */
function ease(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth value noise in [0, 1], continuous across the whole plane. */
function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = ease(x - ix), fy = ease(y - iy);
  const a = latticeValue(ix, iy, seed);
  const b = latticeValue(ix + 1, iy, seed);
  const c = latticeValue(ix, iy + 1, seed);
  const d = latticeValue(ix + 1, iy + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/**
 * How high the ground stands at this tile, in world units.
 *
 * Two octaves only. A third would add detail at a scale small enough to become
 * the staircase this is written to avoid, and nobody looking at a town from
 * across a square can see it anyway.
 */
export function heightAt(x: number, y: number): number {
  const broad = noise(x / WAVELENGTH, y / WAVELENGTH, 0x9e37);
  const rolling = noise(x / (WAVELENGTH / 2.7), y / (WAVELENGTH / 2.7), 0x85eb);
  // Weighted so the broad sweep dominates and the second octave only breaks up
  // its regularity, rather than the two fighting for the silhouette.
  const combined = broad * 0.76 + rolling * 0.24;
  return combined * RELIEF;
}

/**
 * The height a flat-bottomed thing sits at.
 *
 * A building spanning several tiles cannot follow the ground - it would shear.
 * So it takes ONE height for its whole footprint, sampled at its centre, and
 * the renderer fills whatever gap that leaves with foundation. Sampling the
 * centre rather than the lowest corner keeps a house from floating on the high
 * side, which is the more visible of the two errors.
 */
export function siteHeight(rect: { x: number; y: number; w: number; h: number }): number {
  return heightAt(rect.x + rect.w / 2, rect.y + rect.h / 2);
}

/**
 * How much foundation a site needs to meet the ground on every side.
 *
 * Returns the deepest the natural ground falls below the flattened pad, so the
 * caller can skirt exactly that far and no further. Checking the corners and
 * the edge midpoints catches the cases that matter without sampling every tile
 * of a large parcel.
 */
export function foundationDepth(rect: { x: number; y: number; w: number; h: number }): number {
  const pad = siteHeight(rect);
  let deepest = 0;
  const xs = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const ys = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
  for (const x of xs) {
    for (const y of ys) {
      deepest = Math.max(deepest, pad - heightAt(x, y));
    }
  }
  return deepest;
}

/**
 * The downhill direction and steepness at a tile.
 *
 * Used to lean grass and settle scatter into the slope rather than standing it
 * bolt upright on a hillside, which is the tell that a world is a heightmap
 * with props dropped on top.
 */
export function slopeAt(x: number, y: number): { dx: number; dy: number; grade: number } {
  const step = 1;
  const dx = (heightAt(x + step, y) - heightAt(x - step, y)) / (2 * step);
  const dy = (heightAt(x, y + step) - heightAt(x, y - step)) / (2 * step);
  return { dx, dy, grade: Math.hypot(dx, dy) };
}

/**
 * Is the ground here gentle enough to walk without it looking like climbing?
 *
 * Advisory only, and deliberately so: the Kernel decides what is walkable, and
 * a renderer that started refusing legal tiles would be a second, disagreeing
 * authority on where people may go.
 */
export function isGentle(x: number, y: number): boolean {
  return slopeAt(x, y).grade < 0.09;
}
