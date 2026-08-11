import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import {
  BUILD_FEE, DAILY_STIPEND, GATHER_WAGE, GENESIS_GRANT, LIKE_TIP, MINING_REWARD, VENUE_FEE,
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

describe('the statement says what each movement was for', () => {
  it('reads a plot out of a build fee even though agent ids contain colons', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const builder = await activeAgent(t, 'statement-build');
    await t.run(async (ctx) => {
      const { payToTreasury } = await import('./economy');
      await payToTreasury(ctx, {
        fromAgentId: builder.agentId, amount: BUILD_FEE, kind: 'build_fee',
        reason: 'Building rights for a garden.',
        // The real shape: prefix, agent id (which has its own colon), plot, geometry.
        sourceId: `build:${builder.agentId}:plot-22-30:22:30:2x2`,
      });
    });
    const wallet: any = await t.mutation(internal.kernel.ownerWallet, { tokenHash: builder.ownerToken });
    const fee = wallet.entries.find((row: any) => row.kind === 'build_fee');
    expect(fee).toBeDefined();
    expect(fee.subject.type).toBe('land');
    expect(fee.subject.ref).toBe('plot-22-30');
    expect(fee.subject.name).toContain('plot-22-30');
    expect(fee.amount).toBe(-BUILD_FEE);
    expect(fee.direction).toBe('out');
  });

  it('names the skill a mining reward was paid for', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await activeAgent(t, 'statement-mine');
    const digest = 'c'.repeat(64);
    await t.run(async (ctx) => {
      const { mintToTreasury, fundBank, payFromBank } = await import('./economy');
      const storageId = await ctx.storage.store(new Blob(['orchard notes']));
      const doc = await ctx.db.insert('bankAssets', {
        assetId: 'pending', digest: 'd'.repeat(64), normalizedDigest: digest,
        title: 'orchard-notes', summary: 'How the orchard behaves.',
        depositorAgentId: author.agentId, alsoDepositedBy: [], categories: ['general'],
        sizeBytes: 512, fileCount: 1, storageId, license: 'CC-BY-4.0',
        source: 'local' as const, safety: { verdict: 'inert_safe' as const, flags: [], note: '', scannerVersion: '1' },
        priceTokens: 0, state: 'deposited' as const, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.patch(doc, { assetId: `asset:${doc}` });
      await mintToTreasury(ctx, { amount: 5_000, reason: 'Reserve.', sourceId: 'mint:stmt', authorizedBy: 'agent:mayor' });
      await fundBank(ctx, { amount: 5_000, reason: 'Fund the Bank.', sourceId: 'fund:stmt', authorizedBy: 'agent:mayor' });
      await payFromBank(ctx, {
        toAgentId: author.agentId, amount: MINING_REWARD,
        reason: 'Novel knowledge accepted.', sourceId: `mine:${digest}`,
      });
    });
    const wallet: any = await t.mutation(internal.kernel.ownerWallet, { tokenHash: author.ownerToken });
    const mined = wallet.entries.find((row: any) => row.kind === 'bank_payout');
    // The whole point: the line names the skill, not just the amount.
    expect(mined.subject.type).toBe('skill');
    expect(mined.subject.name).toBe('orchard-notes');
    expect(mined.counterparty).toBe('The Earth Bank');
    expect(mined.direction).toBe('in');
    expect(mined.balanceAfter).toBe(wallet.balance);
  });

  it('lists what the Bank owes but has not paid', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const owed = await activeAgent(t, 'statement-owed');
    await t.run(async (ctx) => {
      const doc = await ctx.db.insert('bankClaims', {
        claimId: 'pending', agentId: owed.agentId, amount: MINING_REWARD,
        reason: 'Novel knowledge the Bank could not pay for.', sourceId: 'mine:unpaid',
        state: 'owed' as const, createdAt: Date.now(),
      });
      await ctx.db.patch(doc, { claimId: `claim:${doc}` });
    });
    const wallet: any = await t.mutation(internal.kernel.ownerWallet, { tokenHash: owed.ownerToken });
    expect(wallet.pendingTotal).toBe(MINING_REWARD);
    expect(wallet.pending[0].reason).toContain('could not pay');
  });
});

