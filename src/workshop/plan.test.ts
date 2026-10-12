import { describe, it, expect } from 'vitest';
import { generatePlan, parsePlan, placementError, History, footprint } from './plan';

describe('neighborhood drafts from humans and external agents', () => {
  it('produces reproducible, non-overlapping, road-preserving plans for every recipe', () => {
    for (const recipe of ['village', 'research', 'garden'] as const) for (let seed = 0; seed < 100; seed++) {
      const p = generatePlan(String(seed), recipe);
      expect(parsePlan(p)).toEqual(p);
      expect(generatePlan(String(seed), recipe)).toEqual(p);
      expect(p.objects.length).toBeGreaterThan(5);
    }
  });
  it('refuses unknown assets, collisions, duplicate IDs, fractional coordinates, and oversized plans', () => {
    const p = generatePlan('earth', 'research');
    const first = p.objects[0];
    expect(() => parsePlan({ ...p, objects: [{ ...first, assetId: 'https://untrusted/model.glb' }] })).toThrow('Unknown block');
    expect(() => parsePlan({ ...p, objects: [first, { ...first, id: 'other' }] })).toThrow('overlaps');
    expect(() => parsePlan({ ...p, objects: [first, first] })).toThrow('unique');
    expect(() => parsePlan({ ...p, objects: [{ ...first, x: .5 }] })).toThrow('whole tiles');
    expect(() => parsePlan({ ...p, objects: Array(201).fill(first) })).toThrow('200');
    expect(() => parsePlan({ ...p, objects: [{ ...first, x: 14 }] })).toThrow('roads clear');
    expect(() => parsePlan({ ...p, objects: [{ ...first, rotation: 4 }] })).toThrow('Rotation');
  });
  it('swaps the footprint on rotation and excludes only the object being moved', () => {
    const p = { id: 'a', assetId: 'home-a', x: 1, y: 1, rotation: 1 as const };
    expect(footprint(p)).toEqual({ w: 3, h: 4 });
    expect(placementError(p, [p])).toBeNull();
    expect(placementError({ ...p, x: 31 }, [])).toContain('inside');
  });
  it('strips extra agent fields and keeps edit history reversible across a replacement', () => {
    const a = generatePlan('a', 'village'), b = generatePlan('b', 'research');
    expect(parsePlan({ ...a, authority: 'admin', objects: a.objects.map(o => ({ ...o, url: 'bad' })) })).toEqual(a);
    const h = new History(a); h.commit(b); h.undo(); expect(h.current).toEqual(a);
    h.redo(); expect(h.current).toEqual(b); h.undo(); h.commit(generatePlan('c', 'garden')); expect(h.canRedo).toBe(false);
  });
});
