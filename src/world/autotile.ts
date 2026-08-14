/**
 * The founding map's own edge vocabulary, read back out of the founding map.
 *
 * Generated land used to be painted with flat coloured rectangles: a lake was
 * a blue square, a road a brown one. Beside hand-authored pixel art that reads
 * as damage, and it was the whole reason new rings looked worse than the
 * world they extended - the grass, trees and border continuation were already
 * drawn from the real atlas and already looked right.
 *
 * The atlas ships proper transition tiles for both families, and the founding
 * map already uses them correctly. Rather than re-deriving which frame belongs
 * on which edge by eye, these tables were measured from the founding map: for
 * every tile of the river and every tile of the woodland trail, the four-way
 * mask of "is this neighbour part of the same region" was computed and the
 * artist's chosen frame recorded. The dominant frame per mask IS the table
 * below, so generated water and generated trails are edged exactly the way the
 * hand-drawn ones are.
 *
 * Mask bits, high to low: north, east, south, west. A set bit means that
 * neighbour belongs to the same region, so 0b1111 is interior and 0b0111 is a
 * northern shore. Off-map counts as inside, which keeps the world's rim clean.
 */

export const AUTOTILE_NORTH = 0b1000;
export const AUTOTILE_EAST = 0b0100;
export const AUTOTILE_SOUTH = 0b0010;
export const AUTOTILE_WEST = 0b0001;

export type AutotileTable = Readonly<Record<number, ReadonlyArray<number>>>;

/**
 * River and pond. Interior carries five weighted variants plus two rarer
 * decorated tiles, which is what stops a large lake from tiling visibly.
 */
export const WATER_AUTOTILE: AutotileTable = {
  0b1111: [451, 452, 407, 406, 409, 451, 452, 589, 634],
  0b0111: [361, 362],
  0b1101: [497, 496],
  0b1110: [405, 450],
  0b1011: [408, 453],
  0b0110: [405, 360],
  0b0011: [363],
  0b1100: [495],
  0b1001: [498],
  // A one-tile-wide neck: the atlas has no such piece, so both banks are drawn
  // by choosing the side that keeps the run reading as a channel.
  0b1010: [405],
  0b0101: [361],
  0b1000: [495],
  0b0100: [405],
  0b0010: [363],
  0b0001: [498],
  0b0000: [451],
};

/** Woodland trail: packed earth with grass creeping over every edge. */
export const TRAIL_AUTOTILE: AutotileTable = {
  0b1111: [46, 47, 91, 92],
  0b0111: [1, 2],
  0b1101: [136, 137],
  0b1110: [45, 90],
  0b1011: [48, 93],
  0b0110: [0],
  0b0011: [3],
  0b1100: [135],
  0b1001: [138],
  0b1010: [45],
  0b0101: [1],
  0b1000: [135],
  0b0100: [45],
  0b0010: [3],
  0b0001: [138],
  0b0000: [46],
};

/**
 * Which frame edges this cell, given which neighbours share its region.
 *
 * `variant` picks between the equally correct frames the artist alternated
 * between; callers pass a positional hash so the same tile always resolves the
 * same way and a lake never shimmers between redraws.
 */
export function autotileFrame(table: AutotileTable, mask: number, variant: number): number {
  const choices = table[mask & 0b1111] ?? table[0b1111];
  return choices[Math.abs(variant) % choices.length];
}

/** Build the four-way mask for a cell from a membership test. */
export function autotileMask(
  inRegion: (x: number, y: number) => boolean,
  x: number,
  y: number,
): number {
  return (inRegion(x, y - 1) ? AUTOTILE_NORTH : 0)
    | (inRegion(x + 1, y) ? AUTOTILE_EAST : 0)
    | (inRegion(x, y + 1) ? AUTOTILE_SOUTH : 0)
    | (inRegion(x - 1, y) ? AUTOTILE_WEST : 0);
}
