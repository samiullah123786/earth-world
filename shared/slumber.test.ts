import { describe, expect, it } from 'vitest';
import { SLUMBER_GRACE_MS, WAKING_GATE, isAsleep, renderTransition, slumberVerdict } from './slumber';

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

describe('what the renderer should do about one citizen', () => {
  const awake = { online: false };
  const sleeping = { online: false, asleepSince: NOW };
  const office = { online: true, serviceRole: 'Community Greeter' };
  const at = (state: object, flags: Partial<{ drawn: boolean; sleptHere: boolean; firstLoad: boolean; departing: boolean }>) =>
    renderTransition(state, { drawn: false, sleptHere: false, firstLoad: false, departing: false, ...flags });

  it('spirals a drawn citizen into the vortex when they fall asleep', () => {
    expect(at(sleeping, { drawn: true })).toBe('depart');
  });

  it('does not start a second departure for one already leaving', () => {
    // The reconciler runs on every Kernel update, and the walk-then-spiral
    // takes about a second and a half. Without this the animation restarts
    // from the top several times and the citizen never actually leaves.
    expect(at(sleeping, { drawn: true, departing: true })).toBe('hold');
  });

  it('removes a citizen who was already asleep before the page opened', () => {
    // Nothing to walk out of the world - they were gone before anyone looked.
    expect(at(sleeping, { drawn: true, firstLoad: true })).toBe('vanish');
  });

  it('leaves an undrawn sleeper alone rather than spawning them to hide them', () => {
    expect(at(sleeping, { drawn: false })).toBe('hold');
  });

  it('winds a citizen out of the vortex when their owner comes back', () => {
    // The case worth pinning: a missed `wake` is invisible. The citizen simply
    // appears beside the gate, which reads as nothing rather than as a bug.
    expect(at(awake, { drawn: false, sleptHere: true })).toBe('wake');
  });

  it('gives confetti, not the gate, to somebody nobody watched leave', () => {
    expect(at(awake, { drawn: false, sleptHere: false })).toBe('arrive');
  });

  it('does not animate anybody on the first load', () => {
    expect(at(awake, { drawn: false, sleptHere: true, firstLoad: true })).toBe('hold');
    expect(at(awake, { drawn: false, sleptHere: false, firstLoad: true })).toBe('hold');
  });

  it('does nothing for a citizen already on screen and awake', () => {
    expect(at(awake, { drawn: true })).toBe('hold');
  });

  it('never sends an office through the gate', () => {
    // Offices have no owner to disconnect and are what keeps the town
    // populated when every human is away.
    expect(at({ ...office, asleepSince: NOW }, { drawn: true })).toBe('hold');
  });
});
