import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { personalitySeedForTest } from './kernel';

const modules = import.meta.glob('./**/*.ts');

let nonce = 0;
const act = (t: ReturnType<typeof convexTest>, who: { agentId: string; token: string }, action: Record<string, unknown>) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: `s-${nonce++}`, action });

async function citizen(t: ReturnType<typeof convexTest>, suffix: string, over: Record<string, unknown> = {}) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 6,
    autonomy: 'active', ...over,
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, token: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

/** Give two citizens the history a proposal requires. */
async function courtship(t: ReturnType<typeof convexTest>, a: string, b: string, conversations = 2) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('friendships', {
      friendshipId: `friend:${a}:${b}`, requesterId: a, recipientId: b,
      commonInterests: ['ui'], status: 'accepted', createdAt: now, decidedAt: now,
    });
    for (let index = 0; index < conversations; index++) {
      await ctx.db.insert('conversations', {
        a, b, aName: 'A', bName: 'B', participantIds: [a, b], topic: 'ui',
        lines: [{ speaker: a, es: 'talk', gloss: 'a real exchange' }],
        startedAt: now, endsAt: now, state: 'completed',
      });
    }
  });
}

describe('reputation, and the shape of a family', () => {
  it('gives a like once and never again', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const giver = await citizen(t, 'admirer');
    const receiver = await citizen(t, 'admired');

    const first = await act(t, giver, { type: 'like', agentId: receiver.agentId, reason: 'their care notes are unusually clear' });
    expect(first.receiverLikes).toBe(1);
    const second = await act(t, giver, { type: 'like', agentId: receiver.agentId, reason: 'still true' });
    expect(second.alreadyLiked).toBe(true);

    await t.run(async (ctx) => {
      expect(await ctx.db.query('likes').collect()).toHaveLength(1);
      // Reputation counts people, not clicks: one contribution, not two.
      const credit = (await ctx.db.query('contributions').collect()).filter((row) => row.kind === 'like');
      expect(credit).toHaveLength(1);
      expect(credit[0].dimension).toBe('endorsement');
    });
  });

  it('refuses a like to yourself, and demands a reason', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const alone = await citizen(t, 'vain');
    await expect(act(t, alone, { type: 'like', agentId: alone.agentId, reason: 'I am excellent' }))
      .rejects.toThrow(/another citizen/);
    const other = await citizen(t, 'nearby');
    await expect(act(t, alone, { type: 'like', agentId: other.agentId, reason: 'ok' }))
      .rejects.toThrow(/4-200 character reason/);
  });

  it('seeds each citizen a temperament from its own evidence, deterministically', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const one = await citizen(t, 'quiet', { evidenceDigest: 'f0'.repeat(32), primaryCategory: 'research' });
    const two = await citizen(t, 'loud', { evidenceDigest: '11'.repeat(32), primaryCategory: 'content' });
    const biases = await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      return {
        one: rows.find((row) => row.agentId === one.agentId)?.driveBias,
        two: rows.find((row) => row.agentId === two.agentId)?.driveBias,
      };
    });
    expect(biases.one).toBeDefined();
    expect(biases.two).toBeDefined();
    // Different evidence, different natures: free will has somewhere to diverge from.
    expect(biases.one).not.toEqual(biases.two);
    // Craft tilts temperament. The honest claim is that the tilt RAISES the
    // matching drive - not that it always wins outright, since another drive
    // can still start higher by chance.
    const sameSeed = 'ab'.repeat(32);
    const tilted = await citizen(t, 'writerly', { evidenceDigest: sameSeed, primaryCategory: 'content' });
    const untilted = await citizen(t, 'plain', { evidenceDigest: sameSeed, primaryCategory: 'media' });
    const pair = await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      return {
        tilted: rows.find((row) => row.agentId === tilted.agentId)?.driveBias,
        untilted: rows.find((row) => row.agentId === untilted.agentId)?.driveBias,
      };
    });
    expect(pair.tilted!.social).toBeGreaterThan(pair.untilted!.social);
    // Everything else about them is identical: only the craft moved.
    expect(pair.tilted!.industry).toBe(pair.untilted!.industry);
    // Every drive stays live - a citizen leans, it does not become incapable.
    for (const value of Object.values(biases.one!)) {
      expect(value).toBeGreaterThanOrEqual(4);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it('marries only after courtship, and only when both owners say yes', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const one = await citizen(t, 'ardent');
    const two = await citizen(t, 'beloved');

    // No friendship yet: a proposal out of nowhere is refused.
    await expect(act(t, one, { type: 'propose_marriage', agentId: two.agentId }))
      .rejects.toThrow(/accepted friend/);

    await courtship(t, one.agentId, two.agentId, 1);
    await expect(act(t, one, { type: 'propose_marriage', agentId: two.agentId }))
      .rejects.toThrow(/at least two completed conversations/);

    await courtship(t, one.agentId, two.agentId, 2);
    const proposed = await act(t, one, { type: 'propose_marriage', agentId: two.agentId });
    expect(proposed.state).toBe('proposed');

    const accepted = await act(t, two, { type: 'respond_marriage', marriageId: proposed.marriageId, decision: 'accept' });
    expect(accepted.state).toBe('pending_owners');

    // Agreeing is not marrying: neither citizen is bound until both humans say so.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      expect(rows.find((row) => row.agentId === one.agentId)?.spouseAgentId).toBeUndefined();
    });

    const approvals = await t.run(async (ctx) =>
      (await ctx.db.query('approvals').collect()).filter((row) => row.kind === 'marriage'));
    expect(approvals).toHaveLength(2);

    // One owner alone is not enough.
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: one.ownerToken, approvalId: approvals.find((row) => row.agentId === one.agentId)!._id, decision: 'approve',
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      expect(rows.find((row) => row.agentId === one.agentId)?.spouseAgentId).toBeUndefined();
    });

    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: two.ownerToken, approvalId: approvals.find((row) => row.agentId === two.agentId)!._id, decision: 'approve',
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      expect(rows.find((row) => row.agentId === one.agentId)?.spouseAgentId).toBe(two.agentId);
      expect(rows.find((row) => row.agentId === two.agentId)?.spouseAgentId).toBe(one.agentId);
      const marriage = (await ctx.db.query('marriages').collect())[0];
      expect(marriage.state).toBe('married');
      expect((await ctx.db.query('events').collect()).some((row) => row.kind === 'marriage')).toBe(true);
    });
  });

  it('keeps a decline private and marries nobody', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const one = await citizen(t, 'hopeful');
    const two = await citizen(t, 'unpersuaded');
    await courtship(t, one.agentId, two.agentId, 2);
    const proposed = await act(t, one, { type: 'propose_marriage', agentId: two.agentId });
    await act(t, two, { type: 'respond_marriage', marriageId: proposed.marriageId, decision: 'decline' });
    await t.run(async (ctx) => {
      expect((await ctx.db.query('marriages').collect())[0].state).toBe('declined');
      // Nothing about a refusal reaches the town square.
      expect((await ctx.db.query('events').collect()).some((row) => row.kind === 'marriage')).toBe(false);
    });
  });

  it('is monogamous: a married citizen cannot propose again', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const one = await citizen(t, 'wed');
    const two = await citizen(t, 'spouse');
    const three = await citizen(t, 'third');
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      for (const [who, spouse] of [[one.agentId, two.agentId], [two.agentId, one.agentId]] as const) {
        const row = rows.find((item) => item.agentId === who);
        await ctx.db.patch(row!._id, { spouseAgentId: spouse });
      }
    });
    await courtship(t, one.agentId, three.agentId, 2);
    await expect(act(t, one, { type: 'propose_marriage', agentId: three.agentId }))
      .rejects.toThrow(/between two unmarried citizens/);
  });

  it('composes an offspring that inherits from both parents and banks it once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const one = await citizen(t, 'parent-a', { specialties: ['ui', 'content'], primaryCategory: 'ui' });
    const two = await citizen(t, 'parent-b', { specialties: ['content', 'security'], primaryCategory: 'security' });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('citizens').collect();
      for (const [who, spouse] of [[one.agentId, two.agentId], [two.agentId, one.agentId]] as const) {
        const row = rows.find((item) => item.agentId === who);
        await ctx.db.patch(row!._id, { spouseAgentId: spouse });
      }
      const now = Date.now();
      await ctx.db.insert('marriages', {
        marriageId: 'marriage:test', proposerId: one.agentId, proposedToId: two.agentId,
        state: 'married', proposerOwnerApproved: true, proposedToOwnerApproved: true,
        createdAt: now, updatedAt: now,
      });
    });
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['child skill'])));

    const child = await act(t, one, {
      type: 'compose_offspring', name: 'clear-notice', summary: 'Write a notice people actually read.',
      digest: '7'.repeat(64), normalizedDigest: '6'.repeat(64), sizeBytes: 400, fileCount: 1, storageId,
    });
    // Shared ground leads: 'content' is what both parents can prove.
    expect(child.inherited![0]).toBe('content');
    expect(child.inherited!).toEqual(expect.arrayContaining(['ui', 'security']));
    expect(child.parents).toEqual([one.agentId, two.agentId]);

    await t.run(async (ctx) => {
      const asset = (await ctx.db.query('bankAssets').collect()).find((row) => row.title === 'clear-notice');
      expect(asset?.depositorAgentId).toBe(one.agentId);
      expect(asset?.alsoDepositedBy).toEqual([two.agentId]);
      const rows = await ctx.db.query('citizens').collect();
      // The family is visible: both parents carry the child.
      expect(rows.find((row) => row.agentId === one.agentId)?.offspring).toContain(child.assetId);
      expect(rows.find((row) => row.agentId === two.agentId)?.offspring).toContain(child.assetId);
      const credit = (await ctx.db.query('contributions').collect()).filter((row) => row.kind === 'offspring');
      expect(credit).toHaveLength(2);
    });

    // One pact, one child: composing again returns the same asset.
    const again = await act(t, two, {
      type: 'compose_offspring', name: 'clear-notice', summary: 'Same again.',
      digest: '5'.repeat(64), normalizedDigest: '4'.repeat(64), sizeBytes: 400, fileCount: 1, storageId,
    });
    expect(again.alreadyComposed).toBe(true);
    expect(again.assetId).toBe(child.assetId);
  });

  it('refuses offspring to the unmarried', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const single = await citizen(t, 'single');
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['x'])));
    await expect(act(t, single, {
      type: 'compose_offspring', name: 'orphan', summary: 'no pact',
      digest: '3'.repeat(64), normalizedDigest: '2'.repeat(64), sizeBytes: 100, fileCount: 1, storageId,
    })).rejects.toThrow(/only married citizens/);
  });

  it('survives a seed that is not a digest at all', () => {
    // The backfill can only offer an agent id for citizens registered before
    // seeding existed. parseInt('t:', 16) is NaN, and NaN temperaments reached
    // live citizens before this was hardened.
    const messy = ['agent:sage-0004', '', 'not-hex-at-all', 'zzzz'];
    for (const seed of messy) {
      const bias = personalitySeedForTest(seed, 'general');
      for (const value of Object.values(bias)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(4);
        expect(value).toBeLessThanOrEqual(10);
      }
    }
  });
});
