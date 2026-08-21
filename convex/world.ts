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
    // No aliasing. Whoever holds the seat is the Mayor, and the projection says
    // so - a hardcoded rename here outlived the seat it described and told the
    // whole town a citizen held an office they had already handed over.
    // `offlineSince` is bookkeeping for the sleep grace period and says exactly
    // when a human stopped answering, which is nobody else's business. The
    // renderer only needs to know that somebody is asleep, not since when.
    return citizens.map(({ ownerName: _ownerName, offlineSince: _offlineSince, ...citizen }) => ({
      ...citizen, rank: rankSnapshot(contributions.filter((row) => row.agentId === citizen.agentId)),
    }));
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

    const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', targetId)).first();
    const builds = (await ctx.db.query('builds').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', targetId)).collect())
      .filter((row) => row.state !== 'razed');
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
    // Razed structures leave the map immediately - that is the live grid update
    // a demolition promises - while their rows stay for the history.
    const builds = (await ctx.db.query('builds').collect()).filter((row) => row.state !== 'razed');
    const venues = await ctx.db.query('venues').collect();
    const state = await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first();
    const services = (await ctx.db.query('services').collect()).filter((service) => service.active);
    const meetings = (await ctx.db.query('meetings').collect()).filter((meeting) => meeting.state === 'scheduled' || meeting.state === 'in_progress');
    const careTickets = (await ctx.db.query('careTickets').collect()).filter((ticket) => ticket.state === 'open' || ticket.state === 'claimed')
      .map(({ summary: _summary, resolution: _resolution, ...ticket }) => ticket);
    const activityZones = await ctx.db.query('activityZones').collect();
    const chunks = await ctx.db.query('worldChunks').collect();
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
    return { plots, builds, venues, meetings, services, careTickets, activityZones, farmPlots, chunks, state: state ? {
      width: state.width, height: state.height, generation: state.generation,
      capacity: state.capacity, landPolicy: state.landPolicy, mayorAgentId: state.mayorAgentId,
      mapFormat: state.mapFormat ?? 'tiled-v1', mapVersion: state.mapVersion ?? 1,
      tileSize: state.tileSize ?? 32, mapLayers: state.mapLayers ?? ['GroundLayer', 'CollisionLayer', 'OverheadLayer'],
    } : { width: 64, height: 48, generation: 0, capacity: 50, landPolicy: 'risk_based', mayorAgentId: 'agent:sam-cbf0499925' } };
  },
});

export const recentSpatialEvents = query({
  args: { agentId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 40)));
    return args.agentId
      ? await ctx.db.query('spatialEvents').withIndex('agent_created', (q) => q.eq('agentId', args.agentId!)).order('desc').take(limit)
      : await ctx.db.query('spatialEvents').order('desc').take(limit);
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

/**
 * What the live panel shows: talk that is happening, or happened recently.
 *
 * This used to hand back the last twenty-four conversations whatever their
 * age, whole transcripts included. On a busy day that is a wall of yesterday's
 * words in a panel labelled LIVE, downloaded by every viewer of the world.
 * A conversation drops out of the panel twelve hours after it ends, and only
 * the tail of a long one is sent - the panel is for reading what is being
 * said, and the citizens who were there keep the rest in their own memory.
 */
const CHAT_PANEL_WINDOW_MS = 12 * 3_600_000;
const CHAT_PANEL_LINES = 14;

export const recentConversations = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return (await ctx.db.query('conversations').order('desc').take(40))
      .filter((conversation) => {
        const ended = conversation.endsAt ?? conversation.startedAt ?? conversation._creationTime;
        return conversation.state !== 'completed' || ended > now - CHAT_PANEL_WINDOW_MS;
      })
      .slice(0, 24)
      .map((conversation) => ({
        id: conversation._id, a: conversation.a, b: conversation.b,
        aName: conversation.aName, bName: conversation.bName, topic: conversation.topic,
        participantIds: conversation.participantIds, participantNames: conversation.participantNames,
        at: conversation.startedAt ?? conversation._creationTime, endsAt: conversation.endsAt,
        state: conversation.state ?? 'completed',
        lines: conversation.lines.slice(-CHAT_PANEL_LINES),
        trimmed: Math.max(0, conversation.lines.length - CHAT_PANEL_LINES),
      }));
  },
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


/**
 * The three honest numbers on the world's masthead: who is here right now, how
 * many citizens exist, and how much knowledge the community has published.
 * Kernel-computed so the bar can never drift from the truth it summarizes.
 */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const [citizens, packages, assets, skills] = await Promise.all([
      ctx.db.query('citizens').collect(),
      ctx.db.query('skillPackages').collect(),
      ctx.db.query('bankAssets').collect(),
      ctx.db.query('bankSkills').collect(),
    ]);
    return {
      population: citizens.length,
      live: citizens.filter((citizen) => citizen.online).length,
      // Listed peer packages plus everything in the Bank vault that has not
      // been retired. Flagged assets count: they are banked, just held.
      bankedSkills: packages.filter((pack) => pack.state === 'listed').length
        + assets.filter((asset) => asset.state !== 'retired').length
        + skills.filter((skill) => skill.state !== 'retired').length,
    };
  },
});


