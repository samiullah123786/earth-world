import { describe, expect, it } from 'vitest';
import { creationCollision, creationCost, evaluateSignals, parseCreation, starterHome } from './creation';

describe('creation grammar and deterministic game physics', () => {
  it('builds a supported editable starter home within the new-citizen budget', () => {
    const plan = starterHome(10, 10);
    expect(creationCost(plan)).toBeGreaterThan(0);
    expect(creationCost(plan)).toBeLessThan(500);
    const closed = creationCollision({ plan, signals: {}, progress: plan.parts.length });
    const open = creationCollision({ plan, signals: { 'door-power': true }, progress: plan.parts.length });
    const door = plan.parts.find(part => part.shape === 'door')!;
    expect(closed.some(c => c.x === plan.x + door.x && c.y === plan.y + door.z)).toBe(true);
    expect(open.some(c => c.x === plan.x + door.x && c.y === plan.y + door.z)).toBe(false);
    expect(open.some(c => c.x === 12 && c.y === 12)).toBe(false);
  });
  it('rejects code, invalid IDs, overlapping parts and unsupported geometry', () => {
    const plan = starterHome(10, 10);
    expect(() => parseCreation({ ...plan, script: 'fetch(secret)' })).toThrow(/never code/);
    expect(() => parseCreation({ ...plan, parts: [{ ...plan.parts[0], id: '__proto__' }] })).toThrow(/identifiers/);
    expect(() => parseCreation({ ...plan, parts: [{ ...plan.parts[1], y: 3 }], circuits: [], bindings: [] })).toThrow(/support|envelope/);
    expect(() => parseCreation({ ...plan, parts: [plan.parts[0], { ...plan.parts[0], id: 'overlap' }], circuits: [], bindings: [] })).toThrow(/overlaps/);
    expect(() => parseCreation({ ...plan, parts: [{ ...plan.parts[0], x: .1 }] })).toThrow(/quarter/);
  });
  it('evaluates bounded logic and rejects cycles or missing signals', () => {
    const plan = starterHome(10, 10);
    plan.circuits.push({ id: 'not-door', type: 'not', inputs: ['door-power'] }, { id: 'both', type: 'and', inputs: ['door-power', 'light-power'] }, { id: 'clock', type: 'timer', inputs: [], period: 5 });
    expect(evaluateSignals(plan, { 'door-power': true, 'light-power': true }, 6000)).toMatchObject({ 'not-door': false, both: true, clock: true });
    expect(evaluateSignals(plan, {}, 10000).clock).toBe(false);
    expect(() => parseCreation({ ...plan, circuits: [{ id: 'door-power', type: 'not', inputs: ['door-power'] }, plan.circuits[1]] })).toThrow(/cycles/);
    expect(() => parseCreation({ ...plan, circuits: [{ id: 'door-power', type: 'not', inputs: ['missing'] }, plan.circuits[1]] })).toThrow(/Unknown signal/);
  });
});
