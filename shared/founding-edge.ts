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

// The source atlas ends while the southeast grove is still crossing the east
// boundary. A complete native right edge from the founding map's northeast
// grove (source x 57..60, y 0..16) supplies the missing 4 by 17 forest wall,
// including its own canopy, shadows, trunks, and grass taper. Keeping the
// whole verified strip avoids both half-trees and repeated guessed texture.
const SOUTHEAST_EAST_WALL: Record<number, number[]> = {
  34: [1178, 1179, 1180, 1181],
  35: [1223, 1224, 1225, 1226],
  36: [1268, 1269, 1270, 1271],
  37: [1223, 1224, 1225, 1226],
  38: [1268, 1269, 1270, 1271],
  39: [1223, 1224, 1225, 1226],
  40: [1268, 1269, 1270, 1271],
  41: [1223, 1224, 1225, 1226],
  42: [1268, 1269, 1270, 1271],
  43: [1223, 1224, 1225, 1226],
  44: [1268, 1269, 1270, 1271],
  45: [1178, 1179, 1180, 1181],
  46: [1223, 1224, 1225, 1226],
  47: [1268, 1269, 1270, 1271],
  48: [1314, 1315, 1316, 271],
  49: [1359, 1360, 1361, 271],
  50: [1404, 1405, 1406, 271],
};

// The southeast tree mass reaches below the south edge only at x 52 through
// 57. These three source rows contain its remaining canopy and trunks. Tiles
// x 58 through 63 are already the graphic's real lower edge.
const SOUTHEAST_SOUTH: Record<number, number[]> = {
  52: [1309, 1354, 1399], 53: [1310, 1355, 1400],
  54: [1311, 1356, 1401], 55: [1312, 1357, 1402],
  56: [1313, 1358, 1403], 57: [1314, 1359, 1404],
};

// A second complete founding-grove root cap (source x 53..60, y 14..16)
// finishes the lower-right arm that was still flat after the first recovery.
// The east wall has priority where the two native pieces meet.
const SOUTHEAST_SOUTH_CAP: Record<number, number[]> = {
  58: [1310, 1355, 1400], 59: [1311, 1356, 1401],
  60: [1312, 1357, 1402], 61: [1313, 1358, 1403],
  62: [1314, 1359, 1404], 63: [1315, 1360, 1405],
  64: [1316, 1361, 1406], 65: [271, 271, 271],
};

export function foundingEdgeContinuationFrame(x: number, y: number) {
  if (x >= FOUNDING_WIDTH) {
    const frame = SOUTHEAST_EAST_WALL[y]?.[x - FOUNDING_WIDTH];
    if (frame !== undefined) return frame;
  }
  if (y >= FOUNDING_HEIGHT) {
    const frames = SOUTH_CANOPY[x] ?? SOUTHEAST_SOUTH[x] ?? SOUTHEAST_SOUTH_CAP[x];
    return frames?.[y - FOUNDING_HEIGHT];
  }
  return undefined;
}

export function foundingEdgeContinuationBlocked(x: number, y: number) {
  const frame = foundingEdgeContinuationFrame(x, y);
  return frame !== undefined && frame !== 271;
}
