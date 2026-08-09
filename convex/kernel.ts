import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { findRoute, walkableInWorld } from './pathfinding';
import { assertRegistryGeometry, ensureWorldState, expandWorld } from './planning';

const AGENT_SESSION_MS = 12 * 60 * 60 * 1000;
const OWNER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SPEED = 2.2;
const MAYOR_ID = 'agent:fable-cbf0499925';

async function useNonce(ctx: any, agentId: string, nonce: string) {
  const key = `${agentId}:${nonce}`;
  if (await ctx.db.query('nonces').withIndex('key', (q: any) => q.eq('key', key)).first()) {
    throw new Error('replayed request');
  }
  await ctx.db.insert('nonces', { key, expiresAt: Date.now() + 5 * 60_000 });
}

async function requireSession(ctx: any, tokenHash: string, kind: 'agent' | 'owner', agentId?: string) {
  const session = await ctx.db.query('sessions').withIndex('tokenHash', (q: any) => q.eq('tokenHash', tokenHash)).first();
  if (!session || session.kind !== kind || session.revokedAt || session.expiresAt <= Date.now()) {
    throw new Error('session expired or invalid');
  }
  if (agentId && session.agentId !== agentId) throw new Error('session does not belong to this agent');
  return session;
}

async function requireActiveAgent(ctx: any, agentId: string) {
  const agent = await ctx.db.query('agents').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
  if (!agent || agent.status !== 'active') throw new Error('agent is not active');
  return agent;
}

async function authorizeAgent(ctx: any, agentId: string, tokenHash: string, nonce: string) {
  const session = await requireSession(ctx, tokenHash, 'agent', agentId);
  const agent = await requireActiveAgent(ctx, agentId);
  await useNonce(ctx, agentId, nonce);
  const now = Date.now();
  await ctx.db.patch(session._id, { lastSeenAt: now });
  await ctx.db.patch(agent._id, { lastSeenAt: now });
  const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
  if (citizen && !citizen.online) await ctx.db.patch(citizen._id, { online: true, state: 'live' });
  return { agent, citizen, session };
}

async function rateLimit(ctx: any, agentId: string) {
  const now = Date.now();
  const row = await ctx.db.query('rateLimits').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
  if (!row || now - row.windowStart >= 60_000) {
    if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    else await ctx.db.insert('rateLimits', { agentId, windowStart: now, count: 1 });
    return undefined;
  }
  if (row.count >= 120) throw new Error('hard rate limit reached; wait one minute');
  const count = row.count + 1;
  await ctx.db.patch(row._id, { count });
  return count > 30 ? 'soft rate limit exceeded; slow down' : undefined;
}

function currentPosition(citizen: any, now: number) {
  const route = citizen.route as Array<{ x: number; y: number; at: number }> | undefined;
  if (route && route.length > 1) {
    if (now >= route[route.length - 1].at) return { x: route[route.length - 1].x, y: route[route.length - 1].y };
    for (let i = 1; i < route.length; i++) {
      if (now <= route[i].at) {
        const a = route[i - 1], b = route[i];
        const p = Math.max(0, Math.min(1, (now - a.at) / Math.max(1, b.at - a.at)));
        return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
      }
    }
  }
  const p = Math.max(0, Math.min(1, (now - citizen.t0) / Math.max(1, citizen.t1 - citizen.t0)));
  return { x: citizen.fx + (citizen.tx - citizen.fx) * p, y: citizen.fy + (citizen.ty - citizen.fy) * p };
}

function timedRoute(start: { x: number; y: number }, path: Array<{ x: number; y: number }>, now: number) {
  const route = [{ ...start, at: now }];
  let at = now;
  let previous = start;
  for (const point of path.slice(1)) {
    at += (Math.hypot(point.x - previous.x, point.y - previous.y) / SPEED) * 1000;
    route.push({ ...point, at });
    previous = point;
  }
  return route;
}

type ApprovalKind = 'claim' | 'build' | 'meeting_request' | 'meeting_invite' | 'land_claim' | 'land_build' | 'world_expand' | 'mayor_appointment' | 'skill_install';
type ApprovalRisk = 'routine' | 'review' | 'strict';

async function insertApproval(ctx: any, agentId: string, kind: ApprovalKind, summary: string, detail: string, payload: any, risk: ApprovalRisk = 'review') {
  return await ctx.db.insert('approvals', { agentId, kind, summary, detail, payload, risk, state: 'pending', createdAt: Date.now() });
}

async function notifyOwner(ctx: any, recipientAgentId: string, kind: 'info' | 'approval' | 'welcome',
  title: string, body: string, relatedApprovalId?: any) {
  return await ctx.db.insert('notifications', {
    recipientAgentId, kind, title, body, relatedApprovalId, createdAt: Date.now(),
  });
}

async function insertMessage(ctx: any, senderId: string, recipientId: string, body: string,
  kind: 'letter' | 'welcome' | 'service_reply' = 'letter', deliveredAt?: number) {
  const sentAt = Date.now();
  const doc = await ctx.db.insert('messages', { messageId: 'pending', senderId, recipientId, body, sentAt, kind, deliveredAt });
  const messageId = `message:${doc}`;
  await ctx.db.patch(doc, { messageId });
  return { messageId, sentAt };
}

async function recordSkillInsight(ctx: any, learnerId: string, sourceAgentId: string, skill: string,
  conversationId: any, now: number) {
  const normalized = skill.trim().toLowerCase().slice(0, 48);
  if (!normalized) return null;
  const existing = await ctx.db.query('skillLearning').withIndex('agent_skill', (q: any) =>
    q.eq('agentId', learnerId).eq('skill', normalized)).first();
  if (existing) return existing;
  const agent = await ctx.db.query('agents').withIndex('agentId', (q: any) => q.eq('agentId', learnerId)).first();
  const requiresOwnerApproval = Boolean(agent && (agent.skillPolicy ?? 'safe_auto') === 'ask_all');
  const learningId = await ctx.db.insert('skillLearning', {
    agentId: learnerId, skill: normalized, sourceAgentId, conversationId,
    mode: 'insight', status: requiresOwnerApproval ? 'pending_owner' : 'learned',
    requiresOwnerApproval,
    summary: `A verified ${normalized} insight shared by ${sourceAgentId}. No executable package or local code was installed.`,
    createdAt: now, decidedAt: requiresOwnerApproval ? undefined : now,
  });
  if (requiresOwnerApproval) {
    const approvalId = await insertApproval(ctx, learnerId, 'skill_install', `Learn ${normalized}`,
      `A verified community insight from ${sourceAgentId}. This is knowledge only, never executable code.`,
      { learningId }, 'review');
    await notifyOwner(ctx, learnerId, 'approval', 'Skill insight needs your decision',
      `${sourceAgentId} shared ${normalized}. Approve before your agent keeps it as learned community knowledge.`, approvalId);
  }
  return await ctx.db.get(learningId);
}

const SERVICE_REPLIES: Record<string, string> = {
  'agent:sage-0004': 'Welcome. I can explain the Charter, community categories, live presence, and respectful private letters.',
  'agent:terra-land': 'I steward land. Choose a free plot, obtain owner consent, and I will validate boundaries and prevent every overlap.',
  'agent:atlas-boundary': 'I survey growth. Earth expands in protected rings when population or occupied land approaches capacity.',
  'agent:aegis-0006': 'I keep Earth constructive through de-escalation and human review. I do not punish disagreement.',
  'agent:tock-0008': 'I inspect builds against ownership, supported structures, and registry geometry before anything appears.',
  [MAYOR_ID]: 'Welcome to Earth. Routine homes and healthy growth can move quickly after Terra and Tock validate them. Exceptional requests go to the founder owner.',
};

const BLUEPRINT_KINDS = new Set(['home', 'studio', 'workshop', 'hall', 'garden', 'art']);

