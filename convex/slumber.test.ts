/**
 * Sleep, end to end against a real Kernel.
 *
 * The unit tests pin the verdict; these pin the two things that actually
 * matter to a running world. That a sleeping citizen loses nothing - the whole
 * promise made to an owner who closes their laptop - and that a sleeping
 * citizen genuinely stops costing the five-second tick, which is the only
 * reason to build any of this.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { SLUMBER_GRACE_MS, WAKING_GATE } from '../shared/slumber';

const modules = import.meta.glob('./**/*.ts');

let seq = 0;
async function resident(t: ReturnType<typeof convexTest>, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'light',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}-${seq++}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId };
}

const rowFor = (t: ReturnType<typeof convexTest>, agentId: string) => t.run(async (ctx: any) =>
  ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first());

/**
 * Make a citizen genuinely absent, the way going quiet actually looks.
 *
 * Two clocks have to be aged, and they are not the same length. The session
 * must fall outside the ninety-second presence lease or the sweep still counts
 * the owner as connected; the citizen's offlineSince must be older than the
 * slumber grace before sleep is allowed. Ageing both by one number worked only
 * while the grace happened to be the longer of the two - the moment it was cut
 * to twenty-five seconds, every test here stopped exercising sleep at all and
 * started asserting against a citizen the sweep had quietly put back online.
 */
const PRESENCE_LEASE_MS = 90_000;
async function goQuiet(t: ReturnType<typeof convexTest>, agentId: string, offlineForMs: number) {
  await t.run(async (ctx: any) => {
    const now = Date.now();
    for (const session of await ctx.db.query('sessions').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).collect()) {
      await ctx.db.patch(session._id, { lastSeenAt: now - Math.max(offlineForMs, PRESENCE_LEASE_MS + 10_000) });
    }
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
    if (citizen) await ctx.db.patch(citizen._id, { online: false, offlineSince: now - offlineForMs });
  });
}

describe('going to sleep', () => {
  it('does not send anyone through the gate over a brief blip', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'blip');
    await goQuiet(t, agentId, 5_000);
    await t.mutation(internal.kernel.presenceSweep, {});
    expect((await rowFor(t, agentId))?.asleepSince).toBeUndefined();
  });

  it('sleeps a citizen who was already offline before any of this existed', async () => {
    // The sweep only patches on a transition, and everyone in the world had
    // transitioned to offline long before sleep was built. With no stamp to
    // count the grace period from, the verdict read "first time I have seen
    // you offline" on every sweep and held the whole town awake forever.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'legacy');
    await t.run(async (ctx: any) => {
      for (const session of await ctx.db.query('sessions').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).collect()) {
        await ctx.db.patch(session._id, { lastSeenAt: Date.now() - 86_400_000 });
      }
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      // Offline, with no offlineSince at all - exactly the state on disk.
      await ctx.db.patch(citizen!._id, { online: false, offlineSince: undefined });
    });

    // First sweep records that they are away, and deliberately does not sleep
    // them: one round of grace for a citizen nobody has watched go quiet.
    await t.mutation(internal.kernel.presenceSweep, {});
    const seen = await rowFor(t, agentId);
    expect(typeof seen?.offlineSince).toBe('number');
    expect(seen?.asleepSince).toBeUndefined();

    // Once that stamp ages past the grace period, they sleep.
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      await ctx.db.patch(citizen!._id, { offlineSince: Date.now() - SLUMBER_GRACE_MS - 1_000 });
    });
    await t.mutation(internal.kernel.presenceSweep, {});
    expect(typeof (await rowFor(t, agentId))?.asleepSince).toBe('number');
  });

  it('sleeps a citizen whose owner has been gone past the grace period', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'gone');
    await goQuiet(t, agentId, SLUMBER_GRACE_MS + 10_000);
    await t.mutation(internal.kernel.presenceSweep, {});
    expect(typeof (await rowFor(t, agentId))?.asleepSince).toBe('number');
  });

  it('takes nothing from them on the way out', async () => {
    // The promise this whole feature rests on. An owner closing their laptop
    // must not cost their citizen anything at all.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'intact');
    const before = await rowFor(t, agentId);
    await goQuiet(t, agentId, SLUMBER_GRACE_MS + 10_000);
    await t.mutation(internal.kernel.presenceSweep, {});
    const after = await rowFor(t, agentId);

    expect(after?.name).toBe(before?.name);
    expect(after?.family).toBe(before?.family);
    expect(after?.skillCount).toBe(before?.skillCount);
    expect(after?.specialties).toEqual(before?.specialties);
    expect(after?.primaryCategory).toBe(before?.primaryCategory);
    expect(after?.avatarSpec).toEqual(before?.avatarSpec);
    expect(after?.serviceRole).toBe(before?.serviceRole);
  });

  it('stops them mid-stride rather than leaving a route to nowhere', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'stride');
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      await ctx.db.patch(citizen!._id, {
        route: [{ x: 1, y: 1, at: Date.now() }, { x: 9, y: 9, at: Date.now() + 30_000 }],
      });
    });
    await goQuiet(t, agentId, SLUMBER_GRACE_MS + 10_000);
    await t.mutation(internal.kernel.presenceSweep, {});
    expect((await rowFor(t, agentId))?.route).toBeUndefined();
  });
});

