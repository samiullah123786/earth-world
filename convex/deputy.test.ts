import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const FOUNDING_MAYOR = 'agent:sam-cbf0499925';

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
  return { agentId, ownerToken: `owner-${suffix}`, agentToken: `agent-${suffix}` };
}

/** Move the seat to somebody else, which is what creates a deputy at all. */
async function seatMayor(t: ReturnType<typeof convexTest>, agentId: string) {
  await t.run(async (ctx: any) => {
    const world = await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
    await ctx.db.patch(world._id, { mayorAgentId: agentId });
  });
  await t.mutation(internal.seed.init, {});
}

/** The governance row is created lazily; one tick brings it into being. */
async function governance(t: ReturnType<typeof convexTest>, patch: Record<string, unknown>) {
  await t.mutation(internal.kernel.deputyTick, {});
  await t.run(async (ctx: any) => {
    const config = await ctx.db.query('governanceConfig').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
    await ctx.db.patch(config._id, patch);
  });
}

async function pendingApproval(t: ReturnType<typeof convexTest>, mayorId: string, kind: string, risk: string) {
  return await t.run(async (ctx: any) => await ctx.db.insert('approvals', {
    agentId: mayorId, kind, summary: `${kind} request`, detail: 'raised for the test',
    payload: {}, state: 'pending', createdAt: Date.now(), risk,
  }));
}

describe('the Deputy Mayor', () => {
  it('takes the office when the seat moves, and answers as the deputy', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const newMayor = await resident(t, 'new-mayor');
    await seatMayor(t, newMayor.agentId);

    await t.run(async (ctx: any) => {
      const sam = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', FOUNDING_MAYOR)).first();
      expect(sam.serviceRole).toBe('Deputy Mayor');
      const seated = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', newMayor.agentId)).first();
      expect(seated.serviceRole).toBe('Mayor of Earth');
    });
  });

  it('clears routine work and never touches anything consequential', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const newMayor = await resident(t, 'seat-holder');
    await seatMayor(t, newMayor.agentId);
    // The offices must be running for any of them to act.
    await governance(t, { authoritiesEnabled: true });

    const consequential = [
      await pendingApproval(t, newMayor.agentId, 'world_expand', 'strict'),
      await pendingApproval(t, newMayor.agentId, 'token_transfer', 'routine'),
      await pendingApproval(t, newMayor.agentId, 'mayor_appointment', 'strict'),
      await pendingApproval(t, newMayor.agentId, 'free_grant', 'routine'),
      await pendingApproval(t, newMayor.agentId, 'claim', 'strict'),
    ];

    const result: any = await t.mutation(internal.kernel.deputyTick, {});
    expect(result.ok).toBe(true);
    // Money, offices, the boundary and anything marked strict stay untouched.
    await t.run(async (ctx: any) => {
      for (const id of consequential) {
        const row = await ctx.db.get(id);
        expect(row.state, `${row.kind} must wait for the Mayor`).toBe('pending');
      }
    });
    expect(result.escalated).toBe(consequential.length);
  });

  it("stands down with the Mayor's switch, and never acts while the town is paused", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const newMayor = await resident(t, 'switcher');
    await seatMayor(t, newMayor.agentId);
    await governance(t, { authoritiesEnabled: true, disabledOffices: ['Deputy Mayor'] });
    const stood: any = await t.mutation(internal.kernel.deputyTick, {});
    expect(stood.skipped).toContain('stood down');

    await governance(t, { disabledOffices: [], townPaused: true });
    const paused: any = await t.mutation(internal.kernel.deputyTick, {});
    expect(paused.skipped).toBeTruthy();
  });

  it('has no deputy at all while the founding Mayor still holds the seat', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await governance(t, { authoritiesEnabled: true });
    await t.run(async (ctx: any) => {
      const world = await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
      await ctx.db.patch(world._id, { mayorAgentId: FOUNDING_MAYOR });
    });
    const result: any = await t.mutation(internal.kernel.deputyTick, {});
    expect(result.skipped).toContain('holds the seat');
  });
});
