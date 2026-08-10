import { describe, expect, it } from 'vitest';
import foundingMap from '../../public/assets/map.json';
import {
  FOUNDING_GROUND_ACCENT_FRAMES,
  FOUNDING_GROUND_DECORATION_FRAMES,
  FOUNDING_GROUND_FLOWER_FRAMES,
  FOUNDING_GROUND_TUFT_FRAMES,
  foundingDecorationLayer,
  tileIsSolid,
  tileIsStandable,
} from './foundingLayers';

const objmap = foundingMap.objmap as number[][][];
const decor = foundingMap.bgtiles[1] as number[][];
const { width, height } = foundingMap;
const layerAt = (x: number, y: number) => foundingDecorationLayer(objmap, decor, x, y);

describe('founding-map decoration layering', () => {
  it('keeps the two bank flower patches below every citizen', () => {
    expect(decor[32][22]).toBe(279);
    expect(decor[26][22]).toBe(280);
    expect(layerAt(32, 22)).toBe('ground');
    expect(layerAt(26, 22)).toBe('ground');
  });

  // The reported bug: a citizen walks up to a patch of grass, a mushroom ring
  // or a stump and vanishes behind it. Every one of these is a real tile on the
  // founding map that used to render above every citizen, because its frame
  // number had never been added to a hand-kept list.
  it('never draws ground plants above a tile a citizen can stand on', () => {
    const cases: ReadonlyArray<readonly [number, number, number, string]> = [
      [15, 42, 850, 'mushrooms'],
      [16, 41, 850, 'mushrooms'],
      [49, 10, 846, 'dry grass tuft'],
      [47, 11, 893, 'tree stump'],
      [48, 7, 845, 'flowering bush'],
      [13, 42, 941, 'rocks'],
      [9, 6, 762, 'clay pot'],
    ];
    for (const [x, y, frame, what] of cases) {
      expect(decor[x][y], `${what} at (${x}, ${y})`).toBe(frame);
      expect(tileIsStandable(objmap, x, y), `${what} at (${x}, ${y}) is walkable`).toBe(true);
      expect(layerAt(x, y), `${what} at (${x}, ${y})`).toBe('ground');
    }
  });

  // Trees, roofs and cliffs must keep occluding or the town flattens into a rug.
  it('keeps tree canopies, tent roofs and cliffs above citizens', () => {
    // Every painted cell of the 4x4 riverside tree is collision, which is
    // exactly why collision is a trustworthy signal for height.
    for (const [x, y] of [[16, 25], [17, 26], [16, 27]] as const) {
      expect(tileIsSolid(objmap, x, y), `canopy (${x}, ${y}) is solid`).toBe(true);
      expect(layerAt(x, y)).toBe('overhead');
    }
    // The tent's roof peak is deliberately walkable so a citizen can pass
    // behind it, and it must still occlude. This is the case that proves the
    // rule cannot simply be "walkable means ground".
    for (const [x, y] of [[9, 7], [10, 7], [11, 7], [45, 7]] as const) {
      expect(tileIsStandable(objmap, x, y), `roof peak (${x}, ${y}) is walkable`).toBe(true);
      expect(layerAt(x, y), `roof peak (${x}, ${y})`).toBe('overhead');
    }
  });

  // The invariant, stated over the whole map rather than over samples: the only
  // decoration allowed above a citizen is decoration standing on collision.
  it('leaves nothing overhead that is not rooted in collision', () => {
    const floating: string[] = [];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const frame = decor[x][y];
        if (frame === -1 || frame === undefined) continue;
        if (layerAt(x, y) !== 'overhead') continue;
        const rooted = tileIsSolid(objmap, x, y) || tileIsSolid(objmap, x, y + 1);
        if (!rooted) floating.push(`${frame}@(${x},${y})`);
      }
    }
    expect(floating).toEqual([]);
  });

  it('still exports the verified frames the wilderness scatters', () => {
    expect(new Set([
      ...FOUNDING_GROUND_FLOWER_FRAMES,
      ...FOUNDING_GROUND_TUFT_FRAMES,
      ...FOUNDING_GROUND_ACCENT_FRAMES,
    ])).toEqual(new Set(FOUNDING_GROUND_DECORATION_FRAMES));
  });

  it('treats anything outside the map as solid rather than standable', () => {
    expect(tileIsStandable(objmap, -1, 0)).toBe(false);
    expect(tileIsStandable(objmap, width, 0)).toBe(false);
    expect(tileIsStandable(objmap, 0, height)).toBe(false);
    expect(tileIsStandable(objmap, 1.5, 0)).toBe(false);
  });
});
