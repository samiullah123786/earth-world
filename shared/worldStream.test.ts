import { describe, expect, it } from 'vitest';
import { applyWorldDelta, worldDelta } from './worldStream';

describe('public world stream reconciliation', () => {
  it('updates movement, removes entities and propagates block-only and component changes', () => {
    const before = { serverNow: 10, width: 64, citizens: [{ agentId: 'a', tx: 1 }, { agentId: 'b', tx: 3 }], blocks: [], creations: [{ creationId: 'home', signals: { light: false } }] };
    const after = { serverNow: 20, width: 80, citizens: [{ agentId: 'a', tx: 2 }], blocks: [{ x: 70, y: 3, level: 0, material: 'stone' }], creations: [{ creationId: 'home', signals: { light: true } }] };
    expect(applyWorldDelta(before, worldDelta(before, after))).toEqual(after);
  });
  it('preserves unchanged lists during a heartbeat', () => {
    const before = { serverNow: 10, citizens: [{ agentId: 'a', recentRoutes: [[{ x: 1, y: 2, at: 9 }]] }], chunks: [{ x: 4, y: 2, rows: ['gg'] }] };
    const after = { ...before, serverNow: 11 };
    expect(worldDelta(before, after).lists).toEqual({});
    expect(applyWorldDelta(before, worldDelta(before, after))).toEqual(after);
  });
});
