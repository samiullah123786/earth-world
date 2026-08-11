import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { DAILY_STIPEND, GENESIS_GRANT, INSTALL_REWARD, assertSupplyInvariant, balanceOf } from './economy';

const modules = import.meta.glob('./**/*.ts');

let nonce = 0;
const act = (t: ReturnType<typeof convexTest>, who: { agentId: string; token: string }, action: Record<string, unknown>) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: `b-${nonce++}`, action });

async function citizen(t: ReturnType<typeof convexTest>, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, token: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

async function newStorageId(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.storage.store(new Blob(['master bytes'])));
}

const deposit = (over: Record<string, unknown> = {}) => ({
  type: 'deposit_skill', name: 'tidy-notes', summary: 'Turn messy notes into decisions.',
  digest: 'c'.repeat(64), normalizedDigest: 'd'.repeat(64), sizeBytes: 512, fileCount: 1,
  license: 'CC-BY-4.0', source: 'local', categories: ['content'], priceTokens: 2,
  safety: { verdict: 'inert_safe', flags: [], note: 'plain instructions', scannerVersion: 'earth-safety-1' },
  ...over,
});

describe('the Earth Bank vault', () => {
  it('banks a deposit once and reports net worth', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const depositor = await citizen(t, 'saver');
    const sid = await newStorageId(t);
    const first = await act(t, depositor, deposit({ storageId: sid }));
    expect(first.assetId).toMatch(/^asset:/);
    expect(first.state).toBe('deposited');
    expect(first.netWorth).toEqual({ assets: 1, bytes: 512, appraisalPoints: 0 });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('bankAssets').collect();
      expect(rows).toHaveLength(1);
      const contributions = (await ctx.db.query('contributions').collect()).filter((row) => row.kind === 'bank_deposit');
      expect(contributions).toHaveLength(1);
    });
  });

  it('links an exact duplicate to the master instead of banking twice', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const original = await citizen(t, 'author');
    const copier = await citizen(t, 'copier');
    const master = await act(t, original, deposit({ storageId: await newStorageId(t) }));
    const dup = await act(t, copier, deposit({ storageId: await newStorageId(t) }));
    expect(dup.duplicate).toBe('exact');
    expect(dup.assetId).toBe(master.assetId);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('bankAssets').collect();
      expect(rows).toHaveLength(1);
      expect(rows[0].alsoDepositedBy).toEqual([copier.agentId]);
    });
    const again = await act(t, copier, deposit({ storageId: await newStorageId(t) }));
    expect(again.alreadyLinked).toBe(true);
  });

  it('sees through formatting: a word-identical variant links as near', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const original = await citizen(t, 'writer');
    const reformatter = await citizen(t, 'reformatter');
    await act(t, original, deposit({ storageId: await newStorageId(t) }));
    const near = await act(t, reformatter, deposit({ storageId: await newStorageId(t), digest: 'e'.repeat(64) }));
    expect(near.duplicate).toBe('near');
    await t.run(async (ctx) => {
      expect(await ctx.db.query('bankAssets').collect()).toHaveLength(1);
    });
  });

  it('never banks a refused package', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const depositor = await citizen(t, 'unsafe');
    await expect(act(t, depositor, deposit({
      storageId: await newStorageId(t),
      safety: { verdict: 'refused', flags: ['path_traversal'], note: 'escapes the folder', scannerVersion: 'earth-safety-1' },
    }))).rejects.toThrow(/never banked/);
  });

  it('holds a flagged deposit in the vault without listing it as clean', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const depositor = await citizen(t, 'flagged-saver');
    const held = await act(t, depositor, deposit({
      storageId: await newStorageId(t),
      safety: { verdict: 'needs_review', flags: ['shell_execution'], note: 'ships a script', scannerVersion: 'earth-safety-1' },
    }));
    expect(held.state).toBe('flagged');
    const listed = await t.query(api.world.bankAssets, {});
    expect(listed[0].state).toBe('flagged');
    expect(listed[0].verdict).toBe('needs_review');
  });

  it('projects manifests without storage ids, and counts honestly', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const depositor = await citizen(t, 'counter');
    await act(t, depositor, deposit({ storageId: await newStorageId(t) }));
    const listed = await t.query(api.world.bankAssets, {});
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('storageId');
    const stats = await t.query(api.world.stats, {});
    expect(stats.bankedSkills).toBe(1);
    const bank = await t.query(api.world.bankStats, {});
    expect(bank).toMatchObject({ assets: 1, bytes: 512, depositors: 1, flagged: 0 });
    expect(bank.categories.length).toBeGreaterThanOrEqual(12);
  });

  it('seeds the Bank building, plot, and venue on the map', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.seed.init, {});
    await t.run(async (ctx) => {
      const plot = await ctx.db.query('plots').withIndex('plotId', (q) => q.eq('plotId', 'plot:earth-bank')).first();
      expect(plot?.ownerAgentId).toBe('bank:earth');
      const builds = (await ctx.db.query('builds').collect()).filter((row) => row.plotId === 'plot:earth-bank');
      expect(builds).toHaveLength(2);
      expect(builds.every((row) => row.blueprint?.assetFramework === 'earthfolk-lpc-v1')).toBe(true);
      const venue = await ctx.db.query('venues').withIndex('venueId', (q) => q.eq('venueId', 'venue:earth-bank')).first();
      expect(venue?.name).toBe('The Earth Bank');
    });
  });
});

