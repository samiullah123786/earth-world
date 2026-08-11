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

const post = (t: ReturnType<typeof convexTest>, from: string, to: string, body: string, sentAt: number) =>
  t.run(async (ctx) => {
    const doc = await ctx.db.insert('messages', {
      messageId: 'pending', senderId: from, recipientId: to, body, sentAt, kind: 'letter' as const,
    });
    await ctx.db.patch(doc, { messageId: `message:${doc}` });
    return `message:${doc}`;
  });

describe('the owner mailbox', () => {
  it('separates what the agent received from what it sent, newest first', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'mailbox-mine');
    const other = await activeAgent(t, 'mailbox-other');

    const now = Date.now();
    await post(t, other.agentId, mine.agentId, 'Older note from a neighbour.', now - 60_000);
    await post(t, other.agentId, mine.agentId, 'Newer note from a neighbour.', now - 1_000);
    await post(t, mine.agentId, other.agentId, 'What my agent wrote back.', now - 30_000);

    // Arriving in the world posts a welcome, so the piles are never empty.
    // These assertions are about the letters this test wrote.
    const mail: any = await t.query(internal.kernel.ownerLetters, { tokenHash: mine.ownerToken });
    const letters = mail.inbox.filter((row: any) => row.kind === 'letter');
    expect(letters.map((row: any) => row.body)).toEqual([
      'Newer note from a neighbour.', 'Older note from a neighbour.',
    ]);
    expect(mail.sent.map((row: any) => row.body)).toEqual(['What my agent wrote back.']);
    expect(mail.unread).toBeGreaterThanOrEqual(2);
    // Every letter names the other person, not a raw agent id.
    expect(letters[0].counterpartName).toBe('Test mailbox-other');
    expect(mail.sent[0].counterpartName).toBe('Test mailbox-other');
  });

  it('never shows one owner another owner private letters', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'mailbox-a');
    const other = await activeAgent(t, 'mailbox-b');
    const third = await activeAgent(t, 'mailbox-c');
    await post(t, other.agentId, third.agentId, 'A letter that is none of my business.', Date.now());

    const mail: any = await t.query(internal.kernel.ownerLetters, { tokenHash: mine.ownerToken });
    const everyone = [...mail.inbox, ...mail.sent].map((row: any) => row.counterpartId);
    expect(everyone).not.toContain(third.agentId);
    expect([...mail.inbox, ...mail.sent].map((row: any) => row.body))
      .not.toContain('A letter that is none of my business.');
    expect(other.agentId).toBeTruthy();
  });

  it('marks one letter read without touching the rest', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'mailbox-read');
    const other = await activeAgent(t, 'mailbox-writer');
    const first = await post(t, other.agentId, mine.agentId, 'First.', Date.now() - 5_000);
    await post(t, other.agentId, mine.agentId, 'Second.', Date.now());

    const before: any = await t.query(internal.kernel.ownerLetters, { tokenHash: mine.ownerToken });
    await t.mutation(internal.kernel.readOwnerLetters, { tokenHash: mine.ownerToken, messageId: first });
    const after: any = await t.query(internal.kernel.ownerLetters, { tokenHash: mine.ownerToken });
    expect(after.unread).toBe(before.unread - 1);
    expect(after.inbox.find((row: any) => row.messageId === first).readAt).toBeTruthy();
    expect(after.inbox.find((row: any) => row.body === 'Second.').readAt).toBeFalsy();
  });

  it('refuses to mark a letter the agent did not receive', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'mailbox-x');
    const other = await activeAgent(t, 'mailbox-y');
    const third = await activeAgent(t, 'mailbox-z');
    const notMine = await post(t, other.agentId, third.agentId, 'Private.', Date.now());
    await expect(t.mutation(internal.kernel.readOwnerLetters, { tokenHash: mine.ownerToken, messageId: notMine }))
      .rejects.toThrow();
  });

  it('turns away a caller with no owner session', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await expect(t.query(internal.kernel.ownerLetters, { tokenHash: 'not-a-session' })).rejects.toThrow();
  });
});

describe('notification controls', () => {
  const notify = (t: ReturnType<typeof convexTest>, agentId: string, title: string) =>
    t.run(async (ctx) => ctx.db.insert('notifications', {
      recipientAgentId: agentId, kind: 'info' as const, title, body: 'Something happened.', createdAt: Date.now(),
    }));

  it('dismisses one notification and leaves the others alone', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'notify-one');
    const keep = await notify(t, mine.agentId, 'Keep me');
    const drop = await notify(t, mine.agentId, 'Dismiss me');

    await t.mutation(internal.kernel.dismissOwnerNotification, { tokenHash: mine.ownerToken, notificationId: drop });
    const titles = (await t.query(internal.kernel.ownerNotifications, { tokenHash: mine.ownerToken }))
      .map((row: any) => row.title);
    expect(titles).toContain('Keep me');
    expect(titles).not.toContain('Dismiss me');
    // Dismissed is hidden, not destroyed - the record is the point of this world.
    const stillThere = await t.run(async (ctx) => ctx.db.get(drop));
    expect(stillThere).not.toBeNull();
    expect((stillThere as any).dismissedAt).toBeTruthy();
    expect(keep).toBeTruthy();
  });

  it('clears what has been read and keeps what has not', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'notify-clear');
    await notify(t, mine.agentId, 'Already seen');
    await t.mutation(internal.kernel.readOwnerNotifications, { tokenHash: mine.ownerToken });
    await notify(t, mine.agentId, 'Brand new');

    const cleared: any = await t.mutation(internal.kernel.clearOwnerNotifications, { tokenHash: mine.ownerToken });
    expect(cleared.cleared).toBeGreaterThanOrEqual(1);
    const titles = (await t.query(internal.kernel.ownerNotifications, { tokenHash: mine.ownerToken }))
      .map((row: any) => row.title);
    // The unread one survives; clearing a notice nobody has seen is losing it.
    expect(titles).toEqual(['Brand new']);
  });

  it('refuses to dismiss a notification addressed to someone else', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'notify-mine');
    const other = await activeAgent(t, 'notify-other');
    const theirs = await notify(t, other.agentId, 'Not yours');
    await expect(t.mutation(internal.kernel.dismissOwnerNotification, {
      tokenHash: mine.ownerToken, notificationId: theirs,
    })).rejects.toThrow();
  });
});
