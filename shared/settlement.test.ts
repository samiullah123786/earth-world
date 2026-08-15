import { describe, expect, it } from 'vitest';
import { EARTH_SETTLEMENT_POLICY, isHabitatReadyPlot, needsHabitatExpansion, rankHomePlots } from './settlement';

describe('Earth settlement policy', () => {
  const plots = [
    { plotId: 'legacy', x: 1, y: 1, w: 3, h: 3, district: 'ui' },
    { plotId: 'far', x: 60, y: 50, w: 6, h: 6, district: 'ui' },
    { plotId: 'near', x: 35, y: 25, w: 6, h: 6, district: 'backend' },
    { plotId: 'match', x: 40, y: 30, w: 6, h: 6, district: 'ui' },
  ];

  it('allots only road-ready habitat-sized sites with stable district preference', () => {
    expect(isHabitatReadyPlot(plots[0])).toBe(false);
    expect(rankHomePlots(plots, 'ui').map((plot) => plot.plotId)).toEqual(['match', 'far', 'near']);
    expect(EARTH_SETTLEMENT_POLICY.homeSite).toMatchObject({ width: 6, height: 6, entrySide: 'south' });
  });

  it('opens another ring before the reserve of home sites is exhausted', () => {
    expect(needsHabitatExpansion(plots)).toBe(true);
    const stocked = Array.from({ length: 8 }, (_unused, index) => ({
      plotId: `p${index}`, x: index * 8, y: 0, w: 6, h: 6, district: 'ui',
    }));
    expect(needsHabitatExpansion(stocked)).toBe(false);
    expect(needsHabitatExpansion(stocked.map((plot, index) => index < 6 ? { ...plot, ownerAgentId: `a${index}` } : plot))).toBe(true);
  });
});