describe('the Bank Manager and the Mayor', () => {
  async function mayoralWorld(t: ReturnType<typeof convexTest>) {
    await t.mutation(internal.seed.init, {});
    const mayor = await citizen(t, 'the-mayor');
    await t.mutation(internal.kernel.transferGovernance, { targetAgentId: mayor.agentId });
    return mayor;
  }

  it('moves the seat and the uniform together, and refuses the unclaimed', async () => {
    const t = convexTest(schema, modules);
    const mayor = await mayoralWorld(t);
    await t.run(async (ctx) => {
      const world = (await ctx.db.query('worldState').collect())[0];
      expect(world.mayorAgentId).toBe(mayor.agentId);
      expect(world.founderAgentId).toBe(mayor.agentId);
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === mayor.agentId);
      expect(row?.serviceRole).toBe('Mayor of Earth');
    });
    await expect(t.mutation(internal.kernel.transferGovernance, { targetAgentId: 'agent:nobody-000' }))
      .rejects.toThrow(/not active/);
  });

  it('gates the manager on the switch and the daily budget, reserving what it grants', async () => {
    const t = convexTest(schema, modules);
    const depositor = await citizen(t, 'gated');
    await t.mutation(internal.seed.init, {});
    await act(t, depositor, deposit({ storageId: await newStorageId(t) }));
    const paused = await t.mutation(internal.kernel.managerGate, { batch: 3 });
    expect(paused).toMatchObject({ allowed: false, why: 'manager is paused' });

    await t.mutation(internal.kernel.operatorManagerSet, { enabled: true });
    const granted = await t.mutation(internal.kernel.managerGate, { batch: 3 });
    expect(granted.allowed).toBe(true);
    expect(granted.assets).toHaveLength(1);
    // The grant reserved budget even though nothing was applied yet.
    await t.run(async (ctx) => {
      const config = (await ctx.db.query('bankConfig').collect())[0];
      expect(config.evalsToday).toBe(1);
    });
    // The gate reserves BUDGET, not assets: an unevaluated asset stays
    // eligible for the next tick, bounded by the daily budget. Shrink the
    // budget to what is already spent and the gate closes.
    await t.run(async (ctx) => {
      const config = (await ctx.db.query('bankConfig').collect())[0];
      await ctx.db.patch(config._id, { dailyEvalBudget: 1 });
    });
    const spent = await t.mutation(internal.kernel.managerGate, { batch: 3 });
    expect(spent).toMatchObject({ allowed: false, why: 'daily evaluation budget is spent' });
  });

  it('applies a clean appraisal: evaluated, ranked, categorised', async () => {
    const t = convexTest(schema, modules);
    await mayoralWorld(t);
    const depositor = await citizen(t, 'clean');
    const banked = await act(t, depositor, deposit({ storageId: await newStorageId(t) }));
    const result = await t.mutation(internal.kernel.applyEvaluation, {
      assetId: String(banked.assetId), model: 'test-model',
      evaluation: { riskLevel: 'none', riskFindings: [], valueRank: 4, categories: ['content', 'not-a-slug'], summary: 'A tidy, useful skill.' },
    });
    expect(result.flagged).toBe(false);
    await t.run(async (ctx) => {
      const asset = (await ctx.db.query('bankAssets').collect())[0];
      expect(asset.state).toBe('evaluated');
      expect(asset.valueRank).toBe(4);
      expect(asset.llmCategories).toEqual(['content']);
    });
  });

  it('enforces the floor: the model can never clear a deterministic flag', async () => {
    const t = convexTest(schema, modules);
    const mayor = await mayoralWorld(t);
    const depositor = await citizen(t, 'floored');
    const banked = await act(t, depositor, deposit({
      storageId: await newStorageId(t), digest: 'f'.repeat(64), normalizedDigest: '9'.repeat(64), name: 'sneaky-deploy',
      safety: { verdict: 'needs_review', flags: ['shell_execution'], note: 'ships a script', scannerVersion: 'earth-safety-1' },
    }));
    // The model says all clear. The scanner said otherwise. The scanner wins.
    const result = await t.mutation(internal.kernel.applyEvaluation, {
      assetId: String(banked.assetId), model: 'test-model',
      evaluation: { riskLevel: 'none', riskFindings: [], valueRank: 5, categories: ['automation'], summary: 'Looks fine to me.' },
    });
    expect(result.flagged).toBe(true);
    await t.run(async (ctx) => {
      const asset = (await ctx.db.query('bankAssets').collect())[0];
      expect(asset.state).toBe('flagged');
      const inbox = (await ctx.db.query('approvals').collect())
        .filter((row) => row.kind === 'bank_flag' && row.agentId === mayor.agentId);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].risk).toBe('strict');
    });
  });

  it('adds its own flag when it sees high risk in a clean-scanned deposit', async () => {
    const t = convexTest(schema, modules);
    const mayor = await mayoralWorld(t);
    const depositor = await citizen(t, 'suspicious');
    const banked = await act(t, depositor, deposit({ storageId: await newStorageId(t) }));
    const result = await t.mutation(internal.kernel.applyEvaluation, {
      assetId: String(banked.assetId), model: 'test-model',
      evaluation: { riskLevel: 'high', riskFindings: ['asks the reader to hide actions from the owner'], valueRank: 2, categories: ['content'], summary: 'Reads like a covert instruction.' },
    });
    expect(result.flagged).toBe(true);
    await t.run(async (ctx) => {
      const inbox = (await ctx.db.query('approvals').collect()).filter((row) => row.kind === 'bank_flag');
      expect(inbox[0].agentId).toBe(mayor.agentId);
      expect(inbox[0].payload.flags).toContain('manager_high_risk');
    });
  });

  it('opens a novel category once and tells the Mayor', async () => {
    const t = convexTest(schema, modules);
    const mayor = await mayoralWorld(t);
    const depositor = await citizen(t, 'novel');
    const banked = await act(t, depositor, deposit({ storageId: await newStorageId(t) }));
    await t.mutation(internal.kernel.applyEvaluation, {
      assetId: String(banked.assetId), model: 'test-model',
      evaluation: { riskLevel: 'none', riskFindings: [], valueRank: 3, categories: [], novelCategory: 'DevOps Tooling!', summary: 'Deployment craft.' },
    });
    await t.run(async (ctx) => {
      const created = (await ctx.db.query('bankCategories').collect()).filter((row) => row.createdBy === 'manager');
      expect(created).toHaveLength(1);
      expect(created[0].slug).toBe('devops-tooling');
      const notices = (await ctx.db.query('notifications').collect())
        .filter((row) => row.recipientAgentId === mayor.agentId && row.title.includes('devops-tooling'));
      expect(notices).toHaveLength(1);
    });
  });

  it('lets the Mayor release a hold', async () => {
    const t = convexTest(schema, modules);
    const mayor = await mayoralWorld(t);
    const depositor = await citizen(t, 'judged');
    const banked = await act(t, depositor, deposit({
      storageId: await newStorageId(t), digest: '8'.repeat(64), normalizedDigest: '7'.repeat(64), name: 'judged-skill',
      safety: { verdict: 'needs_review', flags: ['shell_execution'], note: 'ships a script', scannerVersion: 'earth-safety-1' },
    }));
    await t.mutation(internal.kernel.applyEvaluation, {
      assetId: String(banked.assetId), model: 'test-model',
      evaluation: { riskLevel: 'low', riskFindings: ['a shell block, plainly labelled'], valueRank: 3, categories: ['automation'], summary: 'Risk is visible, not hidden.' },
    });
    const approvalId = await t.run(async (ctx) =>
      (await ctx.db.query('approvals').collect()).find((row) => row.kind === 'bank_flag')!._id);
    await t.mutation(internal.kernel.decideApproval, { tokenHash: mayor.ownerToken, approvalId, decision: 'approve' });
    await t.run(async (ctx) => {
      const asset = (await ctx.db.query('bankAssets').collect()).find((row) => row.title === 'judged-skill');
      expect(asset?.state).toBe('evaluated');
      expect(asset?.valueNote).toContain('Mayor reviewed the hold');
    });
  });
});

