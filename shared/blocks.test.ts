import { describe, expect, it } from 'vitest';
import {
  BLOCK_HEIGHT_CAP, BLOCK_PALETTE, blockCost, blocksWalking,
  isBlockMaterial, placementVerdict, removalVerdict, type TileFacts,
} from './blocks';

const buildable: TileFacts = {
  ownPlot: true, road: false, standable: true, reserved: false, structure: false, stack: 0,
};

const why = (verdict: ReturnType<typeof placementVerdict>) => (verdict.ok ? '' : verdict.why);

describe('the palette', () => {
  it('refuses a material Earth does not stock', () => {
    expect(isBlockMaterial('obsidian')).toBe(false);
    expect(why(placementVerdict('obsidian', 1, buildable, 9999))).toMatch(/no such material/);
  });

  it('prices every material it stocks', () => {
    for (const kind of Object.keys(BLOCK_PALETTE)) {
      expect(blockCost(kind as any)).toBeGreaterThan(0);
    }
  });

  it('knows which materials a walker cannot pass through', () => {
    expect(blocksWalking('stone')).toBe(true);
    expect(blocksWalking('flowers')).toBe(false);
    expect(blocksWalking('path')).toBe(false);
  });
});

describe('where a citizen may build', () => {
  it('places a plank on their own empty ground and charges for it', () => {
    const verdict = placementVerdict('plank', 1, buildable, 100);
    expect(verdict).toEqual({ ok: true, cost: BLOCK_PALETTE.plank.price });
  });

  it('refuses land the builder does not hold', () => {
    expect(why(placementVerdict('plank', 1, { ...buildable, ownPlot: false }, 100)))
      .toMatch(/land you hold/);
  });

  it('refuses to narrow a road', () => {
    expect(why(placementVerdict('stone', 1, { ...buildable, road: true }, 100)))
      .toMatch(/road belongs to everyone/);
  });

  it('refuses water and the void, which have no ground', () => {
    expect(why(placementVerdict('stone', 1, { ...buildable, standable: false }, 100)))
      .toMatch(/no ground/);
  });

  it('will not let anyone wall up a doorway', () => {
    // The Mason was once entombed by a wall completed on his own tile. A
    // hand-placed block must never be able to do the same thing.
    expect(why(placementVerdict('brick', 1, { ...buildable, reserved: true }, 100)))
      .toMatch(/doorway has to stay open/);
  });

  it('refuses a tile a building already stands on', () => {
    expect(why(placementVerdict('brick', 1, { ...buildable, structure: true }, 100)))
      .toMatch(/building already stands/);
  });
});

describe('nothing floats', () => {
  it('refuses a first block placed above the ground', () => {
    expect(why(placementVerdict('stone', 3, buildable, 100))).toMatch(/sits on the ground/);
  });

  it('refuses a gap above an existing column', () => {
    expect(why(placementVerdict('stone', 4, { ...buildable, stack: 2 }, 100)))
      .toMatch(/column is 2 high/);
  });

  it('accepts the very next level up', () => {
    expect(placementVerdict('stone', 3, { ...buildable, stack: 2 }, 100).ok).toBe(true);
  });

  it('refuses a level that is not a whole number', () => {
    expect(why(placementVerdict('stone', 1.5, buildable, 100))).toMatch(/whole level/);
  });
});

describe('nothing towers over the town', () => {
  it('allows a column right up to the cap', () => {
    expect(placementVerdict('stone', BLOCK_HEIGHT_CAP, { ...buildable, stack: BLOCK_HEIGHT_CAP - 1 }, 999).ok)
      .toBe(true);
  });

  it('refuses the block that would clear it', () => {
    expect(why(placementVerdict('stone', BLOCK_HEIGHT_CAP + 1, { ...buildable, stack: BLOCK_HEIGHT_CAP }, 999)))
      .toMatch(new RegExp(`above ${BLOCK_HEIGHT_CAP} blocks`));
  });
});

describe('a block is bought, not wished for', () => {
  it('refuses a builder who cannot afford the material', () => {
    expect(why(placementVerdict('glass', 1, buildable, BLOCK_PALETTE.glass.price - 1)))
      .toMatch(/costs 12 Earth Tokens and you hold 11/);
  });

  it('accepts a builder holding exactly the price', () => {
    expect(placementVerdict('glass', 1, buildable, BLOCK_PALETTE.glass.price).ok).toBe(true);
  });

  it('tells a trespasser they are trespassing before it tells them they are poor', () => {
    // Ordering is a real feature: the useful refusal is the one you can act on.
    expect(why(placementVerdict('glass', 1, { ...buildable, ownPlot: false }, 0)))
      .toMatch(/land you hold/);
  });
});

describe('taking it back down', () => {
  it('removes the top block of your own column', () => {
    expect(removalVerdict(2, { ownPlot: true, stack: 2 })).toEqual({ ok: true });
  });

  it('refuses to pull a block out from under the ones above it', () => {
    expect(removalVerdict(1, { ownPlot: true, stack: 3 }))
      .toEqual({ ok: false, why: 'take the top block first, or the rest would hang in the air' });
  });

  it('refuses an empty column', () => {
    expect(removalVerdict(1, { ownPlot: true, stack: 0 }))
      .toMatchObject({ ok: false, why: expect.stringMatching(/nothing here/) });
  });

  it('refuses somebody else\'s land', () => {
    expect(removalVerdict(1, { ownPlot: false, stack: 2 }))
      .toMatchObject({ ok: false, why: expect.stringMatching(/land you hold/) });
  });
});
