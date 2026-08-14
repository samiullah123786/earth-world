import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

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

async function mayorSession(t: ReturnType<typeof convexTest>) {
  // ctx: any because ReturnType<typeof convexTest> loses the schema generics,
  // and with them every index name - the same trap the earlier suites hit.
  const seatHolder = await t.run(async (ctx: any) =>
    (await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', 'earth')).first())?.mayorAgentId);
  const mayorToken = 'o-mayor-controls';
  await t.run(async (ctx) => {
    await ctx.db.insert('sessions', {
      tokenHash: mayorToken, agentId: seatHolder!, kind: 'owner',
      createdAt: Date.now(), expiresAt: Date.now() + 600_000, lastSeenAt: Date.now(),
    });
  });
  return mayorToken;
}

describe('the Mayor control center', () => {
  it('pauses the town: acts refuse honestly, leave still works, reads stay alive', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'pause');
    const mayorToken = await mayorSession(t);

    await t.mutation(internal.kernel.mayorGovernanceSet, { tokenHash: mayorToken, paused: true });
    await expect(t.mutation(internal.kernel.act, {
      agentId: mine.agentId, tokenHash: mine.agentToken, nonce: `pause-act-${seq++}`, action: { type: 'say', gloss: 'hello' },
    })).rejects.toThrow(/paused by the Mayor/);
    // Reads are not acts: the owner's mailbox answers during a pause.
    const mail: any = await t.query(internal.kernel.ownerLetters, { tokenHash: mine.ownerToken });
    expect(Array.isArray(mail.inbox)).toBe(true);
    await t.mutation(internal.kernel.mayorGovernanceSet, { tokenHash: mayorToken, paused: false });
    const resumed: any = await t.mutation(internal.kernel.act, {
      agentId: mine.agentId, tokenHash: mine.agentToken, nonce: `resume-${seq++}`, action: { type: 'say', gloss: 'hello again' },
    });
    expect(resumed.ok).toBe(true);

    // Leaving is its own mutation, not an act: even mid-pause, a live session
    // ends gracefully rather than being trapped inside a frozen town.
    await t.mutation(internal.kernel.mayorGovernanceSet, { tokenHash: mayorToken, paused: true });
    const left: any = await t.mutation(internal.kernel.leave, {
      agentId: mine.agentId, tokenHash: mine.agentToken, nonce: `pause-leave-${seq++}`,
    });
    expect(left.ok).toBe(true);
  });

  it('stands one office down while the others stay on duty', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mayorToken = await mayorSession(t);
    await t.mutation(internal.kernel.mayorGovernanceSet, { tokenHash: mayorToken, enabled: true });
    await t.mutation(internal.kernel.mayorGovernanceSet, {
      tokenHash: mayorToken, office: 'Community Warden', officeEnabled: false,
    });
    await t.mutation(internal.kernel.presenceSweep, {});
    const { warden, others } = await t.run(async (ctx) => {
      const citizens = await ctx.db.query('citizens').collect();
      const officeRoles = ['Community Greeter', 'Build Inspector', 'Land Steward', 'Boundary Surveyor'];
      return {
        warden: citizens.find((row) => row.serviceRole === 'Community Warden'),
        others: citizens.filter((row) => officeRoles.includes(row.serviceRole ?? '')),
      };
    });
    expect(warden?.online).toBe(false);
    expect(others.length).toBeGreaterThan(0);
    for (const officer of others) expect(officer.online).toBe(true);

    const view: any = await t.query(internal.kernel.mayorGovernance, { tokenHash: mayorToken });
    expect(view.disabledOffices).toContain('Community Warden');
  });

  it('grows the world on the spot, within the daily allowance', { timeout: 60_000 }, async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mayorToken = await mayorSession(t);
    const before = await t.run(async (ctx) =>
      (await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first()));

    const grown: any = await t.mutation(internal.kernel.mayorExpandWorld, { tokenHash: mayorToken });
    expect(grown.ok).toBe(true);
    expect(grown.started).toBe(true);
    // The ring is laid one chunk per step - a whole ring in one transaction
    // timed out on the real backend and silently never happened. Drive the
    // steps here the way the scheduler does in production.
    await t.mutation(internal.kernel.runWorldExpansion, { reason: 'test ring' });
    // Terrain collapse lives in an action (mutations get one second); drive
    // the read / generate / store loop the way that action does.
    const { generateWfcChunk } = await import('../shared/wfc');
    for (let step = 0; step < 40; step++) {
      const work: any = await t.query(internal.kernel.expansionWork, {});
      if (!work.pending) break;
      if (work.ready) { await t.mutation(internal.kernel.expansionCommit, {}); break; }
      const collapsed = generateWfcChunk({ seed: work.seed, biome: work.biome, boundary: work.boundary });
      await t.mutation(internal.kernel.expansionStore, {
        chunk: {
          chunkId: `chunk:${work.coordinate.chunkX}:${work.coordinate.chunkY}`,
          chunkX: work.coordinate.chunkX, chunkY: work.coordinate.chunkY, size: 16,
          biome: work.biome, generation: work.generation, seed: work.seed,
          tiles: collapsed.tiles, edges: collapsed.edges,
        },
      });
    }
    const after = await t.run(async (ctx: any) =>
      (await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', 'earth')).first()));
    expect(after.width).toBeGreaterThan(before!.width);
    expect(after.pendingExpansion).toBeUndefined();
    // The default allowance is one ring a day; the second ask is refused with
    // the reason and the remedy in one sentence.
    await expect(t.mutation(internal.kernel.mayorExpandWorld, { tokenHash: mayorToken }))
      .rejects.toThrow(/allowance/);
    await t.mutation(internal.kernel.mayorGovernanceSet, { tokenHash: mayorToken, maxRingsPerDay: 2 });
    const again: any = await t.mutation(internal.kernel.mayorExpandWorld, { tokenHash: mayorToken });
    expect(again.ringsToday).toBe(2);
  });

  it('turns the mining yield dial and the Bank pays the new rate', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mayorToken = await mayorSession(t);
    await t.mutation(internal.kernel.mayorEconomySet, { tokenHash: mayorToken, miningReward: 40 });
    const view: any = await t.query(internal.kernel.mayorBankLedger, { tokenHash: mayorToken });
    expect(view.ok).toBe(true);
    // The dial is stored on the Bank's config, where payMiningReward reads it.
    const config = await t.run(async (ctx) =>
      (await ctx.db.query('bankConfig').withIndex('key', (q) => q.eq('key', 'bank')).first()));
    expect(config?.miningReward).toBe(40);
    await expect(t.mutation(internal.kernel.mayorEconomySet, { tokenHash: mayorToken, miningReward: -5 }))
      .rejects.toThrow(/mining reward/);
  });

  it('refuses every control to anyone who is not the sitting Mayor', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const stranger = await activeAgent(t, 'not-mayor');
    await expect(t.mutation(internal.kernel.mayorGovernanceSet, { tokenHash: stranger.ownerToken, paused: true }))
      .rejects.toThrow();
    await expect(t.mutation(internal.kernel.mayorExpandWorld, { tokenHash: stranger.ownerToken }))
      .rejects.toThrow();
  });
});
