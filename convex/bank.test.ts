import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

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
  return { agentId, token: `agent-${suffix}` };
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
    expect(first.netWorth).toEqual({ assets: 1, bytes: 512 });
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
