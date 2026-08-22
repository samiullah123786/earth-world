import { describe, expect, it } from 'vitest';
import { TAKEOVER_LEASE_MS, drivenActivity, isDriven, stepVerdict } from './takeover';

const NOW = 1_800_000_000_000;
const bounds = { width: 20, height: 20 };
// A wall down x=5, everything else open.
const walkable = (x: number, y: number) => x >= 0 && y >= 0 && x < 20 && y < 20 && x !== 5;

describe('holding the wheel', () => {
  it('is only held while the lease is live', () => {
    expect(isDriven({ drivenBy: 'agent:me', drivenUntil: NOW + 1000 }, NOW)).toBe(true);
    expect(isDriven({ drivenBy: 'agent:me', drivenUntil: NOW - 1 }, NOW)).toBe(false);
    expect(isDriven({}, NOW)).toBe(false);
  });

  it('lapses on its own, so a citizen is never frozen out of its life', () => {
    // A wheel nobody is at must free the agent. Without this, closing a tab
    // mid-takeover would strand a citizen standing still forever.
    expect(TAKEOVER_LEASE_MS).toBeLessThanOrEqual(120_000);
    expect(isDriven({ drivenBy: 'agent:me', drivenUntil: NOW }, NOW + TAKEOVER_LEASE_MS)).toBe(false);
  });
});

describe('one step at a time', () => {
  const from = { x: 3, y: 3 };

  it('allows a single step in any of the eight directions', () => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      expect(stepVerdict(from, { x: from.x + dx, y: from.y + dy }, bounds, walkable).ok, `${dx},${dy}`).toBe(true);
    }
  });

  it('refuses a leap, so a held key can never fling a body across the map', () => {
    const verdict = stepVerdict(from, { x: 12, y: 3 }, bounds, walkable);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toMatch(/one tile at a time/);
  });

  it('refuses to walk through something solid', () => {
    const verdict = stepVerdict({ x: 4, y: 3 }, { x: 5, y: 3 }, bounds, walkable);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toMatch(/solid/);
  });

  it('refuses to leave the world', () => {
    expect(stepVerdict({ x: 0, y: 0 }, { x: -1, y: 0 }, bounds, walkable).ok).toBe(false);
    expect(stepVerdict({ x: 19, y: 19 }, { x: 20, y: 19 }, bounds, walkable).ok).toBe(false);
  });

  it('refuses a fractional tile', () => {
    expect(stepVerdict(from, { x: 3.5, y: 3 }, bounds, walkable).ok).toBe(false);
  });

  it('refuses a step to nowhere', () => {
    expect(stepVerdict(from, { ...from }, bounds, walkable).ok).toBe(false);
  });

  it('obeys exactly the walkability an autonomous citizen obeys', () => {
    // The rule that makes takeover safe to exist: possession changes who
    // decides the next step, never which steps are legal. Anywhere the map
    // refuses an agent, it refuses a human driving one.
    for (let y = 2; y <= 4; y++) {
      const verdict = stepVerdict({ x: 4, y: 3 }, { x: 5, y }, bounds, walkable);
      expect(verdict.ok, `wall at 5,${y}`).toBe(false);
    }
  });
});

describe('possession is public', () => {
  it('says so in words the feed can carry', () => {
    expect(drivenActivity('Mason')).toMatch(/in person/);
  });
});
