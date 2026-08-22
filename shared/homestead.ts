/**
 * How a homestead is laid out on its plot.
 *
 * Every structure a citizen could build was placed at offset (0,0) - the
 * plot's own corner - while the home itself spans the entire plot. So a home,
 * a garden and a bench on one plot did not merely risk overlapping: they were
 * guaranteed to, all three stacked in the same corner, and an extension came
 * out with the exact footprint of the house it extended. Nineteen overlapping
 * pairs out of twenty-five standing structures, measured on the live world.
 *
 * A plot is not a pile. This module divides it: the dwelling takes the north
 * of the parcel, and a one-tile yard along the south holds the garden and the
 * bench. Everything is derived from the plot's own rectangle, so it is
 * deterministic, it fits by construction, and both the settlement path and
 * the build path can ask the same question and get the same answer.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Plot = { x: number; y: number; w: number; h: number };

/** Do these two rectangles share any ground at all? */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function contains(plot: Plot, rect: Rect): boolean {
  return rect.x >= plot.x && rect.y >= plot.y
    && rect.x + rect.w <= plot.x + plot.w
    && rect.y + rect.h <= plot.y + plot.h;
}

/**
 * The yard: the southern strip a plot keeps for everything that is not the
 * dwelling. One tile deep on a small parcel, two on anything generous - a
 * garden needs somewhere to be that is not the living room.
 */
export function yardDepth(plot: Plot): number {
  if (plot.h <= 2) return 0;
  return plot.h >= 6 ? 2 : 1;
}

/**
 * Where the house goes: the plot, less its yard.
 *
 * A plot too small for a yard gives the whole parcel to the dwelling, because
 * a citizen with nowhere to live is worse than a citizen with nowhere to sit.
 */
export function homeRect(plot: Plot): Rect {
  const yard = yardDepth(plot);
  return { x: plot.x, y: plot.y, w: plot.w, h: Math.max(1, plot.h - yard) };
}

/**
 * The full homestead, laid out at once.
 *
 * Returned as named rectangles rather than a list, because the caller always
 * wants a specific one and matching by index is how a bench ends up in a
 * flowerbed.
 */
export function planHomestead(plot: Plot): { home: Rect; garden: Rect | null; bench: Rect | null } {
  const home = homeRect(plot);
  const yard = yardDepth(plot);
  if (yard <= 0) return { home, garden: null, bench: null };

  const yardTop = plot.y + plot.h - yard;
  // The garden takes the yard from the west and stops well short of the far
  // edge on a roomy parcel. A garden that swallows the whole yard leaves a
  // homestead with one free tile and no room to ever add anything - which is
  // a plot that refuses its owner's next build for no reason a person would
  // accept. Small plots give what little they have; large ones keep a margin.
  const gardenWidth = plot.w <= 3 ? Math.max(1, plot.w - 1) : Math.max(2, Math.floor(plot.w / 2));
  const garden = plot.w >= 2
    ? { x: plot.x, y: yardTop, w: gardenWidth, h: yard }
    : null;
  const bench = { x: plot.x + plot.w - 1, y: yardTop, w: 1, h: 1 };
  return { home, garden, bench };
}

/**
 * Where a newly requested structure should stand on a plot that already has
 * things on it.
 *
 * The named parts of a homestead go to their planned places. Anything else -
 * an extension, a custom blueprint - is offered the first free rectangle,
 * scanned row by row so growth spreads across the parcel rather than piling
 * on the door. Returns null when the plot genuinely has no room, which is a
 * refusal the builder deserves to hear rather than a silent overlap.
 */
export function placeOnPlot(
  plot: Plot, structure: string, size: { w: number; h: number }, occupied: ReadonlyArray<Rect>,
): Rect | null {
  const plan = planHomestead(plot);
  const named: Record<string, Rect | null> = {
    home: plan.home, garden: plan.garden, bench: plan.bench,
  };
  const preferred = named[structure];
  if (preferred && contains(plot, preferred) && !occupied.some((taken) => overlaps(preferred, taken))) {
    return preferred;
  }

  const width = Math.max(1, Math.min(size.w, plot.w));
  const height = Math.max(1, Math.min(size.h, plot.h));
  for (let y = plot.y; y + height <= plot.y + plot.h; y++) {
    for (let x = plot.x; x + width <= plot.x + plot.w; x++) {
      const candidate = { x, y, w: width, h: height };
      if (!occupied.some((taken) => overlaps(candidate, taken))) return candidate;
    }
  }
  return null;
}
