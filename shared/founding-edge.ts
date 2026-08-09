export const FOUNDING_WIDTH = 64;
export const FOUNDING_HEIGHT = 48;

// These frames continue graphics that are physically cut by the 64 by 48
// founding-map boundary. They are derived by following the source tileset grid,
// not by repeating or sampling nearby forest texture.
const SOUTH_CANOPY: Record<number, number[]> = {
  23: [515, 560, 605, 650], 24: [516, 561, 606, 651],
  25: [517, 562, 607, 652], 26: [518, 563, 608, 653],
  27: [519, 564, 609, 654], 28: [520, 565, 610, 655],
  29: [521, 566, 611, 656], 30: [522, 567, 612],
  32: [515, 560, 605, 650], 33: [516, 561, 606, 651],
  34: [517, 562, 607, 652], 35: [518, 563, 608, 653],
  36: [519, 564, 609, 654], 37: [520, 565, 610, 655],
  38: [521, 566, 611, 656], 39: [522, 567, 612],
};

// The southeast canopy reaches beyond the east edge only on its first two
// rows. The next source frames complete those rows and then become transparent.
const SOUTHEAST_EAST: Record<number, number[]> = {
  34: [1088, 1089, 1090],
  35: [1133, 1134, 1135],
};

// The southeast tree mass reaches below the south edge only at x 52 through
// 57. These three source rows contain its remaining canopy and trunks. Tiles
// x 58 through 63 are already the graphic's real lower edge.
const SOUTHEAST_SOUTH: Record<number, number[]> = {
  52: [1309, 1354, 1399], 53: [1310, 1355, 1400],
  54: [1311, 1356, 1401], 55: [1312, 1357, 1402],
  56: [1313, 1358, 1403], 57: [1314, 1359, 1404],
};

export function foundingEdgeContinuationFrame(x: number, y: number) {
  if (y >= FOUNDING_HEIGHT && x < FOUNDING_WIDTH) {
    const frames = SOUTH_CANOPY[x] ?? SOUTHEAST_SOUTH[x];
    return frames?.[y - FOUNDING_HEIGHT];
  }
  if (x >= FOUNDING_WIDTH && y < FOUNDING_HEIGHT) {
    return SOUTHEAST_EAST[y]?.[x - FOUNDING_WIDTH];
  }
  return undefined;
}

export function foundingEdgeContinuationBlocked(x: number, y: number) {
  return foundingEdgeContinuationFrame(x, y) !== undefined;
}
