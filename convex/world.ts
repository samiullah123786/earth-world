import { query } from './_generated/server';
import { v } from 'convex/values';

// Public projections only. Keys, owner sessions, claim tokens, pending approvals,
// and private declines never cross this boundary.
export const citizens = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query('citizens').collect()).map(({ ownerName: _ownerName, ...citizen }) => citizen),
});

export const citizenProfile = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    if (!citizen) return null;
    const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first();
    const builds = await ctx.db.query('builds').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).collect();
    const { ownerName: _ownerName, ...publicCitizen } = citizen;
    return { ...publicCitizen, plot, builds };
  },
});

export const worldObjects = query({
  args: {},
  handler: async (ctx) => {
    const plots = await ctx.db.query('plots').collect();
    const builds = await ctx.db.query('builds').collect();
    const venues = await ctx.db.query('venues').collect();
    const meetings = (await ctx.db.query('meetings').collect()).filter((meeting) => meeting.state === 'scheduled' || meeting.state === 'in_progress');
    return { plots, builds, venues, meetings };
  },
});

export const feed = query({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query('events').order('desc').take(12);
    return events.map((event) => ({
      id: event._id, ts: event._creationTime, gloss: event.gloss, kind: event.kind,
      actorId: event.actorId, payload: event.payload,
    }));
  },
});
