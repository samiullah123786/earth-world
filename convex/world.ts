import { query } from './_generated/server';

// OBSERVE — live views the web client subscribes to (realtime via Convex).
export const citizens = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('citizens').collect();
  },
});

export const feed = query({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query('events').order('desc').take(12);
    return events.map((e) => ({ id: e._id, ts: e._creationTime, gloss: e.gloss, kind: e.kind }));
  },
});
