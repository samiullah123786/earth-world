import { describe, expect, it } from 'vitest';
import { contains, overlaps, placeOnPlot, planHomestead, yardDepth } from './homestead';

/**
 * The invariant this file exists to hold: nothing a citizen builds may stand
 * on anything else they built. It was violated nineteen times out of
 * twenty-five on the live world, because every structure was placed at the
 * plot's own corner and the home spanned the entire plot.
 */
describe('laying out a homestead', () => {
  const plotSizes = [
    { w: 3, h: 3 }, { w: 4, h: 3 }, { w: 6, h: 6 }, { w: 5, h: 4 },
    { w: 8, h: 6 }, { w: 2, h: 2 }, { w: 1, h: 1 }, { w: 3, h: 1 },
  ];

  it('never lets two parts of one homestead share ground', () => {
    for (const size of plotSizes) {
      const plot = { x: 10, y: 20, ...size };
      const plan = planHomestead(plot);
      const parts = [plan.home, plan.garden, plan.bench].filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          expect(overlaps(parts[i], parts[j]), `${size.w}x${size.h} parts ${i},${j}`).toBe(false);
        }
      }
    }
  });

  it('keeps every part inside the plot it belongs to', () => {
    for (const size of plotSizes) {
      const plot = { x: 7, y: 13, ...size };
      const plan = planHomestead(plot);
      for (const part of [plan.home, plan.garden, plan.bench]) {
        if (part) expect(contains(plot, part), `${size.w}x${size.h}`).toBe(true);
      }
    }
  });

  it('reproduces the exact live failure as a pass', () => {
    // plot-22-38 on the real world: home 3x3 at 22,38 with a garden at 22,40
    // and a bench at 24,40 - both standing on the home's own third row.
    const plot = { x: 22, y: 38, w: 3, h: 3 };
    const plan = planHomestead(plot);
    expect(plan.home).toEqual({ x: 22, y: 38, w: 3, h: 2 });
    expect(plan.garden).toEqual({ x: 22, y: 40, w: 2, h: 1 });
    expect(plan.bench).toEqual({ x: 24, y: 40, w: 1, h: 1 });
    expect(overlaps(plan.home, plan.garden!)).toBe(false);
    expect(overlaps(plan.home, plan.bench!)).toBe(false);
    expect(overlaps(plan.garden!, plan.bench!)).toBe(false);
  });

  it('gives a tiny plot entirely to the dwelling', () => {
    // Somewhere to live beats somewhere to sit when only one will fit.
    const plot = { x: 0, y: 0, w: 2, h: 2 };
    expect(yardDepth(plot)).toBe(0);
    const plan = planHomestead(plot);
    expect(plan.home).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(plan.garden).toBeNull();
    expect(plan.bench).toBeNull();
  });

  it('gives a generous plot a deeper yard', () => {
    const plan = planHomestead({ x: 0, y: 0, w: 6, h: 6 });
    expect(plan.home).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    // Three wide, not five: the yard keeps a margin so the homestead can
    // still grow after its garden is planted.
    expect(plan.garden).toEqual({ x: 0, y: 4, w: 3, h: 2 });
  });
});

describe('placing something new on an occupied plot', () => {
  const plot = { x: 0, y: 0, w: 6, h: 6 };

  it('sends a named part to its planned place when it is free', () => {
    expect(placeOnPlot(plot, 'home', { w: 3, h: 3 }, [])).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(placeOnPlot(plot, 'bench', { w: 1, h: 1 }, [])).toEqual({ x: 5, y: 4, w: 1, h: 1 });
  });

  it('never returns ground that is already taken', () => {
    // The extension bug: an extension came out with the exact footprint of
    // the home it was extending, because it was placed at the same corner.
    const home = { x: 0, y: 0, w: 6, h: 4 };
    const spot = placeOnPlot(plot, 'extension', { w: 2, h: 1 }, [home]);
    expect(spot).not.toBeNull();
    expect(overlaps(spot!, home)).toBe(false);
    expect(contains(plot, spot!)).toBe(true);
  });

  it('refuses rather than overlapping when the plot is genuinely full', () => {
    const full = [{ x: 0, y: 0, w: 6, h: 6 }];
    expect(placeOnPlot(plot, 'extension', { w: 2, h: 2 }, full)).toBeNull();
  });

  it('finds room beside a partial build rather than giving up', () => {
    const corner = [{ x: 0, y: 0, w: 2, h: 2 }];
    const spot = placeOnPlot(plot, 'extension', { w: 2, h: 2 }, corner);
    expect(spot).not.toBeNull();
    expect(overlaps(spot!, corner[0])).toBe(false);
  });

  it('lays a whole homestead down one at a time without a single collision', () => {
    // The settlement path writes home, garden and bench in one batch. Feeding
    // each placement the ones before it is what makes the batch safe.
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const [structure, size] of [
      ['home', { w: 3, h: 3 }], ['garden', { w: 2, h: 1 }],
      ['bench', { w: 1, h: 1 }], ['extension', { w: 2, h: 1 }],
    ] as Array<[string, { w: number; h: number }]>) {
      const spot = placeOnPlot(plot, structure, size, placed);
      expect(spot, structure).not.toBeNull();
      for (const taken of placed) expect(overlaps(spot!, taken), structure).toBe(false);
      placed.push(spot!);
    }
    expect(placed).toHaveLength(4);
  });
});
