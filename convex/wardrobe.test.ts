import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { avatarSpecForVariant } from '../shared/avatar-identity';
import { resolveAvatarKey } from '../src/avatar_identity';

const modules = import.meta.glob('./**/*.ts');

let seq = 0;
async function activeAgent(t: ReturnType<typeof convexTest>, suffix: string, gender: 'male' | 'female' = 'male') {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender, family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}-${seq++}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, ownerToken: `owner-${suffix}`, agentToken: `agent-${suffix}` };
}

describe('the owner wardrobe', () => {
  it('lets an owner pick a look, stamps who chose, and dresses both tables', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'wardrobe-pick');

    const result: any = await t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: mine.ownerToken, variant: 7 });
    expect(result.ok).toBe(true);
    // primaryCategory 'ui' maps to the creative archetype; the owner picked 7.
    expect(result.avatarSpec).toEqual(avatarSpecForVariant('male', 'creative', 7, 'owner-styled'));

    await t.run(async (ctx) => {
      const agent = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', mine.agentId)).first();
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', mine.agentId)).first();
      // The world draws citizens; the session reads agents. Both must agree,
      // or the dashboard preview and the walking figure become two people.
      expect(agent?.avatarSpec?.catalogKey).toBe('citizen_male_creative_07');
      expect(agent?.avatarSpec?.selectionBasis).toBe('owner-styled');
      expect(citizen?.avatarSpec?.catalogKey).toBe('citizen_male_creative_07');
      const gloss = (await ctx.db.query('events').collect()).map((row) => row.gloss).join('\n');
      expect(gloss).toContain('stepped out in a new look');
    });
  });

  it('keeps identity locked: gender and archetype survive every look change', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'wardrobe-lock', 'female');

    const first: any = await t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: mine.ownerToken, variant: 3 });
    const second: any = await t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: mine.ownerToken, variant: 12 });
    for (const spec of [first.avatarSpec, second.avatarSpec]) {
      expect(spec.catalogKey.startsWith('citizen_female_creative_')).toBe(true);
      expect(spec.archetype).toBe('creative');
    }
    expect(second.avatarSpec.variant).toBe(12);
  });

  it('refuses looks outside the wardrobe and callers without an owner session', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mine = await activeAgent(t, 'wardrobe-refuse');

    for (const variant of [16, -1, 2.5]) {
      await expect(t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: mine.ownerToken, variant }))
        .rejects.toThrow(/16 numbered variants/);
    }
    // An AGENT session is not an OWNER session; the wardrobe is the owner's.
    await expect(t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: mine.agentToken, variant: 2 }))
      .rejects.toThrow();
    await expect(t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: 'not-a-session', variant: 2 }))
      .rejects.toThrow();
  });

  it("the Crown Rule: no claim and no wardrobe look can ever produce authority dress", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    // A malicious registrant claims the crowned sheet outright. The Kernel
    // drops the spec at the door rather than trusting it.
    const agentId = 'agent:test-crown-forger';
    await t.mutation(internal.kernel.register, {
      agentId, publicKey: 'public-crown', name: 'Forger', ownerName: 'Owner Forger',
      gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
      charterVersion: '2026-08-09', claimTokenHash: 'claim-crown', claimExpiresAt: Date.now() + 60_000,
      evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
      autonomy: 'active',
      avatarSpec: { ...avatarSpecForVariant('male', 'creative', 2, 'verified-capabilities'), catalogKey: 'mayor_sam' },
    });
    await t.run(async (ctx) => {
      const agent = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
      expect(agent?.avatarSpec).toBeUndefined();
    });
    // Every look the wardrobe can produce stays in the citizen namespace.
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: 'claim-crown', ownerSessionHash: 'owner-crown' });
    for (const variant of [0, 7, 15]) {
      const dressed: any = await t.mutation(internal.kernel.setOwnerAvatar, { tokenHash: 'owner-crown', variant });
      expect(dressed.avatarSpec.catalogKey).toMatch(/^citizen_(male|female)_(engineering|creative|scholar|civic)_\d{2}$/);
    }
    // And even a forged spec that somehow reached a citizen row is refused by
    // the render chain: authority keys resolve by service role, never claim.
    const available = new Set(['mayor_sam', 'citizen_male_creative_02', 'default_male']);
    const forged = {
      agentId, name: 'Forger', gender: 'male', family: 'engineering', primaryCategory: 'ui',
      avatarSpec: { ...avatarSpecForVariant('male', 'creative', 2, 'owner-styled'), catalogKey: 'mayor_sam' },
    };
    expect(resolveAvatarKey(forged, available)).not.toBe('mayor_sam');
  });

  it('an owner-styled look survives the world resolution chain, an alien basis does not', async () => {
    const available = new Set(['citizen_male_creative_07', 'citizen_male_creative_02', 'default_male']);
    const citizen = { agentId: 'agent:test-x', name: 'X', gender: 'male', family: 'engineering', primaryCategory: 'ui' };
    const styled = { ...citizen, avatarSpec: avatarSpecForVariant('male', 'creative', 7, 'owner-styled') };
    expect(resolveAvatarKey(styled, available)).toBe('citizen_male_creative_07');
    // A spec with a basis nobody vouches for falls back to the identity hash.
    const alien = { ...citizen, avatarSpec: { ...avatarSpecForVariant('male', 'creative', 7, 'self-claimed') } };
    expect(resolveAvatarKey(alien, available)).not.toBe('citizen_male_creative_07');
  });
});
