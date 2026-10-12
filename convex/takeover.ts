/**
 * Taking the wheel of your own citizen.
 *
 * Every mutation here is authorised by the OWNER session - the same session
 * that proves ownership everywhere else - because driving somebody else's
 * agent would make every reputation in this world worthless. The rules a
 * driven citizen obeys are the rules an autonomous one obeys: walkable ground
 * only, one tile per step, inside the world, and every build still goes
 * through civic approval. Possession changes who decides the next step, never
 * which steps are legal.
 */

import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { TAKEOVER_LEASE_MS, drivenActivity, isDriven, stepVerdict } from '../shared/takeover';
import { loadWorldWalkability } from './worldGrid';
import { placeBlock, removeBlock } from './handbuild';
import { greetCitizen } from './greet';
import { ensureWorldState } from './planning';
import { currentPosition, appendRouteHistory } from '../shared/position';

/** The owner session behind this token, and the citizen it owns. */
async function ownedCitizen(ctx: any, tokenHash: string) {
  const session = await ctx.db.query('sessions')
    .withIndex('tokenHash', (q: any) => q.eq('tokenHash', tokenHash)).first();
  if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) {
    throw new Error('sign in as the owner of this citizen first');
  }
  const citizen = await ctx.db.query('citizens')
    .withIndex('agentId', (q: any) => q.eq('agentId', session.agentId)).first();
  if (!citizen) throw new Error('this owner has no citizen in the world');
  return { session, citizen };
}

/** Step into your agent's body, or renew the lease you already hold. */
export const take = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const { session, citizen } = await ownedCitizen(ctx, tokenHash);
    const now = Date.now();
    if (citizen.asleepSince) {
      throw new Error('this citizen is asleep beyond the gate; connect the agent first');
    }
    if (citizen.activeBuildId && (citizen.buildingUntil ?? 0) > now) {
      throw new Error('this citizen is physically committed to an active construction route');
    }
    const renewing = isDriven(citizen, now) && citizen.drivenBy === session.agentId;
    const here = currentPosition(citizen, now);
    await ctx.db.patch(citizen._id, {
      drivenBy: session.agentId,
      drivenUntil: now + TAKEOVER_LEASE_MS,
      // Stop whatever the agent was doing mid-stride: two things steering one
      // body is how a citizen ends up twitching between two destinations.
      ...(renewing ? {} : { route: undefined, recentRoutes: appendRouteHistory(citizen, undefined, now), fx: here.x, fy: here.y, tx: here.x, ty: here.y, t0: now, t1: now }),
      activity: drivenActivity(),
    });
    if (!renewing) {
      await ctx.db.insert('events', {
        kind: 'move', actorId: citizen.agentId,
        payload: { x: here.x, y: here.y, driven: true },
        gloss: `🎮 ${citizen.name}'s owner stepped in and is walking them in person.`,
      });
    }
    return {
      ok: true, agentId: citizen.agentId, name: citizen.name,
      x: here.x, y: here.y, until: now + TAKEOVER_LEASE_MS, renewing,
    };
  },
});

/** Step back out. The agent resumes its own life from wherever it stands. */
export const release = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const { session, citizen } = await ownedCitizen(ctx, tokenHash);
    if (citizen.drivenBy !== session.agentId) return { ok: true, alreadyFree: true };
    await ctx.db.patch(citizen._id, {
      drivenBy: undefined, drivenUntil: undefined,
      activity: 'back on their own again, picking up where they stood',
    });
    await ctx.db.insert('events', {
      kind: 'move', actorId: citizen.agentId,
      payload: { ...currentPosition(citizen, Date.now()), released: true },
      gloss: `🎮 ${citizen.name} has the wheel again.`,
    });
    return { ok: true, agentId: citizen.agentId };
  },
});

/**
 * One step, on foot.
 *
 * A single tile at a time and always onto walkable ground, so a held key or a
 * dropped connection can never fling a body across the map, and every
 * position the world records is one the citizen could have walked to.
 */