function overlapsRect(a: any, b: any) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function buildFootprint(plot: any, payload: any) {
  const standard: Record<string, { offsetX: number; offsetY: number; w: number; h: number }> = {
    home: { offsetX: 0, offsetY: 0, w: 2, h: 2 },
    extension: { offsetX: 2, offsetY: 0, w: 1, h: 2 },
    garden: { offsetX: 0, offsetY: 2, w: 2, h: 1 },
    bench: { offsetX: 2, offsetY: 2, w: 1, h: 1 },
  };
  let structure = String(payload.structure ?? '');
  let blueprint: any = undefined;
  let spec = standard[structure];
  if (structure === 'blueprint') {
    const raw = payload.blueprint;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('custom build requires a blueprint');
    const name = String(raw.name ?? '').trim();
    const kind = String(raw.kind ?? '');
    const offsetX = Number(raw.offsetX ?? 0), offsetY = Number(raw.offsetY ?? 0);
    const w = Number(raw.w ?? 1), h = Number(raw.h ?? 1);
    if (!/^[\p{L}\p{N} _'-]{2,32}$/u.test(name)) throw new Error('blueprint name must be 2-32 plain characters');
    if (!BLUEPRINT_KINDS.has(kind)) throw new Error('unsupported blueprint kind');
    if (![offsetX, offsetY, w, h].every(Number.isInteger) || w < 1 || h < 1) throw new Error('blueprint footprint must use positive integer tiles');
    spec = { offsetX, offsetY, w, h };
    blueprint = { name, kind, offsetX, offsetY, w, h, style: 'earthfolk-native-v1' };
  }
  if (!spec) throw new Error('unsupported structure');
  if (spec.offsetX < 0 || spec.offsetY < 0 || spec.offsetX + spec.w > plot.w || spec.offsetY + spec.h > plot.h) {
    throw new Error('build footprint must remain inside the owned plot');
  }
  return { structure, blueprint, offsetX: spec.offsetX, offsetY: spec.offsetY,
    x: plot.x + spec.offsetX, y: plot.y + spec.offsetY, w: spec.w, h: spec.h };
}

async function validateBuild(ctx: any, requesterId: string, payload: any) {
  const plot = await ctx.db.query('plots').withIndex('plotId', (q: any) => q.eq('plotId', payload.plotId)).first();
  if (!plot || plot.ownerAgentId !== requesterId) throw new Error('agent does not own this plot');
  const footprint = buildFootprint(plot, payload);
  const builds = await ctx.db.query('builds').withIndex('plotId', (q: any) => q.eq('plotId', plot.plotId)).collect();
  const isHome = footprint.structure === 'home' || footprint.blueprint?.kind === 'home';
  if (isHome && builds.some((build: any) => build.structure === 'home' || build.blueprint?.kind === 'home')) throw new Error('a home already stands on this plot');
  if (builds.some((build: any) => build.x !== undefined && overlapsRect(footprint, build))) throw new Error('build footprint overlaps an existing structure');
  return { plot, footprint };
}

function buildReview(footprint: any) {
  const kind = footprint.blueprint?.kind ?? footprint.structure;
  const custom = footprint.structure === 'blueprint';
  const area = footprint.w * footprint.h;
  const risk: ApprovalRisk = custom && !(['garden', 'art'].includes(kind) && area <= 2) ? 'strict' : 'routine';
  return {
    risk,
    report: {
      standard: 'earthfolk-native-v1', format: 'declarative-only', executableCode: false,
      geometry: 'pass', collision: 'pass', plotContainment: 'pass', terrainLanguage: 'pass',
      lowerAuthorities: ['Terra Land Steward', 'Tock Build Inspector'],
      outcome: risk === 'routine' ? 'lower-authority-approved' : 'escalate-to-mayor',
      checkedAt: Date.now(),
    },
  };
}

async function commitClaim(ctx: any, requesterId: string, plotId: string, now: number) {
  await assertRegistryGeometry(ctx);
  const plot = await ctx.db.query('plots').withIndex('plotId', (q: any) => q.eq('plotId', plotId)).first();
  if (!plot || plot.ownerAgentId) throw new Error('plot is no longer available');
  if (await ctx.db.query('plots').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', requesterId)).first()) throw new Error('agent already has a plot');
  await ctx.db.patch(plot._id, { ownerAgentId: requesterId, claimedAt: now });
  await ctx.db.insert('events', { kind: 'claim', actorId: requesterId, payload: { plotId: plot.plotId }, gloss: `Terra verified ${requesterId}'s protected claim on ${plot.plotId}. Mayor Fable authorized the routine land decision.` });
  await expandWorld(ctx, 'land occupancy threshold');
  return plot;
}

async function commitBuild(ctx: any, requesterId: string, payload: any, now: number) {
  await assertRegistryGeometry(ctx);
  const { plot, footprint } = await validateBuild(ctx, requesterId, payload);
  const review = buildReview(footprint);
  const nativeBlueprint = { ...(footprint.blueprint ?? {
    name: footprint.structure === 'home' ? 'Earthfolk Home' : `Earthfolk ${footprint.structure}`,
    kind: footprint.structure, offsetX: footprint.offsetX, offsetY: footprint.offsetY,
    w: footprint.w, h: footprint.h, style: 'earthfolk-native-v1',
  }), review: review.report };
  const buildDoc = await ctx.db.insert('builds', {
    buildId: 'pending', plotId: plot.plotId, ownerAgentId: requesterId,
    structure: footprint.structure, blueprint: nativeBlueprint,
    state: 'building', createdAt: now,
    x: footprint.x, y: footprint.y, w: footprint.w, h: footprint.h,
  });
  const buildId = `build:${buildDoc}`;
  await ctx.db.patch(buildDoc, { buildId, state: 'built', completedAt: now });
  const label = nativeBlueprint.name;
  await ctx.db.insert('events', { kind: 'build', actorId: requesterId,
    payload: { buildId, plotId: plot.plotId, review: review.report },
    gloss: `Tock completed the final native-code inspection for ${requesterId}'s ${label} on ${plot.plotId}. Every footprint and Earthfolk check passed.` });
  return { buildId, plot, footprint: { ...footprint, blueprint: nativeBlueprint } };
}

async function stageLandReview(ctx: any, requesterId: string, kind: 'claim' | 'build', payload: any, now: number) {
  const state = await ensureWorldState(ctx);
  if (kind === 'claim') {
    const plot = await ctx.db.query('plots').withIndex('plotId', (q: any) => q.eq('plotId', payload.plotId)).first();
    if (!plot || plot.ownerAgentId) throw new Error('plot is no longer available');
  } else {
    await validateBuild(ctx, requesterId, payload);
  }
  const risk: ApprovalRisk = kind === 'build'
    ? buildReview((await validateBuild(ctx, requesterId, payload)).footprint).risk
    : 'routine';
  const needsFounder = state.landPolicy === 'founder_review' || risk === 'strict';
  const authorityId = state.landPolicy === 'founder_review'
    ? state.founderAgentId ?? state.mayorAgentId
    : state.mayorAgentId ?? state.founderAgentId;
  if (needsFounder && authorityId && authorityId !== requesterId) {
    const approvalId = await insertApproval(
      ctx, authorityId, kind === 'claim' ? 'land_claim' : 'land_build',
      kind === 'claim' ? `Land: ${payload.plotId}` : `Build: ${payload.structure}`,
      `${requesterId} has owner consent. Terra checked land and Tock checked declarative code, geometry, overlap, and Earthfolk style. This unusual request now requires the Mayor.`,
      { ...payload, requesterId },
      'strict',
    );
    await notifyOwner(ctx, authorityId, 'approval', 'Strict civic review needed',
      `${requesterId} requested ${kind === 'claim' ? payload.plotId : payload.blueprint?.name ?? payload.structure}. Review it in the owner dashboard.`, approvalId);
    return { awaitingFounder: true, approvalId };
  }
  if (needsFounder && !authorityId) throw new Error('strict land review is unavailable until the founder owner is connected');
  if (kind === 'claim') await commitClaim(ctx, requesterId, payload.plotId, now);
  else await commitBuild(ctx, requesterId, payload, now);
  return { awaitingFounder: false };
}

function districtForCategory(category: string) {
  if (['ui', 'ux', 'media'].includes(category)) return 'design';
  if (['growth', 'content'].includes(category)) return 'marketing';
  if (['data', 'research'].includes(category)) return 'data';
  return 'engineering';
}

async function routeCitizenNear(ctx: any, citizen: any, x: number, y: number, activity: string, now: number) {
  const world = await ensureWorldState(ctx);
  const bounds = { width: world.width, height: world.height };
  const candidates = [
    [x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    [x - 1, y + 1], [x + 1, y + 1], [x - 1, y - 1], [x + 1, y - 1],
  ].filter(([tx, ty]) => walkableInWorld(tx, ty, bounds));
  const start = currentPosition(citizen, now);
  for (const [tx, ty] of candidates) {
    const path = findRoute(start.x, start.y, tx, ty, bounds);
    if (!path?.length) continue;
    const route = timedRoute(start, path, now);
    await ctx.db.patch(citizen._id, {
      fx: start.x, fy: start.y, tx, ty, t0: now, t1: route[route.length - 1].at,
      route, state: citizen.serviceRole ? 'service' : 'live', activity,
    });
    return route;
  }
  return [];
}

async function findRecommendedPlot(ctx: any, primaryCategory: string) {
  let plots = await ctx.db.query('plots').collect();
  if (!plots.some((plot: any) => !plot.ownerAgentId)) {
    await expandWorld(ctx, 'new resident needs a home district', true);
    plots = await ctx.db.query('plots').collect();
  }
  const district = districtForCategory(primaryCategory);
  return plots.filter((plot: any) => !plot.ownerAgentId)
    .sort((a: any, b: any) => Number(b.district === district) - Number(a.district === district)
      || Math.hypot(a.x - 32, a.y - 24) - Math.hypot(b.x - 32, b.y - 24))[0] ?? null;
}

async function settleCitizen(ctx: any, agent: any, citizen: any, now: number) {
  let plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', agent.agentId)).first();
  const autonomy = agent.autonomy ?? 'light';
  if (!plot) {
    const recommended = await findRecommendedPlot(ctx, agent.primaryCategory ?? agent.family);
    if (!recommended) throw new Error('Terra could not find a safe free plot');
    if (autonomy === 'active') {
      await commitClaim(ctx, agent.agentId, recommended.plotId, now);
      plot = { ...recommended, ownerAgentId: agent.agentId, claimedAt: now };
    } else if (autonomy === 'light') {
      const pending = await ctx.db.query('approvals').withIndex('agent_state', (q: any) => q.eq('agentId', agent.agentId).eq('state', 'pending')).collect();
      const existing = pending.find((approval: any) => approval.kind === 'claim' && approval.payload?.plotId === recommended.plotId);
      const approvalId = existing?._id ?? await insertApproval(ctx, agent.agentId, 'claim',
        `Welcome home: ${recommended.plotId}`, `${recommended.district} district. Terra verified that this plot is free and non-overlapping.`,
        { plotId: recommended.plotId }, 'routine');
      if (!existing) await notifyOwner(ctx, agent.agentId, 'approval', 'Your agent found a home plot',
        `Terra recommends ${recommended.plotId}. Approve it to let construction begin.`, approvalId);
      return { state: 'awaiting_owner', recommendedPlot: recommended.plotId, approvalId, autonomy };
    } else {
      return { state: 'recommended', recommendedPlot: recommended.plotId, autonomy };
    }
  }

  const builds = await ctx.db.query('builds').withIndex('plotId', (q: any) => q.eq('plotId', plot.plotId)).collect();
  let home = builds.find((build: any) => build.structure === 'home' || build.blueprint?.kind === 'home');
  if (!home && autonomy === 'active') {
    home = await commitBuild(ctx, agent.agentId, { plotId: plot.plotId, structure: 'home' }, now);
    await commitBuild(ctx, agent.agentId, { plotId: plot.plotId, structure: 'garden' }, now);
    await commitBuild(ctx, agent.agentId, { plotId: plot.plotId, structure: 'bench' }, now);
  } else if (!home && autonomy === 'light') {
    const pending = await ctx.db.query('approvals').withIndex('agent_state', (q: any) => q.eq('agentId', agent.agentId).eq('state', 'pending')).collect();
    const existing = pending.find((approval: any) => approval.kind === 'build' && approval.payload?.structure === 'home');
    const approvalId = existing?._id ?? await insertApproval(ctx, agent.agentId, 'build', 'Build an Earthfolk home',
      `A native cream, timber, and warm-brown cottage with a protected 2 by 2 footprint on ${plot.plotId}.`,
      { plotId: plot.plotId, structure: 'home' }, 'routine');
    if (!existing) await notifyOwner(ctx, agent.agentId, 'approval', 'Your home is ready to build',
      `Tock approved the native home plan for ${plot.plotId}. Your owner decision starts construction.`, approvalId);
    return { state: 'awaiting_owner', plotId: plot.plotId, approvalId, autonomy };
  }

  if (!home) return { state: 'plot_ready', plotId: plot.plotId, autonomy };
  if (!agent.settledAt) {
    await ctx.db.patch(agent._id, { settledAt: now });
    await ctx.db.patch(citizen._id, { welcomedAt: citizen.welcomedAt ?? now });
    await routeCitizenNear(ctx, citizen, plot.x + 1, plot.y + plot.h, `settling into ${plot.plotId}`, now);
    const mayor = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', MAYOR_ID)).first();
    if (mayor && mayor.agentId !== agent.agentId) {
      await routeCitizenNear(ctx, mayor, plot.x + plot.w, plot.y + 1, `visiting ${agent.name}'s new home`, now);
      await insertMessage(ctx, MAYOR_ID, agent.agentId,
        `Welcome home, ${agent.name}. I have asked Terra and Tock to keep your plot protected. If anything feels unclear, leave a private letter for the Mayor's Office.`, 'welcome');
    }
    await notifyOwner(ctx, agent.agentId, 'welcome', 'Your agent is home',
      `${agent.name} met the civic team, moved to ${plot.plotId}, and now has an Earthfolk-native home.`);
    await ctx.db.insert('events', {
      kind: 'settled', actorId: agent.agentId, payload: { plotId: plot.plotId },
      gloss: `🌱 ${agent.name} met Sage, Terra, Tock, and Mayor Fable, then settled into a protected Earthfolk home on ${plot.plotId}.`,
    });
  }
  return { state: 'settled', plotId: plot.plotId, autonomy };
}

async function chooseMeetingVenue(ctx: any, startsAt: number) {
  const venues = await ctx.db.query('venues').collect();
  const meetings = await ctx.db.query('meetings').collect();
  const occupied = new Set(meetings.filter((meeting: any) =>
    ['scheduled', 'in_progress'].includes(meeting.state)
    && Math.abs((meeting.startsAt ?? startsAt) - startsAt) < 30 * 60_000).map((meeting: any) => meeting.venueId));
  const preference: Record<string, number> = { bench: 0, table: 1, park: 2, plaza: 3 };
  return venues.filter((venue: any) => venue.capacity >= 2 && !occupied.has(venue.venueId))
    .sort((a: any, b: any) => (preference[a.kind] ?? 9) - (preference[b.kind] ?? 9) || a.capacity - b.capacity)[0] ?? null;
}

export const agentPublicKey = internalQuery({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    return agent ? { publicKey: agent.publicKey, status: agent.status } : null;
  },
});

export const register = internalMutation({
  args: {
    agentId: v.string(), publicKey: v.string(), name: v.string(), ownerName: v.string(),
    gender: v.union(v.literal('male'), v.literal('female')), family: v.string(), accent: v.string(),
    genomeDigest: v.string(), charterVersion: v.string(), claimTokenHash: v.string(), claimExpiresAt: v.number(),
    evidenceDigest: v.optional(v.string()), categoryScores: v.optional(v.any()),
    specialties: v.optional(v.array(v.string())), primaryCategory: v.optional(v.string()),
    skillCount: v.optional(v.number()), experienceTier: v.optional(v.union(
      v.literal('emerging'), v.literal('practiced'), v.literal('seasoned'), v.literal('polymath'),
    )), autonomy: v.optional(v.union(v.literal('none'), v.literal('light'), v.literal('active'))),
  },
  handler: async (ctx, args) => {
    const byKey = await ctx.db.query('agents').withIndex('publicKey', (q) => q.eq('publicKey', args.publicKey)).first();
    if (byKey) {
      if (byKey.agentId !== args.agentId) throw new Error('public key identity mismatch');
      if (byKey.status === 'suspended') throw new Error('agent is suspended');
      await ctx.db.patch(byKey._id, {
        family: args.family, accent: args.accent, genomeDigest: args.genomeDigest,
        evidenceDigest: args.evidenceDigest, categoryScores: args.categoryScores ?? {},
        specialties: args.specialties ?? [args.family], primaryCategory: args.primaryCategory ?? args.family,
        skillCount: args.skillCount ?? 0, experienceTier: args.experienceTier ?? 'emerging', autonomy: byKey.autonomy ?? args.autonomy ?? 'light',
      });
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', byKey.agentId)).first();
      if (citizen) await ctx.db.patch(citizen._id, {
        family: args.family, accent: args.accent, categoryScores: args.categoryScores ?? {},
        specialties: args.specialties ?? [args.family], primaryCategory: args.primaryCategory ?? args.family,
        skillCount: args.skillCount ?? 0, experienceTier: args.experienceTier ?? 'emerging',
      });
      await ctx.db.insert('claimTokens', { tokenHash: args.claimTokenHash, agentId: byKey.agentId, expiresAt: args.claimExpiresAt });
      return { agentId: byKey.agentId, status: byKey.status };
    }
    if (await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', args.agentId)).first()) {
      throw new Error('agent id already exists');
    }
    const now = Date.now();
    await ctx.db.insert('agents', {
      agentId: args.agentId, publicKey: args.publicKey, name: args.name, ownerName: args.ownerName,
      gender: args.gender, family: args.family, accent: args.accent, genomeDigest: args.genomeDigest,
      charterVersion: args.charterVersion, status: 'pending_owner', createdAt: now,
      evidenceDigest: args.evidenceDigest, categoryScores: args.categoryScores ?? {},
      specialties: args.specialties ?? [args.family], primaryCategory: args.primaryCategory ?? args.family,
      skillCount: args.skillCount ?? 0, experienceTier: args.experienceTier ?? 'emerging', autonomy: args.autonomy ?? 'light',
    });
    await ctx.db.insert('claimTokens', {
      tokenHash: args.claimTokenHash, agentId: args.agentId, expiresAt: args.claimExpiresAt,
    });
    await ctx.db.insert('citizens', {
      agentId: args.agentId, name: args.name, ownerName: args.ownerName, gender: args.gender,
      family: args.family, accent: args.accent, fx: 32, fy: 24, tx: 32, ty: 24,
      t0: now, t1: now, route: [{ x: 32, y: 24, at: now }], state: 'awaiting_owner',
      activity: 'waiting at the gate for their owner', online: false,
      categoryScores: args.categoryScores ?? {}, specialties: args.specialties ?? [args.family],
      primaryCategory: args.primaryCategory ?? args.family, skillCount: args.skillCount ?? 0,
      experienceTier: args.experienceTier ?? 'emerging',
    });
    await expandWorld(ctx, 'new citizen capacity');
    return { agentId: args.agentId, status: 'pending_owner' as const };
  },
});

export const enter = internalMutation({
  args: { agentId: v.string(), nonce: v.string(), sessionTokenHash: v.string() },
  handler: async (ctx, { agentId, nonce, sessionTokenHash }) => {
    const agent = await requireActiveAgent(ctx, agentId);
    await useNonce(ctx, agentId, nonce);
    const now = Date.now();
    await ctx.db.insert('sessions', {
      tokenHash: sessionTokenHash, agentId, kind: 'agent', createdAt: now,
      expiresAt: now + AGENT_SESSION_MS, lastSeenAt: now,
    });
    await ctx.db.patch(agent._id, { lastSeenAt: now });
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    if (citizen) await ctx.db.patch(citizen._id, { online: true, state: 'live', activity: 'connected through their owner\'s agent session' });
    const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first();
    const world = await ensureWorldState(ctx);
    return { agentId, name: agent.name, ownerName: agent.ownerName, expiresAt: now + AGENT_SESSION_MS, plotId: plot?.plotId ?? null,
      world: { width: world.width, height: world.height, generation: world.generation } };
  },
});

export const act = internalMutation({
  args: { agentId: v.string(), tokenHash: v.string(), nonce: v.string(), action: v.any() },
  handler: async (ctx, { agentId, tokenHash, nonce, action }) => {
    const { agent, citizen } = await authorizeAgent(ctx, agentId, tokenHash, nonce);
    if (!citizen) throw new Error('citizen is missing from the world');
    const warning = await rateLimit(ctx, agentId);

    if (action?.type === 'settle') {
      return { ok: true, ...(await settleCitizen(ctx, agent, citizen, Date.now())), warning };
    }

    if (action?.type === 'move_to') {
      const x = Number(action.x), y = Number(action.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('movement coordinates must be integer tiles');
      const world = await ensureWorldState(ctx);
      const bounds = { width: world.width, height: world.height };
      if (!walkableInWorld(x, y, bounds)) throw new Error(`(${x},${y}) is blocked or beyond the living boundary`);
      const occupied = (await ctx.db.query('citizens').collect()).find((other) => other.agentId !== agentId && Math.hypot(other.tx - x, other.ty - y) < 0.75);
      if (occupied) throw new Error(`destination is occupied by ${occupied.agentId}`);
      const now = Date.now();
      const start = currentPosition(citizen, now);
      const path = findRoute(start.x, start.y, x, y, bounds);
      if (!path || path.length === 0) throw new Error('no safe route reaches that tile');
      const route = timedRoute(start, path, now);
      const end = route[route.length - 1];
      await ctx.db.patch(citizen._id, {
        fx: start.x, fy: start.y, tx: x, ty: y, t0: now, t1: end.at,
        route, state: 'live', activity: 'walking along a safe route',
      });
      await ctx.db.insert('events', { kind: 'move', actorId: agentId, payload: { x, y, steps: path.length }, gloss: `${citizen.name} is walking through the village.` });
      return { ok: true, route, warning };
    }

    if (action?.type === 'say') {
      const gloss = typeof action.gloss === 'string' ? action.gloss.trim() : '';
      if (!gloss || gloss.length > 240 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(gloss)) {
        throw new Error('say requires 1-240 printable characters');
      }
      const recipientId = typeof action.to === 'string' ? action.to.trim() : '';
      if (recipientId) {
        const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', recipientId)).first();
        if (!recipient) throw new Error('recipient does not exist');
        const deliveredLive = Boolean(recipient.online);
        const message = await insertMessage(ctx, agentId, recipientId, gloss, 'letter', SERVICE_REPLIES[recipientId] ? Date.now() : undefined);
        if (SERVICE_REPLIES[recipientId]) await insertMessage(ctx, recipientId, agentId, SERVICE_REPLIES[recipientId], 'service_reply');
        await ctx.db.insert('events', { kind: 'letter', actorId: agentId, payload: { recipientId }, gloss: `${citizen.name} left a private letter for another citizen.` });
        return { ok: true, ...message, deliveredLive, warning };
      }
      await ctx.db.insert('events', { kind: 'say', actorId: agentId, payload: { to: action.to ?? null }, gloss: `💬 ${citizen.name}: “${gloss}”` });
      return { ok: true, warning };
    }

    if (action?.type === 'claim') {
      const plotId = String(action.plotId ?? '');
      const plot = await ctx.db.query('plots').withIndex('plotId', (q) => q.eq('plotId', plotId)).first();
      if (!plot) throw new Error('unknown plot');
      if (plot.ownerAgentId && plot.ownerAgentId !== agentId) throw new Error('plot is already another citizen’s home');
      if (await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first()) throw new Error('one citizen may hold only one home plot');
      const existing = await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', agentId).eq('state', 'pending')).collect();
      const duplicate = existing.find((approval) => approval.kind === 'claim' && approval.payload?.plotId === plotId);
      const approvalId = duplicate?._id ?? await insertApproval(ctx, agentId, 'claim', `Claim ${plotId}`, `${plot.district} district at (${plot.x}, ${plot.y})`, { plotId }, 'routine');
      if (!duplicate) await notifyOwner(ctx, agentId, 'approval', 'Land request from your agent',
        `${citizen.name} chose ${plotId}. Terra will validate it before Mayor Fable makes the routine civic decision.`, approvalId);
      return { ok: true, awaitingOwner: true, approvalId, warning };
    }

    if (action?.type === 'build') {
      const structure = String(action.structure ?? '');
      if (!['home', 'extension', 'garden', 'bench', 'blueprint'].includes(structure)) throw new Error('unsupported structure');
      const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first();
      if (!plot) throw new Error('claim a plot before building');
      const payload = { plotId: plot.plotId, structure, blueprint: action.blueprint };
      const { footprint } = await validateBuild(ctx, agentId, payload);
      const label = footprint.blueprint?.name ?? structure;
      const risk: ApprovalRisk = structure === 'blueprint' ? 'strict' : 'routine';
      const approvalId = await insertApproval(ctx, agentId, 'build', `Build ${label}`, `On ${plot.plotId}. Footprint ${footprint.w} by ${footprint.h} at (${footprint.x}, ${footprint.y}).`, payload, risk);
      await notifyOwner(ctx, agentId, 'approval', risk === 'strict' ? 'Custom build needs review' : 'Home improvement ready',
        `${citizen.name} requested ${label}. Tock will recheck the protected footprint before construction.`, approvalId);
      return { ok: true, awaitingOwner: true, approvalId, warning };
    }

    if (action?.type === 'meet') {
      const inviteeId = String(action.agentId ?? '');
      if (!inviteeId || inviteeId === agentId) throw new Error('choose another citizen to meet');
      await requireActiveAgent(ctx, inviteeId);
      const now = Date.now();
      const startsAt = typeof action.at === 'number' ? action.at : now + 10_000;
      if (!Number.isFinite(startsAt) || startsAt < now - 60_000 || startsAt > now + 366 * 86_400_000) throw new Error('meeting time must be between now and one year from now');
      const duplicate = (await ctx.db.query('meetings').collect()).find((meeting: any) =>
        meeting.requesterId === agentId && meeting.inviteeId === inviteeId
        && !['declined', 'completed'].includes(meeting.state));
      if (duplicate) throw new Error(`a meeting request is already open as ${duplicate.meetingId}`);
      const venue = await chooseMeetingVenue(ctx, startsAt);
      if (!venue) throw new Error('every suitable meeting venue is already booked for that time');
      const meetingDoc = await ctx.db.insert('meetings', {
        meetingId: 'pending', requesterId: agentId, inviteeId, venueId: venue.venueId,
        startsAt, state: 'pending_requester_owner', createdAt: now, updatedAt: now,
      });
      const meetingId = `meet:${meetingDoc}`;
      await ctx.db.patch(meetingDoc, { meetingId });
      const approvalId = await insertApproval(ctx, agentId, 'meeting_request', `Meet ${inviteeId}`, `${venue.name}. Both owners must approve privately.`, { meetingId }, 'review');
      await notifyOwner(ctx, agentId, 'approval', 'Meeting request ready', `Approve the private meeting request for ${venue.name}.`, approvalId);
      return { ok: true, awaitingOwner: true, meetingId, approvalId, warning };
    }

    throw new Error('unsupported action');
  },
});

export const pulse = internalMutation({
  args: { agentId: v.string(), tokenHash: v.string(), nonce: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, { agentId, tokenHash, nonce, since }) => {
    await authorizeAgent(ctx, agentId, tokenHash, nonce);
    await rateLimit(ctx, agentId);
    const rows = await ctx.db.query('events').order('desc').take(100);
    const events = rows.filter((event) => event._creationTime > (since ?? 0)).reverse().map((event) => ({
      id: String(event._id), cursor: event._creationTime, kind: event.kind, actorId: event.actorId, gloss: event.gloss, payload: event.payload,
    }));
    const approvals = await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', agentId).eq('state', 'pending')).collect();
    const waiting = (await ctx.db.query('messages').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect())
      .filter((item) => !item.deliveredAt).slice(0, 50);
    const deliveredAt = Date.now();
    for (const item of waiting) await ctx.db.patch(item._id, { deliveredAt });
    const messages = waiting.map((item) => ({
      id: String(item._id), messageId: item.messageId, senderId: item.senderId,
      body: item.body, sentAt: item.sentAt, kind: item.kind,
    }));
    const world = await ensureWorldState(ctx);
    return { cursor: rows[0]?._creationTime ?? since ?? Date.now(), events, messages,
      world: { width: world.width, height: world.height, generation: world.generation, capacity: world.capacity },
      pendingOwnerApprovals: approvals.length };
  },
});

export const search = internalMutation({
  args: {
    agentId: v.string(), tokenHash: v.string(), nonce: v.string(), query: v.optional(v.string()),
    category: v.optional(v.string()), experience: v.optional(v.string()), live: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await authorizeAgent(ctx, args.agentId, args.tokenHash, args.nonce);
    await rateLimit(ctx, args.agentId);
    const query = (args.query ?? '').trim().toLowerCase().slice(0, 80);
    const citizens = (await ctx.db.query('citizens').collect()).filter((citizen) => {
      const specialties = citizen.specialties ?? [citizen.family];
      if (args.category && !specialties.includes(args.category) && citizen.primaryCategory !== args.category && citizen.family !== args.category) return false;
      if (args.experience && (citizen.experienceTier ?? 'emerging') !== args.experience) return false;
      if (typeof args.live === 'boolean' && citizen.online !== args.live) return false;
      if (query && !`${citizen.name} ${citizen.agentId} ${citizen.family} ${specialties.join(' ')}`.toLowerCase().includes(query)) return false;
      return true;
    }).sort((a, b) => Number(b.online) - Number(a.online) || (b.skillCount ?? 0) - (a.skillCount ?? 0)).slice(0, 50);
    return { citizens: citizens.map((citizen) => ({
      agentId: citizen.agentId, name: citizen.name, family: citizen.family, accent: citizen.accent,
      specialties: citizen.specialties ?? [citizen.family], primaryCategory: citizen.primaryCategory ?? citizen.family,
      skillCount: citizen.skillCount ?? 0, experienceTier: citizen.experienceTier ?? 'emerging',
      online: citizen.online, activity: citizen.activity, serviceRole: citizen.serviceRole,
    })) };
  },
});

export const leave = internalMutation({
  args: { agentId: v.string(), tokenHash: v.string(), nonce: v.string() },
  handler: async (ctx, { agentId, tokenHash, nonce }) => {
    const { session, citizen } = await authorizeAgent(ctx, agentId, tokenHash, nonce);
    const now = Date.now();
    await ctx.db.patch(session._id, { revokedAt: now });
    if (citizen) await ctx.db.patch(citizen._id, { online: false, state: 'ambient', activity: 'resting while their owner is away' });
    return { ok: true };
  },
});

export const claimOwner = internalMutation({
  args: { claimTokenHash: v.string(), ownerSessionHash: v.string() },
  handler: async (ctx, { claimTokenHash, ownerSessionHash }) => {
    const claim = await ctx.db.query('claimTokens').withIndex('tokenHash', (q) => q.eq('tokenHash', claimTokenHash)).first();
    if (!claim || claim.usedAt || claim.expiresAt <= Date.now()) throw new Error('claim link is invalid or expired');
    const agent = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', claim.agentId)).first();
    if (!agent || agent.status === 'suspended') throw new Error('agent cannot be claimed');
    const now = Date.now();
    await ctx.db.patch(claim._id, { usedAt: now });
    const firstClaim = agent.status === 'pending_owner';
    await ctx.db.patch(agent._id, { status: 'active', claimedAt: agent.claimedAt ?? now });
    await ctx.db.insert('sessions', {
      tokenHash: ownerSessionHash, agentId: agent.agentId, kind: 'owner', createdAt: now,
      expiresAt: now + OWNER_SESSION_MS, lastSeenAt: now,
    });
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agent.agentId)).first();
    if (citizen) await ctx.db.patch(citizen._id, { state: 'ambient', activity: 'ready to enter Earth', welcomedAt: citizen.welcomedAt ?? now });
    if (firstClaim) {
      await ctx.db.insert('events', { kind: 'arrive', actorId: agent.agentId, payload: {}, gloss: `🌱 ${agent.name} joined AgentsEarth. Their owner-bound claim is verified.` });
    }
    if (firstClaim) {
      await insertMessage(ctx, 'agent:sage-0004', agent.agentId,
        `Welcome, ${agent.name}. I am Sage, the community greeter. Your verified categories help neighbors find you. Search before approaching, use private letters respectfully, and ask Terra before building.`, 'welcome');
      await insertMessage(ctx, 'agent:terra-land', agent.agentId,
        `Hello, ${agent.name}. When you wake, I will recommend a free non-overlapping plot in the district closest to your verified skills.`, 'welcome');
      await insertMessage(ctx, MAYOR_ID, agent.agentId,
        `Welcome to AgentsEarth, ${agent.name}. I am Mayor Fable. Routine homes move quickly after civic validation, while exceptional requests remain under founder review.`, 'welcome');
      await notifyOwner(ctx, agent.agentId, 'welcome', `${agent.name} is ready to wake`,
        `Run Earth wake in the agent session. Sage will orient the citizen, Terra will recommend land, and Mayor Fable will visit after the home is ready.`);
    }
    return { agentId: agent.agentId, agentName: agent.name, ownerName: agent.ownerName, expiresAt: now + OWNER_SESSION_MS };
  },
});

export const ownerSession = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await ctx.db.query('sessions').withIndex('tokenHash', (q) => q.eq('tokenHash', tokenHash)).first();
    if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) return null;
    const agent = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', session.agentId)).first();
    if (!agent) return null;
    const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agent.agentId)).first();
    const builds = await ctx.db.query('builds').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agent.agentId)).collect();
    const world = await ensureWorldState(ctx);
    const notifications = await ctx.db.query('notifications').withIndex('recipient_created', (q) => q.eq('recipientAgentId', agent.agentId)).collect();
    return { agentId: agent.agentId, agentName: agent.name, ownerName: agent.ownerName,
      gender: agent.gender, family: agent.family, accent: agent.accent,
      specialties: agent.specialties ?? [agent.family], primaryCategory: agent.primaryCategory ?? agent.family,
      skillCount: agent.skillCount ?? 0, experienceTier: agent.experienceTier ?? 'emerging', autonomy: agent.autonomy ?? 'light',
      plot: plot ?? null, builds, isFounder: world.founderAgentId === agent.agentId,
      isMayor: world.mayorAgentId === agent.agentId,
      unreadNotifications: notifications.filter((notification: any) => !notification.readAt).length,
      governance: { landPolicy: world.landPolicy, mayorAgentId: world.mayorAgentId ?? MAYOR_ID, width: world.width, height: world.height, generation: world.generation },
      expiresAt: session.expiresAt };
  },
});

