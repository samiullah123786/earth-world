import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { currentAspiration } from '../shared/aspirations';

const modules = import.meta.glob('./**/*.ts');

describe('the aspiration ladder', () => {
  it('names the first unmet need, and frees the fulfilled', () => {
    const base = { hasHome: true, civicPoints: 5, bankedSkills: 2, wallet: 500 };
    expect(currentAspiration({ ...base, hasHome: false })?.key).toBe('shelter');
    expect(currentAspiration({ ...base, civicPoints: 0 })?.key).toBe('contribution');
    expect(currentAspiration({ ...base, bankedSkills: 0 })?.key).toBe('legacy');
    expect(currentAspiration({ ...base, wallet: 12 })?.key).toBe('prosperity');
    // Shelter outranks everything: survival first.
    expect(currentAspiration({ hasHome: false, civicPoints: 0, bankedSkills: 0, wallet: 0 })?.key).toBe('shelter');
    // Every rung climbed: freedom, not another chore.
    expect(currentAspiration(base)).toBeNull();
    // Every rung carries the exact command that climbs it.
    for (const partial of [{ hasHome: false }, { civicPoints: 0 }, { bankedSkills: 0 }, { wallet: 0 }]) {
      const rung = currentAspiration({ ...base, ...partial });
      expect(rung?.hint).toMatch(/Earth /);
    }
  });

  it('the slow tick stores each verdict on the citizen row for the fast tick to read', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agentId = 'agent:test-ladder-tick';
    await t.mutation(internal.kernel.register, {
      agentId, publicKey: 'public-ladder', name: 'Ladder', ownerName: 'Owner Ladder',
      gender: 'female', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
      charterVersion: '2026-08-09', claimTokenHash: 'claim-ladder', claimExpiresAt: Date.now() + 60_000,
      evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
      autonomy: 'none',
    });
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-ladder', ownerSessionHash: 'owner-ladder' });
    await t.mutation(internal.kernel.enter, { agentId, nonce: 'ladder-enter', sessionTokenHash: 'agent-ladder' });

    const result: any = await t.mutation(internal.kernel.aspirationTick, {});
    expect(result.ok).toBe(true);
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      // Homeless, so the stored verdict names shelter - and the 5-second
      // drive tick now needs nothing but this field.
      expect(citizen.aspiration?.key).toBe('shelter');
      expect(citizen.aspiration?.gloss).toContain('home');
    });
  });

  it('settles an active-consent citizen from ambient life, and only once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agentId = 'agent:test-settler';
    await t.mutation(internal.kernel.register, {
      agentId, publicKey: 'public-settler', name: 'Settler', ownerName: 'Owner Settler',
      gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
      charterVersion: '2026-08-09', claimTokenHash: 'claim-settler', claimExpiresAt: Date.now() + 60_000,
      evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
      autonomy: 'active',
    });
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-settler', ownerSessionHash: 'owner-settler' });
    await t.mutation(internal.kernel.enter, { agentId, nonce: 'settler-enter', sessionTokenHash: 'agent-settler' });

    const first: any = await t.mutation(internal.kernel.ambientSettle, { agentId });
    expect(first.ok).toBe(true);
    await t.run(async (ctx: any) => {
      const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', agentId)).first();
      expect(plot).toBeTruthy();
      const glosses = (await ctx.db.query('events').collect()).map((row: any) => row.gloss).join('\n');
      expect(glosses).toContain("standing consent");
    });
    // A settled citizen never reaches the rung again.
    const second: any = await t.mutation(internal.kernel.ambientSettle, { agentId });
    expect(second.already).toBe(true);
  });
});