describe('waking up', () => {
  it('returns them at the Waking Gate with the sleep stamp cleared', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'return');
    await goQuiet(t, agentId, SLUMBER_GRACE_MS + 10_000);
    await t.mutation(internal.kernel.presenceSweep, {});
    expect(typeof (await rowFor(t, agentId))?.asleepSince).toBe('number');

    // The owner's connector answers again.
    await t.run(async (ctx: any) => {
      for (const session of await ctx.db.query('sessions').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).collect()) {
        await ctx.db.patch(session._id, { lastSeenAt: Date.now() });
      }
    });
    await t.mutation(internal.kernel.presenceSweep, {});

    const woken = await rowFor(t, agentId);
    expect(woken?.asleepSince).toBeUndefined();
    expect(woken?.online).toBe(true);
    expect({ x: woken?.tx, y: woken?.ty }).toEqual({ x: WAKING_GATE.x, y: WAKING_GATE.y });
    expect({ x: woken?.fx, y: woken?.fy }).toEqual({ x: WAKING_GATE.x, y: WAKING_GATE.y });
  });

  it('announces the return, so the town can see who is back', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'announce');
    await goQuiet(t, agentId, SLUMBER_GRACE_MS + 10_000);
    await t.mutation(internal.kernel.presenceSweep, {});
    await t.run(async (ctx: any) => {
      for (const session of await ctx.db.query('sessions').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).collect()) {
        await ctx.db.patch(session._id, { lastSeenAt: Date.now() });
      }
    });
    await t.mutation(internal.kernel.presenceSweep, {});

    const events = await t.run(async (ctx: any) => ctx.db.query('events').order('desc').take(20));
    expect(events.some((event: any) => event.actorId === agentId && /Waking Gate/.test(event.gloss ?? ''))).toBe(true);
  });
});