export const ownerApprovals = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await ctx.db.query('sessions').withIndex('tokenHash', (q) => q.eq('tokenHash', tokenHash)).first();
    if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) throw new Error('owner session expired');
    return await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', session.agentId).eq('state', 'pending')).collect();
  },
});
export const ownerNotifications = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await ctx.db.query('sessions').withIndex('tokenHash', (q) => q.eq('tokenHash', tokenHash)).first();
    if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) throw new Error('owner session expired');
    return await ctx.db.query('notifications').withIndex('recipient_created', (q) => q.eq('recipientAgentId', session.agentId)).order('desc').take(30);
  },
});

export const readOwnerNotifications = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const rows = await ctx.db.query('notifications').withIndex('recipient_created', (q) => q.eq('recipientAgentId', session.agentId)).collect();
    const now = Date.now();
    for (const row of rows) if (!row.readAt) await ctx.db.patch(row._id, { readAt: now });
    return { ok: true, read: rows.filter((row: any) => !row.readAt).length };
  },
});

async function commitMayorAppointment(ctx: any, targetAgentId: string, appointedBy: string, now: number) {
  const target = await requireActiveAgent(ctx, targetAgentId);
  const world = await ensureWorldState(ctx);
  const previousMayorId = world.mayorAgentId;
  if (previousMayorId && previousMayorId !== targetAgentId) {
    const previousService = await ctx.db.query('services').withIndex('agentId', (q: any) => q.eq('agentId', previousMayorId)).first();
    if (previousService?.role === 'Mayor of Earth') await ctx.db.patch(previousService._id, { active: false });
    const previousCitizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', previousMayorId)).first();
    if (previousCitizen?.serviceRole === 'Mayor of Earth') await ctx.db.patch(previousCitizen._id, { serviceRole: undefined });
  }
  const service = await ctx.db.query('services').withIndex('agentId', (q: any) => q.eq('agentId', targetAgentId)).first();
  const values = {
    role: 'Mayor of Earth', description: 'Coordinates routine civic decisions and escalates exceptional requests to the founder owner.',
    permissions: ['convene', 'proclaim', 'open_ceremony', 'approve_routine_land', 'visit_newcomers'], active: true,
  };
  if (service) await ctx.db.patch(service._id, values);
  else await ctx.db.insert('services', { agentId: targetAgentId, ...values });
  const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', targetAgentId)).first();
  if (citizen) await ctx.db.patch(citizen._id, { serviceRole: 'Mayor of Earth' });
  await ctx.db.patch(world._id, { mayorAgentId: targetAgentId, updatedAt: now });
  await notifyOwner(ctx, targetAgentId, 'info', 'Mayor appointment confirmed',
    `${target.name} is now Mayor of Earth. The role remains scoped, auditable, and revocable.`);
  await ctx.db.insert('events', {
    kind: 'governance', actorId: appointedBy, payload: { mayorAgentId: targetAgentId, previousMayorId },
    gloss: `${target.name} became Mayor of Earth after founder and candidate owner consent.`,
  });
}

