import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { adoptionRank } from './market';

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

async function bankedAsset(t: ReturnType<typeof convexTest>, depositor: string, title: string, extras: Record<string, unknown> = {}) {
  return await t.run(async (ctx: any) => {
    const storageId = await ctx.storage.store(new Blob([`master bytes of ${title}`]));
    const doc = await ctx.db.insert('bankAssets', {
      assetId: 'pending', digest: 'd'.repeat(64), normalizedDigest: `${title}-norm`.padEnd(64, '0').slice(0, 64),
      title, summary: `Everything ${title} knows, written down at length so the one-liner must truncate somewhere sensible.`,
      depositorAgentId: depositor, alsoDepositedBy: [], categories: ['general'],
      sizeBytes: 512, fileCount: 2, storageId, license: 'CC-BY-4.0',
      source: 'local' as const,
      safety: { verdict: 'inert_safe' as const, flags: [], note: '', scannerVersion: '1' },
      priceTokens: 40, state: 'deposited' as const, createdAt: Date.now(), updatedAt: Date.now(),
      ...extras,
    });
    const assetId = `asset:${doc}`;
    await ctx.db.patch(doc, { assetId });
    return assetId;
  });
}

describe('the machine market surface', () => {
  // The whole point of this endpoint is what it does NOT say. An agent pays
  // for every byte out of its own context window, so the row shape is pinned
  // exactly - a well-meaning refactor that adds a field fails here first.
  it('serves rows with exactly the lean key set, nothing more', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await activeAgent(t, 'lean');
    await bankedAsset(t, seller.agentId, 'lean-probe');

    const market: any = await t.query(api.market.list, {});
    expect(market.ok).toBe(true);
    expect(market.listings.length).toBeGreaterThan(0);
    for (const row of market.listings) {
      expect(Object.keys(row).sort()).toEqual(
        ['digest', 'forkOf', 'id', 'name', 'oneLiner', 'price', 'pulls', 'rank', 'verified']);
      // A row stays small enough that a page of fifty fits in a few KB.
      expect(JSON.stringify(row).length).toBeLessThanOrEqual(320);
      expect(row.oneLiner.length).toBeLessThanOrEqual(120);
    }
  });

  it('never leaks bytes, storage ids, embeddings, or owner names anywhere', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await activeAgent(t, 'sealed');
    const assetId = await bankedAsset(t, seller.agentId, 'sealed-probe');

    const everything = JSON.stringify(await t.query(api.market.list, {}))
      + JSON.stringify(await t.query(api.market.detail, { id: assetId }));
    for (const forbidden of ['storageId', 'embedding', 'markdownBody', 'ownerName', 'Owner sealed', 'master bytes']) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it('ranks by adoption and paginates with an honest end', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await activeAgent(t, 'ranked');
    await bankedAsset(t, seller.agentId, 'quiet-skill');
    await bankedAsset(t, seller.agentId, 'popular-skill', { pulls: 10, verifiedInstalls: 4 });
    await bankedAsset(t, seller.agentId, 'middling-skill', { pulls: 3 });

    const market: any = await t.query(api.market.list, { limit: 2 });
    const names = market.listings.map((row: any) => row.name);
    expect(names[0]).toBe('popular-skill');            // 10 + 2*4 = 18
    expect(market.listings[0].rank).toBe(adoptionRank({ pulls: 10, verifiedInstalls: 4 }));
    expect(market.nextCursor).toBe(2);

    const rest: any = await t.query(api.market.list, { cursor: 2, limit: 50 });
    expect(rest.nextCursor).toBeNull();                 // the end is stated, not implied
    expect(rest.listings.map((row: any) => row.name)).toContain('quiet-skill');
  });

  it('hides flagged and retired listings from shoppers', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await activeAgent(t, 'held');
    await bankedAsset(t, seller.agentId, 'held-skill', {
      state: 'flagged', safety: { verdict: 'needs_review', flags: ['exfiltration'], note: '', scannerVersion: '1' },
    });
    await bankedAsset(t, seller.agentId, 'gone-skill', { state: 'retired' });

    const market: any = await t.query(api.market.list, { limit: 50 });
    const names = market.listings.map((row: any) => row.name);
    expect(names).not.toContain('held-skill');
    expect(names).not.toContain('gone-skill');
    const detail: any = await t.query(api.market.detail, { id: 'asset:nonexistent' });
    expect(detail.ok).toBe(false);
  });

  it('counts a pull once per trade, and a verified install once, forever', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const buyer = await activeAgent(t, 'puller');
    const seller = await activeAgent(t, 'author');
    const assetId = await bankedAsset(t, seller.agentId, 'counted-skill', { priceTokens: 0 });

    const tradeId = await t.run(async (ctx: any) => {
      const doc = await ctx.db.insert('skillTrades', {
        tradeId: 'pending', kind: 'asset' as const, packageId: assetId,
        requesterId: buyer.agentId, providerId: seller.agentId, priceTokens: 0,
        state: 'delivered' as const, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.patch(doc, { tradeId: `trade:${doc}` });
      return `trade:${doc}`;
    });

    // First fetch counts; the re-download of the same trade does not.
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.kernel.act, {
        agentId: buyer.agentId, tokenHash: buyer.agentToken, nonce: `fetch-${i}-${seq++}`,
        action: { type: 'fetch_package', tradeId },
      });
    }
    let detail: any = await t.query(api.market.detail, { id: assetId });
    expect(detail.pulls).toBe(1);

    await t.mutation(internal.kernel.act, {
      agentId: buyer.agentId, tokenHash: buyer.agentToken, nonce: `confirm-${seq++}`,
      action: { type: 'confirm_install', tradeId, outcome: 'installed' },
    });
    detail = await t.query(api.market.detail, { id: assetId });
    expect(detail.verifiedInstalls).toBe(1);
    expect(detail.rank).toBe(1 + 2 * 1);

    // Confirming again is refused by the trade state gate, so the count holds.
    await expect(t.mutation(internal.kernel.act, {
      agentId: buyer.agentId, tokenHash: buyer.agentToken, nonce: `confirm-again-${seq++}`,
      action: { type: 'confirm_install', tradeId, outcome: 'installed' },
    })).rejects.toThrow(/not awaiting/);
    detail = await t.query(api.market.detail, { id: assetId });
    expect(detail.verifiedInstalls).toBe(1);
  });
});
