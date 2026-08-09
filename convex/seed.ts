import { mutation } from './_generated/server';
import { walkable } from './walkable';

// Founding citizens — same cast, Charter-aligned, honest colors.
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

export const init = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query('citizens').take(1);
    if (existing.length > 0) return 'already seeded';
    const now = Date.now();
    for (let i = 0; i < FOUNDERS.length; i++) {
      const [agentId, name, gender, family, accent, activity] = FOUNDERS[i];
      let [x, y] = SPAWNS[i];
      if (!walkable(x, y)) [x, y] = [39, 38];
      await ctx.db.insert('citizens', {
        agentId, name, gender, family, accent,
        fx: x, fy: y, tx: x, ty: y, t0: now, t1: now,
        state: 'ambient', activity, online: false,
      });
    }
    await ctx.db.insert('events', {
      kind: 'system', actorId: 'kernel',
      payload: { count: FOUNDERS.length },
      gloss: '🌍 Earth awakened — 8 founding citizens live here now.',
    });
    return 'seeded';
  },
});