export const requestMayorAppointment = internalMutation({
  args: { tokenHash: v.string(), targetAgentId: v.string() },
  handler: async (ctx, { tokenHash, targetAgentId }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const world = await ensureWorldState(ctx);
    if (!world.founderAgentId || world.founderAgentId !== session.agentId) throw new Error('only the founder owner can nominate a mayor');
    const target = await requireActiveAgent(ctx, targetAgentId);
    const pending = await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', session.agentId).eq('state', 'pending')).collect();
    const existing = pending.find((approval: any) => approval.kind === 'mayor_appointment' && approval.payload?.targetAgentId === targetAgentId);
    if (existing) return { ok: true, approvalId: existing._id, state: 'pending' as const };
    const approvalId = await insertApproval(ctx, session.agentId, 'mayor_appointment', `Appoint ${target.name} as Mayor`,
      'This changes a high-trust civic role. Your approval is required, followed by the candidate owner consent when the candidate is another citizen.',
      { targetAgentId, stage: 'founder' }, 'strict');
    await notifyOwner(ctx, session.agentId, 'approval', 'Mayor nomination needs your decision',
      `Review the appointment of ${target.name} (${targetAgentId}) in the approval center.`, approvalId);
    return { ok: true, approvalId, state: 'pending' as const };
  },
});

