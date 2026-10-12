import { internal } from '../convex/_generated/api';
import { loadWorldWalkability } from '../convex/worldGrid';

export async function owner(t: any, ownerToken = 'test-owner') {
  await t.mutation(internal.seed.init, {});
  const agentId = 'agent:test-modular';
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: 'test-key', name: 'Modular Builder', ownerName: 'Private Owner',
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: 'test-claim', claimExpiresAt: Date.now() + 60_000,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'test-claim', ownerSessionHash: ownerToken });
  await t.mutation(internal.kernel.enter, { agentId, nonce: 'test-enter', sessionTokenHash: 'test-agent' });
  const site = await t.run(async (ctx: any) => {
    const plot = await ctx.db.query('plots').withIndex('plotId', (q: any) => q.eq('plotId', 'plot-10-10')).first();
    if (!plot) throw new Error('fixture plot missing');
    const plots = await ctx.db.query('plots').collect();
    const walkable = await loadWorldWalkability(ctx, { width: 64, height: 48 });
    for (let y = 2; y < 40; y++) for (let x = 2; x < 56; x++) {
      if (plots.some((other: any) => other._id !== plot._id && other.ownerAgentId && x < other.x + other.w && x + 6 > other.x && y < other.y + other.h && y + 6 > other.y)) continue;
      if (Array.from({ length: 36 }, (_, i) => walkable(x + i % 6, y + Math.floor(i / 6))).every(Boolean)) {
        for (const other of plots) if (other._id !== plot._id && x < other.x + other.w && x + 6 > other.x && y < other.y + other.h && y + 6 > other.y) await ctx.db.delete(other._id);
        await ctx.db.patch(plot._id, { ownerAgentId: agentId, x, y, w: 6, h: 6 });
        return { x, y };
      }
    }
    throw new Error('fixture needs an open 6x6 site');
  });
  return { agentId, ...site };
}