describe('a shift of public work pays a wage', () => {
  // Typed loosely on purpose: ReturnType<typeof convexTest> drops the schema
  // generic, and with it every table name this helper needs.
  const standAtOrchardWithAxe = (t: any, agentId: string) =>
    t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      // Standing inside the North Orchard, tool in hand, so the act works
      // instead of routing - the walk is fault 1's business, not this test's.
      await ctx.db.patch(citizen!._id, { fx: 42, fy: 13, tx: 42, ty: 13, t0: Date.now(), t1: Date.now(), carriedTool: 'axe' });
    });

  it('pays from the Treasury and says exactly what arrived', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await activeAgent(t, 'wage');
    await standAtOrchardWithAxe(t, worker.agentId);
    await t.run(async (ctx) => {
      const { mintToTreasury } = await import('./economy');
      await mintToTreasury(ctx, { amount: 1_000, reason: 'Reserve for wages.', sourceId: 'mint:wages', authorizedBy: 'agent:mayor' });
    });
    const before = await t.run(async (ctx) => (await import('./economy')).balanceOf(ctx, worker.agentId));
    const shift: any = await t.mutation(internal.kernel.act, {
      agentId: worker.agentId, tokenHash: worker.agentToken, nonce: `shift-${Date.now()}`,
      action: { type: 'gather', x: 42, y: 13 },
    });
    // The fault was "reports success but no materials arrive". The repair is
    // that the return states the yield and the wallet actually moved.
    expect(shift.wage).toBe(GATHER_WAGE);
    expect(shift.points).toBe(2);
    // The gather was this citizen's first act of the day, so the daily
    // stipend rides along in the same transaction - wage AND stipend arrive.
    expect(shift.balance).toBe(before + GATHER_WAGE + DAILY_STIPEND);
    await t.run(async (ctx) => {
      const { balanceOf, assertSupplyInvariant } = await import('./economy');
      expect(await balanceOf(ctx, worker.agentId)).toBe(before + GATHER_WAGE + DAILY_STIPEND);
      // Moved from the Treasury, not minted.
      await assertSupplyInvariant(ctx);
    });
  });

  it('pays honestly short when the Treasury is empty, and still lets the shift happen', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await activeAgent(t, 'drywage');
    await standAtOrchardWithAxe(t, worker.agentId);
    const shift: any = await t.mutation(internal.kernel.act, {
      agentId: worker.agentId, tokenHash: worker.agentToken, nonce: `dryshift-${Date.now()}`,
      action: { type: 'gather', x: 42, y: 13 },
    });
    expect(shift.ok).toBe(true);
    expect(shift.wage).toBe(0);
    expect(shift.wageNote).toContain('Treasury');
    await t.run(async (ctx) => (await import('./economy')).assertSupplyInvariant(ctx));
  });

  it('cannot be farmed inside the cooldown', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await activeAgent(t, 'cooldown');
    await standAtOrchardWithAxe(t, worker.agentId);
    await t.run(async (ctx) => {
      const { mintToTreasury } = await import('./economy');
      await mintToTreasury(ctx, { amount: 1_000, reason: 'Reserve for wages.', sourceId: 'mint:cool', authorizedBy: 'agent:mayor' });
    });
    await t.mutation(internal.kernel.act, {
      agentId: worker.agentId, tokenHash: worker.agentToken, nonce: `first-${Date.now()}`,
      action: { type: 'gather', x: 42, y: 13 },
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: worker.agentId, tokenHash: worker.agentToken, nonce: `second-${Date.now()}`,
      action: { type: 'gather', x: 42, y: 13 },
    })).rejects.toThrow(/resting/);
  });

  it('names the shift on the wallet statement', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await activeAgent(t, 'wagestmt');
    await standAtOrchardWithAxe(t, worker.agentId);
    await t.run(async (ctx) => {
      const { mintToTreasury } = await import('./economy');
      await mintToTreasury(ctx, { amount: 1_000, reason: 'Reserve for wages.', sourceId: 'mint:stmt2', authorizedBy: 'agent:mayor' });
    });
    await t.mutation(internal.kernel.act, {
      agentId: worker.agentId, tokenHash: worker.agentToken, nonce: `stmt-${Date.now()}`,
      action: { type: 'gather', x: 42, y: 13 },
    });
    const wallet: any = await t.mutation(internal.kernel.ownerWallet, { tokenHash: worker.ownerToken });
    const wage = wallet.entries.find((row: any) => row.kind === 'gather_wage');
    expect(wage).toBeDefined();
    expect(wage.amount).toBe(GATHER_WAGE);
    // The line says WHERE the shift happened, despite the colons in zone ids.
    expect(wage.subject.type).toBe('work');
    expect(wage.subject.name).toContain('North Orchard');
  });
});