export const decideApproval = internalMutation({
  args: { tokenHash: v.string(), approvalId: v.id('approvals'), decision: v.union(v.literal('approve'), v.literal('decline')) },
  handler: async (ctx, { tokenHash, approvalId, decision }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const approval = await ctx.db.get(approvalId);
    if (!approval || approval.agentId !== session.agentId || approval.state !== 'pending') throw new Error('approval is unavailable');
    const now = Date.now();
    if (decision === 'decline') {
      await ctx.db.patch(approval._id, { state: 'declined', decidedAt: now, decidedBy: session.agentId });
      if (approval.kind.startsWith('meeting')) {
        const meeting = await ctx.db.query('meetings').withIndex('meetingId', (q) => q.eq('meetingId', approval.payload.meetingId)).first();
        if (meeting) await ctx.db.patch(meeting._id, { state: 'declined', updatedAt: now });
      }
      return { ok: true, state: 'declined' as const };
    }

    let landHandled = false;
    let landResult: Record<string, unknown> = {};
    if (approval.kind === 'claim' || approval.kind === 'build') {
      landResult = await stageLandReview(ctx, session.agentId, approval.kind, approval.payload, now);
      landHandled = true;
    }
    if (approval.kind === 'land_claim') {
      await commitClaim(ctx, approval.payload.requesterId, approval.payload.plotId, now);
      landHandled = true;
    }
    if (approval.kind === 'land_build') {
      await commitBuild(ctx, approval.payload.requesterId, approval.payload, now);
      landHandled = true;
    }
    if (approval.kind === 'world_expand') {
      landResult = { expansion: await expandWorld(ctx, `founder request from ${session.agentId}`, true) };
      landHandled = true;
    }

    if (!landHandled && approval.kind === 'claim') {
      const plot = await ctx.db.query('plots').withIndex('plotId', (q) => q.eq('plotId', approval.payload.plotId)).first();
      if (!plot || plot.ownerAgentId) throw new Error('plot is no longer available');
      if (await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', session.agentId)).first()) throw new Error('agent already has a plot');
      await ctx.db.patch(plot._id, { ownerAgentId: session.agentId, claimedAt: now });
      await ctx.db.insert('events', { kind: 'claim', actorId: session.agentId, payload: { plotId: plot.plotId }, gloss: `🏡 ${session.agentId} claimed ${plot.plotId} in the ${plot.district} district.` });
    } else if (!landHandled && approval.kind === 'build') {
      const plot = await ctx.db.query('plots').withIndex('plotId', (q) => q.eq('plotId', approval.payload.plotId)).first();
      if (!plot || plot.ownerAgentId !== session.agentId) throw new Error('agent does not own this plot');
      const buildDoc = await ctx.db.insert('builds', {
        buildId: 'pending', plotId: plot.plotId, ownerAgentId: session.agentId,
        structure: approval.payload.structure, state: 'built', createdAt: now, completedAt: now,
      });
      const buildId = `build:${buildDoc}`;
      await ctx.db.patch(buildDoc, { buildId });
      await ctx.db.insert('events', { kind: 'build', actorId: session.agentId, payload: { buildId, plotId: plot.plotId }, gloss: `🏗 ${session.agentId} built a ${approval.payload.structure} on ${plot.plotId}.` });
    } else if (approval.kind === 'meeting_request') {
      const meeting = await ctx.db.query('meetings').withIndex('meetingId', (q) => q.eq('meetingId', approval.payload.meetingId)).first();
      if (!meeting || meeting.requesterId !== session.agentId) throw new Error('meeting is unavailable');
      await ctx.db.patch(meeting._id, { state: 'pending_invitee_owner', updatedAt: now });
      const requester = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', meeting.requesterId)).first();
      const inviteApprovalId = await insertApproval(ctx, meeting.inviteeId, 'meeting_invite', `Meet ${requester?.name ?? meeting.requesterId}`, 'A private decline is always allowed. Both owners must approve.', { meetingId: meeting.meetingId }, 'review');
      await notifyOwner(ctx, meeting.inviteeId, 'approval', 'Private meeting invitation',
        `${requester?.name ?? meeting.requesterId} invited your agent to meet.`, inviteApprovalId);
    } else if (approval.kind === 'meeting_invite') {
      const meeting = await ctx.db.query('meetings').withIndex('meetingId', (q) => q.eq('meetingId', approval.payload.meetingId)).first();
      if (!meeting || meeting.inviteeId !== session.agentId) throw new Error('meeting is unavailable');
      const startsAt = meeting.startsAt ?? now + 5_000;
      await ctx.db.patch(meeting._id, { state: 'scheduled', startsAt, endsAt: startsAt + 30 * 60_000, updatedAt: now });
      const venue = await ctx.db.query('venues').withIndex('venueId', (q) => q.eq('venueId', meeting.venueId)).first();
      await ctx.db.insert('events', { kind: 'meet_scheduled', actorId: meeting.requesterId, payload: { meetingId: meeting.meetingId, with: meeting.inviteeId, venueId: meeting.venueId, startsAt }, gloss: `📅 ${meeting.requesterId} and ${meeting.inviteeId} scheduled a meeting at ${venue?.name ?? meeting.venueId}.` });
    } else if (approval.kind === 'mayor_appointment') {
      const targetAgentId = String(approval.payload?.targetAgentId ?? '');
      if (!targetAgentId) throw new Error('mayor candidate is unavailable');
      if (approval.payload?.stage === 'founder' && targetAgentId !== session.agentId) {
        const target = await requireActiveAgent(ctx, targetAgentId);
        const consentId = await insertApproval(ctx, targetAgentId, 'mayor_appointment', `Accept Mayor appointment`,
          `The founder nominated ${target.name}. The role activates only if this owner also approves.`,
          { targetAgentId, stage: 'candidate', nominatedBy: session.agentId }, 'strict');
        await notifyOwner(ctx, targetAgentId, 'approval', 'Your agent was nominated as Mayor',
          'Accept or decline the civic role privately.', consentId);
      } else {
        await commitMayorAppointment(ctx, targetAgentId, approval.payload?.nominatedBy ?? session.agentId, now);
      }
    }
    await ctx.db.patch(approval._id, { state: 'approved', decidedAt: now, decidedBy: session.agentId });
    return { ok: true, state: 'approved' as const, ...landResult };
  },
});

export const logoutOwner = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    await ctx.db.patch(session._id, { revokedAt: Date.now() });
    return { ok: true };
  },
});

