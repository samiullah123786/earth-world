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

async function seededEvent(t: ReturnType<typeof convexTest>, state: string) {
  return await t.run(async (ctx: any) => {
    const venue = (await ctx.db.query('venues').collect())[0];
    const now = Date.now();
    const doc = await ctx.db.insert('communityEvents', {
      eventId: 'pending', hostAgentId: 'agent:test-host', title: 'Lantern Evening',
      summary: 'A quiet gathering to test the walk.', kind: 'social', venueId: venue.venueId,
      startsAt: now + 60_000, endsAt: now + 3_600_000, capacity: 12, importance: 'routine',
      state, committeeAgentIds: [], createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(doc, { eventId: `event:${doc}` });
    return { eventId: `event:${doc}`, venue };
  });
}

describe('the town: events, leaderboards, and the Chronicler', () => {
  it("walks the citizen to an event on the owner's word and records the errand", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'walker');
    const { eventId } = await seededEvent(t, 'approved');

    const sent: any = await t.mutation(internal.kernel.ownerSendToEvent, {
      tokenHash: mine.ownerToken, eventId,
    });
    expect(sent.ok).toBe(true);
    expect(sent.arrivesAt).toBeGreaterThan(Date.now());
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', mine.agentId)).first();
      expect(citizen.attendingEventId).toBe(eventId);
      expect(citizen.route?.length).toBeGreaterThan(0);
      const glosses = (await ctx.db.query('events').collect()).map((row: any) => row.gloss).join('\n');
      // The errand rides the public record, which is how the agent's own
      // process learns of it on its next wake.
      expect(glosses).toContain("set out for Lantern Evening");
    });
  });

  it('refuses the walk for finished gatherings and for agent sessions', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'refused-walk');
    const { eventId } = await seededEvent(t, 'completed');
    await expect(t.mutation(internal.kernel.ownerSendToEvent, { tokenHash: mine.ownerToken, eventId }))
      .rejects.toThrow(/over/);
    const live = await seededEvent(t, 'live');
    await expect(t.mutation(internal.kernel.ownerSendToEvent, { tokenHash: mine.agentToken, eventId: live.eventId }))
      .rejects.toThrow();
  });

  it('ranks citizens on three honest measures and never ranks an office', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const liked = await activeAgent(t, 'liked');
    const other = await activeAgent(t, 'other');
    await t.run(async (ctx: any) => {
      await ctx.db.insert('likes', {
        pairKey: `${other.agentId}|${liked.agentId}`, giverAgentId: other.agentId,
        receiverAgentId: liked.agentId, reason: 'steady help', createdAt: Date.now(),
      });
    });
    const board: any = await t.query(internal.kernel.leaderboard, {});
    expect(board.ok).toBe(true);
    expect(board.byLikes[0].name).toBe('Test liked');
    expect(board.byLikes[0].value).toBe(1);
    for (const list of [board.byNetWorth, board.byBankedSkills, board.byLikes]) {
      expect(list.length).toBeLessThanOrEqual(8);
      for (const row of list) {
        expect(['Sage', 'Aegis', 'Tock', 'Terra', 'Atlas']).not.toContain(row.name);
      }
    }
  });

  it('posts one bulletin per day, and only one', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const first: any = await t.mutation(internal.kernel.chroniclerPost, {
      today: '2026-08-12', posts: [{ title: 'A good day on Earth', body: 'Two new skills were banked.' }],
    });
    expect(first.ok).toBe(true);
    const second: any = await t.mutation(internal.kernel.chroniclerPost, {
      today: '2026-08-12', posts: [{ title: 'Again?', body: 'This must not post.' }],
    });
    expect(second.already).toBe(true);
    await t.run(async (ctx: any) => {
      const bulletins = (await ctx.db.query('dispatches').collect())
        .filter((row: any) => row.kind === 'bulletin');
      expect(bulletins.length).toBe(1);
      expect(bulletins[0].title).toBe('A good day on Earth');
    });
  });
});
