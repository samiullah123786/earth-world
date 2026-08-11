import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import {
  BUILD_FEE, DAILY_STIPEND, GENESIS_GRANT, LIKE_TIP, MINING_REWARD, VENUE_FEE,
  assertSupplyInvariant, balanceOf, payToTreasury, redenominate, supplyAudit, tip,
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
  return { agentId, agentToken: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

describe('V2 denomination', () => {
  it('gives every new citizen the V2 stipend, once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const someone = await activeAgent(t, 'stipend');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, someone.agentId)).toBe(GENESIS_GRANT);
      expect(GENESIS_GRANT).toBe(500);
      await assertSupplyInvariant(ctx);
    });
  });

  // A founder who arrived under V1 must end up exactly as rich as a V2 arrival,
  // or the migration quietly creates a two-tier citizenry.
  it('multiplies every holding and the Treasury together, exactly once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const founder = await activeAgent(t, 'founder');

    await t.run(async (ctx) => {
      // Rewind this citizen to a V1 holding of five.
      const row = await ctx.db.query('balances').withIndex('agentId', (q) => q.eq('agentId', founder.agentId)).first();
      await ctx.db.patch(row!._id, { amount: 5 });
      const treasury = await ctx.db.query('treasury').withIndex('key', (q) => q.eq('key', 'earth')).first();
      await ctx.db.patch(treasury!._id, { minted: 5, held: 0, burned: 0, granted: 0 });
      await assertSupplyInvariant(ctx);

      const first = await redenominate(ctx);
      expect(first.posted).toBe(true);
      expect(await balanceOf(ctx, founder.agentId)).toBe(500);
      const audit = await assertSupplyInvariant(ctx);
      expect(audit.circulating).toBe(500);

      // Running it again must change nothing at all.
      const second = await redenominate(ctx);
      expect(second.posted).toBe(false);
      expect(await balanceOf(ctx, founder.agentId)).toBe(500);
      await assertSupplyInvariant(ctx);
    });
  });

  it('keeps the ledger honest rather than rewriting old entries', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const founder = await activeAgent(t, 'history');
    await t.run(async (ctx) => {
      const before = await ctx.db.query('ledger').collect();
      const genesis = before.find((row) => row.kind === 'genesis_grant' && row.toAgentId === founder.agentId);
      const amountBefore = genesis!.amount;
      await redenominate(ctx);
      const after = await ctx.db.query('ledger').collect();
      const sameEntry = after.find((row) => row.entryId === genesis!.entryId);
      // The old entry still says what it said. History is not restated.
      expect(sameEntry!.amount).toBe(amountBefore);
      expect(after.some((row) => row.kind === 'redenomination')).toBe(true);
    });
  });
});

