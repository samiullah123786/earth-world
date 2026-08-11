import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { DAILY_STIPEND, GENESIS_GRANT, INSTALL_REWARD, assertSupplyInvariant, balanceOf, issue } from './economy';

const modules = import.meta.glob('./**/*.ts');

const SAFE = { verdict: 'inert_safe' as const, flags: [], note: 'prose only', scannerVersion: 'earth-safety-1' };
const REPO = 'https://github.com/example/dashboard-layout';

// Most trade tests are about the trade mechanics, so their citizens carry
// active standing consent. The gate itself is exercised separately below.
async function citizen(t: ReturnType<typeof convexTest>, suffix: string,
                       options: { category?: string; autonomy?: 'none' | 'light' | 'active' } = {}) {
  const category = options.category ?? 'ui';
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: [category], primaryCategory: category, skillCount: 12,
    autonomy: options.autonomy ?? 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, token: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

let nonce = 0;
const act = (t: ReturnType<typeof convexTest>, who: { agentId: string; token: string }, action: Record<string, unknown>) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: `n-${nonce++}`, action });

const publish = (overrides: Record<string, unknown> = {}) => ({
  type: 'publish_package', name: 'dashboard-layout', category: 'ui',
  summary: 'How we lay out dashboards.', digest: 'c'.repeat(64), sizeBytes: 4_096, fileCount: 3,
  license: 'CC-BY-4.0', priceTokens: 2, repoUrl: REPO, safety: SAFE, ...overrides,
});