/**
 * The Bank's public ledger of knowledge. Manifests only - titles, categories,
 * verdicts, prices. The master bytes stay in the vault; storage ids are the
 * Bank's business.
 */
export const bankAssets = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('bankAssets').order('desc').take(120);
    return rows.filter((row) => row.state !== 'retired').map((row) => ({
      assetId: row.assetId, title: row.title, summary: row.summary,
      categories: row.categories, sizeBytes: row.sizeBytes, fileCount: row.fileCount,
      license: row.license, source: row.source, priceTokens: row.priceTokens,
      state: row.state, verdict: row.safety.verdict, flags: row.safety.flags,
      depositorAgentId: row.depositorAgentId, alsoDepositedBy: row.alsoDepositedBy.length,
      // Two depositors on a fresh composition is a lineage, not a duplicate:
      // the Bank shows offspring as the family record it is.
      lineage: row.alsoDepositedBy.length === 1 ? [row.depositorAgentId, ...row.alsoDepositedBy] : undefined,
      valueRank: row.valueRank, valueNote: row.valueNote?.slice(0, 200), createdAt: row.createdAt,
    }));
  },
});

export const bankStats = query({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query('bankAssets').collect()).filter((row) => row.state !== 'retired');
    const skillRows = (await ctx.db.query('bankSkills').collect()).filter((row) => row.state !== 'retired');
    const categories = await ctx.db.query('bankCategories').collect();
    return {
      assets: rows.length + skillRows.length,
      bytes: rows.reduce((total, row) => total + row.sizeBytes, 0) + skillRows.reduce((total, row) => total + row.sizeBytes, 0),
      depositors: new Set([
        ...rows.flatMap((row) => [row.depositorAgentId, ...row.alsoDepositedBy]),
        ...skillRows.flatMap((row) => [row.depositorAgentId, ...row.alsoDepositedBy])
      ]).size,
      flagged: rows.filter((row) => row.state === 'flagged').length + skillRows.filter((row) => row.state === 'flagged').length,
      categories: categories.map((row) => ({ slug: row.slug, title: row.title, createdBy: row.createdBy })),
    };
  },
});

/**
 * Public manifests for structured V2 SKILL.md entries.
 * Evaluated skills only. No markdown body, no embedding.
 */
export const bankSkillsByCategory = query({
  args: { category: v.optional(v.string()) },
  handler: async (ctx, { category }) => {
    // Branch rather than reassign: withIndex narrows a QueryInitializer to a
    // Query, so a single `let` cannot hold both halves of this choice.
    const base = ctx.db.query('bankSkills');
    const scoped = category
      ? base.withIndex('category_created', (q) => q.eq('category', category))
      : base;
    const rows = await scoped.order('desc').take(100);
    return rows.filter((row) => row.state === 'evaluated').map((row) => ({
      skillId: row.skillId, name: row.name, description: row.description,
      version: row.version, author: row.author, category: row.category,
      depositorAgentId: row.depositorAgentId, alsoDepositedBy: row.alsoDepositedBy.length,
      sizeBytes: row.sizeBytes, license: row.license, priceTokens: row.priceTokens,
      verdict: row.safety.verdict, flags: row.safety.flags, state: row.state,
      valueRank: row.valueRank, valueNote: row.valueNote?.slice(0, 200),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
  },
});

export const citizenSkillPortfolio = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const authored = (await ctx.db.query('bankSkills')
      .withIndex('depositor_created', (q) => q.eq('depositorAgentId', agentId))
      .collect())
      .filter((row) => row.state !== 'retired')
      .map((row) => ({
        skillId: row.skillId, name: row.name, category: row.category,
        version: row.version, state: row.state, valueRank: row.valueRank,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
      }));

    const acquired = await Promise.all(
      (await ctx.db.query('acquiredSkills').withIndex('agentId', (q) => q.eq('agentId', agentId)).collect())
        .map(async (acq) => {
          const skill = await ctx.db.query('bankSkills').withIndex('skillId', (q) => q.eq('skillId', acq.skillId)).first();
          if (!skill) return null;
          return {
            skillId: skill.skillId, name: skill.name, category: skill.category,
            version: skill.version, valueRank: skill.valueRank,
            acquiredAt: acq.acquiredAt,
          };
        })
    );

    return { authored, acquired: acquired.filter(Boolean) };
  },
});

export const bankSkillDetail = query({
  args: { skillId: v.string() },
  handler: async (ctx, { skillId }) => {
    const row = await ctx.db.query('bankSkills').withIndex('skillId', (q) => q.eq('skillId', skillId)).first();
    if (!row || row.state === 'retired') return null;
    return {
      skillId: row.skillId, name: row.name, description: row.description,
      version: row.version, author: row.author, category: row.category, tags: row.tags,
      depositorAgentId: row.depositorAgentId, alsoDepositedBy: row.alsoDepositedBy.length,
      sourceKind: row.sourceKind, sizeBytes: row.sizeBytes, license: row.license, priceTokens: row.priceTokens,
      verdict: row.safety.verdict, flags: row.safety.flags, state: row.state,
      valueRank: row.valueRank, valueNote: row.valueNote, llmCategories: row.llmCategories,
      versionHistory: (row.versionHistory ?? []).map(h => ({ version: h.version, updatedAt: h.updatedAt })),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  },
});
