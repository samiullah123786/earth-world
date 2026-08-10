import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const FIELD = { x: 21, y: 35 };   // inside zone:common-field

let nonce = 0;
const act = (t: ReturnType<typeof convexTest>, who: { agentId: string; token: string }, action: Record<string, unknown>) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: `f-${nonce++}`, action });

async function citizen(t: ReturnType<typeof convexTest>, suffix: string, at = FIELD) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 6,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  await t.run(async (ctx) => {
    const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === agentId);
    const now = Date.now();
    await ctx.db.patch(row!._id, { fx: at.x, fy: at.y, tx: at.x, ty: at.y, t0: now, t1: now, route: [{ ...at, at: now }] });
  });
  return { agentId, token: `agent-${suffix}` };
}

const facingOf = (t: ReturnType<typeof convexTest>, agentId: string) =>
  t.run(async (ctx) => (await ctx.db.query('citizens').collect()).find((one) => one.agentId === agentId)?.facing);

describe('citizens turn to what they act on', () => {
  it('faces the worked tile in each direction', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'turner', { x: 22, y: 36 });
    await act(t, worker, { type: 'equip', tool: 'watering_can' });

    // The Common Field spans (20,34)-(25,37), so all four targets are workable
    // ground and only the direction differs.
    await act(t, worker, { type: 'plant', x: 23, y: 36 });
    expect(await facingOf(t, worker.agentId)).toBe('right');

    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: 22, fy: 36, tx: 22, ty: 36, t0: now, t1: now, workingUntil: 0 });
    });
    await act(t, worker, { type: 'plant', x: 21, y: 36 });
    expect(await facingOf(t, worker.agentId)).toBe('left');

    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: 22, fy: 36, tx: 22, ty: 36, t0: now, t1: now, workingUntil: 0 });
    });
    await act(t, worker, { type: 'plant', x: 22, y: 35 });
    expect(await facingOf(t, worker.agentId)).toBe('back');

    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: 22, fy: 35, tx: 22, ty: 35, t0: now, t1: now, workingUntil: 0 });
    });
    await act(t, worker, { type: 'plant', x: 22, y: 36 });
    expect(await facingOf(t, worker.agentId)).toBe('front');
  });

  it('turns two citizens toward each other when they speak', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const west = await citizen(t, 'west', { x: 30, y: 24 });
    const east = await citizen(t, 'east', { x: 32, y: 24 });
    await act(t, west, { type: 'say', to: east.agentId, gloss: 'A word about ui, if you have a moment.', topic: 'ui' });
    expect(await facingOf(t, west.agentId)).toBe('right');
    expect(await facingOf(t, east.agentId)).toBe('left');
  });

  it('leaves facing alone when the target is underfoot', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'standing', { x: 22, y: 35 });
    await act(t, worker, { type: 'equip', tool: 'watering_can' });
    // Give it a known heading first, so this asserts what the rule actually
    // promises - the heading survives - rather than how an unset field reads.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      await ctx.db.patch(row!._id, { facing: 'left' });
    });
    await act(t, worker, { type: 'plant', x: 22, y: 35 });
    // No direction is more correct than another for the tile you stand on, so
    // the citizen keeps whatever it was facing rather than snapping.
    expect(await facingOf(t, worker.agentId)).toBe('left');
  });
});
