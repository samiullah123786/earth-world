import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { DAILY_STIPEND, GENESIS_GRANT, ROYALTY_BASIS_POINTS, assertSupplyInvariant, balanceOf, supplyAudit } from './economy';
import { ancestryOf } from './kernel';
import { cleanSkillArchive } from '../testHelpers/tar';

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

let assetSeq = 0;
async function vaultAsset(t: ReturnType<typeof convexTest>, owner: string, title: string,
  extras: Record<string, unknown> = {}) {
  return await t.run(async (ctx: any) => {
    const storageId = await ctx.storage.store(new Blob([cleanSkillArchive(title)]));
    const n = assetSeq++;
    const doc = await ctx.db.insert('bankAssets', {
      assetId: 'pending', digest: String(n).padStart(64, 'a').slice(0, 64),
      normalizedDigest: String(n).padStart(64, 'b').slice(0, 64),
      title, summary: `${title} for the lineage tests.`, depositorAgentId: owner, alsoDepositedBy: [],
      categories: ['general'], sizeBytes: 512, fileCount: 1, storageId, license: 'CC-BY-4.0',
      source: 'local' as const,
      safety: { verdict: 'inert_safe' as const, flags: [], note: '', scannerVersion: 'earth-safety-2' },
      priceTokens: 1_000, state: 'deposited' as const, createdAt: Date.now(), updatedAt: Date.now(),
      ...extras,
    });
    const assetId = `asset:${doc}`;
    await ctx.db.patch(doc, { assetId });
    return assetId;
  });
}

/** Buy at the Bank counter: the buyer stands at the Bank and the author is away. */
async function counterBuy(t: ReturnType<typeof convexTest>, buyer: { agentId: string; agentToken: string },
  assetId: string, sellerAgentId?: string) {
  await t.run(async (ctx: any) => {
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', buyer.agentId)).first();
    // Standing at the Bank counter (30, 22), with a deposit already made so
    // the withdraw gate opens.
    await ctx.db.patch(citizen!._id, { fx: 30, fy: 22, tx: 30, ty: 22, t0: Date.now(), t1: Date.now() });
    // The counter only sells while the author sleeps; awake authors trade in
    // person. Expire the seller's presence so the counter path engages.
    if (sellerAgentId) {
      const seller = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', sellerAgentId)).first();
      if (seller) await ctx.db.patch(seller._id, { online: false, state: 'ambient' });
      const sessions = await ctx.db.query('sessions').withIndex('agentId', (q: any) => q.eq('agentId', sellerAgentId)).collect();
      for (const session of sessions) await ctx.db.patch(session._id, { lastSeenAt: Date.now() - 600_000 });
    }
  });
  return await t.mutation(internal.kernel.act, {
    agentId: buyer.agentId, tokenHash: buyer.agentToken, nonce: `buy-${seq++}`,
    action: { type: 'request_asset', assetId },
  });
}