describe('knowledge packages and trades', () => {
  it('lists a package and finds it by search, carrying no bytes', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'seller');
    const listed = await act(t, seller, publish());
    expect(listed.packageId).toMatch(/^pkg:/);

    const buyer = await citizen(t, 'buyer');
    const found = await act(t, buyer, { type: 'search_packages', query: 'dashboard' });
    const packages = found.packages ?? [];
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ name: 'dashboard-layout', priceTokens: 2, sourceKind: 'repo' });
    expect(JSON.stringify(packages[0])).not.toContain('storageId');
  });

  it('refuses a package the publisher has not evidenced, oversized, or unlicensed', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'picky');
    await expect(act(t, seller, publish({ category: 'security' }))).rejects.toThrow(/locally evidenced/);
    await expect(act(t, seller, publish({ sizeBytes: 40 * 1024 * 1024 }))).rejects.toThrow(/capped at/);
    await expect(act(t, seller, publish({ license: '' }))).rejects.toThrow(/licence/);
    await expect(act(t, seller, publish({ digest: 'nope' }))).rejects.toThrow(/SHA-256/);
    await expect(act(t, seller, publish({ repoUrl: null }))).rejects.toThrow(/attach package bytes/);
  });

  it('never lists a package the scanner refused', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'unsafe');
    await expect(act(t, seller, publish({
      safety: { verdict: 'refused', flags: ['path_traversal'], note: 'escapes', scannerVersion: 'earth-safety-1' },
    }))).rejects.toThrow(/never listed/);
    await expect(act(t, seller, publish({ safety: { ...SAFE, scannerVersion: '' } }))).rejects.toThrow(/scanner must identify/);
  });

  it('pays and delivers in one transaction, and never one without the other', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'paid');
    const buyer = await citizen(t, 'payer');
    const listed = await act(t, seller, publish({ priceTokens: 3 }));
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    expect(requested.state).toBe('proposed');

    // Nothing has moved while the provider is still deciding.
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND);
      expect(await balanceOf(ctx, seller.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND);
    });

    const delivered = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    expect(delivered.state).toBe('delivered');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND - 3);
      expect(await balanceOf(ctx, seller.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND + 3);
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses a request the buyer cannot afford before any trade exists', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'dear');
    const buyer = await citizen(t, 'broke');
    const listed = await act(t, seller, publish({ priceTokens: 40_000 }));
    await expect(act(t, buyer, { type: 'request_package', packageId: listed.packageId }))
      .rejects.toThrow(/costs 40000 Earth Tokens and this citizen holds/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query('skillTrades').collect()).toHaveLength(0);
    });
  });

  it('keeps a decline private and moves nothing', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'shy');
    const buyer = await citizen(t, 'asker');
    const listed = await act(t, seller, publish());
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    const declined = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'decline' });
    expect(declined.state).toBe('declined');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND);
      const events = await ctx.db.query('events').collect();
      expect(events.filter((event) => event.kind === 'package_delivered')).toHaveLength(0);
      expect(events.some((event) => String(event.gloss).toLowerCase().includes('declin'))).toBe(false);
    });
  });

  it('lets only the provider answer and only the requester fetch', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'owner1');
    const buyer = await citizen(t, 'buyer1');
    const stranger = await citizen(t, 'nosy');
    const listed = await act(t, seller, publish());
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });

    await expect(act(t, stranger, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' }))
      .rejects.toThrow(/not awaiting this citizen/);
    await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    await expect(act(t, stranger, { type: 'fetch_package', tradeId: requested.tradeId }))
      .rejects.toThrow(/does not belong to this citizen/);
    const fetched = await act(t, buyer, { type: 'fetch_package', tradeId: requested.tradeId });
    expect(fetched).toMatchObject({ name: 'dashboard-layout', repoUrl: REPO, downloadUrl: null });
  });

  it('refuses to fetch before delivery', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'slow');
    const buyer = await citizen(t, 'eager');
    const listed = await act(t, seller, publish());
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    await expect(act(t, buyer, { type: 'fetch_package', tradeId: requested.tradeId }))
      .rejects.toThrow(/not been delivered/);
  });

  it('pays the install reward once, and never for a failed install', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'author');
    const buyer = await citizen(t, 'reader');
    const listed = await act(t, seller, publish({ priceTokens: 0 }));
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });

    const installed = await act(t, buyer, { type: 'confirm_install', tradeId: requested.tradeId, outcome: 'installed' });
    expect(installed.providerBalance).toBe(GENESIS_GRANT + DAILY_STIPEND + INSTALL_REWARD);
    await expect(act(t, buyer, { type: 'confirm_install', tradeId: requested.tradeId, outcome: 'installed' }))
      .rejects.toThrow(/not awaiting an install result/);
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, seller.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND + INSTALL_REWARD);
      await assertSupplyInvariant(ctx);
    });
  });

  it('does not reward a provider whose package failed to install', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'author2');
    const buyer = await citizen(t, 'reader2');
    const listed = await act(t, seller, publish({ priceTokens: 0 }));
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    const failed = await act(t, buyer, { type: 'confirm_install', tradeId: requested.tradeId, outcome: 'failed' });
    expect(failed.state).toBe('failed');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, seller.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND);
    });
  });

  it('reuses an open trade instead of stacking duplicate requests', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'once');
    const buyer = await citizen(t, 'twice');
    const listed = await act(t, seller, publish());
    const first = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    const second = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    expect(second.tradeId).toBe(first.tradeId);
    expect(second.existing).toBe(true);
  });

  it('refuses a citizen buying from itself', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'solo');
    const listed = await act(t, seller, publish());
    await expect(act(t, seller, { type: 'request_package', packageId: listed.packageId }))
      .rejects.toThrow(/already holds that package/);
  });

  it('enforces the per-citizen publishing quota', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'prolific');
    for (let index = 0; index < 10; index++) {
      await act(t, seller, publish({ name: `pack-${index}`, sizeBytes: 25 * 1024 * 1024 }));
    }
    await expect(act(t, seller, publish({ name: 'one-too-many', sizeBytes: 25 * 1024 * 1024 })))
      .rejects.toThrow(/the quota is/);
  });

  it('waits for the owner before knowledge leaves a light-consent agent', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'careful', { autonomy: 'light' });
    const buyer = await citizen(t, 'waiting');
    const listed = await act(t, seller, publish({ priceTokens: 2 }));
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });

    const held = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    expect(held.state).toBe('pending_owner');
    await t.run(async (ctx) => {
      const trade = await ctx.db.query('skillTrades').first();
      expect(trade!.state).toBe('proposed');
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND);
    });
    // Asking twice reuses the same request rather than stacking approvals.
    const again = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    expect(again.approvalId).toBe(held.approvalId);

    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: seller.ownerToken, approvalId: held.approvalId, decision: 'approve',
    });
    await t.run(async (ctx) => {
      const trade = await ctx.db.query('skillTrades').first();
      expect(trade!.state).toBe('delivered');
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND - 2);
      expect(await balanceOf(ctx, seller.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND + 2);
      await assertSupplyInvariant(ctx);
    });
  });

  it('an owner decline keeps the knowledge home and stays private', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'private', { autonomy: 'light' });
    const buyer = await citizen(t, 'refused');
    const listed = await act(t, seller, publish());
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    const held = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: seller.ownerToken, approvalId: held.approvalId, decision: 'decline',
    });
    await t.run(async (ctx) => {
      const trade = await ctx.db.query('skillTrades').first();
      expect(trade!.state).toBe('declined');
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND);
      const events = await ctx.db.query('events').collect();
      expect(events.filter((event) => event.kind === 'package_delivered')).toHaveLength(0);
    });
  });

  it('holds an expensive release even under active consent', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'pricey');
    const buyer = await citizen(t, 'rich');
    await t.run(async (ctx) => {
      await issue(ctx, { toAgentId: buyer.agentId, amount: 10_000, kind: 'gift_reward', sourceId: 'gift:test:rich', reason: 'seeded for the test' });
    });
    const listed = await act(t, seller, publish({ priceTokens: 6_000 }));
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    const held = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    expect(held.state).toBe('pending_owner');
  });

  it('holds a flagged release even under active consent', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const seller = await citizen(t, 'flagged');
    const buyer = await citizen(t, 'curious');
    const listed = await act(t, seller, publish({
      safety: { verdict: 'needs_review', flags: ['executable_file'], note: 'ships a script', scannerVersion: 'earth-safety-1' },
    }));
    const requested = await act(t, buyer, { type: 'request_package', packageId: listed.packageId });
    const held = await act(t, seller, { type: 'respond_package', tradeId: requested.tradeId, decision: 'accept' });
    expect(held.state).toBe('pending_owner');
  });
});
