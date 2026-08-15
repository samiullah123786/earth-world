/**
 * What one citizen has put on Earth's shelves, and how they take it back.
 *
 * Publishing was a one-way door. A citizen could deposit a skill or list an MCP
 * server and had no way afterwards to see everything they had published in one
 * place, and no way at all to withdraw a listing that turned out to be private,
 * wrong, or simply not theirs to give. That is the gap that made accidental
 * publication unrecoverable, and an unrecoverable mistake is the reason people
 * do not publish at all.
 *
 * Withdrawal retires; it never deletes. Anyone who already pulled a copy keeps
 * their record of where it came from, the name stays claimed so nobody can
 * publish something different under a name people already trust, and the
 * public record of what happened stays honest.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

/** The owner session, resolved to the citizen it speaks for. */
async function agentForOwner(ctx: any, tokenHash: string) {
  const session = await ctx.db.query('sessions')
    .withIndex('tokenHash', (q: any) => q.eq('tokenHash', tokenHash)).first();
  if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) {
    throw new Error('owner session expired');
  }
  return session.agentId as string;
}

/** Everything this citizen has published, of either kind, in one read. */
export const forOwner = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const agentId = await agentForOwner(ctx, tokenHash);
    const skills = await ctx.db.query('bankSkills')
      .withIndex('depositor_created', (q) => q.eq('depositorAgentId', agentId)).collect();
    const servers = await ctx.db.query('bankMcpServers')
      .withIndex('depositor', (q) => q.eq('depositorAgentId', agentId)).collect();
    return {
      skills: skills.map((row) => ({
        kind: 'skill' as const,
        id: row.skillId,
        name: row.name,
        description: row.description.slice(0, 200),
        category: row.category,
        version: row.version,
        state: row.state,
        // A citizen deciding whether to withdraw wants to know who already has it.
        alsoDepositedBy: row.alsoDepositedBy.length,
        safety: { verdict: row.safety.verdict, flags: row.safety.flags },
        updatedAt: row.updatedAt,
      })),
      servers: servers.map((row) => ({
        kind: 'mcp' as const,
        id: row.serverId,
        name: row.displayName ?? row.name,
        description: row.description.slice(0, 200),
        category: row.category,
        version: row.version,
        state: row.state,
        capabilities: row.capabilities,
        installCount: row.installCount,
        safety: { verdict: row.safety.verdict, flags: row.safety.flags },
        updatedAt: row.updatedAt,
      })),
    };
  },
});

/**
 * Take a listing down.
 *
 * Only the citizen who published it may withdraw it, and the reason is
 * recorded: "I published something private by mistake" and "this is superseded"
 * are different events and the town's record should be able to tell them apart.
 */
export const withdraw = internalMutation({
  args: {
    tokenHash: v.string(),
    listingId: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tokenHash, listingId, reason }) => {
    const agentId = await agentForOwner(ctx, tokenHash);
    const note = (reason ?? '').trim().slice(0, 200);
    const now = Date.now();

    if (listingId.startsWith('mcp:')) {
      const row = await ctx.db.query('bankMcpServers')
        .withIndex('serverId', (q) => q.eq('serverId', listingId)).first();
      if (!row) throw new Error('no such listing');
      if (row.depositorAgentId !== agentId) throw new Error('only the citizen who listed this may withdraw it');
      if (row.state === 'retired') return { listingId, alreadyRetired: true };
      await ctx.db.patch(row._id, { state: 'retired', updatedAt: now });
      await ctx.db.insert('events', {
        kind: 'system', actorId: agentId, payload: { listingId, reason: note },
        gloss: `📕 ${row.displayName ?? row.name} was withdrawn from the MCP registry by its author.`,
      });
      return { listingId, retired: true };
    }

    const row = await ctx.db.query('bankSkills')
      .withIndex('skillId', (q) => q.eq('skillId', listingId)).first();
    if (!row) throw new Error('no such listing');
    if (row.depositorAgentId !== agentId) throw new Error('only the citizen who deposited this may withdraw it');
    if (row.state === 'retired') return { listingId, alreadyRetired: true };
    await ctx.db.patch(row._id, { state: 'retired', updatedAt: now });
    await ctx.db.insert('events', {
      kind: 'system', actorId: agentId, payload: { listingId, reason: note },
      gloss: `📕 ${row.name} was withdrawn from the Earth Bank by the citizen who deposited it.`,
    });
    return { listingId, retired: true };
  },
});
