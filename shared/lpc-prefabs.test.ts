import { describe, expect, it } from 'vitest';
import { LPC_PREFABS, cellsAreContiguous, footprintCells, requireLpcPrefab, validatePrefab, type LpcPrefab } from './lpc-prefabs';

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

  it('ships canonical native prefabs for every standard build action', () => {
    expect(Object.keys(LPC_PREFABS)).toEqual(expect.arrayContaining([
      'house_native_3x3', 'garden_native_2x1', 'bench_native_2x1',
    ]));
  });
});
