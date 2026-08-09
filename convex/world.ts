import { query } from './_generated/server';
import { v } from 'convex/values';
import { CIVIC_ROLES, rankSnapshot } from './community';

function currentPosition(citizen: any, now: number) {
  const route = citizen.route as Array<{ x: number; y: number; at: number }> | undefined;
  if (route && route.length > 1) {
    if (now >= route[route.length - 1].at) return { x: route[route.length - 1].x, y: route[route.length - 1].y };
    for (let i = 1; i < route.length; i++) {
      if (now <= route[i].at) {
        const a = route[i - 1], b = route[i];
        const progress = Math.max(0, Math.min(1, (now - a.at) / Math.max(1, b.at - a.at)));
        return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
      }
    }
  }
  return { x: citizen.tx, y: citizen.ty };
}

// Public projections only. Keys, owner sessions, claim tokens, pending approvals,
// and private declines never cross this boundary.
export const citizens = query({
  args: {},
  handler: async (ctx) => {
    const [citizens, contributions] = await Promise.all([
      ctx.db.query('citizens').collect(), ctx.db.query('contributions').collect(),
    ]);
    return citizens.map(({ ownerName: _ownerName, ...citizen }) => ({
      ...citizen, rank: rankSnapshot(contributions.filter((row) => row.agentId === citizen.agentId)),
    }));
  },
});

export const citizenProfile = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    if (!citizen) return null;
    const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first();
    const builds = await ctx.db.query('builds').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).collect();
    const service = await ctx.db.query('services').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    const contributions = await ctx.db.query('contributions').withIndex('agent_created', (q) => q.eq('agentId', agentId)).collect();
    const { ownerName: _ownerName, ...publicCitizen } = citizen;
    return { ...publicCitizen, current: currentPosition(citizen, Date.now()), plot, builds, rank: rankSnapshot(contributions),
      role: service?.active ? { name: service.role, description: service.description, permissions: service.permissions } : null };
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
    const careTickets = (await ctx.db.query('careTickets').collect()).filter((ticket) => ticket.state === 'open' || ticket.state === 'claimed')
      .map(({ summary: _summary, resolution: _resolution, ...ticket }) => ticket);
    return { plots, builds, venues, meetings, services, careTickets, state: state ? {
      width: state.width, height: state.height, generation: state.generation,
      capacity: state.capacity, landPolicy: state.landPolicy, mayorAgentId: state.mayorAgentId,
    } : { width: 64, height: 48, generation: 0, capacity: 50, landPolicy: 'risk_based', mayorAgentId: 'agent:fable-cbf0499925' } };
  },
});

export const communityDirectory = query({
  args: { category: v.optional(v.string()), live: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const [citizens, plots, services, contributions] = await Promise.all([
      ctx.db.query('citizens').collect(), ctx.db.query('plots').collect(), ctx.db.query('services').collect(), ctx.db.query('contributions').collect(),
    ]);
    const homes = new Map(plots.filter((plot) => plot.ownerAgentId).map((plot) => [plot.ownerAgentId, plot]));
    const roles = new Map(services.filter((service) => service.active).map((service) => [service.agentId, service]));
    return citizens.filter((citizen) => {
      const specialties = citizen.specialties ?? [citizen.family];
      return (!args.category || specialties.includes(args.category) || citizen.primaryCategory === args.category || citizen.family === args.category)
        && (typeof args.live !== 'boolean' || citizen.online === args.live);
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || (b.skillCount ?? 0) - (a.skillCount ?? 0))
    .map((citizen) => {
      const position = currentPosition(citizen, now);
      const home = homes.get(citizen.agentId);
      const role = roles.get(citizen.agentId);
      const rank = rankSnapshot(contributions.filter((row) => row.agentId === citizen.agentId));
      return {
      agentId: citizen.agentId, name: citizen.name, gender: citizen.gender,
      family: citizen.family, accent: citizen.accent, online: citizen.online,
      state: citizen.state, activity: citizen.activity, current: position, target: { x: citizen.tx, y: citizen.ty },
      talkingWith: (citizen.talkingUntil ?? 0) > now ? citizen.talkingWith : undefined,
      specialties: citizen.specialties ?? [citizen.family],
      primaryCategory: citizen.primaryCategory ?? citizen.family, skillCount: citizen.skillCount ?? 0,
      experienceTier: citizen.experienceTier ?? 'emerging',
      rank,
      role: role ? { name: role.role, description: role.description, permissions: role.permissions } : null,
      home: home ? { plotId: home.plotId, district: home.district, x: home.x, y: home.y, w: home.w, h: home.h } : null,
    };
    });
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


export const latestConversation = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const pick = (await ctx.db.query('conversations').order('desc').take(50)).find((conversation) =>
      (conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b]).includes(agentId));
    if (!pick) return null;
    return { id: pick._id, a: pick.a, b: pick.b, topic: pick.topic, aName: pick.aName, bName: pick.bName,
      participantIds: pick.participantIds, participantNames: pick.participantNames,
      at: pick.startedAt ?? pick._creationTime, endsAt: pick.endsAt, state: pick.state ?? 'completed', lines: pick.lines };
  },
});

export const recentConversations = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query('conversations').order('desc').take(24)).map((conversation) => ({
    id: conversation._id, a: conversation.a, b: conversation.b,
    aName: conversation.aName, bName: conversation.bName, topic: conversation.topic,
    participantIds: conversation.participantIds, participantNames: conversation.participantNames,
    at: conversation.startedAt ?? conversation._creationTime, endsAt: conversation.endsAt,
    state: conversation.state ?? 'completed', lines: conversation.lines,
  })),
});

export const communityProgress = query({
  args: {},
  handler: async (ctx) => {
    const [citizens, contributions, applications, tickets] = await Promise.all([
      ctx.db.query('citizens').collect(), ctx.db.query('contributions').collect(),
      ctx.db.query('civicApplications').collect(), ctx.db.query('careTickets').collect(),
    ]);
    return {
      leaderboard: citizens.map((citizen) => ({
        agentId: citizen.agentId, name: citizen.name,
        rank: rankSnapshot(contributions.filter((row) => row.agentId === citizen.agentId)),
      })).filter((entry) => entry.rank.score > 0).sort((a, b) => b.rank.score - a.rank.score).slice(0, 20),
      civicRoles: Object.entries(CIVIC_ROLES).map(([id, role]) => ({ id, ...role })),
      activeApplications: applications.filter((application) => application.state === 'pending_owner' || application.state === 'pending_civic').length,
      openCareTickets: tickets.filter((ticket) => ticket.state === 'open' || ticket.state === 'claimed').length,
    };
  },
});