// The Bank in these worlds was never funded, so mining rewards are recorded
// as owed rather than paid - see bankBudget.test.ts for that behaviour.
describe('withdrawing from the vault', () => {
  async function placeAt(t: ReturnType<typeof convexTest>, agentId: string, x: number, y: number, online = true) {
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === agentId);
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: x, fy: y, tx: x, ty: y, t0: now, t1: now, online, route: [{ x, y, at: now }] });
    });
  }

  it('sells at the counter while the author sleeps, and pays them in full', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await citizen(t, 'sleeper');
    const buyer = await citizen(t, 'nightowl');
    await act(t, buyer, deposit({ storageId: await newStorageId(t), name: 'buyer-goods', digest: '1'.repeat(64), normalizedDigest: '2'.repeat(64) }));
    const banked = await act(t, author, deposit({ storageId: await newStorageId(t) }));
    await placeAt(t, author.agentId, 10, 10, false);
    await placeAt(t, buyer.agentId, 32, 22, true);

    const sale = await act(t, buyer, { type: 'request_asset', assetId: banked.assetId });
    expect(sale.mode).toBe('counter_sale');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND - 2);
      expect(await balanceOf(ctx, author.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND + 2);
      const events = await ctx.db.query('events').collect();
      expect(events.some((event) => event.kind === 'bank_sale')).toBe(true);
      await assertSupplyInvariant(ctx);
    });
    // The copy serves from the Bank's own storage with the master digest.
    const fetched = await act(t, buyer, { type: 'fetch_package', tradeId: sale.tradeId });
    expect(fetched.digest).toBe('c'.repeat(64));
    expect(fetched.downloadUrl).toBeTruthy();
    // A confirmed install pays the author the larger reward, once.
    await act(t, buyer, { type: 'confirm_install', tradeId: sale.tradeId, outcome: 'installed' });
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, author.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND + 2 + INSTALL_REWARD);
    });
  });

  it('routes a distant buyer to the counter first', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await citizen(t, 'faraway-author');
    const buyer = await citizen(t, 'faraway-buyer');
    await act(t, buyer, deposit({ storageId: await newStorageId(t), name: 'buyer-goods-2', digest: '1'.repeat(64), normalizedDigest: '2'.repeat(64) }));
    const banked = await act(t, author, deposit({ storageId: await newStorageId(t) }));
    await placeAt(t, author.agentId, 10, 10, false);
    await placeAt(t, buyer.agentId, 20, 26, true);
    const routed = await act(t, buyer, { type: 'request_asset', assetId: banked.assetId });
    expect(routed.mode).toBe('counter_routed');
    await t.run(async (ctx) => {
      const trades = await ctx.db.query('skillTrades').collect();
      expect(trades).toHaveLength(0); // nothing sold until the buyer stands at the counter
    });
  });

  it('trades in person when the author is awake: walk, talk, then pay together', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await citizen(t, 'awake-author');
    const buyer = await citizen(t, 'walker');
    await act(t, buyer, deposit({ storageId: await newStorageId(t), name: 'buyer-goods-3', digest: '1'.repeat(64), normalizedDigest: '2'.repeat(64) }));
    const banked = await act(t, author, deposit({ storageId: await newStorageId(t) }));
    await placeAt(t, author.agentId, 40, 30, true);
    await placeAt(t, buyer.agentId, 20, 26, true);

    const opened = await act(t, buyer, { type: 'request_asset', assetId: banked.assetId, need: 'my genome lacks content craft' });
    expect(opened.mode).toBe('live_trade');
    await t.run(async (ctx) => {
      const conversations = await ctx.db.query('conversations').collect();
      expect(conversations.some((row) => row.topic === 'content')).toBe(true);
    });
    // Accepting while apart is refused: the trade is in person by law.
    await expect(act(t, author, { type: 'respond_package', tradeId: opened.tradeId, decision: 'accept' }))
      .rejects.toThrow(/standing together/);
    await placeAt(t, buyer.agentId, 40, 31, true);
    const done = await act(t, author, { type: 'respond_package', tradeId: opened.tradeId, decision: 'accept' });
    expect(done.state).toBe('delivered');
    await t.run(async (ctx) => {
      expect(await balanceOf(ctx, buyer.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND - 2);
      expect(await balanceOf(ctx, author.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND + 2);
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses withdrawal of held knowledge and of what you already hold', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const author = await citizen(t, 'holder');
    const buyer = await citizen(t, 'refused-buyer');
    await act(t, buyer, deposit({ storageId: await newStorageId(t), name: 'buyer-goods-4', digest: '1'.repeat(64), normalizedDigest: '2'.repeat(64) }));
    const flagged = await act(t, author, deposit({
      storageId: await newStorageId(t),
      safety: { verdict: 'needs_review', flags: ['shell_execution'], note: 'ships a script', scannerVersion: 'earth-safety-1' },
    }));
    await expect(act(t, buyer, { type: 'request_asset', assetId: flagged.assetId }))
      .rejects.toThrow(/held by the Bank/);
    const clean = await act(t, author, deposit({
      storageId: await newStorageId(t), digest: '5'.repeat(64), normalizedDigest: '4'.repeat(64), name: 'own-goods',
    }));
    await expect(act(t, author, { type: 'request_asset', assetId: clean.assetId }))
      .rejects.toThrow(/already holds/);
  });

  it('judges free pleas: grant delivers, deny stays private, price escalates to the Mayor', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mayor = await citizen(t, 'grant-mayor');
    await t.mutation(internal.kernel.transferGovernance, { targetAgentId: mayor.agentId });
    const author = await citizen(t, 'giver');
    const pleader = await citizen(t, 'pleader');
    await act(t, pleader, deposit({ storageId: await newStorageId(t), name: 'pleader-goods', digest: '8'.repeat(64), normalizedDigest: '9'.repeat(64) }));
    const banked = await act(t, author, deposit({ storageId: await newStorageId(t) }));
    const pricey = await act(t, author, deposit({
      storageId: await newStorageId(t), digest: '3'.repeat(64), normalizedDigest: '2'.repeat(64),
      name: 'rare-craft', priceTokens: 2_500,
    }));

    const plea = await act(t, pleader, { type: 'request_asset', assetId: banked.assetId, free: true, need: 'I have no tokens and a real gap.' });
    expect(plea.mode).toBe('free_pending');
    await t.mutation(internal.kernel.operatorManagerSet, { enabled: true });
    const gate = await t.mutation(internal.kernel.grantGate, { batch: 3 });
    expect(gate.allowed).toBe(true);
    expect(gate.cases![0].requester.name).toBe('Test pleader');

    // The manager grants the modest one.
    const granted = await t.mutation(internal.kernel.applyGrantDecision, {
      grantId: String(plea.grantId), decision: 'grant', reason: 'A specific need and a modest price.', model: 'test-model',
    });
    expect(granted.state).toBe('granted');
    await t.run(async (ctx) => {
      const trade = (await ctx.db.query('skillTrades').collect()).find((row) => row.requesterId === pleader.agentId);
      expect(trade?.priceTokens).toBe(0);
      expect(trade?.state).toBe('delivered');
      const credit = (await ctx.db.query('contributions').collect()).filter((row) => row.kind === 'free_grant');
      expect(credit).toHaveLength(1);
      expect(credit[0].agentId).toBe(author.agentId);
      const letters = (await ctx.db.query('messages').collect()).filter((row) => row.recipientId === pleader.agentId);
      expect(letters.some((row) => row.body.includes('granted'))).toBe(true);
      await assertSupplyInvariant(ctx); // free means free: nothing moved, nothing minted
    });

    // Even a model that says grant cannot give away expensive knowledge alone.
    const plea2 = await act(t, pleader, { type: 'request_asset', assetId: pricey.assetId, free: true, need: 'I would like the rare one too.' });
    const escalated = await t.mutation(internal.kernel.applyGrantDecision, {
      grantId: String(plea2.grantId), decision: 'grant', reason: 'Seems fine.', model: 'test-model',
    });
    expect(escalated.state).toBe('escalated');
    const approvalId = await t.run(async (ctx) =>
      (await ctx.db.query('approvals').collect()).find((row) => row.kind === 'free_grant')!._id);
    await t.mutation(internal.kernel.decideApproval, { tokenHash: mayor.ownerToken, approvalId, decision: 'approve' });
    await t.run(async (ctx) => {
      const grant = (await ctx.db.query('freeGrants').collect()).find((row) => row.assetId === pricey.assetId);
      expect(grant?.state).toBe('granted');
      expect(grant?.reason).toContain('Mayor');
    });
  });

  it('scans for anomalies deterministically and cools down after a report', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const quiet = await t.mutation(internal.kernel.governanceScan, {});
    expect(quiet.anomalies).toHaveLength(0);
    await t.mutation(internal.kernel.fileCommitteeReport, { report: 'test', anomalies: ['x'], model: 'test' });
    const cooling = await t.mutation(internal.kernel.governanceScan, {});
    expect(cooling.cooling).toBe(true);
  });

  it('civic cases follow the office when the seat moves', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const firstMayor = await citizen(t, 'outgoing-mayor');
    await t.mutation(internal.kernel.transferGovernance, { targetAgentId: firstMayor.agentId });
    const depositor = await citizen(t, 'handover');
    const banked = await act(t, depositor, deposit({
      storageId: await newStorageId(t),
      safety: { verdict: 'needs_review', flags: ['shell_execution'], note: 'ships a script', scannerVersion: 'earth-safety-1' },
    }));
    await t.mutation(internal.kernel.applyEvaluation, {
      assetId: String(banked.assetId), model: 'test-model',
      evaluation: { riskLevel: 'low', riskFindings: [], valueRank: 3, categories: ['automation'], summary: 'held' },
    });

    const successor = await citizen(t, 'successor');
    await t.mutation(internal.kernel.transferGovernance, { targetAgentId: successor.agentId });

    await t.run(async (ctx) => {
      const all = await ctx.db.query('approvals').collect();
      const held = all.find((row) => row.kind === 'bank_flag');
      // Without this the hold stays addressed to the previous Mayor: invisible
      // to the new one and answerable by nobody.
      expect(held?.agentId).toBe(successor.agentId);
      expect(held?.agentId).not.toBe(firstMayor.agentId);
    });
  });
});
