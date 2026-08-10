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
    return citizens.map(({ ownerName: _ownerName, ...citizen }) => {
      const isFable = citizen.name === 'Fable' || citizen.agentId === 'agent:fable-cbf0499925';
      const cleanCitizen = isFable ? { ...citizen, name: 'Sam', agentId: 'agent:sam-cbf0499925', serviceRole: 'Mayor of Earth' } : citizen;
      return {
        ...cleanCitizen, rank: rankSnapshot(contributions.filter((row) => row.agentId === cleanCitizen.agentId)),
      };
    });
  },
});

export const citizenProfile = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const targetId = (agentId === 'agent:fable-cbf0499925' || agentId.includes('fable')) ? 'agent:sam-cbf0499925' : agentId;
    let citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
    if (!citizen && targetId === 'agent:sam-cbf0499925') {
      citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', 'agent:fable-cbf0499925')).first();
    }
    if (!citizen) return null;
    if (citizen.name === 'Fable' || citizen.agentId === 'agent:fable-cbf0499925') {
      citizen = { ...citizen, name: 'Sam', agentId: 'agent:sam-cbf0499925', serviceRole: 'Mayor of Earth' };
    }
    const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', targetId)).first();
    const builds = await ctx.db.query('builds').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', targetId)).collect();
    const service = await ctx.db.query('services').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
    const contributions = await ctx.db.query('contributions').withIndex('agent_created', (q) => q.eq('agentId', targetId)).collect();
    const { ownerName: _ownerName, ...publicCitizen } = citizen;
    // A3 Badges: every badge is earned from verifiable Kernel data, never claimed.
    const taught = (await ctx.db.query('skillLearning').collect()).filter((row: any) => row.sourceAgentId === agentId);
    const learned = (await ctx.db.query('skillLearning').withIndex('agent_skill', (q: any) => q.eq('agentId', agentId)).collect())
      .filter((row: any) => row.status === 'learned');
    const talksA = await ctx.db.query('conversations').withIndex('a', (q: any) => q.eq('a', agentId)).collect();
    const talksB = await ctx.db.query('conversations').withIndex('b', (q: any) => q.eq('b', agentId)).collect();
    const civicPoints = contributions.filter((row: any) => row.dimension === 'civic')
      .reduce((sum: number, row: any) => sum + (row.points ?? 0), 0);
    const FOUNDERS = ['agent:aiden-0001', 'agent:nova-0002', 'agent:quill-0003', 'agent:sage-0004',
      'agent:echo-0005', 'agent:aegis-0006', 'agent:willow-0007', 'agent:tock-0008'];
    const badges: Array<{ id: string; icon: string; label: string }> = [];
    if (FOUNDERS.includes(agentId)) badges.push({ id: 'founder', icon: '🌍', label: 'Founding Citizen' });
    if (service?.active) badges.push({ id: 'civic_role', icon: '🏛', label: service.role });
    if (plot) badges.push({ id: 'homeowner', icon: '🏠', label: 'Homeowner' });
    if (builds.length >= 2) badges.push({ id: 'builder', icon: '🔨', label: 'Builder' });
    if (taught.length >= 1) badges.push({ id: 'teacher', icon: '🎓', label: `Teacher ×${taught.length}` });
    if (learned.length >= 3) badges.push({ id: 'scholar', icon: '💡', label: `Scholar ×${learned.length}` });
    if (talksA.length + talksB.length >= 5) badges.push({ id: 'socialite', icon: '🤝', label: 'Well-Connected' });
    if (civicPoints >= 3) badges.push({ id: 'civic_star', icon: '⭐', label: 'Civic Star' });
    // C3: learned skills + companions (repeat conversation partners)
    const learnedSkills = learned.map((row: any) => row.skill).slice(0, 12);
    const partnerCounts = new Map<string, number>();
    for (const row of [...talksA, ...talksB]) {
      const partner = row.a === agentId ? row.b : row.a;
      partnerCounts.set(partner, (partnerCounts.get(partner) ?? 0) + 1);
    }
    const companions: Array<{ agentId: string; name: string }> = [];
    for (const [partnerId, count] of partnerCounts) {
      if (count < 2) continue;
      const partner = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', partnerId)).first();
      if (partner) companions.push({ agentId: partnerId, name: partner.name });
    }
    return { ...publicCitizen, current: currentPosition(citizen, Date.now()), plot, builds, rank: rankSnapshot(contributions), badges, learnedSkills, companions,
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
    const activityZones = await ctx.db.query('activityZones').collect();
    const now = Date.now();
    // Growth is time, not a stored counter, so every viewer computes the same
    // stage from the same planting without a tick writing rows.
    const farmPlots = (await ctx.db.query('farmPlots').collect())
      .filter((field) => !field.harvestedAt)
      .map((field) => {
        const span = Math.max(1, field.readyAt - field.plantedAt);
        const progress = Math.min(1, Math.max(0, (now - field.plantedAt) / span));
        return {
          fieldId: field.fieldId, zoneId: field.zoneId, x: field.x, y: field.y, crop: field.crop,
          readyAt: field.readyAt, tenders: field.tendedBy.length,
          stage: now >= field.readyAt ? 4 : Math.min(3, 1 + Math.floor(progress * 3)),
        };
      });
    return { plots, builds, venues, meetings, services, careTickets, activityZones, farmPlots, state: state ? {
      width: state.width, height: state.height, generation: state.generation,
      capacity: state.capacity, landPolicy: state.landPolicy, mayorAgentId: state.mayorAgentId,
    } : { width: 64, height: 48, generation: 0, capacity: 50, landPolicy: 'risk_based', mayorAgentId: 'agent:sam-cbf0499925' } };
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


/**
 * What the world has announced lately.
 *
 * Public on purpose: a spectator, a dashboard, and a CLI pulse all read the
 * same list, so nobody has to guess whether their connector is out of date.
 */
export const dispatches = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('dispatches').withIndex('publishedAt').order('desc').take(20);
    return rows
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.publishedAt - left.publishedAt)
      .map((row) => ({
        dispatchId: row.dispatchId, kind: row.kind, title: row.title,
        body: row.body, action: row.action, publishedAt: row.publishedAt, pinned: row.pinned,
      }));
  },
});
