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
import { ensureWorldState } from './planning';

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
    const renewing = citizen.drivenBy === session.agentId;
    await ctx.db.patch(citizen._id, {
      drivenBy: session.agentId,
      drivenUntil: now + TAKEOVER_LEASE_MS,
      // Stop whatever the agent was doing mid-stride: two things steering one
      // body is how a citizen ends up twitching between two destinations.
      route: undefined, fx: citizen.tx, fy: citizen.ty, t0: now, t1: now,
      activity: drivenActivity(citizen.name),
    });
    if (!renewing) {
      await ctx.db.insert('events', {
        kind: 'move', actorId: citizen.agentId,
        payload: { x: citizen.tx, y: citizen.ty, driven: true },
        gloss: `🎮 ${citizen.name}'s owner stepped in and is walking them in person.`,
      });
    }
    return {
      ok: true, agentId: citizen.agentId, name: citizen.name,
      x: citizen.tx, y: citizen.ty, until: now + TAKEOVER_LEASE_MS, renewing,
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
      payload: { x: citizen.tx, y: citizen.ty, released: true },
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
    const world = await ensureWorldState(ctx);
    const bounds = { width: world.width, height: world.height };
    const isWalkable = await loadWorldWalkability(ctx, bounds);
    const verdict = stepVerdict(
      { x: citizen.tx, y: citizen.ty }, { x, y }, bounds, isWalkable);
    if (!verdict.ok) throw new Error(verdict.why);

    // A step is a short walk, not a teleport: giving it a duration means every
    // watcher interpolates it the same way they interpolate any other walk.
    const STEP_MS = 320;
    const facing = x > citizen.tx ? 'right' : x < citizen.tx ? 'left'
      : y > citizen.ty ? 'front' : 'back';
    await ctx.db.patch(citizen._id, {
      fx: citizen.tx, fy: citizen.ty, tx: x, ty: y,
      t0: now, t1: now + STEP_MS, facing: facing as any,
      route: [{ x: citizen.tx, y: citizen.ty, at: now }, { x, y, at: now + STEP_MS }],
      drivenUntil: now + TAKEOVER_LEASE_MS,
      activity: drivenActivity(citizen.name),
    });
    return { ok: true, x, y, until: now + TAKEOVER_LEASE_MS };
  },
});

/** Whether this owner is currently driving, for a client reconnecting. */
export const status = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await ctx.db.query('sessions')
      .withIndex('tokenHash', (q: any) => q.eq('tokenHash', tokenHash)).first();
    if (!session || session.kind !== 'owner') return { ok: false as const };
    const citizen = await ctx.db.query('citizens')
      .withIndex('agentId', (q: any) => q.eq('agentId', session.agentId)).first();
    if (!citizen) return { ok: false as const };
    const now = Date.now();
    return {
      ok: true as const,
      agentId: citizen.agentId, name: citizen.name,
      x: citizen.tx, y: citizen.ty,
      driving: isDriven({ drivenBy: citizen.drivenBy, drivenUntil: citizen.drivenUntil }, now)
        && citizen.drivenBy === session.agentId,
      asleep: Boolean(citizen.asleepSince),
    };
  },
});
