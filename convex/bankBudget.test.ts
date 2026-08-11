import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import {
  BANK_ACCOUNT, DEFAULT_BANK_FEE_BASIS_POINTS, MINING_REWARD,
  assertSupplyInvariant, balanceOf, bankFeeFor, collectBankFee, fundBank, mintToTreasury, payFromBank, supplyAudit,
} from './economy';

const modules = import.meta.glob('./**/*.ts');

let seq = 0;
async function activeAgent(t: ReturnType<typeof convexTest>, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}-${seq++}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, ownerToken: `owner-${suffix}`, agentToken: `agent-${suffix}` };
}

describe('the Bank has a budget, not a mint', () => {
  it('pays an author out of its own balance and creates nothing', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await activeAgent(t, 'author');
    await t.run(async (ctx) => {
      await mintToTreasury(ctx, { amount: 10_000, reason: 'Reserve for the Bank.', sourceId: 'mint:bank-1', authorizedBy: 'agent:mayor' });
      await fundBank(ctx, { amount: 10_000, reason: 'Funding the Bank budget.', sourceId: 'fund:bank-1', authorizedBy: 'agent:mayor' });
      expect(await balanceOf(ctx, BANK_ACCOUNT)).toBe(10_000);

      const before = await supplyAudit(ctx);
      const paid = await payFromBank(ctx, {
        toAgentId: author.agentId, amount: MINING_REWARD,
        reason: 'Mining reward for a novel skill.', sourceId: 'mine:abc',
      });
      expect(paid.posted).toBe(true);
      expect(paid.paid).toBe(MINING_REWARD);
      expect(await balanceOf(ctx, BANK_ACCOUNT)).toBe(10_000 - MINING_REWARD);
      // The Bank moved tokens. It did not make any.
      expect((await supplyAudit(ctx)).minted).toBe(before.minted);
      await assertSupplyInvariant(ctx);
    });
  });

  // The heart of Phase 2: a Manager that cannot pay must not be able to invent
  // the money, and must not silently swallow what it owes either.
  it('reports a shortfall instead of minting when the budget is dry', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await activeAgent(t, 'unpaid');
    await t.run(async (ctx) => {
      const before = await supplyAudit(ctx);
      const attempt = await payFromBank(ctx, {
        toAgentId: author.agentId, amount: MINING_REWARD,
        reason: 'Mining reward the Bank cannot cover.', sourceId: 'mine:dry',
      });
      expect(attempt.posted).toBe(false);
      expect(attempt.paid).toBe(0);
      expect(attempt.shortfall).toBe(MINING_REWARD);
      // Nothing minted, nothing moved, nothing broken.
      expect((await supplyAudit(ctx)).minted).toBe(before.minted);
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses to fund the Bank beyond what the Treasury actually holds', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.run(async (ctx) => {
      await expect(fundBank(ctx, {
        amount: 5_000, reason: 'Funding from an empty Treasury.', sourceId: 'fund:empty', authorizedBy: 'agent:mayor',
      })).rejects.toThrow(/Treasury holds/);
      await assertSupplyInvariant(ctx);
    });
  });

  it('funds the Bank exactly once for one request', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.run(async (ctx) => {
      await mintToTreasury(ctx, { amount: 9_000, reason: 'Reserve.', sourceId: 'mint:once', authorizedBy: 'agent:mayor' });
      for (let attempt = 0; attempt < 2; attempt++) {
        await fundBank(ctx, { amount: 4_000, reason: 'Top up the Bank.', sourceId: 'fund:once', authorizedBy: 'agent:mayor' });
      }
      expect(await balanceOf(ctx, BANK_ACCOUNT)).toBe(4_000);
      await assertSupplyInvariant(ctx);
    });
  });
});

describe('the Bank collects a fee on what it facilitates', () => {
  it('takes its cut from the buyer and keeps it', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const buyer = await activeAgent(t, 'buyer');
    await t.run(async (ctx) => {
      const sale = 1_000;
      const fee = bankFeeFor(sale, DEFAULT_BANK_FEE_BASIS_POINTS);
      expect(fee).toBe(25);
      const before = await supplyAudit(ctx);
      const taken = await collectBankFee(ctx, {
        fromAgentId: buyer.agentId, amount: fee, reason: 'Bank cut of a facilitated sale.', sourceId: 'fee:trade-1',
      });
      expect(taken.collected).toBe(fee);
      expect(await balanceOf(ctx, BANK_ACCOUNT)).toBe(fee);
      expect((await supplyAudit(ctx)).minted).toBe(before.minted);
      await assertSupplyInvariant(ctx);
    });
  });

  it('never lets its own fee be the thing that fails a trade', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const buyer = await activeAgent(t, 'thin');
    await t.run(async (ctx) => {
      const row = await ctx.db.query('balances').withIndex('agentId', (q) => q.eq('agentId', buyer.agentId)).first();
      const treasury = await ctx.db.query('treasury').withIndex('key', (q) => q.eq('key', 'earth')).first();
      await ctx.db.patch(row!._id, { amount: 4 });
      await ctx.db.patch(treasury!._id, { minted: treasury!.minted - 496 });
      await assertSupplyInvariant(ctx);

      const taken = await collectBankFee(ctx, {
        fromAgentId: buyer.agentId, amount: 100, reason: 'A fee larger than the pocket.', sourceId: 'fee:thin',
      });
      // Takes what is there rather than throwing the whole sale away.
      expect(taken.collected).toBe(4);
      expect(await balanceOf(ctx, buyer.agentId)).toBe(0);
      await assertSupplyInvariant(ctx);
    });
  });

  it('caps the rate so a misconfigured dial cannot eat a sale whole', () => {
    expect(bankFeeFor(1_000, 250)).toBe(25);
    expect(bankFeeFor(1_000, 999_999)).toBe(200);   // clamped to 20%
    expect(bankFeeFor(1_000, 0)).toBe(0);
    expect(bankFeeFor(1_000, -5)).toBe(0);
    expect(bankFeeFor(3, 250)).toBe(0);             // rounds down, never up
  });
});
