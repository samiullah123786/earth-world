import { describe, expect, it } from 'vitest';
import { LPC_PREFABS, cellsAreContiguous, footprintCells, matchLegacyPlacements, requireLpcPrefab, validatePrefab, type LpcPrefab } from './lpc-prefabs';

describe('versioned LPC prefab blueprints', () => {
  it('validates every shipped prefab as a contiguous, layered atomic footprint', () => {
    expect(Object.keys(LPC_PREFABS)).toEqual(expect.arrayContaining([
      'house_small_brick', 'bank_lpc_grand', 'store_wooden',
    ]));
    for (const prefab of Object.values(LPC_PREFABS)) {
      expect(cellsAreContiguous(footprintCells(prefab))).toBe(true);
      expect(prefab.collision).not.toContainEqual(prefab.entry);
      expect(validatePrefab(prefab)).toBe(prefab);
    }
  });

  it('fails closed for unknown, disconnected, or self-blocking blueprints', () => {
    expect(() => requireLpcPrefab('random_tiles')).toThrow(/unknown LPC prefab/i);
    const base = requireLpcPrefab('house_small_brick');
    expect(() => validatePrefab({ ...base, entry: base.collision[0] } as LpcPrefab)).toThrow(/blocks its own entry/i);
    expect(cellsAreContiguous([{ x: 0, y: 0 }, { x: 2, y: 0 }])).toBe(false);
  });

  it('maps the legacy bundled placement lists to one canonical prefab only', () => {
    const garden = requireLpcPrefab('community_garden');
    const legacy = garden.placements.map((placement) => ({
      [placement.layer === 'ground' ? 'tile' : 'prop']: placement.assetId,
      xOffset: placement.xOffset,
      yOffset: placement.yOffset,
    }));
    expect(matchLegacyPlacements(legacy)?.id).toBe('community_garden');
    expect(matchLegacyPlacements(legacy.map((placement) =>
      'prop' in placement && placement.prop === 'wooden_bench'
        ? { ...placement, xOffset: 2 }
        : placement))?.id).toBe('community_garden');
    expect(matchLegacyPlacements([...legacy, { prop: 'streetlamp', xOffset: 3, yOffset: 1 }])).toBeNull();
  });
});
