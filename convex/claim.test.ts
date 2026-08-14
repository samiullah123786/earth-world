import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

/** The register payload an agent sends; the same public key is the same person. */
function payload(suffix: string, claim: string, expiresInMs = 30 * 60_000) {
  return {
    agentId: `agent:test-${suffix}`, publicKey: `public-${suffix}`, name: `Test ${suffix}`,
    ownerName: `Owner ${suffix}`, gender: 'male' as const, family: 'engineering', accent: 'design',
    genomeDigest: 'a'.repeat(64), charterVersion: '2026-08-09',
    claimTokenHash: claim, claimExpiresAt: Date.now() + expiresInMs,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'light' as const,
  };
}

async function claimTokenCount(t: ReturnType<typeof convexTest>, agentId: string) {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db.query('claimTokens').collect();
    return rows.filter((row: any) => row.agentId === agentId).length;
  });
}

describe('claiming an agent', () => {
  it('never asks a bound owner to claim again when the agent re-registers', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.register, payload('bound', 'claim-bound'));
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-bound', ownerSessionHash: 'owner-bound' });

    // The install re-runs, or doctor --repair rejoins. Same key, same citizen.
    const again: any = await t.mutation(internal.kernel.register, payload('bound', 'claim-bound-2'));
    expect(again.alreadyClaimed).toBe(true);
    // No second token exists, so no link can be handed out and none can leak.
    expect(await claimTokenCount(t, 'agent:test-bound')).toBe(1);
  });

  it('still issues a link when the owner has no live way in', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.register, payload('lapsed', 'claim-lapsed'));
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-lapsed', ownerSessionHash: 'owner-lapsed' });
    // The owner's session ages out; recovery must remain possible.
    await t.run(async (ctx: any) => {
      const session = await ctx.db.query('sessions').withIndex('tokenHash', (q: any) => q.eq('tokenHash', 'owner-lapsed')).first();
      await ctx.db.patch(session._id, { expiresAt: Date.now() - 1 });
    });

    const again: any = await t.mutation(internal.kernel.register, payload('lapsed', 'claim-lapsed-2'));
    expect(again.alreadyClaimed).toBe(false);
    expect(await claimTokenCount(t, 'agent:test-lapsed')).toBe(2);
    // And the fresh link actually works.
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-lapsed-2', ownerSessionHash: 'owner-lapsed-2' });
  });

  it('keeps a claim link single-use', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.register, payload('once', 'claim-once'));
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-once', ownerSessionHash: 'owner-once' });
    await expect(
      t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-once', ownerSessionHash: 'someone-else' }),
    ).rejects.toThrow(/invalid or expired/);
  });

  it('an unclaimed agent still gets a link every time it registers', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.register, payload('waiting', 'claim-waiting'));
    const again: any = await t.mutation(internal.kernel.register, payload('waiting', 'claim-waiting-2'));
    expect(again.status).toBe('pending_owner');
    expect(again.alreadyClaimed).toBe(false);
    expect(await claimTokenCount(t, 'agent:test-waiting')).toBe(2);
  });
});
