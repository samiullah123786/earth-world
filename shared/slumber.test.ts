import { describe, expect, it } from 'vitest';
import { SLUMBER_GRACE_MS, WAKING_GATE, isAsleep, slumberVerdict } from './slumber';

const NOW = 1_700_000_000_000;

describe('who is asleep', () => {
  it('a citizen with no sleep stamp is awake', () => {
    expect(isAsleep({ online: false })).toBe(false);
  });

  it('a citizen with a sleep stamp is asleep', () => {
    expect(isAsleep({ online: false, asleepSince: NOW })).toBe(true);
  });

  it('an office is never asleep, stamp or not', () => {
    // This is what keeps the world populated when every human is away. If
    // offices could sleep, a town with no owners online would be empty grass,
    // and the Greeter would not be there to meet the first person back.
    expect(isAsleep({ online: false, serviceRole: 'Community Greeter', asleepSince: NOW })).toBe(false);
  });
});

describe('the verdict', () => {
  it('leaves a live citizen exactly alone', () => {
    expect(slumberVerdict({ online: true }, NOW)).toBe('hold');
  });

  it('does not sleep somebody over a single missed heartbeat', () => {
    // Presence is leased and swept, so `online` flickers off for a lid close,
    // a tunnel, a redeploy. None of those should send anyone through the gate.
    expect(slumberVerdict({ online: false, offlineSince: NOW - 1_000 }, NOW)).toBe('hold');
    expect(slumberVerdict({ online: false, offlineSince: NOW - SLUMBER_GRACE_MS + 1 }, NOW)).toBe('hold');
  });

  it('sleeps a citizen once the grace period is spent', () => {
    expect(slumberVerdict({ online: false, offlineSince: NOW - SLUMBER_GRACE_MS }, NOW)).toBe('sleep');
    expect(slumberVerdict({ online: false, offlineSince: NOW - 600_000 }, NOW)).toBe('sleep');
  });

  it('waits a round rather than sleeping somebody it has never seen go offline', () => {
    // No offlineSince means this is the first sweep to notice. Sleeping here
    // would put every citizen through the gate on the first run after deploy.
    expect(slumberVerdict({ online: false }, NOW)).toBe('hold');
  });

  it('wakes the moment the owner is back, without waiting for anything', () => {
    expect(slumberVerdict({ online: true, asleepSince: NOW - 500_000 }, NOW)).toBe('wake');
  });

  it('never sleeps an office, and wakes one that somehow slept', () => {
    expect(slumberVerdict({ online: false, serviceRole: 'Community Warden', offlineSince: NOW - 900_000 }, NOW)).toBe('hold');
    expect(slumberVerdict({ online: false, serviceRole: 'Community Warden', asleepSince: NOW }, NOW)).toBe('wake');
  });

  it('holds a sleeping citizen asleep rather than re-stamping them', () => {
    // Re-stamping every sweep would rewrite a row a minute for every absent
    // citizen - the write load this whole change exists to remove.
    expect(slumberVerdict({ online: false, asleepSince: NOW - 10_000, offlineSince: NOW - 600_000 }, NOW)).toBe('hold');
  });

  it('respects a caller-supplied grace period', () => {
    expect(slumberVerdict({ online: false, offlineSince: NOW - 5_000 }, NOW, 1_000)).toBe('sleep');
  });
});

describe('the gate', () => {
  it('stands on open ground the renderer and the Kernel both agree on', () => {
    expect(WAKING_GATE).toEqual({ x: 29, y: 26 });
  });

  it('is close enough to Founding Plaza to be seen from it', () => {
    // Founding Plaza is at 32,24. A gate nobody walks past is a gate nobody
    // understands, so its distance from the town centre is part of the design.
    const distance = Math.hypot(WAKING_GATE.x - 32, WAKING_GATE.y - 24);
    expect(distance).toBeGreaterThan(2);
    expect(distance).toBeLessThan(12);
  });

  it('does not stand inside the Earth Bank, which is where it was first put', () => {
    // The bank's plot is 30,17 six by six. The original site looked clear on
    // the collision layer and was drawn straight through the domed roof,
    // because the tilemap knows nothing about what citizens have built on it.
    const insideBank = WAKING_GATE.x >= 30 && WAKING_GATE.x < 36
      && WAKING_GATE.y >= 17 && WAKING_GATE.y < 23;
    expect(insideBank).toBe(false);
  });
});