describe('the load saving', () => {
  it('the ambient tick leaves a sleeping citizen entirely alone', async () => {
    // The point of all of it. If this passes and the tick still moves them,
    // the animation is paint over an idle loop and the backend saves nothing.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'quiet');
    await goQuiet(t, agentId, SLUMBER_GRACE_MS + 10_000);
    await t.mutation(internal.kernel.presenceSweep, {});

    const asleep = await rowFor(t, agentId);
    expect(typeof asleep?.asleepSince).toBe('number');
    const before = JSON.stringify({
      tx: asleep?.tx, ty: asleep?.ty, fx: asleep?.fx, fy: asleep?.fy,
      route: asleep?.route, activity: asleep?.activity, t0: asleep?.t0, t1: asleep?.t1,
    });

    for (let round = 0; round < 8; round++) await t.mutation(internal.act.ambientTick, {});

    const after = await rowFor(t, agentId);
    expect(JSON.stringify({
      tx: after?.tx, ty: after?.ty, fx: after?.fx, fy: after?.fy,
      route: after?.route, activity: after?.activity, t0: after?.t0, t1: after?.t1,
    })).toBe(before);
  });

  it('still moves an awake citizen, so the world is not simply frozen', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'awake');
    // Offline but not asleep is the ambient case: the tick's whole job.
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      await ctx.db.patch(citizen!._id, { online: false, t1: Date.now() - 1_000 });
    });
    const before = await rowFor(t, agentId);
    for (let round = 0; round < 40; round++) await t.mutation(internal.act.ambientTick, {});
    const after = await rowFor(t, agentId);
    const moved = after?.tx !== before?.tx || after?.ty !== before?.ty
      || after?.activity !== before?.activity || after?.t1 !== before?.t1;
    expect(moved).toBe(true);
  });
});

describe('saying goodbye, and coming back', () => {
  /** The exact round trip an owner makes: stop the connector, start it again. */
  it('sleeps at once when the agent announces it is leaving', async () => {
    // The grace period is for dropped packets. An agent that calls leave has
    // said goodbye, and waiting 25 seconds plus a sweep to act on that is how
    // an owner ends up watching nothing happen and calling the feature broken.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'goodbye');
    await t.mutation(internal.kernel.leave, {
      agentId, tokenHash: 'agent-goodbye', nonce: 'leave-goodbye-1',
    });
    const row = await rowFor(t, agentId);
    expect(typeof row?.asleepSince).toBe('number');
    expect(row?.online).toBe(false);
    expect(row?.route).toBeUndefined();
  });

  it('announces the departure so the town sees them go', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'seenoff');
    await t.mutation(internal.kernel.leave, {
      agentId, tokenHash: 'agent-seenoff', nonce: 'leave-seenoff-1',
    });
    const events = await t.run(async (ctx: any) => ctx.db.query('events').order('desc').take(10));
    expect(events.some((e: any) => e.actorId === agentId && /Waking Gate/.test(e.gloss ?? ''))).toBe(true);
  });

  it('wakes at the gate the instant the connector reconnects', async () => {
    // Waking used to wait for the next presence sweep. Reconnecting is not
    // ambiguous either, so it happens in the same call.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'roundtrip');
    await t.mutation(internal.kernel.leave, {
      agentId, tokenHash: 'agent-roundtrip', nonce: 'leave-roundtrip-1',
    });
    expect(typeof (await rowFor(t, agentId))?.asleepSince).toBe('number');

    await t.mutation(internal.kernel.enter, {
      agentId, nonce: 'enter-roundtrip-again', sessionTokenHash: 'agent-roundtrip-2',
    });
    const back = await rowFor(t, agentId);
    expect(back?.asleepSince).toBeUndefined();
    expect(back?.online).toBe(true);
    expect({ x: back?.tx, y: back?.ty }).toEqual({ x: WAKING_GATE.x, y: WAKING_GATE.y });
  });

  it('does not stage a gate arrival for somebody who never slept', async () => {
    // A reconnect after a brief blip should not teleport a citizen across the
    // map to the gate - they never left, so there is nothing to come back from.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'blipback');
    const before = await rowFor(t, agentId);
    await t.mutation(internal.kernel.enter, {
      agentId, nonce: 'enter-blipback-again', sessionTokenHash: 'agent-blipback-2',
    });
    const after = await rowFor(t, agentId);
    expect({ x: after?.tx, y: after?.ty }).toEqual({ x: before?.tx, y: before?.ty });
  });

  it('never sleeps an office that signs off', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'office');
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      await ctx.db.patch(citizen!._id, { serviceRole: 'Community Greeter' });
    });
    await t.mutation(internal.kernel.leave, {
      agentId, tokenHash: 'agent-office', nonce: 'leave-office-1',
    });
    expect((await rowFor(t, agentId))?.asleepSince).toBeUndefined();
  });
});