export const step = internalMutation({
  args: { tokenHash: v.string(), x: v.number(), y: v.number() },
  handler: async (ctx, { tokenHash, x, y }) => {
    const { session, citizen } = await ownedCitizen(ctx, tokenHash);
    const now = Date.now();
    if (!isDriven({ drivenBy: citizen.drivenBy, drivenUntil: citizen.drivenUntil }, now)
      || citizen.drivenBy !== session.agentId) {
      throw new Error('take the wheel before walking');
    }
    if (citizen.t1 > now) throw new Error('finish the current step before taking another');
    const world = await ensureWorldState(ctx);
    const bounds = { width: world.width, height: world.height };
    const isWalkable = await loadWorldWalkability(ctx, bounds);
    const here = currentPosition(citizen, now);
    const verdict = stepVerdict(here, { x, y }, bounds, isWalkable);
    if (!verdict.ok) throw new Error(verdict.why);
    if (x !== here.x && y !== here.y
      && (!isWalkable(x, here.y) || !isWalkable(here.x, y))) {
      throw new Error('something solid blocks the corner');
    }

    // A step is a short walk, not a teleport: giving it a duration means every
    // watcher interpolates it the same way they interpolate any other walk.
    const STEP_MS = 320;
    const facing = x > citizen.tx ? 'right' : x < citizen.tx ? 'left'
      : y > citizen.ty ? 'front' : 'back';
    const route = [{ x: here.x, y: here.y, at: now }, { x, y, at: now + STEP_MS }];
    await ctx.db.patch(citizen._id, {
      fx: here.x, fy: here.y, tx: x, ty: y,
      t0: now, t1: now + STEP_MS, facing: facing as any,
      route, recentRoutes: appendRouteHistory(citizen, route, now),
      drivenUntil: now + TAKEOVER_LEASE_MS,
      activity: drivenActivity(),
    });
    return { ok: true, x, y, until: now + TAKEOVER_LEASE_MS };
  },
});


/**
 * A driven citizen still has to be the one holding the wheel.
 *
 * Every act below is something the agent itself could have done; possession
 * only changes who chose it. So each one re-checks the lease before acting,
 * because a lapsed wheel means the agent is autonomous again and a stale
 * browser tab must not be able to spend its tokens.
 */
async function atTheWheel(ctx: any, tokenHash: string) {
  const { session, citizen } = await ownedCitizen(ctx, tokenHash);
  if (!isDriven({ drivenBy: citizen.drivenBy, drivenUntil: citizen.drivenUntil }, Date.now())
    || citizen.drivenBy !== session.agentId) {
    throw new Error('take the wheel first');
  }
  return citizen;
}

/**
 * Place a block by hand, paying for it out of the citizen's own purse.
 *
 * Exactly the rules an autonomous agent obeys - own land, on the ground or on
 * the block below, under the height cap, never across a doorway - because the
 * whole promise of takeover is that the world's laws do not bend for whoever
 * happens to be steering.
 */
export const build = internalMutation({
  args: { tokenHash: v.string(), x: v.number(), y: v.number(), level: v.number(), kind: v.string() },
  handler: async (ctx, { tokenHash, x, y, level, kind }) => {
    const citizen = await atTheWheel(ctx, tokenHash);
    // One click, one payment: the tile and the level a human is clicking on
    // cannot be paid for twice in the same second, and a retry of the same
    // click lands on the same key.
    const sourceId = `block:driven:${citizen.agentId}:${x}:${y}:${level}:${Math.floor(Date.now() / 1000)}`;
    const done = await placeBlock(ctx, citizen, { x, y, level, kind }, sourceId);
    await ctx.db.patch(citizen._id, { drivenUntil: Date.now() + TAKEOVER_LEASE_MS });
    return done;
  },
});

export const unbuild = internalMutation({
  args: { tokenHash: v.string(), x: v.number(), y: v.number(), level: v.number() },
  handler: async (ctx, { tokenHash, x, y, level }) => {
    const citizen = await atTheWheel(ctx, tokenHash);
    const done = await removeBlock(ctx, citizen, { x, y, level });
    await ctx.db.patch(citizen._id, { drivenUntil: Date.now() + TAKEOVER_LEASE_MS });
    return done;
  },
});

/**
 * Offer a hand to somebody standing next to you.
 *
 * A handshake needs both people, and driving one of them changes nothing about
 * that: the other citizen still has to offer back, which its own agent decides.
 * You can reach out. You cannot make somebody take your hand.
 */
export const greet = internalMutation({
  args: { tokenHash: v.string(), agentId: v.string() },
  handler: async (ctx, { tokenHash, agentId }) => {
    const citizen = await atTheWheel(ctx, tokenHash);
    const done = await greetCitizen(ctx, citizen, agentId);
    await ctx.db.patch(citizen._id, { drivenUntil: Date.now() + TAKEOVER_LEASE_MS });
    return done;
  },
});

/** Whether this owner is currently driving, for a client reconnecting. */
export const status = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await ctx.db.query('sessions')
      .withIndex('tokenHash', (q: any) => q.eq('tokenHash', tokenHash)).first();
    if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) {
      return { ok: false as const };
    }
    const citizen = await ctx.db.query('citizens')
      .withIndex('agentId', (q: any) => q.eq('agentId', session.agentId)).first();
    if (!citizen) return { ok: false as const };
    const now = Date.now();
    return {
      ok: true as const,
      agentId: citizen.agentId, name: citizen.name,
      ...currentPosition(citizen, now),
      driving: isDriven({ drivenBy: citizen.drivenBy, drivenUntil: citizen.drivenUntil }, now)
        && citizen.drivenBy === session.agentId,
      asleep: Boolean(citizen.asleepSince),
    };
  },
});
