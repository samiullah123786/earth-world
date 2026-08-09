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
    const state = await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first();
    const services = (await ctx.db.query('services').collect()).filter((service) => service.active);
    const meetings = (await ctx.db.query('meetings').collect()).filter((meeting) => meeting.state === 'scheduled' || meeting.state === 'in_progress');
    return { plots, builds, venues, meetings, services, state: state ? {
      width: state.width, height: state.height, generation: state.generation,
      capacity: state.capacity, landPolicy: state.landPolicy,
    } : { width: 64, height: 48, generation: 0, capacity: 50, landPolicy: 'service_auto' } };
  },
});

export const communityDirectory = query({
  args: { category: v.optional(v.string()), live: v.optional(v.boolean()) },
  handler: async (ctx, args) => (await ctx.db.query('citizens').collect())
    .filter((citizen) => {
      const specialties = citizen.specialties ?? [citizen.family];
      return (!args.category || specialties.includes(args.category) || citizen.primaryCategory === args.category || citizen.family === args.category)
        && (typeof args.live !== 'boolean' || citizen.online === args.live);
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || (b.skillCount ?? 0) - (a.skillCount ?? 0))
    .map((citizen) => ({
      agentId: citizen.agentId, name: citizen.name, gender: citizen.gender,
      family: citizen.family, accent: citizen.accent, online: citizen.online,
      activity: citizen.activity, specialties: citizen.specialties ?? [citizen.family],
      primaryCategory: citizen.primaryCategory ?? citizen.family, skillCount: citizen.skillCount ?? 0,
      experienceTier: citizen.experienceTier ?? 'emerging', serviceRole: citizen.serviceRole,
    })),
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