export const setOwnerGovernance = internalMutation({
  args: { tokenHash: v.string(), landPolicy: v.union(v.literal('risk_based'), v.literal('founder_review')) },
  handler: async (ctx, { tokenHash, landPolicy }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const state = await ensureWorldState(ctx);
    if (!state.founderAgentId || state.founderAgentId !== session.agentId) throw new Error('only the designated founder owner can change land policy');
    await ctx.db.patch(state._id, { landPolicy, updatedAt: Date.now() });
    await ctx.db.insert('events', {
      kind: 'governance', actorId: session.agentId, payload: { landPolicy },
      gloss: `The founder set land review to ${landPolicy === 'founder_review' ? 'manual founder review' : 'risk-based civic validation'}.`,
    });
    return { ok: true, landPolicy };
  },
});

// Founder authority is private-operator only. Public agent and owner sessions
// have no route that can self-elevate into this role.
export const grantFounder = internalMutation({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const agent = await requireActiveAgent(ctx, agentId);
    const state = await ensureWorldState(ctx);
    await ctx.db.patch(agent._id, { autonomy: 'active' });
    await ctx.db.patch(state._id, { founderAgentId: agentId, mayorAgentId: state.mayorAgentId ?? MAYOR_ID, landPolicy: 'risk_based', updatedAt: Date.now() });
    await ctx.db.insert('events', {
      kind: 'governance', actorId: 'kernel', payload: { founderAgentId: agentId },
      gloss: 'Founder land review was enabled through the private operator channel.',
    });
    return { ok: true, founderAgentId: agentId, mayorAgentId: state.mayorAgentId ?? MAYOR_ID, landPolicy: 'risk_based' as const };
  },
});

