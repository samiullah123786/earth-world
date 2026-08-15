export const EARTH_SETTLEMENT_POLICY = {
  version: 'earth-settlement-v1',
  homeSite: { width: 6, height: 6, entrySide: 'south', roadSearchDepth: 6 },
  reserveHomeSites: 5,
  claimedExpansionRatio: 0.75,
  plotBufferTiles: 1,
  decoration: {
    trees: 'seeded 3x3 groves outside plots, roads, shores and entry corridors',
    planting: 'clustered beds on the ground pass; never isolated visual confetti',
    water: 'open water, then a complete shore socket ring, then dry terrain',
    civicObjects: 'only at authored venues or road-connected civic clearings',
  },
} as const;

export type SettlementPlot = Readonly<{
  plotId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  district: string;
  ownerAgentId?: string;
}>;

export function isHabitatReadyPlot(plot: Pick<SettlementPlot, 'w' | 'h'>) {
  return plot.w >= EARTH_SETTLEMENT_POLICY.homeSite.width
    && plot.h >= EARTH_SETTLEMENT_POLICY.homeSite.height;
}

/** Stable, explainable allotment: eligibility, district fit, civic distance, id. */
export function rankHomePlots<T extends SettlementPlot>(plots: readonly T[], preferredDistrict: string): T[] {
  return plots.filter((plot) => !plot.ownerAgentId && isHabitatReadyPlot(plot))
    .sort((left, right) => Number(right.district === preferredDistrict) - Number(left.district === preferredDistrict)
      || Math.hypot(left.x - 32, left.y - 24) - Math.hypot(right.x - 32, right.y - 24)
      || left.plotId.localeCompare(right.plotId));
}

export function needsHabitatExpansion(plots: readonly SettlementPlot[]) {
  const eligible = plots.filter(isHabitatReadyPlot);
  const free = eligible.filter((plot) => !plot.ownerAgentId).length;
  const claimed = eligible.length - free;
  return free < EARTH_SETTLEMENT_POLICY.reserveHomeSites
    || (eligible.length > 0 && claimed / eligible.length >= EARTH_SETTLEMENT_POLICY.claimedExpansionRatio);
}
