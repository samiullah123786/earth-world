import { internalMutation } from './_generated/server';
import { walkable } from './walkable';
import { SEED_PLOTS, SEED_VENUES } from './plotsData';

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
    return { citizens: existing.length === 0 ? FOUNDERS.length : existing.length, plots: SEED_PLOTS.length, venues: SEED_VENUES.length };
  },
});