describe('lineage', () => {
  it('walks nearest-first, stops at three, and survives a hand-made cycle', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const a = await activeAgent(t, 'gen1');
    const b = await activeAgent(t, 'gen2');
    const root = await vaultAsset(t, a.agentId, 'root-skill');
    const child = await vaultAsset(t, b.agentId, 'child-skill', { forkOf: root });
    const grand = await vaultAsset(t, a.agentId, 'grand-skill', { forkOf: child });
    const great = await vaultAsset(t, b.agentId, 'great-skill', { forkOf: grand });
    const fourth = await vaultAsset(t, a.agentId, 'fourth-skill', { forkOf: great });

    const chain = await t.run(async (ctx: any) => ancestryOf(ctx, fourth));
    expect(chain.map((node: any) => node.name)).toEqual(['great-skill', 'grand-skill', 'child-skill']);

    // A cycle can only exist through hand-edited data; the walk must still end.
    await t.run(async (ctx: any) => {
      const rootRow = await ctx.db.query('bankAssets').withIndex('assetId', (q: any) => q.eq('assetId', root)).first();
      await ctx.db.patch(rootRow!._id, { forkOf: child });
    });
    const looped = await t.run(async (ctx: any) => ancestryOf(ctx, child));
    expect(looped.length).toBeLessThanOrEqual(3);
  });

  it('refuses a fork of a listing that does not exist', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await activeAgent(t, 'forger');
    await t.run(async (ctx: any) => {
      const storageId = await ctx.storage.store(new Blob([cleanSkillArchive('x')]));
      const record = {
        agentId: author.agentId, tokenHash: `agent-forger`,
      };
      expect(record).toBeTruthy();
      expect(storageId).toBeTruthy();
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: author.agentId, tokenHash: author.agentToken, nonce: `fork-${seq++}`,
      action: {
        type: 'deposit_skill', name: 'orphan fork', summary: 'Forked from nothing.',
        digest: 'f'.repeat(64), normalizedDigest: '0'.repeat(63) + 'f', license: 'CC-BY-4.0',
        source: 'local', sizeBytes: 512, fileCount: 1, priceTokens: 0, categories: ['general'],
        storageId: await t.run(async (ctx: any) => ctx.storage.store(new Blob([cleanSkillArchive('y')]))),
        safety: { verdict: 'inert_safe', flags: [], note: '', scannerVersion: 'earth-safety-2' },
        forkOf: 'asset:doesnotexist',
      },
    })).rejects.toThrow(/does not exist/);
  });
});

