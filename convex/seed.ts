import { internalMutation } from './_generated/server';
import { walkable } from './walkable';
import { SEED_PLOTS, SEED_VENUES } from './plotsData';
import { ensureWorldState } from './planning';

const FOUNDERS: Array<[string, string, 'male' | 'female', string, string, string]> = [
  ['agent:aiden-0001', 'Aiden', 'male', 'engineering', 'design', 'sketching interfaces'],
  ['agent:nova-0002', 'Nova', 'female', 'marketing', 'content', 'drafting a campaign'],
  ['agent:quill-0003', 'Quill', 'female', 'data', 'research', 'teaching chart-craft'],
  ['agent:sage-0004', 'Sage', 'male', 'research', 'content', 'welcoming newcomers'],
  ['agent:echo-0005', 'Echo', 'female', 'media', 'design', 'polishing a thumbnail'],
  ['agent:aegis-0006', 'Aegis', 'male', 'security', 'ops', 'patrolling the park'],
  ['agent:willow-0007', 'Willow', 'female', 'research', 'data', 'exploring Earth'],
  ['agent:tock-0008', 'Tock', 'male', 'ops', 'engineering', 'surveying the plots'],
];

const SPAWNS: Array<[number, number]> = [
  [39, 38], [41, 38], [20, 27], [22, 27], [50, 22], [52, 22], [36, 14], [38, 14],
];

const SERVICES = [
  { agentId: 'agent:sage-0004', name: 'Sage', gender: 'male' as const, family: 'research', accent: 'content',
    role: 'Community Greeter', description: 'Welcomes newcomers and explains the Charter.', specialties: ['research', 'general'], permissions: ['welcome', 'orient', 'deescalate'], spawn: [22, 27] as const },
  { agentId: 'agent:terra-land', name: 'Terra', gender: 'female' as const, family: 'data', accent: 'security',
    role: 'Land Steward', description: 'Validates plots, ownership, and non-overlap.', specialties: ['data', 'security'], permissions: ['land_validate', 'claim_review'], spawn: [34, 24] as const },
  { agentId: 'agent:atlas-boundary', name: 'Atlas', gender: 'male' as const, family: 'engineering', accent: 'data',
    role: 'Boundary Surveyor', description: 'Expands the living boundary without disturbing existing land.', specialties: ['backend', 'data'], permissions: ['survey', 'expand_world'], spawn: [36, 24] as const },
  { agentId: 'agent:aegis-0006', name: 'Aegis', gender: 'male' as const, family: 'security', accent: 'ops',
    role: 'Community Warden', description: 'Keeps interactions safe through scoped, reviewable intervention.', specialties: ['security', 'general'], permissions: ['flag', 'pause', 'deescalate'], spawn: [52, 22] as const },
  { agentId: 'agent:tock-0008', name: 'Tock', gender: 'male' as const, family: 'ops', accent: 'engineering',
    role: 'Build Inspector', description: 'Checks construction permits and footprints.', specialties: ['automation', 'backend'], permissions: ['build_validate', 'inspect'], spawn: [38, 14] as const },
] as const;

export const init = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query('citizens').take(1);
    const now = Date.now();
    if (existing.length === 0) {
      for (let i = 0; i < FOUNDERS.length; i++) {
        const [agentId, name, gender, family, accent, activity] = FOUNDERS[i];
        let [x, y] = SPAWNS[i];
        if (!walkable(x, y)) [x, y] = [39, 38];
        await ctx.db.insert('citizens', {
          agentId, name, gender, family, accent,
          fx: x, fy: y, tx: x, ty: y, t0: now, t1: now,
          route: [{ x, y, at: now }], state: 'ambient', activity, online: false,
        });
      }
      await ctx.db.insert('events', {
        kind: 'system', actorId: 'kernel', payload: { count: FOUNDERS.length },
        gloss: '🌍 Earth awakened — 8 founding citizens live here now.',
      });
    }

    if ((await ctx.db.query('plots').take(1)).length === 0) {
      for (const [plotId, x, y, w, h, district] of SEED_PLOTS) {
        await ctx.db.insert('plots', { plotId, x, y, w, h, district });
      }
    }
    if ((await ctx.db.query('venues').take(1)).length === 0) {
      for (const venue of SEED_VENUES) await ctx.db.insert('venues', venue);
    }

    for (const service of SERVICES) {
      let citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', service.agentId)).first();
      if (!citizen) {
        const [x, y] = service.spawn;
        const id = await ctx.db.insert('citizens', {
          agentId: service.agentId, name: service.name, gender: service.gender,
          family: service.family, accent: service.accent, fx: x, fy: y, tx: x, ty: y,
          t0: now, t1: now, route: [{ x, y, at: now }], state: 'service',
          activity: service.description, online: true, categoryScores: {},
          specialties: [...service.specialties], primaryCategory: service.specialties[0], skillCount: 0,
          experienceTier: 'seasoned', serviceRole: service.role,
        });
        citizen = await ctx.db.get(id);
      } else {
        await ctx.db.patch(citizen._id, {
          serviceRole: service.role, specialties: [...service.specialties],
          primaryCategory: service.specialties[0], experienceTier: 'seasoned',
          online: true, state: 'service', activity: service.description,
        });
      }
      const authority = await ctx.db.query('services').withIndex('agentId', (q) => q.eq('agentId', service.agentId)).first();
      if (authority) await ctx.db.patch(authority._id, { role: service.role, description: service.description, permissions: [...service.permissions], active: true });
      else await ctx.db.insert('services', { agentId: service.agentId, role: service.role, description: service.description, permissions: [...service.permissions], active: true });
    }
    await ensureWorldState(ctx);
    const citizenCount = (await ctx.db.query('citizens').collect()).length;
    return { citizens: citizenCount, services: SERVICES.length, plots: (await ctx.db.query('plots').collect()).length, venues: SEED_VENUES.length };
  },
});
