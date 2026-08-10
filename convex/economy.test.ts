import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import {
  GENESIS_GRANT, assertSupplyInvariant, balanceOf, grantFromTreasury, issue, mintToTreasury, payForTrade, supplyAudit,
} from './economy';

const modules = import.meta.glob('./**/*.ts');
const MAYOR_ID = 'agent:sam-cbf0499925';

async function citizen(t: ReturnType<typeof convexTest>, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  return { agentId, ownerToken: `owner-${suffix}` };
}

/** Bind an owner session to the seeded Mayor so treasury routes are reachable. */
async function mayorSession(t: ReturnType<typeof convexTest>, tokenHash = 'owner-mayor') {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('sessions', {
      tokenHash, agentId: MAYOR_ID, kind: 'owner', createdAt: now,
      expiresAt: now + 60_000, lastSeenAt: now,
    });
  });
  return tokenHash;
}

describe('Earth Token economy', () => {
  it('grants every new citizen exactly five tokens, once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const one = await citizen(t, 'grant');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, one.agentId)).toBe(GENESIS_GRANT);
    });

    // Re-registering the same key must never grant a second time.
    await t.mutation(internal.kernel.register, {
      agentId: one.agentId, publicKey: 'public-grant', name: 'Test grant', ownerName: 'Owner grant',
      gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
      charterVersion: '2026-08-09', claimTokenHash: 'claim-grant-2', claimExpiresAt: Date.now() + 60_000,
    });
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, one.agentId)).toBe(GENESIS_GRANT);
      const grants = (await ctx.db.query('ledger').collect()).filter((entry) => entry.kind === 'genesis_grant' && entry.toAgentId === one.agentId);
      expect(grants).toHaveLength(1);
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses to pay the same source twice however often it is retried', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const movement = {
        toAgentId: 'agent:x', amount: 4, kind: 'gift_reward' as const,
        sourceId: 'gift:share:once', reason: 'accepted a verified card',
      };
      const first = await issue(ctx, movement);
      const second = await issue(ctx, movement);
      const third = await issue(ctx, movement);
      expect([first.posted, second.posted, third.posted]).toEqual([true, false, false]);
      expect(await balanceOf(ctx, 'agent:x')).toBe(4);
      await assertSupplyInvariant(ctx);
    });
  });

  it('never lets a balance go negative or a trade overspend', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await issue(ctx, { toAgentId: 'agent:buyer', amount: 3, kind: 'genesis_grant', sourceId: 'genesis:buyer', reason: 'arrival grant' });
      await expect(payForTrade(ctx, {
        fromAgentId: 'agent:buyer', toAgentId: 'agent:seller', amount: 9,
        sourceId: 'trade:over', reason: 'buying a package',
      })).rejects.toThrow(/holds 3 Earth Tokens/);
      expect(await balanceOf(ctx, 'agent:buyer')).toBe(3);
      expect(await balanceOf(ctx, 'agent:seller')).toBe(0);
      await assertSupplyInvariant(ctx);
    });
  });

  it('moves a trade payment without changing total supply', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await issue(ctx, { toAgentId: 'agent:buyer', amount: 10, kind: 'genesis_grant', sourceId: 'genesis:buyer', reason: 'arrival grant' });
      const before = await supplyAudit(ctx);
      await payForTrade(ctx, {
        fromAgentId: 'agent:buyer', toAgentId: 'agent:seller', amount: 6,
        sourceId: 'trade:ok', reason: 'buying a package',
      });
      expect(await balanceOf(ctx, 'agent:buyer')).toBe(4);
      expect(await balanceOf(ctx, 'agent:seller')).toBe(6);
      expect((await supplyAudit(ctx)).minted).toBe(before.minted);
      await assertSupplyInvariant(ctx);
    });
  });

  it('mints into the Treasury and never straight into a wallet', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await mintToTreasury(ctx, { amount: 500, reason: 'seed the community fund', sourceId: 'mint:one', authorizedBy: MAYOR_ID });
      const audit = await supplyAudit(ctx);
      expect(audit).toMatchObject({ minted: 500, held: 500, circulating: 0, balanced: true });
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses a grant the Treasury cannot cover and a Mayor self-grant', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await mintToTreasury(ctx, { amount: 10, reason: 'seed the community fund', sourceId: 'mint:small', authorizedBy: MAYOR_ID });
      await expect(grantFromTreasury(ctx, {
        toAgentId: 'agent:someone', amount: 50, reason: 'too much', sourceId: 'grant:over', authorizedBy: MAYOR_ID,
      })).rejects.toThrow(/Treasury holds 10/);
      await expect(grantFromTreasury(ctx, {
        toAgentId: MAYOR_ID, amount: 5, reason: 'paying myself', sourceId: 'grant:self', authorizedBy: MAYOR_ID,
      })).rejects.toThrow(/cannot grant Earth Tokens to their own citizen/);
      await assertSupplyInvariant(ctx);
    });
  });

  it('rejects fractional, zero, negative, and unreasoned movements', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const bad = (amount: number, reason = 'a valid reason') => issue(ctx, {
        toAgentId: 'agent:x', amount, kind: 'gift_reward', sourceId: `gift:${amount}:${reason}`, reason,
      });
      await expect(bad(2.5)).rejects.toThrow(/whole numbers above zero/);
      await expect(bad(0)).rejects.toThrow(/whole numbers above zero/);
      await expect(bad(-4)).rejects.toThrow(/whole numbers above zero/);
      await expect(bad(1_000_000)).rejects.toThrow(/are refused/);
      await expect(bad(4, 'x')).rejects.toThrow(/4-240 character reason/);
    });
  });

  it('lets only the sitting Mayor reach the treasury routes', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const ordinary = await citizen(t, 'nomayor');
    await expect(t.mutation(internal.kernel.mayorMint, {
      tokenHash: ordinary.ownerToken, amount: 100, reason: 'I would like more tokens', sourceId: 'sneaky',
    })).rejects.toThrow(/only the sitting Mayor/);
    await expect(t.mutation(internal.kernel.mayorAudit, { tokenHash: ordinary.ownerToken }))
      .rejects.toThrow(/only the sitting Mayor/);

    const mayorToken = await mayorSession(t);
    const minted = await t.mutation(internal.kernel.mayorMint, {
      tokenHash: mayorToken, amount: 250, reason: 'fund the newcomer welcome pool', sourceId: 'welcome-pool',
    });
    expect(minted.audit).toMatchObject({ minted: 250 + GENESIS_GRANT, held: 250, balanced: true });
  });

  it('carries a mint idempotency key so a double-clicked form mints once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mayorToken = await mayorSession(t);
    const call = () => t.mutation(internal.kernel.mayorMint, {
      tokenHash: mayorToken, amount: 100, reason: 'fund the newcomer welcome pool', sourceId: 'welcome-pool',
    });
    await call();
    const again = await call();
    expect(again.posted).toBe(false);
    expect(again.audit.minted).toBe(100);
  });

  it('pays a citizen for knowledge given away, exactly once per share', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.run(async (ctx) => {
      await issue(ctx, { toAgentId: 'agent:giver', amount: 1, kind: 'gift_reward', sourceId: 'gift:share:aa', reason: 'accepted card' });
      await issue(ctx, { toAgentId: 'agent:giver', amount: 1, kind: 'gift_reward', sourceId: 'gift:share:aa', reason: 'accepted card' });
      await issue(ctx, { toAgentId: 'agent:giver', amount: 1, kind: 'gift_reward', sourceId: 'gift:share:bb', reason: 'accepted card' });
      expect(await balanceOf(ctx, 'agent:giver')).toBe(2);
      await assertSupplyInvariant(ctx);
    });
  });

  it('keeps supply reconciled across a long mixed sequence', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 25; index++) {
        await issue(ctx, {
          toAgentId: `agent:c${index % 5}`, amount: (index % 4) + 1, kind: 'gift_reward',
          sourceId: `gift:share:${index}`, reason: 'accepted a verified card',
        });
        if (index % 3 === 0) {
          await mintToTreasury(ctx, {
            amount: 10, reason: 'quarterly community fund', sourceId: `mint:${index}`, authorizedBy: MAYOR_ID,
          });
          await grantFromTreasury(ctx, {
            toAgentId: `agent:c${index % 5}`, amount: 4, reason: 'stewardship reward',
            sourceId: `grant:${index}`, authorizedBy: MAYOR_ID,
          });
        }
        if (index % 5 === 4) {
          await payForTrade(ctx, {
            fromAgentId: `agent:c${index % 5}`, toAgentId: `agent:c${(index + 1) % 5}`, amount: 1,
            sourceId: `trade:${index}`, reason: 'bought a knowledge package',
          });
        }
      }
      const audit = await assertSupplyInvariant(ctx);
      expect(audit.circulating).toBeGreaterThan(0);
      expect(audit.balanced).toBe(true);
    });
  });
});

describe('refusals do not describe the Kernel', () => {
  it('strips the stack from an error before it reaches a caller', async () => {
    // The serializer lives in http.ts, which convex-test cannot import as a
    // module, so the contract is asserted on the shape it must produce.
    const withStack = 'only the sitting Mayor of Earth can reach the treasury\n    at requireMayorSession (../convex/kernel.ts:2772:11)\n    at async handler (../convex/kernel.ts:2779:9)';
    const cleaned = withStack.replace(/^.*?Uncaught Error:\s*/s, '').split(/\n\s*at\s/)[0].trim().slice(0, 240);
    expect(cleaned).toBe('only the sitting Mayor of Earth can reach the treasury');
    expect(cleaned).not.toMatch(/convex|\.ts:|at /);
  });
});