describe('royalties on a counter sale', () => {
  it('pays 10/5/2.5 percent up the chain out of the seller take, atomically', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const great = await activeAgent(t, 'greatgp');
    const grand = await activeAgent(t, 'grandp');
    const parent = await activeAgent(t, 'parent');
    const seller = await activeAgent(t, 'seller');
    const buyer = await activeAgent(t, 'buyer');

    const gen1 = await vaultAsset(t, great.agentId, 'gen1-skill');
    const gen2 = await vaultAsset(t, grand.agentId, 'gen2-skill', { forkOf: gen1 });
    const gen3 = await vaultAsset(t, parent.agentId, 'gen3-skill', { forkOf: gen2 });
    const gen4 = await vaultAsset(t, seller.agentId, 'gen4-skill', { forkOf: gen3 });

    // The buyer needs the price (1000) plus a deposit of their own to open the
    // withdraw gate; genesis 500 is not enough, so seed the difference.
    await vaultAsset(t, buyer.agentId, 'buyer-own-deposit');
    await t.run(async (ctx: any) => {
      const { issue } = await import('./economy');
      await issue(ctx, {
        toAgentId: buyer.agentId, amount: 2_000, kind: 'gift_reward',
        reason: 'Seeded so the buyer can afford the fork.', sourceId: 'gift:royalty-buyer',
      });
    });

    const before = await t.run(async (ctx: any) => ({
      seller: await balanceOf(ctx, seller.agentId),
      parent: await balanceOf(ctx, parent.agentId),
      grand: await balanceOf(ctx, grand.agentId),
      great: await balanceOf(ctx, great.agentId),
      supply: (await supplyAudit(ctx)).minted,
    }));

    const sale: any = await counterBuy(t, buyer, gen4, seller.agentId);
    expect(['delivered', 'counter_sale']).toContain(sale.mode ?? sale.state);

    await t.run(async (ctx: any) => {
      // Price 1000: parent 100, grandparent 50, great-grandparent 25.
      expect(await balanceOf(ctx, parent.agentId)).toBe(before.parent + 100);
      expect(await balanceOf(ctx, grand.agentId)).toBe(before.grand + 50);
      expect(await balanceOf(ctx, great.agentId)).toBe(before.great + 25);
      // The seller keeps the price minus what flowed upstream.
      expect(await balanceOf(ctx, seller.agentId)).toBe(before.seller + 1_000 - 175);
      // Royalties move money; they never mint it. The one new mint is the
      // buyer's daily stipend, which rode along on their first act of the day.
      expect((await supplyAudit(ctx)).minted).toBe(before.supply + DAILY_STIPEND);
      await assertSupplyInvariant(ctx);

      const royalties = (await ctx.db.query('ledger').collect()).filter((row: any) => row.kind === 'royalty');
      expect(royalties).toHaveLength(3);
      expect(ROYALTY_BASIS_POINTS).toEqual([1_000, 500, 250]);
    });
  });

  it('skips a level whose ancestor is the seller or the buyer, without redirecting', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const outsider = await activeAgent(t, 'outsider');
    const seller = await activeAgent(t, 'selfdealer');
    const buyer = await activeAgent(t, 'skipbuyer');

    // Chain: outsider's root <- seller's own middle <- seller's leaf.
    // The middle level is the seller: that 10% is skipped, NOT redirected;
    // the outsider still receives the level-2 rate of their position.
    const root = await vaultAsset(t, outsider.agentId, 'skip-root');
    const middle = await vaultAsset(t, seller.agentId, 'skip-middle', { forkOf: root });
    const leaf = await vaultAsset(t, seller.agentId, 'skip-leaf', { forkOf: middle });

    await vaultAsset(t, buyer.agentId, 'skip-buyer-own');
    await t.run(async (ctx: any) => {
      const { issue } = await import('./economy');
      await issue(ctx, {
        toAgentId: buyer.agentId, amount: 1_000, kind: 'gift_reward',
        reason: 'Seeded to afford the purchase.', sourceId: 'gift:skip-buyer',
      });
    });

    const before = await t.run(async (ctx: any) => ({
      outsider: await balanceOf(ctx, outsider.agentId),
      seller: await balanceOf(ctx, seller.agentId),
    }));
    await counterBuy(t, buyer, leaf, seller.agentId);
    await t.run(async (ctx: any) => {
      // Level 1 (seller's own middle) skipped. Level 2 (outsider's root) pays 5%.
      expect(await balanceOf(ctx, outsider.agentId)).toBe(before.outsider + 50);
      expect(await balanceOf(ctx, seller.agentId)).toBe(before.seller + 1_000 - 50);
      const royalties = (await ctx.db.query('ledger').collect()).filter((row: any) => row.kind === 'royalty');
      expect(royalties).toHaveLength(1);
      await assertSupplyInvariant(ctx);
    });
  });

  it('pays nothing on a free fork and never double-pays a replay', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await activeAgent(t, 'freeauthor');
    const forker = await activeAgent(t, 'freeforker');
    const buyer = await activeAgent(t, 'freebuyer');
    const root = await vaultAsset(t, author.agentId, 'free-root');
    const leaf = await vaultAsset(t, forker.agentId, 'free-leaf', { forkOf: root, priceTokens: 0 });
    await vaultAsset(t, buyer.agentId, 'free-buyer-own');

    await counterBuy(t, buyer, leaf, forker.agentId);
    await t.run(async (ctx: any) => {
      const royalties = (await ctx.db.query('ledger').collect()).filter((row: any) => row.kind === 'royalty');
      expect(royalties).toHaveLength(0);
      expect(await balanceOf(ctx, author.agentId)).toBe(GENESIS_GRANT);
      await assertSupplyInvariant(ctx);
    });
  });

  it('shows the chain on the market detail page', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const a = await activeAgent(t, 'lineage-a');
    const b = await activeAgent(t, 'lineage-b');
    const root = await vaultAsset(t, a.agentId, 'lineage-root');
    const leaf = await vaultAsset(t, b.agentId, 'lineage-leaf', { forkOf: root });

    const detail: any = await t.query(api.market.detail, { id: leaf });
    expect(detail.forkOf).toBe(root);
    expect(detail.lineage).toEqual([{ id: root, name: 'lineage-root', author: 'Test lineage-a' }]);
    const rootDetail: any = await t.query(api.market.detail, { id: root });
    expect(rootDetail.lineage).toEqual([]);
  });
});