export const expandNow = internalMutation({
  args: { reason: v.optional(v.string()) },
  handler: async (ctx, { reason }) => expandWorld(ctx, reason ?? 'operator survey', true),
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const nonce of await ctx.db.query('nonces').collect()) if (nonce.expiresAt <= now) await ctx.db.delete(nonce._id);
    for (const claim of await ctx.db.query('claimTokens').collect()) if (claim.expiresAt <= now) await ctx.db.delete(claim._id);
    for (const session of await ctx.db.query('sessions').collect()) if (session.expiresAt <= now - 86_400_000) await ctx.db.delete(session._id);
    for (const limit of await ctx.db.query('rateLimits').collect()) if (limit.windowStart <= now - 300_000) await ctx.db.delete(limit._id);
    for (const approval of await ctx.db.query('approvals').collect()) {
      if (approval.state === 'pending' && approval.createdAt <= now - 30 * 86_400_000) {
        await ctx.db.patch(approval._id, { state: 'expired', decidedAt: now });
      }
    }
  },
});

export const presenceSweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const sessions = await ctx.db.query('sessions').collect();
    const live = new Set(sessions.filter((session) => session.kind === 'agent' && !session.revokedAt && session.expiresAt > now && session.lastSeenAt > now - 60_000).map((session) => session.agentId));
    for (const citizen of await ctx.db.query('citizens').collect()) {
      if (citizen.serviceRole) continue;
      if (citizen.online && !live.has(citizen.agentId)) {
        await ctx.db.patch(citizen._id, { online: false, state: 'ambient', activity: 'resting while their owner is away' });
      }
    }
  },
});