describe('the new ways tokens move', () => {
  it('pays a like tip out of the liker pocket, never by minting', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const giver = await activeAgent(t, 'liker');
    const taker = await activeAgent(t, 'liked');

    await t.run(async (ctx) => {
      const supplyBefore = (await supplyAudit(ctx)).minted;
      const paid = await tip(ctx, {
        fromAgentId: giver.agentId, toAgentId: taker.agentId, amount: LIKE_TIP,
        kind: 'like_tip', reason: 'A like that cost something.', sourceId: 'like:a|b',
      });
      expect(paid.posted).toBe(true);
      expect(await balanceOf(ctx, giver.agentId)).toBe(GENESIS_GRANT - LIKE_TIP);
      expect(await balanceOf(ctx, taker.agentId)).toBe(GENESIS_GRANT + LIKE_TIP);
      // Not one new token was created.
      expect((await supplyAudit(ctx)).minted).toBe(supplyBefore);
      await assertSupplyInvariant(ctx);

      // Replaying the same like pays nothing more.
      const again = await tip(ctx, {
        fromAgentId: giver.agentId, toAgentId: taker.agentId, amount: LIKE_TIP,
        kind: 'like_tip', reason: 'A like that cost something.', sourceId: 'like:a|b',
      });
      expect(again.posted).toBe(false);
      expect(await balanceOf(ctx, giver.agentId)).toBe(GENESIS_GRANT - LIKE_TIP);
    });
  });

  it('lets a citizen too poor to tip still like, without breaking the books', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const pauper = await activeAgent(t, 'pauper');
    const other = await activeAgent(t, 'wealthy');
    await t.run(async (ctx) => {
      const row = await ctx.db.query('balances').withIndex('agentId', (q) => q.eq('agentId', pauper.agentId)).first();
      const treasury = await ctx.db.query('treasury').withIndex('key', (q) => q.eq('key', 'earth')).first();
      await ctx.db.patch(row!._id, { amount: 0 });
      await ctx.db.patch(treasury!._id, { minted: treasury!.minted - GENESIS_GRANT });

      const paid = await tip(ctx, {
        fromAgentId: pauper.agentId, toAgentId: other.agentId, amount: LIKE_TIP,
        kind: 'like_tip', reason: 'A like from someone with nothing.', sourceId: 'like:poor|rich',
      });
      expect(paid.posted).toBe(false);
      expect(paid.paid).toBe(0);
      await assertSupplyInvariant(ctx);
    });
  });

  it('moves a venue fee out of circulation and into the Treasury', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const host = await activeAgent(t, 'host');
    await t.run(async (ctx) => {
      const before = await supplyAudit(ctx);
      await payToTreasury(ctx, {
        fromAgentId: host.agentId, amount: VENUE_FEE, kind: 'venue_fee',
        reason: 'Booked the Waterfall Bench.', sourceId: 'venue:test-1',
      });
      const after = await supplyAudit(ctx);
      expect(await balanceOf(ctx, host.agentId)).toBe(GENESIS_GRANT - VENUE_FEE);
      expect(after.held).toBe(before.held + VENUE_FEE);
      expect(after.circulating).toBe(before.circulating - VENUE_FEE);
      // Nothing minted, nothing burned - the tokens only changed pocket.
      expect(after.minted).toBe(before.minted);
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses a fee the citizen cannot afford, before anything moves', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const broke = await activeAgent(t, 'broke');
    await t.run(async (ctx) => {
      const before = await supplyAudit(ctx);
      await expect(payToTreasury(ctx, {
        fromAgentId: broke.agentId, amount: GENESIS_GRANT + 1, kind: 'build_fee',
        reason: 'Building rights they cannot afford.', sourceId: 'build:too-dear',
      })).rejects.toThrow(/holds/);
      expect(await balanceOf(ctx, broke.agentId)).toBe(GENESIS_GRANT);
      expect((await supplyAudit(ctx)).held).toBe(before.held);
      await assertSupplyInvariant(ctx);
    });
  });

  it('charges a build fee once even if the same permit is posted twice', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const builder = await activeAgent(t, 'builder');
    await t.run(async (ctx) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await payToTreasury(ctx, {
          fromAgentId: builder.agentId, amount: BUILD_FEE, kind: 'build_fee',
          reason: 'Building rights on their own plot.', sourceId: 'build:permit-1',
        });
      }
      expect(await balanceOf(ctx, builder.agentId)).toBe(GENESIS_GRANT - BUILD_FEE);
      await assertSupplyInvariant(ctx);
    });
  });
});

describe('the faucets', () => {
  it('mints a mining reward once for a novel deposit and never twice', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await activeAgent(t, 'miner');
    await t.run(async (ctx) => {
      const { issue } = await import('./economy');
      for (let attempt = 0; attempt < 2; attempt++) {
        await issue(ctx, {
          toAgentId: author.agentId, amount: MINING_REWARD, kind: 'mining_reward',
          reason: 'A novel SKILL.md accepted into the Bank.', sourceId: 'mine:digest-abc',
        });
      }
      expect(await balanceOf(ctx, author.agentId)).toBe(GENESIS_GRANT + MINING_REWARD);
      await assertSupplyInvariant(ctx);
    });
  });

  it('pays the daily stipend at most once per calendar day', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await activeAgent(t, 'worker');
    await t.run(async (ctx) => {
      const { issue, dayStampOf } = await import('./economy');
      const monday = dayStampOf(Date.parse('2026-08-10T09:00:00Z'));
      const tuesday = dayStampOf(Date.parse('2026-08-11T09:00:00Z'));
      expect(monday).not.toBe(tuesday);
      for (const day of [monday, monday, tuesday]) {
        await issue(ctx, {
          toAgentId: worker.agentId, amount: DAILY_STIPEND, kind: 'daily_stipend',
          reason: `Active on ${day}.`, sourceId: `stipend:${worker.agentId}:${day}`,
        });
      }
      // Two days of work, two stipends - not three.
      expect(await balanceOf(ctx, worker.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND * 2);
      await assertSupplyInvariant(ctx);
    });
  });
});