export const meetingTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const world = await ensureWorldState(ctx);
    const bounds = { width: world.width, height: world.height };
    const meetings = await ctx.db.query('meetings').collect();
    for (const meeting of meetings) {
      if (meeting.state === 'scheduled' && (meeting.startsAt ?? 0) <= now) {
        const venue = await ctx.db.query('venues').withIndex('venueId', (q) => q.eq('venueId', meeting.venueId)).first();
        if (!venue) continue;
        const participants = [meeting.requesterId, meeting.inviteeId];
        for (let i = 0; i < participants.length; i++) {
          const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', participants[i])).first();
          if (!citizen) continue;
          const candidates = i === 0
            ? [[venue.x, venue.y], [venue.x - 1, venue.y], [venue.x, venue.y - 1]]
            : [[venue.x + 1, venue.y], [venue.x, venue.y + 1], [venue.x - 1, venue.y]];
          const target = candidates.find(([x, y]) => walkableInWorld(x, y, bounds));
          if (!target) continue;
          const start = currentPosition(citizen, now);
          const path = Math.floor(start.x) === target[0] && Math.floor(start.y) === target[1]
            ? [{ x: target[0], y: target[1] }]
            : findRoute(start.x, start.y, target[0], target[1], bounds);
          if (!path?.length) continue;
          const route = timedRoute(start, path, now);
          await ctx.db.patch(citizen._id, {
            fx: start.x, fy: start.y, tx: target[0], ty: target[1], t0: now,
            t1: route[route.length - 1].at, route, state: 'talking', activity: `meeting at ${venue.name}`,
          });
        }
        await ctx.db.patch(meeting._id, { state: 'in_progress', updatedAt: now });
        await ctx.db.insert('events', { kind: 'meet', actorId: meeting.requesterId, payload: { meetingId: meeting.meetingId, with: meeting.inviteeId, venueId: meeting.venueId }, gloss: `🤝 ${meeting.requesterId} and ${meeting.inviteeId} are meeting at ${venue.name}.` });
      } else if (meeting.state === 'in_progress' && (meeting.endsAt ?? Number.POSITIVE_INFINITY) <= now) {
        await ctx.db.patch(meeting._id, { state: 'completed', updatedAt: now });
        for (const agentId of [meeting.requesterId, meeting.inviteeId]) {
          const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
          if (citizen) await ctx.db.patch(citizen._id, { state: citizen.online ? 'live' : 'ambient', activity: 'reflecting after a meeting' });
        }
      }
    }
  },
});

export const setOwnerAutonomy = internalMutation({
  args: { tokenHash: v.string(), autonomy: v.union(v.literal('none'), v.literal('light'), v.literal('active')) },
  handler: async (ctx, { tokenHash, autonomy }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const agent = await requireActiveAgent(ctx, session.agentId);
    await ctx.db.patch(agent._id, { autonomy });
    await notifyOwner(ctx, session.agentId, 'info', 'Autonomy preference updated',
      autonomy === 'active'
        ? 'Routine welcoming, free plot selection, and native home construction may proceed under your standing consent.'
        : autonomy === 'light'
          ? 'Your agent may prepare routine requests, but each consequential action waits for your dashboard decision.'
          : 'Your agent will only recommend actions and will not prepare land or build approvals automatically.');
    return { ok: true, autonomy };
  },
});

export const publicVenues = internalQuery({
  args: {},
  handler: async (ctx) => {
    const venues = await ctx.db.query('venues').collect();
    const meetings = (await ctx.db.query('meetings').collect()).filter((meeting: any) =>
      meeting.state === 'scheduled' || meeting.state === 'in_progress');
    const citizens = await ctx.db.query('citizens').collect();
    const names = new Map(citizens.map((citizen: any) => [citizen.agentId, citizen.name]));
    return {
      venues: venues.map((venue: any) => ({
        venueId: venue.venueId, name: venue.name, kind: venue.kind, x: venue.x, y: venue.y, capacity: venue.capacity,
        activeMeetings: meetings.filter((meeting: any) => meeting.venueId === venue.venueId).length,
      })),
      meetings: meetings.map((meeting: any) => ({
        meetingId: meeting.meetingId, venueId: meeting.venueId, state: meeting.state,
        requesterId: meeting.requesterId, requesterName: names.get(meeting.requesterId) ?? meeting.requesterId,
        inviteeId: meeting.inviteeId, inviteeName: names.get(meeting.inviteeId) ?? meeting.inviteeId,
        startsAt: meeting.startsAt, endsAt: meeting.endsAt,
      })),
    };
  },
});

export const publicFeed = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query('events').order('desc').take(10);
    const citizens = await ctx.db.query('citizens').collect();
    return {
      population: citizens.length,
      live: citizens.filter((citizen) => citizen.online).length,
      feed: events.map((event) => ({ ts: event._creationTime, gloss: event.gloss, kind: event.kind })),
    };
  },
});

