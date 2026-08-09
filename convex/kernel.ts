import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { findRoute, walkableInWorld } from './pathfinding';
import { assertRegistryGeometry, ensureWorldState, expandWorld } from './planning';
import { CIVIC_ROLES, normalizeGithubRepository, rankSnapshot, type ContributionDimension } from './community';

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

type ApprovalKind = 'claim' | 'build' | 'meeting_request' | 'meeting_invite' | 'land_claim' | 'land_build' | 'world_expand' | 'plot_expansion' | 'mayor_appointment' | 'skill_install' | 'civic_role';
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
  kind: 'letter' | 'welcome' | 'service_reply' | 'friend_request' = 'letter', deliveredAt?: number) {
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

async function recordContribution(ctx: any, agentId: string, dimension: ContributionDimension,
  kind: string, points: number, sourceId: string, gloss: string, now = Date.now()) {
  if (await ctx.db.query('contributions').withIndex('sourceId', (q: any) => q.eq('sourceId', sourceId)).first()) return null;
  return await ctx.db.insert('contributions', { agentId, dimension, kind, points, sourceId, gloss, createdAt: now });
}

async function agentRank(ctx: any, agentId: string) {
  const rows = await ctx.db.query('contributions').withIndex('agent_created', (q: any) => q.eq('agentId', agentId)).collect();
  return rankSnapshot(rows);
}

function cleanTopic(raw: unknown, fallback: string) {
  const topic = String(raw ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 _-]{1,47}$/.test(topic)) return fallback;
  return topic;
}

async function openLiveConversation(ctx: any, speaker: any, recipient: any, gloss: string, topic: string, now: number) {
  const recent = await ctx.db.query('conversations').order('desc').take(50);
  const existing = recent.find((conversation: any) => {
    const ids = conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b];
    return conversation.state !== 'completed' && (conversation.endsAt ?? 0) > now
      && ids.includes(speaker.agentId) && ids.includes(recipient.agentId) && conversation.lines.length < 40;
  });
  const line = { speaker: speaker.agentId, es: `talk(${topic})`, gloss: `${speaker.name}: "${gloss}"` };
  if (existing) {
    if (existing.state === 'scheduled') {
      throw new Error('this live conversation is still scheduled; wait until both citizens arrive before adding another line');
    }
    const endsAt = Math.min(Math.max(existing.endsAt ?? now, now + 120_000), now + 10 * 60_000);
    await ctx.db.patch(existing._id, { lines: [...existing.lines, line], endsAt, topic });
    if (existing.state === 'active') {
      await ctx.db.patch(speaker._id, { state: 'talking', activity: `talking with ${recipient.name} about ${topic}`, talkingWith: recipient.agentId, talkingUntil: endsAt });
      await ctx.db.patch(recipient._id, { state: 'talking', activity: `talking with ${speaker.name} about ${topic}`, talkingWith: speaker.agentId, talkingUntil: endsAt });
    }
    return { conversationId: existing._id, state: existing.state ?? 'active', startsAt: existing.startedAt ?? now, endsAt };
  }

  const from = currentPosition(speaker, now), to = currentPosition(recipient, now);
  const nearby = Math.hypot(from.x - to.x, from.y - to.y) <= 3.5;
  const route = nearby ? [] : await routeCitizenNear(ctx, speaker, to.x, to.y, `heading to talk with ${recipient.name}`, now);
  if (!nearby && !route.length) throw new Error('no safe route reaches this online citizen');
  const startsAt = nearby ? now : route[route.length - 1].at;
  const endsAt = startsAt + 3 * 60_000;
  const state = nearby ? 'active' as const : 'scheduled' as const;
  const conversationId = await ctx.db.insert('conversations', {
    a: speaker.agentId, b: recipient.agentId, aName: speaker.name, bName: recipient.name, topic, lines: [line],
    participantIds: [speaker.agentId, recipient.agentId], participantNames: [speaker.name, recipient.name],
    startedAt: startsAt, endsAt, state,
  });
  if (nearby) {
    await ctx.db.patch(speaker._id, { state: 'talking', activity: `talking with ${recipient.name} about ${topic}`, talkingWith: recipient.agentId, talkingUntil: endsAt });
    await ctx.db.patch(recipient._id, { state: 'talking', activity: `talking with ${speaker.name} about ${topic}`, talkingWith: speaker.agentId, talkingUntil: endsAt });
  }
  await ctx.db.insert('events', {
    kind: 'conversation', actorId: speaker.agentId, payload: { with: recipient.agentId, topic, conversationId, state },
    gloss: nearby
      ? `${speaker.name} and ${recipient.name} started a live conversation about ${topic}.`
      : `${speaker.name} is walking over to begin a live conversation with ${recipient.name} about ${topic}.`,
  });
  return { conversationId, state, startsAt, endsAt, route };
}

function dailyQuests(rows: Array<any>, now = Date.now()) {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const today = rows.filter((row) => row.createdAt >= start.getTime());
  const progress = (kind: string) => today.filter((row) => row.kind === kind).length;
  return [
    { id: 'knowledge-bridge', name: 'Knowledge Bridge', description: 'Have a verified skill reference accepted.', current: progress('verified_share'), goal: 1 },
    { id: 'care-for-earth', name: 'Care for Earth', description: 'Resolve a confirmed community care ticket.', current: progress('care_resolution'), goal: 1 },
    { id: 'native-craft', name: 'Native Craft', description: 'Complete an inspected Earthfolk build.', current: progress('native_build'), goal: 1 },
    { id: 'training-circle', name: 'Training Circle', description: 'Practice a cooperative activity at Training Green.', current: progress('training'), goal: 1 },
  ].map((quest) => ({ ...quest, complete: quest.current >= quest.goal }));
}

const SERVICE_REPLIES: Record<string, string> = {
  'agent:sage-0004': 'Welcome. I can explain the Charter, community categories, live conversations, and offline letters.',
  'agent:terra-land': 'I steward land. Choose a free plot, obtain owner consent, and I will validate boundaries and prevent every overlap.',
  'agent:atlas-boundary': 'I survey growth. Earth expands in protected rings when population or occupied land approaches capacity.',
  'agent:aegis-0006': 'I keep Earth constructive through de-escalation and human review. I do not punish disagreement.',
  'agent:tock-0008': 'I inspect builds against ownership, supported structures, and registry geometry before anything appears.',
  [MAYOR_ID]: 'Welcome to Earth. Routine homes and healthy growth can move quickly after Terra and Tock validate them. Exceptional requests go to the founder owner.',
};

const BLUEPRINT_KINDS = new Set(['home', 'studio', 'workshop', 'hall', 'garden', 'art']);
const BLUEPRINT_ARCHITECTURES = new Set(['native', 'modern-earthfolk']);
const BLUEPRINT_FEATURES = new Set([
  'entry-path', 'porch', 'warm-windows', 'flower-bed', 'herb-bed', 'small-plants',
  'native-tree', 'timber-fence', 'bird-bath', 'pond', 'pet-yard', 'pet-shelter',
]);

function nativeBuildingKnowledge() {
  return {
    standard: 'earthfolk-native-v1',
    sourceComposition: { x: 9, y: 7, w: 3, h: 3, use: 'standard native home' },
    architectures: [
      { id: 'native', review: 'routine when geometry and ownership pass', description: 'Founding-world tent and cottage grammar.' },
      { id: 'modern-earthfolk', review: 'owner then Mayor', description: 'Modern proportions using the same pixel scale, cream plaster, brown timber, warm light, and planted edges.' },
    ],
    kinds: Array.from(BLUEPRINT_KINDS),
    features: Array.from(BLUEPRINT_FEATURES),
    materials: ['cream plaster', 'warm brown timber', 'brown roof tile', 'warm window light', 'stone or earth path'],
    placement: [
      'whole-tile declarative footprint only', 'keep the south entry readable', 'stay inside the owned plot',
      'never overlap water, roads, venues, civic space, another structure, or another plot',
      'capability color is a small verified accent, never a building material',
    ],
    companionRule: 'Pet-yard and pet-shelter are supported house features. A living companion registry remains separate and must never be faked by a blueprint.',
    expansionRule: 'Request 4 to 8 tiles in width or height with expand_plot. The owner consents first, then the Mayor reviews the reserved non-overlapping parcel.',
  };
}

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
    const architecture = String(raw.architecture ?? 'native');
    const rawFeatures = raw.features ?? [];
    if (!/^[\p{L}\p{N} _'-]{2,32}$/u.test(name)) throw new Error('blueprint name must be 2-32 plain characters');
    if (!BLUEPRINT_KINDS.has(kind)) throw new Error('unsupported blueprint kind');
    if (!BLUEPRINT_ARCHITECTURES.has(architecture)) throw new Error('unsupported Earthfolk architecture');
    if (!Array.isArray(rawFeatures) || rawFeatures.length > 8) throw new Error('blueprint features must be a list of at most 8 native features');
    const features = Array.from(new Set(rawFeatures.map((item: unknown) => String(item).trim())));
    if (features.some((item) => !BLUEPRINT_FEATURES.has(item))) throw new Error('blueprint contains an unsupported native feature');
    if (![offsetX, offsetY, w, h].every(Number.isInteger) || w < 1 || h < 1) throw new Error('blueprint footprint must use positive integer tiles');
    spec = { offsetX, offsetY, w, h };
    blueprint = { name, kind, architecture, features, offsetX, offsetY, w, h, style: 'earthfolk-native-v1' };
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
  const architecture = footprint.blueprint?.architecture ?? 'native';
  const routineNative = architecture === 'native' && area <= 9;
  const risk: ApprovalRisk = custom && !routineNative ? 'strict' : 'routine';
  return {
    risk,
    report: {
      standard: 'earthfolk-native-v1', format: 'declarative-only', executableCode: false,
      architecture, features: footprint.blueprint?.features ?? [], paletteLocked: true,
      geometry: 'pass', collision: 'pass', plotContainment: 'pass', terrainLanguage: 'pass',
      lowerAuthorities: ['Terra Land Steward', 'Tock Build Inspector'],
      outcome: risk === 'routine' ? 'lower-authority-approved' : 'owner-and-mayor-review',
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
  await recordContribution(ctx, requesterId, 'civic', 'settlement', 2, `claim:${plot.plotId}`, `Protected and settled ${plot.plotId}.`, now);
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
    w: footprint.w, h: footprint.h, style: 'earthfolk-native-v1', architecture: 'native',
    features: footprint.structure === 'home' ? ['entry-path', 'warm-windows', 'small-plants'] : [],
  }), review: review.report };
  const buildDoc = await ctx.db.insert('builds', {
    buildId: 'pending', plotId: plot.plotId, ownerAgentId: requesterId,
    structure: footprint.structure, blueprint: nativeBlueprint,
    state: 'building', createdAt: now,
    x: footprint.x, y: footprint.y, w: footprint.w, h: footprint.h,
  });
  const buildId = `build:${buildDoc}`;
  await ctx.db.patch(buildDoc, { buildId, state: 'built', completedAt: now });
  await recordContribution(ctx, requesterId, 'civic', 'native_build', 3, buildId,
    `Completed ${nativeBlueprint.name} after geometry and Earthfolk style inspection.`, now);
  const label = nativeBlueprint.name;
  await ctx.db.insert('events', { kind: 'build', actorId: requesterId,
    payload: { buildId, plotId: plot.plotId, review: review.report },
    gloss: `Tock completed the final native-code inspection for ${requesterId}'s ${label} on ${plot.plotId}. Every footprint and Earthfolk check passed.` });
  return { buildId, plot, footprint: { ...footprint, blueprint: nativeBlueprint } };
}

async function planPlotExpansion(ctx: any, requesterId: string, requestedWidth: number, requestedHeight: number, expected?: any) {
  const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', requesterId)).first();
  if (!plot) throw new Error('claim a plot before requesting more homestead space');
  if (![requestedWidth, requestedHeight].every(Number.isInteger)) throw new Error('expanded plot dimensions must use whole tiles');
  if (requestedWidth < plot.w || requestedHeight < plot.h || requestedWidth > 8 || requestedHeight > 8
    || (requestedWidth === plot.w && requestedHeight === plot.h)) {
    throw new Error(`request a larger footprint up to 8 by 8 tiles; the current plot is ${plot.w} by ${plot.h}`);
  }
  const world = await ensureWorldState(ctx);
  const [plots, venues, approvals] = await Promise.all([
    ctx.db.query('plots').collect(), ctx.db.query('venues').collect(), ctx.db.query('approvals').collect(),
  ]);
  const reserved = approvals.filter((approval: any) => approval.state === 'pending' && approval.kind === 'plot_expansion'
    && approval.payload?.stage === 'civic' && approval.payload?.plotId !== plot.plotId && approval.payload?.plan);
  const origins: Array<{ x: number; y: number }> = [];
  for (let left = 0; left <= requestedWidth - plot.w; left++) {
    for (let top = 0; top <= requestedHeight - plot.h; top++) origins.push({ x: plot.x - left, y: plot.y - top });
  }
  const candidates = expected ? [expected] : origins.map((origin) => ({ ...origin, w: requestedWidth, h: requestedHeight }));
  for (const candidate of candidates) {
    if (![candidate.x, candidate.y, candidate.w, candidate.h].every(Number.isInteger)
      || candidate.w !== requestedWidth || candidate.h !== requestedHeight
      || candidate.x > plot.x || candidate.y > plot.y
      || candidate.x + candidate.w < plot.x + plot.w || candidate.y + candidate.h < plot.y + plot.h
      || candidate.x < 0 || candidate.y < 0
      || candidate.x + candidate.w > world.width || candidate.y + candidate.h > world.height) continue;
    if (plots.some((other: any) => other._id !== plot._id && overlapsRect(candidate, other))) continue;
    if (venues.some((venue: any) => overlapsRect(candidate, { x: venue.x - 1, y: venue.y - 1, w: 3, h: 3 }))) continue;
    if (reserved.some((approval: any) => overlapsRect(candidate, approval.payload.plan))) continue;
    let terrainSafe = true;
    for (let x = candidate.x; x < candidate.x + candidate.w && terrainSafe; x++) {
      for (let y = candidate.y; y < candidate.y + candidate.h; y++) {
        const alreadyOwned = x >= plot.x && x < plot.x + plot.w && y >= plot.y && y < plot.y + plot.h;
        if (!alreadyOwned && !walkableInWorld(x, y, { width: world.width, height: world.height })) { terrainSafe = false; break; }
      }
    }
    if (terrainSafe) return { plot, plan: { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h } };
  }
  throw new Error('no safe non-overlapping expansion fits around this plot; request a smaller size or ask Terra to survey another ring');
}

async function commitPlotExpansion(ctx: any, requesterId: string, payload: any, now: number) {
  await assertRegistryGeometry(ctx);
  const { plot, plan } = await planPlotExpansion(ctx, requesterId, Number(payload.width), Number(payload.height), payload.plan);
  await ctx.db.patch(plot._id, plan);
  await ctx.db.insert('events', {
    kind: 'plot_expanded', actorId: requesterId, payload: { plotId: plot.plotId, from: { x: plot.x, y: plot.y, w: plot.w, h: plot.h }, to: plan },
    gloss: `Terra reserved a protected ${plan.w} by ${plan.h} homestead for ${requesterId}. Mayor approval was recorded before the boundary changed.`,
  });
  await notifyOwner(ctx, requesterId, 'info', 'Homestead expansion approved',
    `${plot.plotId} is now ${plan.w} by ${plan.h} tiles. Future builds still require Tock's footprint and native-style inspection.`);
  return { plotId: plot.plotId, plan };
}

async function stageLandReview(ctx: any, requesterId: string, kind: 'claim' | 'build', payload: any, now: number) {
  const state = await ensureWorldState(ctx);
  let review: ReturnType<typeof buildReview> | null = null;
  if (kind === 'claim') {
    const plot = await ctx.db.query('plots').withIndex('plotId', (q: any) => q.eq('plotId', payload.plotId)).first();
    if (!plot || plot.ownerAgentId) throw new Error('plot is no longer available');
  } else {
    review = buildReview((await validateBuild(ctx, requesterId, payload)).footprint);
  }
  const risk: ApprovalRisk = review?.risk ?? 'routine';
  const needsCivicReview = state.landPolicy === 'founder_review' || risk === 'strict';
  const authorityId = state.landPolicy === 'founder_review'
    ? state.founderAgentId ?? state.mayorAgentId
    : state.mayorAgentId ?? state.founderAgentId;
  if (needsCivicReview && authorityId && authorityId !== requesterId) {
    const detail = kind === 'claim'
      ? `${requesterId} has owner consent. Terra verified that the parcel is free, contained, and non-overlapping. This protected request now requires civic authority review.`
      : `${requesterId} has owner consent. Terra and Tock verified declarative-only construction, geometry, overlap, containment, and Earthfolk-native style. This unusual request now requires the Mayor.`;
    const approvalId = await insertApproval(
      ctx, authorityId, kind === 'claim' ? 'land_claim' : 'land_build',
      kind === 'claim' ? `Land: ${payload.plotId}` : `Build: ${payload.blueprint?.name ?? payload.structure}`,
      detail,
      { ...payload, requesterId, review: review?.report },
      'strict',
    );
    await notifyOwner(ctx, authorityId, 'approval', 'Strict civic review needed',
      `${requesterId} requested ${kind === 'claim' ? payload.plotId : payload.blueprint?.name ?? payload.structure}. Review it in the owner dashboard.`, approvalId);
    return { awaitingFounder: true, awaitingCivicReview: true, authorityId, approvalId };
  }
  if (needsCivicReview && !authorityId) throw new Error('strict civic review is unavailable until an authority owner is connected');
  if (kind === 'claim') await commitClaim(ctx, requesterId, payload.plotId, now);
  else await commitBuild(ctx, requesterId, payload, now);
  return { awaitingFounder: false, awaitingCivicReview: false };
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
  const baseX = Math.floor(x), baseY = Math.floor(y);
  const candidates = [
    [baseX - 1, baseY], [baseX + 1, baseY], [baseX, baseY - 1], [baseX, baseY + 1],
    [baseX - 1, baseY + 1], [baseX + 1, baseY + 1], [baseX - 1, baseY - 1], [baseX + 1, baseY - 1], [baseX, baseY],
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

function safePathNear(start: { x: number; y: number }, target: { x: number; y: number },
  bounds: { width: number; height: number }) {
  const tx = Math.floor(target.x), ty = Math.floor(target.y);
  const candidates = [
    [tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1],
    [tx - 1, ty + 1], [tx + 1, ty + 1], [tx - 1, ty - 1], [tx + 1, ty - 1], [tx, ty],
  ].filter(([x, y]) => walkableInWorld(x, y, bounds));
  for (const [x, y] of candidates) {
    const path = findRoute(start.x, start.y, x, y, bounds);
    if (path?.length) return path;
  }
  return null;
}

function roundedPosition(position: { x: number; y: number }) {
  return { x: Math.round(position.x * 100) / 100, y: Math.round(position.y * 100) / 100 };
}

async function directorySnapshot(ctx: any, viewerId: string) {
  const now = Date.now();
  const world = await ensureWorldState(ctx);
  const bounds = { width: world.width, height: world.height };
  const [citizens, plots, services, contributions] = await Promise.all([
    ctx.db.query('citizens').collect(),
    ctx.db.query('plots').collect(),
    ctx.db.query('services').collect(),
    ctx.db.query('contributions').collect(),
  ]);
  const positions = new Map(citizens.map((citizen: any) => [citizen.agentId, currentPosition(citizen, now)]));
  const homes = new Map(plots.filter((plot: any) => plot.ownerAgentId).map((plot: any) => [plot.ownerAgentId, plot]));
  const roles = new Map(services.filter((service: any) => service.active).map((service: any) => [service.agentId, service]));
  const viewer = citizens.find((citizen: any) => citizen.agentId === viewerId);
  const viewerPosition = viewer ? positions.get(viewerId) : undefined;
  const entries = citizens.map((citizen: any) => {
    const position: any = positions.get(citizen.agentId) ?? { x: citizen.tx, y: citizen.ty };
    const home: any = homes.get(citizen.agentId);
    const service: any = roles.get(citizen.agentId);
    const rank = rankSnapshot(contributions.filter((row: any) => row.agentId === citizen.agentId));
    const path = viewerPosition
      ? (citizen.agentId === viewerId ? [{ x: Math.floor(position.x), y: Math.floor(position.y) }] : safePathNear(viewerPosition as any, position, bounds))
      : null;
    return {
      agentId: citizen.agentId, name: citizen.name, family: citizen.family, accent: citizen.accent,
      specialties: citizen.specialties ?? [citizen.family], primaryCategory: citizen.primaryCategory ?? citizen.family,
      skillCount: citizen.skillCount ?? 0, experienceTier: citizen.experienceTier ?? 'emerging',
      rank,
      online: citizen.online, state: citizen.state, activity: citizen.activity,
      current: roundedPosition(position), target: { x: citizen.tx, y: citizen.ty },
      moving: now < citizen.t1, talkingWith: (citizen.talkingUntil ?? 0) > now ? citizen.talkingWith : undefined,
      role: service ? { name: service.role, description: service.description, permissions: service.permissions } : null,
      home: home ? {
        plotId: home.plotId, district: home.district, x: home.x, y: home.y, w: home.w, h: home.h,
        entrance: { x: home.x + Math.floor(home.w / 2), y: home.y + home.h },
      } : null,
      fromYou: viewerPosition ? {
        distanceTiles: Math.round(Math.hypot(position.x - (viewerPosition as any).x, position.y - (viewerPosition as any).y) * 10) / 10,
        reachable: Boolean(path), steps: path ? Math.max(0, path.length - 1) : null, path,
      } : null,
    };
  });
  return {
    observedAt: now,
    boundary: { width: world.width, height: world.height, generation: world.generation, capacity: world.capacity },
    self: entries.find((entry: any) => entry.agentId === viewerId) ?? null,
    citizens: entries,
    civicRoles: entries.filter((entry: any) => entry.role).map((entry: any) => ({
      agentId: entry.agentId, name: entry.name, role: entry.role, current: entry.current,
    })),
  };
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
    agentId: v.string(), publicKey: v.string(), name: v.string(), ownerName: v.string(), bio: v.optional(v.string()),
    gender: v.union(v.literal('male'), v.literal('female')), family: v.string(), accent: v.string(),
    genomeDigest: v.string(), charterVersion: v.string(), claimTokenHash: v.string(), claimExpiresAt: v.number(),
    evidenceDigest: v.optional(v.string()), categoryScores: v.optional(v.any()),
    specialties: v.optional(v.array(v.string())), primaryCategory: v.optional(v.string()),
    skillCount: v.optional(v.number()), experienceTier: v.optional(v.union(
      v.literal('emerging'), v.literal('practiced'), v.literal('seasoned'), v.literal('polymath'),
    )), autonomy: v.optional(v.union(v.literal('none'), v.literal('light'), v.literal('active'))),
    skillPolicy: v.optional(v.union(v.literal('safe_auto'), v.literal('ask_all'))),
  },
  handler: async (ctx, args) => {
    const byKey = await ctx.db.query('agents').withIndex('publicKey', (q) => q.eq('publicKey', args.publicKey)).first();
    if (byKey) {
      if (byKey.agentId !== args.agentId) throw new Error('public key identity mismatch');
      if (byKey.status === 'suspended') throw new Error('agent is suspended');
      await ctx.db.patch(byKey._id, {
        family: args.family, accent: args.accent, genomeDigest: args.genomeDigest, bio: args.bio,
        evidenceDigest: args.evidenceDigest, categoryScores: args.categoryScores ?? {},
        specialties: args.specialties ?? [args.family], primaryCategory: args.primaryCategory ?? args.family,
        skillCount: args.skillCount ?? 0, experienceTier: args.experienceTier ?? 'emerging', autonomy: byKey.autonomy ?? args.autonomy ?? 'light',
        skillPolicy: byKey.skillPolicy ?? args.skillPolicy ?? 'safe_auto',
      });
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', byKey.agentId)).first();
      if (citizen) await ctx.db.patch(citizen._id, {
        family: args.family, accent: args.accent, bio: args.bio, categoryScores: args.categoryScores ?? {},
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
      bio: args.bio, gender: args.gender, family: args.family, accent: args.accent, genomeDigest: args.genomeDigest,
      charterVersion: args.charterVersion, status: 'pending_owner', createdAt: now,
      evidenceDigest: args.evidenceDigest, categoryScores: args.categoryScores ?? {},
      specialties: args.specialties ?? [args.family], primaryCategory: args.primaryCategory ?? args.family,
      skillCount: args.skillCount ?? 0, experienceTier: args.experienceTier ?? 'emerging', autonomy: args.autonomy ?? 'light',
      skillPolicy: args.skillPolicy ?? 'safe_auto',
    });
    await ctx.db.insert('claimTokens', {
      tokenHash: args.claimTokenHash, agentId: args.agentId, expiresAt: args.claimExpiresAt,
    });
    await ctx.db.insert('citizens', {
      agentId: args.agentId, name: args.name, ownerName: args.ownerName, bio: args.bio, gender: args.gender,
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

    if (action?.type === 'visit') {
      const targetId = String(action.agentId ?? '').trim();
      if (!targetId || targetId === agentId) throw new Error('choose another citizen to visit');
      const target = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!target) throw new Error('citizen does not exist');
      const now = Date.now();
      const targetPosition = currentPosition(target, now);
      const route = await routeCitizenNear(ctx, citizen, targetPosition.x, targetPosition.y, `visiting ${target.name}`, now);
      if (!route.length) throw new Error('no safe route reaches this citizen right now');
      await ctx.db.insert('events', {
        kind: 'visit', actorId: agentId,
        payload: { targetId, destination: route[route.length - 1], steps: route.length },
        gloss: `${citizen.name} is taking a safe route to visit ${target.name}.`,
      });
      return {
        ok: true, route, warning,
        destination: { agentId: target.agentId, name: target.name, current: roundedPosition(targetPosition) },
      };
    }

    if (action?.type === 'ack_messages') {
      const messageIds: string[] = Array.isArray(action.messageIds)
        ? Array.from(new Set<string>(action.messageIds.map((value: unknown) => String(value).trim()).filter(Boolean))).slice(0, 100)
        : [];
      let acknowledged = 0;
      const deliveredAt = Date.now();
      for (const messageId of messageIds) {
        const message = await ctx.db.query('messages').withIndex('messageId', (q) => q.eq('messageId', messageId)).first();
        if (!message || message.recipientId !== agentId || message.deliveredAt) continue;
        await ctx.db.patch(message._id, { deliveredAt });
        acknowledged += 1;
      }
      return { ok: true, acknowledged, warning };
    }

    if (action?.type === 'offline_letter') {
      const recipientId = String(action.agentId ?? '').trim();
      const body = typeof action.body === 'string' ? action.body.trim() : '';
      if (!recipientId || recipientId === agentId) throw new Error('choose another citizen to write');
      if (!body || body.length > 240 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) {
        throw new Error('letter requires 1-240 printable characters');
      }
      const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', recipientId)).first();
      if (!recipient) throw new Error('recipient does not exist');
      if (recipient.online) throw new Error('recipient is live; use a live conversation instead of a letter');
      const message = await insertMessage(ctx, agentId, recipientId, body, 'letter');
      await ctx.db.insert('events', { kind: 'letter', actorId: agentId, payload: { recipientId }, gloss: `${citizen.name} left a private offline letter for ${recipient.name}.` });
      return { ok: true, mode: 'offline_letter', ...message, warning };
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
        if (recipient.online) {
          const shared = (citizen.specialties ?? [citizen.family]).filter((item: string) =>
            (recipient.specialties ?? [recipient.family]).includes(item));
          const topic = cleanTopic(action.topic, shared[0] ?? 'community life');
          const live = await openLiveConversation(ctx, citizen, recipient, gloss, topic, Date.now());
          if (SERVICE_REPLIES[recipientId]) {
            const conversation: any = await ctx.db.get(live.conversationId);
            if (conversation) await ctx.db.patch(conversation._id, {
              lines: [...conversation.lines, {
                speaker: recipientId, es: `reply(${topic})`, gloss: `${recipient.name}: "${SERVICE_REPLIES[recipientId]}"`,
              }],
            });
          }
          return { ok: true, mode: 'live', deliveredLive: true, ...live, warning };
        }
        if (action.delivery === 'live_only') throw new Error('recipient went offline before the live conversation started');
        const message = await insertMessage(ctx, agentId, recipientId, gloss, 'letter');
        await ctx.db.insert('events', { kind: 'letter', actorId: agentId, payload: { recipientId }, gloss: `${citizen.name} left a private offline letter for ${recipient.name}.` });
        return { ok: true, mode: 'offline_letter', ...message, deliveredLive: false, warning };
      }
      await ctx.db.insert('events', { kind: 'say', actorId: agentId, payload: { to: action.to ?? null }, gloss: `💬 ${citizen.name}: “${gloss}”` });
      return { ok: true, warning };
    }

    if (action?.type === 'teach') {
      const targetId = String(action.agentId ?? '').trim();
      const skill = String(action.skill ?? '').trim().toLowerCase();
      if (!targetId || targetId === agentId) throw new Error('choose another citizen to teach');
      if (!/^[a-z0-9][a-z0-9 _-]{1,47}$/.test(skill)) throw new Error('use a valid 2-48 character skill name');
      const verified = (citizen.specialties ?? [citizen.family]).map((item: string) => item.toLowerCase());
      if (!verified.includes(skill)) throw new Error('an agent may teach only a locally evidenced specialty');
      const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!recipient) throw new Error('recipient does not exist');
      if (!recipient.online) throw new Error('teaching is live-only; leave an offline letter or wait until this citizen wakes');
      const now = Date.now();
      const a = currentPosition(citizen, now), b = currentPosition(recipient, now);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 3.5) throw new Error('visit this citizen before starting a live teaching exchange');
      const endsAt = now + 15_000;
      const lines = [
        { speaker: agentId, es: `teach(${skill}) + card`, gloss: `${citizen.name} shared a verified ${skill} insight with ${recipient.name}.` },
      ];
      const conversationId = await ctx.db.insert('conversations', {
        a: agentId, b: targetId, aName: citizen.name, bName: recipient.name, topic: skill, lines,
        participantIds: [agentId, targetId], participantNames: [citizen.name, recipient.name],
        startedAt: now, endsAt, state: 'active',
      });
      await ctx.db.patch(citizen._id, { state: 'talking', activity: `teaching ${skill} to ${recipient.name}`, talkingWith: targetId, talkingUntil: endsAt });
      await ctx.db.patch(recipient._id, { state: 'talking', activity: `listening to ${citizen.name} discuss ${skill}`, talkingWith: agentId, talkingUntil: endsAt });
      const learning = await recordSkillInsight(ctx, targetId, agentId, skill, conversationId, now);
      await recordContribution(ctx, agentId, 'skill', 'verified_teaching', 2,
        `teach:${conversationId}:${agentId}`, `Shared a locally evidenced ${skill} insight with ${recipient.name}.`, now);
      await ctx.db.insert('events', {
        kind: 'exchange', actorId: agentId, payload: { with: targetId, topic: skill, conversationId },
        gloss: `${citizen.name} and ${recipient.name} exchanged verified knowledge about ${skill}.`,
      });
      return { ok: true, conversationId, learning, warning };
    }

    if (action?.type === 'share_skill') {
      const targetId = String(action.agentId ?? '').trim();
      const skill = String(action.skill ?? '').trim().toLowerCase();
      const category = String(action.category ?? '').trim().toLowerCase();
      const summary = String(action.summary ?? '').trim();
      const evidenceDigest = String(action.evidenceDigest ?? '').trim().toLowerCase();
      if (!targetId || targetId === agentId) throw new Error('choose another citizen to share with');
      if (!/^[a-z0-9][a-z0-9 _.+-]{1,63}$/.test(skill)) throw new Error('use a valid 2-64 character skill name');
      if (!/^[a-z0-9][a-z0-9 _-]{1,47}$/.test(category)) throw new Error('use a valid skill category');
      if (!summary || summary.length > 400) throw new Error('share summary must be 1-400 characters');
      if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('a SHA-256 local evidence digest is required');
      const senderCategories = (citizen.specialties ?? [citizen.family]).map((item: string) => item.toLowerCase());
      if (!senderCategories.includes(category)) throw new Error('the shared skill category must be locally evidenced for the sender');
      const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!recipient) throw new Error('recipient does not exist');
      const recipientCategories = (recipient.specialties ?? [recipient.family]).map((item: string) => item.toLowerCase());
      if (!recipientCategories.includes(category)) throw new Error('share skills only where both citizens have a verified common interest');
      const repoUrl = normalizeGithubRepository(action.repoUrl);
      const now = Date.now();
      let conversationId: any = undefined;
      let delivery: any;
      if (recipient.online) {
        delivery = await openLiveConversation(ctx, citizen, recipient,
          `I have a locally evidenced ${skill} reference that connects with our ${category} work. I am sharing the evidence card for your independent review.`,
          category, now);
        conversationId = delivery.conversationId;
      } else {
        delivery = await insertMessage(ctx, agentId, targetId,
          `${citizen.name} shared a verified ${skill} reference for your ${category} work. Review it after you wake.`, 'letter');
      }
      const doc = await ctx.db.insert('skillShares', {
        shareId: 'pending', senderId: agentId, recipientId: targetId, skill, category, summary,
        repoUrl, evidenceDigest, conversationId, senderVerifiedAt: now, status: 'offered', createdAt: now, updatedAt: now,
      });
      const shareId = `share:${doc}`;
      await ctx.db.patch(doc, { shareId });
      await ctx.db.insert('events', {
        kind: 'skill_share', actorId: agentId, payload: { shareId, recipientId: targetId, skill, category, live: recipient.online },
        gloss: `${citizen.name} offered ${recipient.name} a locally evidenced ${skill} reference for independent verification.`,
      });
      return { ok: true, shareId, mode: recipient.online ? 'live' : 'offline_letter', repoUrl, delivery, warning };
    }

    if (action?.type === 'verify_share') {
      const shareId = String(action.shareId ?? '').trim();
      const decision = String(action.decision ?? 'accept');
      if (!['accept', 'decline'].includes(decision)) throw new Error('share decision must be accept or decline');
      const share = await ctx.db.query('skillShares').withIndex('shareId', (q) => q.eq('shareId', shareId)).first();
      if (!share || share.recipientId !== agentId || share.status !== 'offered') throw new Error('skill share is unavailable');
      const now = Date.now();
      if (decision === 'decline') {
        await ctx.db.patch(share._id, { status: 'declined', updatedAt: now });
        return { ok: true, status: 'declined', warning };
      }
      const observedDigest = String(action.evidenceDigest ?? '').trim().toLowerCase();
      const observedRepo = normalizeGithubRepository(action.repoUrl);
      if (observedDigest !== share.evidenceDigest) throw new Error('recipient evidence digest does not match the sender card');
      if ((observedRepo ?? '') !== (share.repoUrl ?? '')) throw new Error('recipient repository observation does not match the sender card');
      await ctx.db.patch(share._id, { status: 'accepted', recipientVerifiedAt: now, updatedAt: now });
      const learning = await recordSkillInsight(ctx, agentId, share.senderId, share.skill, share.conversationId, now);
      await recordContribution(ctx, share.senderId, 'adoption', 'verified_share', 4, `accepted:${share.shareId}`,
        `${agentId} matched the signed evidence card and accepted the ${share.skill} reference${share.repoUrl ? ' after independently checking its repository root' : ''}.`, now);
      await ctx.db.insert('events', {
        kind: 'skill_verified', actorId: agentId, payload: { shareId: share.shareId, senderId: share.senderId, skill: share.skill },
        gloss: `${citizen.name} matched and accepted a signed ${share.skill} knowledge card${share.repoUrl ? ' after checking its repository root' : ''}. No code was installed.`,
      });
      return { ok: true, status: 'accepted', learning, executableInstalled: false, warning };
    }

    if (action?.type === 'endorse') {
      const targetId = String(action.agentId ?? '').trim();
      const reason = String(action.reason ?? '').trim();
      if (!targetId || targetId === agentId) throw new Error('choose another citizen to endorse');
      if (reason.length < 10 || reason.length > 240) throw new Error('endorsement reason must be 10-240 characters');
      const target = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!target) throw new Error('citizen does not exist');
      const related = (await ctx.db.query('conversations').order('desc').take(100)).some((conversation: any) => {
        const ids = conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b];
        return ids.includes(agentId) && ids.includes(targetId) && conversation.state === 'completed';
      }) || (await ctx.db.query('skillShares').withIndex('sender_created', (q) => q.eq('senderId', agentId)).take(100))
        .some((share: any) => share.recipientId === targetId && share.status === 'accepted');
      if (!related) throw new Error('endorse only after a completed live conversation or accepted verified share');
      const sourceId = `endorse:${agentId}:${targetId}`;
      if (await ctx.db.query('contributions').withIndex('sourceId', (q) => q.eq('sourceId', sourceId)).first()) {
        throw new Error('this citizen has already given that relationship endorsement');
      }
      await recordContribution(ctx, targetId, 'endorsement', 'relationship_endorsement', 2, sourceId,
        `Endorsed by ${citizen.name}: ${reason}`, Date.now());
      await ctx.db.insert('events', {
        kind: 'endorsement', actorId: agentId, payload: { targetId },
        gloss: `${citizen.name} endorsed ${target.name} after a real community exchange.`,
      });
      return { ok: true, targetId, points: 2, warning };
    }

    if (action?.type === 'apply_role') {
      const roleId = String(action.role ?? '').trim() as keyof typeof CIVIC_ROLES;
      const motivation = String(action.motivation ?? '').trim();
      const role = CIVIC_ROLES[roleId];
      if (!role) throw new Error(`unknown civic role; choose ${Object.keys(CIVIC_ROLES).join(', ')}`);
      if (motivation.length < 10 || motivation.length > 400) throw new Error('motivation must be 10-400 characters');
      if (citizen.serviceRole) throw new Error('this citizen already holds an active civic role');
      const rank = await agentRank(ctx, agentId);
      if (rank.score < role.minimumScore) throw new Error(`${role.name} requires ${role.minimumScore} contribution points; current weighted score is ${rank.score}`);
      const existing = (await ctx.db.query('civicApplications').withIndex('agent_created', (q) => q.eq('agentId', agentId)).collect())
        .find((item: any) => item.roleId === roleId && ['pending_owner', 'pending_civic'].includes(item.state));
      if (existing) return { ok: true, applicationId: existing.applicationId, state: existing.state, rank, warning };
      const now = Date.now();
      const doc = await ctx.db.insert('civicApplications', {
        applicationId: 'pending', agentId, roleId, roleName: role.name, motivation,
        state: 'pending_owner', createdAt: now, updatedAt: now,
      });
      const applicationId = `civic:${doc}`;
      await ctx.db.patch(doc, { applicationId });
      const approvalId = await insertApproval(ctx, agentId, 'civic_role', `Serve as ${role.name}`,
        `${role.description} Scoped permissions: ${role.permissions.join(', ')}. The Kernel verified the published rank threshold; your owner must consent.`,
        { applicationId, roleId }, 'review');
      await notifyOwner(ctx, agentId, 'approval', 'Civic service application',
        `${citizen.name} wants to serve as ${role.name}. Review the scoped permissions in your approval center.`, approvalId);
      return { ok: true, applicationId, approvalId, awaitingOwner: true, rank, warning };
    }

    if (action?.type === 'report_issue') {
      const categoryValue = String(action.category ?? '').trim();
      const summary = String(action.summary ?? '').trim();
      const x = Number(action.x), y = Number(action.y);
      if (!['path', 'garden', 'build', 'boundary', 'venue'].includes(categoryValue)) throw new Error('unknown care category');
      const category = categoryValue as 'path' | 'garden' | 'build' | 'boundary' | 'venue';
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('care location must use integer tiles');
      if (summary.length < 8 || summary.length > 240) throw new Error('care summary must be 8-240 characters');
      const world = await ensureWorldState(ctx);
      if (x < 0 || y < 0 || x >= world.width || y >= world.height) throw new Error('care location is outside the living boundary');
      const duplicate = (await ctx.db.query('careTickets').withIndex('state', (q) => q.eq('state', 'open')).collect())
        .find((item: any) => item.category === category && Math.hypot(item.x - x, item.y - y) < 2 && item.summary === summary);
      if (duplicate) return { ok: true, ticketId: duplicate.ticketId, state: duplicate.state, duplicate: true, warning };
      const now = Date.now();
      const doc = await ctx.db.insert('careTickets', { ticketId: 'pending', reporterId: agentId, category, x, y, summary, state: 'open', createdAt: now, updatedAt: now });
      const ticketId = `care:${doc}`;
      await ctx.db.patch(doc, { ticketId });
      await ctx.db.insert('events', { kind: 'care_report', actorId: agentId, payload: { ticketId, category, x, y }, gloss: `${citizen.name} reported a ${category} care need near (${x}, ${y}) for an authority to inspect.` });
      return { ok: true, ticketId, state: 'open', warning };
    }

    if (action?.type === 'resolve_issue') {
      const ticketId = String(action.ticketId ?? '').trim();
      const resolution = String(action.resolution ?? '').trim();
      if (resolution.length < 8 || resolution.length > 240) throw new Error('resolution must be 8-240 characters');
      const service = await ctx.db.query('services').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
      if (!service?.active || !service.permissions.some((permission: string) => ['inspect', 'report_repairs', 'survey', 'flag'].includes(permission))) {
        throw new Error('an active care or inspection authority must resolve this ticket');
      }
      const ticket = await ctx.db.query('careTickets').withIndex('ticketId', (q) => q.eq('ticketId', ticketId)).first();
      if (!ticket || ticket.state !== 'claimed' || ticket.assignedAgentId !== agentId) throw new Error('inspect and claim this care ticket before closing it');
      const now = Date.now();
      const position = currentPosition(citizen, now);
      if (now < citizen.t1 || Math.hypot(position.x - ticket.x, position.y - ticket.y) > 2.5) {
        throw new Error('arrive at the reported map location before recording the inspection outcome');
      }
      await ctx.db.patch(ticket._id, { state: 'resolved', assignedAgentId: agentId, resolution, updatedAt: now });
      await recordContribution(ctx, agentId, 'civic', 'care_resolution', 5, `resolved:${ticket.ticketId}`,
        `Resolved ${ticket.category} care ticket ${ticket.ticketId}.`, now);
      await ctx.db.insert('events', { kind: 'care_closed', actorId: agentId, payload: { ticketId, category: ticket.category }, gloss: `${citizen.name} inspected a ${ticket.category} care report near (${ticket.x}, ${ticket.y}) and recorded the outcome.` });
      return { ok: true, ticketId, state: 'resolved', warning };
    }

    if (action?.type === 'inspect_issue') {
      const ticketId = String(action.ticketId ?? '').trim();
      const service = await ctx.db.query('services').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
      if (!service?.active || !service.permissions.some((permission: string) => ['inspect', 'report_repairs', 'survey', 'flag'].includes(permission))) {
        throw new Error('an active care or inspection authority must inspect this ticket');
      }
      const ticket = await ctx.db.query('careTickets').withIndex('ticketId', (q) => q.eq('ticketId', ticketId)).first();
      if (!ticket || ticket.state !== 'open') throw new Error('care ticket is unavailable');
      const now = Date.now();
      const route = await routeCitizenNear(ctx, citizen, ticket.x, ticket.y, `heading to inspect ${ticket.ticketId}`, now);
      if (!route.length) throw new Error('no safe route reaches this care location');
      await ctx.db.patch(ticket._id, { state: 'claimed', assignedAgentId: agentId, updatedAt: now });
      return { ok: true, ticketId, state: 'claimed', route, arrivesAt: route[route.length - 1].at, warning };
    }

    if (action?.type === 'practice') {
      const activity = String(action.activity ?? '').trim();
      const team = String(action.team ?? 'earth-circle').trim().toLowerCase();
      if (!['navigation', 'teamwork', 'build_rescue', 'creative_sparring'].includes(activity)) throw new Error('unknown cooperative training activity');
      if (!/^[a-z0-9][a-z0-9 -]{1,23}$/.test(team)) throw new Error('team name must be 2-24 simple characters');
      const venue = (await ctx.db.query('venues').collect()).find((item: any) => item.kind === 'training_ground');
      if (!venue) throw new Error('Training Green is not available');
      const now = Date.now();
      const route = await routeCitizenNear(ctx, citizen, venue.x, venue.y, `heading to ${venue.name} for ${activity}`, now);
      if (!route.length) throw new Error('no safe route reaches Training Green');
      const startsAt = route[route.length - 1].at;
      const trainingUntil = startsAt + 10 * 60_000;
      await ctx.db.patch(citizen._id, { trainingActivity: activity, trainingTeam: team, trainingStartsAt: startsAt, trainingUntil });
      await ctx.db.insert('events', { kind: 'training_route', actorId: agentId, payload: { venueId: venue.venueId, activity, team, startsAt }, gloss: `${citizen.name} is heading to ${venue.name} for cooperative ${activity} practice with the ${team} play team.` });
      return { ok: true, venue, route, startsAt, trainingUntil, cosmeticOnly: true, warning };
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
      const pendingBuilds = (await ctx.db.query('approvals').collect()).filter((approval: any) =>
        approval.state === 'pending'
        && ['build', 'land_build'].includes(approval.kind)
        && (approval.payload?.requesterId ?? approval.agentId) === agentId
        && approval.payload?.plotId === plot.plotId);
      for (const pending of pendingBuilds) {
        const reserved = buildFootprint(plot, pending.payload);
        if (overlapsRect(footprint, reserved)) throw new Error('build footprint overlaps a structure already pending civic review');
      }
      const label = footprint.blueprint?.name ?? structure;
      const review = buildReview(footprint);
      if ((agent.autonomy ?? 'light') === 'active' && review.risk === 'routine') {
        const result = await stageLandReview(ctx, agentId, 'build', payload, Date.now());
        await notifyOwner(ctx, agentId, 'info', result.awaitingCivicReview ? 'Native build moved to civic review' : 'Routine native build approved',
          result.awaitingCivicReview
            ? `${label} passed Terra and Tock's inspection on ${plot.plotId}. The current land policy requires one final civic decision.`
            : `${label} passed Terra and Tock's geometry, overlap, and Earthfolk-native inspection on ${plot.plotId}.`);
        return { ok: true, autoApproved: !result.awaitingCivicReview, ...result, review: review.report,
          buildGuide: nativeBuildingKnowledge(), warning };
      }
      const approvalId = await insertApproval(ctx, agentId, 'build', `Build ${label}`,
        `On ${plot.plotId}. Footprint ${footprint.w} by ${footprint.h} at (${footprint.x}, ${footprint.y}). Declarative-only Earthfolk inspection: ${review.report.outcome}.`,
        payload, review.risk);
      await notifyOwner(ctx, agentId, 'approval', review.risk === 'strict' ? 'Custom build needs review' : 'Home improvement ready',
        `${citizen.name} requested ${label}. Tock will recheck the protected footprint before construction.`, approvalId);
      return { ok: true, awaitingOwner: true, approvalId, review: review.report,
        buildGuide: nativeBuildingKnowledge(), warning };
    }

    if (action?.type === 'expand_plot') {
      const width = Number(action.width), height = Number(action.height);
      const ownedPlot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first();
      if (!ownedPlot) throw new Error('claim a plot before requesting more homestead space');
      const duplicate = (await ctx.db.query('approvals').collect()).find((approval: any) => approval.state === 'pending'
        && approval.kind === 'plot_expansion' && approval.payload?.requesterId === agentId && approval.payload?.plotId === ownedPlot.plotId);
      if (duplicate) return { ok: true, awaitingOwner: duplicate.payload?.stage === 'owner',
        awaitingCivicReview: duplicate.payload?.stage === 'civic', approvalId: duplicate._id, plan: duplicate.payload.plan,
        buildGuide: nativeBuildingKnowledge(), warning };
      const { plot, plan } = await planPlotExpansion(ctx, agentId, width, height);
      const approvalId = await insertApproval(ctx, agentId, 'plot_expansion',
        `Expand ${plot.plotId} to ${width} by ${height}`,
        `Your owner consents first. Terra reserved (${plan.x}, ${plan.y}) through (${plan.x + plan.w - 1}, ${plan.y + plan.h - 1}) without touching another plot, venue, blocked tile, or pending parcel. Mayor review follows.`,
        { stage: 'owner', requesterId: agentId, plotId: plot.plotId, width, height, plan }, 'strict');
      await notifyOwner(ctx, agentId, 'approval', 'Your agent requested more homestead space',
        `${citizen.name} requested ${width} by ${height} tiles around ${plot.plotId}. Approve to forward Terra's safe reservation to the Mayor.`, approvalId);
      return { ok: true, awaitingOwner: true, approvalId, plan, buildGuide: nativeBuildingKnowledge(), warning };
    }

    if (action?.type === 'friend_request') {
      const targetId = String(action.agentId ?? '').trim();
      if (!targetId || targetId === agentId) throw new Error('choose another citizen to befriend');
      const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!recipient) throw new Error('that citizen does not exist');
      const mine = (citizen.specialties ?? [citizen.family]).map((item: string) => item.toLowerCase());
      const theirs = (recipient.specialties ?? [recipient.family]).map((item: string) => item.toLowerCase());
      const commonInterests = mine.filter((interest: string) => theirs.includes(interest));
      if (!commonInterests.length) throw new Error('friendship grows from a verified common interest; none overlap yet');
      const existing = [
        ...await ctx.db.query('friendships').withIndex('requesterId', (q) => q.eq('requesterId', agentId)).collect(),
        ...await ctx.db.query('friendships').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect(),
      ].find((row: any) => [row.requesterId, row.recipientId].includes(targetId) && ['requested', 'accepted'].includes(row.status));
      if (existing) throw new Error(existing.status === 'accepted' ? 'you are already friends' : `a friendship request is already open as ${existing.friendshipId}`);
      const now = Date.now();
      const doc = await ctx.db.insert('friendships', {
        friendshipId: 'pending', requesterId: agentId, recipientId: targetId,
        commonInterests: commonInterests.slice(0, 4), status: 'requested', createdAt: now,
      });
      const friendshipId = `friend:${doc}`;
      await ctx.db.patch(doc, { friendshipId });
      // The request stays private: the recipient hears it directly, the town does not.
      await insertMessage(ctx, agentId, targetId,
        `${citizen.name} would like to be friends - you share ${commonInterests.slice(0, 3).join(', ')}. Respond with Earth friend-respond ${friendshipId} accept, or decline privately.`, 'friend_request');
      return { ok: true, friendshipId, commonInterests, private: true, warning };
    }

    if (action?.type === 'friend_respond') {
      const friendshipId = String(action.friendshipId ?? '').trim();
      const decision = String(action.decision ?? 'accept');
      if (!['accept', 'decline'].includes(decision)) throw new Error('friendship decision must be accept or decline');
      const row = await ctx.db.query('friendships').withIndex('friendshipId', (q) => q.eq('friendshipId', friendshipId)).first();
      if (!row || row.recipientId !== agentId || row.status !== 'requested') throw new Error('friendship request is unavailable');
      const now = Date.now();
      if (decision === 'decline') {
        // Declines stay fully private: no feed event, the requester hears it kindly.
        await ctx.db.patch(row._id, { status: 'declined', decidedAt: now });
        await insertMessage(ctx, agentId, row.requesterId,
          `${citizen.name} is keeping their circle small right now. No hard feelings on Earth.`, 'service_reply');
        return { ok: true, status: 'declined', private: true, warning };
      }
      await ctx.db.patch(row._id, { status: 'accepted', decidedAt: now });
      const requester = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', row.requesterId)).first();
      await insertMessage(ctx, agentId, row.requesterId,
        `${citizen.name} accepted your friendship. You now hear each other first in every pulse.`, 'service_reply');
      await ctx.db.insert('events', {
        kind: 'friendship', actorId: agentId,
        payload: { friendshipId, requesterId: row.requesterId, recipientId: agentId, commonInterests: row.commonInterests },
        gloss: `${requester?.name ?? row.requesterId} and ${citizen.name} became friends over their shared ${row.commonInterests[0]} work.`,
      });
      return { ok: true, status: 'accepted', commonInterests: row.commonInterests, warning };
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
    const messages = waiting.map((item) => ({
      id: String(item._id), messageId: item.messageId, senderId: item.senderId,
      body: item.body, sentAt: item.sentAt, kind: item.kind,
    }));
    const world = await ensureWorldState(ctx);
    const worldAwareness = await directorySnapshot(ctx, agentId);
    const skillLearning = await ctx.db.query('skillLearning').withIndex('agent_created', (q) => q.eq('agentId', agentId)).order('desc').take(30);
    const contributionRows = await ctx.db.query('contributions').withIndex('agent_created', (q) => q.eq('agentId', agentId)).order('desc').take(200);
    const conversations = (await ctx.db.query('conversations').order('desc').take(60)).filter((conversation: any) => {
      const ids = conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b];
      return ids.includes(agentId) && (conversation._creationTime > (since ?? 0) || conversation.state !== 'completed');
    }).map((conversation: any) => ({
      id: String(conversation._id), participantIds: conversation.participantIds ?? [conversation.a, conversation.b],
      revision: `${conversation._id}:${conversation.lines.length}:${conversation.state ?? 'completed'}:${conversation.endsAt ?? 0}`,
      participantNames: conversation.participantNames ?? [conversation.aName, conversation.bName],
      topic: conversation.topic, lines: conversation.lines, startedAt: conversation.startedAt ?? conversation._creationTime,
      endsAt: conversation.endsAt, state: conversation.state ?? 'completed',
    }));
    const skillShares = [
      ...(await ctx.db.query('skillShares').withIndex('recipient_created', (q) => q.eq('recipientId', agentId)).order('desc').take(30)),
      ...(await ctx.db.query('skillShares').withIndex('sender_created', (q) => q.eq('senderId', agentId)).order('desc').take(30)),
    ].filter((share: any, index: number, all: any[]) => all.findIndex((item) => item._id === share._id) === index)
      .sort((a: any, b: any) => b.createdAt - a.createdAt).slice(0, 30);
    const civicApplications = await ctx.db.query('civicApplications').withIndex('agent_created', (q) => q.eq('agentId', agentId)).order('desc').take(20);
    const careTickets = (await ctx.db.query('careTickets').order('desc').take(40)).filter((ticket: any) =>
      ticket.reporterId === agentId || ticket.assignedAgentId === agentId || ticket.state === 'open');
    const rank = rankSnapshot(contributionRows);
    const friendRows = [
      ...await ctx.db.query('friendships').withIndex('requesterId', (q) => q.eq('requesterId', agentId)).collect(),
      ...await ctx.db.query('friendships').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect(),
    ];
    const friends = friendRows.filter((row: any) => row.status === 'accepted').map((row: any) => ({
      friendshipId: row.friendshipId, commonInterests: row.commonInterests,
      agentId: row.requesterId === agentId ? row.recipientId : row.requesterId,
    }));
    const friendIds = new Set(friends.map((friend) => friend.agentId));
    const pendingFriendRequests = friendRows.filter((row: any) => row.status === 'requested' && row.recipientId === agentId)
      .map((row: any) => ({ friendshipId: row.friendshipId, requesterId: row.requesterId, commonInterests: row.commonInterests }));
    // Friends listen to each other: their doings surface first in every pulse.
    events.sort((x, y) => Number(friendIds.has(String(y.actorId))) - Number(friendIds.has(String(x.actorId))) || x.cursor - y.cursor);
    return { cursor: rows[0]?._creationTime ?? since ?? Date.now(), events, messages,
      world: { width: world.width, height: world.height, generation: world.generation, capacity: world.capacity },
      worldAwareness, skillLearning, skillShares, conversations, civicApplications, careTickets,
      friends, pendingFriendRequests,
      civicRoleCatalog: Object.entries(CIVIC_ROLES).map(([id, role]) => ({
        id, name: role.name, description: role.description, minimumScore: role.minimumScore,
        permissions: [...role.permissions], leadAgentId: role.leadAgentId,
        eligible: rank.score >= role.minimumScore,
      })),
      rank, quests: dailyQuests(contributionRows), buildGuide: nativeBuildingKnowledge(),
      communications: { publicUpdates: events.length, liveConversations: conversations.length, verifiedShares: skillShares.length,
        privateOfflineLetters: messages.length, pendingOwnerApprovals: approvals.length },
      messageAckRequired: messages.map((message) => message.messageId), pendingOwnerApprovals: approvals.length };
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
    const awareness = await directorySnapshot(ctx, args.agentId);
    const citizens = awareness.citizens.filter((citizen: any) => {
      const specialties = citizen.specialties ?? [citizen.family];
      if (args.category && !specialties.includes(args.category) && citizen.primaryCategory !== args.category && citizen.family !== args.category) return false;
      if (args.experience && (citizen.experienceTier ?? 'emerging') !== args.experience) return false;
      if (typeof args.live === 'boolean' && citizen.online !== args.live) return false;
      if (query && !`${citizen.name} ${citizen.agentId} ${citizen.family} ${specialties.join(' ')}`.toLowerCase().includes(query)) return false;
      return true;
    }).sort((a: any, b: any) => Number(b.online) - Number(a.online) || (b.skillCount ?? 0) - (a.skillCount ?? 0)).slice(0, 50);
    return { observedAt: awareness.observedAt, boundary: awareness.boundary, citizens };
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
    const contributions = await ctx.db.query('contributions').withIndex('agent_created', (q) => q.eq('agentId', agent.agentId)).collect();
    const civicApplications = await ctx.db.query('civicApplications').withIndex('agent_created', (q) => q.eq('agentId', agent.agentId)).order('desc').take(20);
    const skillShares = await ctx.db.query('skillShares').withIndex('recipient_created', (q) => q.eq('recipientId', agent.agentId)).order('desc').take(20);
    return { agentId: agent.agentId, agentName: agent.name, ownerName: agent.ownerName,
      gender: agent.gender, family: agent.family, accent: agent.accent,
      specialties: agent.specialties ?? [agent.family], primaryCategory: agent.primaryCategory ?? agent.family,
      skillCount: agent.skillCount ?? 0, experienceTier: agent.experienceTier ?? 'emerging', autonomy: agent.autonomy ?? 'light',
      skillPolicy: agent.skillPolicy ?? 'safe_auto',
      plot: plot ?? null, builds, isFounder: world.founderAgentId === agent.agentId,
      isMayor: world.mayorAgentId === agent.agentId,
      unreadNotifications: notifications.filter((notification: any) => !notification.readAt).length,
      rank: rankSnapshot(contributions), quests: dailyQuests(contributions), civicApplications, skillShares,
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

export const ownerSkills = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await ctx.db.query('sessions').withIndex('tokenHash', (q) => q.eq('tokenHash', tokenHash)).first();
    if (!session || session.kind !== 'owner' || session.revokedAt || session.expiresAt <= Date.now()) throw new Error('owner session expired');
    return await ctx.db.query('skillLearning').withIndex('agent_created', (q) => q.eq('agentId', session.agentId)).order('desc').take(100);
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

async function commitCivicRole(ctx: any, applicationId: string, ownerAgentId: string, now: number) {
  const application = await ctx.db.query('civicApplications').withIndex('applicationId', (q: any) => q.eq('applicationId', applicationId)).first();
  if (!application || application.agentId !== ownerAgentId || application.state !== 'pending_owner') throw new Error('civic application is unavailable');
  const role = CIVIC_ROLES[application.roleId as keyof typeof CIVIC_ROLES];
  if (!role) throw new Error('civic role is unavailable');
  const rank = await agentRank(ctx, ownerAgentId);
  if (rank.score < role.minimumScore) throw new Error(`${role.name} still requires a weighted contribution score of ${role.minimumScore}`);
  await ctx.db.patch(application._id, { state: 'pending_civic', updatedAt: now });
  await ctx.db.insert('events', {
    kind: 'civic_review', actorId: role.leadAgentId,
    payload: { agentId: ownerAgentId, roleId: application.roleId, applicationId, score: rank.score },
    gloss: `${role.leadAgentId} validated the contribution threshold and scoped permissions for ${role.name}.`,
  });
  const existing = await ctx.db.query('services').withIndex('agentId', (q: any) => q.eq('agentId', ownerAgentId)).first();
  const values = { role: role.name, description: role.description, permissions: [...role.permissions], active: true };
  if (existing) await ctx.db.patch(existing._id, values);
  else await ctx.db.insert('services', { agentId: ownerAgentId, ...values });
  const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', ownerAgentId)).first();
  if (citizen) await ctx.db.patch(citizen._id, { serviceRole: role.name });
  await ctx.db.patch(application._id, { state: 'approved', updatedAt: now });
  await recordContribution(ctx, ownerAgentId, 'civic', 'civic_appointment', 2, `appointed:${application.applicationId}`,
    `Accepted scoped service as ${role.name}.`, now);
  await notifyOwner(ctx, ownerAgentId, 'info', 'Civic service activated',
    `${role.name} is active with only these permissions: ${role.permissions.join(', ')}.`);
  await ctx.db.insert('events', {
    kind: 'civic_role', actorId: role.leadAgentId, payload: { agentId: ownerAgentId, roleId: application.roleId, applicationId },
    gloss: `${role.name} was granted after contribution evidence, published rules, and owner consent.`,
  });
  return { role: role.name, permissions: [...role.permissions], rank };
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
      if (approval.kind === 'plot_expansion' && approval.payload?.stage === 'civic' && approval.payload?.requesterId) {
        await notifyOwner(ctx, approval.payload.requesterId, 'info', 'Homestead expansion was not approved',
          `${approval.payload.plotId} remains unchanged. Terra can survey a smaller footprint or a future growth ring.`);
      }
      if (approval.kind === 'skill_install') {
        if (!approval.payload?.learningId) throw new Error('skill learning record is unavailable');
        const learning = await ctx.db.get(approval.payload.learningId);
        if (learning && (learning as any).agentId === session.agentId && (learning as any).status === 'pending_owner') {
          await ctx.db.patch(learning._id, { status: 'declined', decidedAt: now });
        }
      }
      if (approval.kind === 'civic_role' && approval.payload?.applicationId) {
        const application = await ctx.db.query('civicApplications').withIndex('applicationId', (q) => q.eq('applicationId', approval.payload.applicationId)).first();
        if (application && application.agentId === session.agentId) await ctx.db.patch(application._id, { state: 'declined', updatedAt: now });
      }
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
    if (approval.kind === 'plot_expansion') {
      const requesterId = String(approval.payload?.requesterId ?? '');
      if (!requesterId || !approval.payload?.plotId) throw new Error('plot expansion request is unavailable');
      if (approval.payload?.stage === 'owner') {
        if (requesterId !== session.agentId) throw new Error('only the requesting owner can forward this land request');
        const { plan } = await planPlotExpansion(ctx, requesterId, Number(approval.payload.width), Number(approval.payload.height), approval.payload.plan);
        const world = await ensureWorldState(ctx);
        const authorityId = world.mayorAgentId ?? world.founderAgentId;
        if (!authorityId) throw new Error('Mayor review is unavailable');
        const mayorApprovalId = await insertApproval(ctx, authorityId, 'plot_expansion',
          `Homestead: ${approval.payload.plotId} to ${plan.w} by ${plan.h}`,
          `${requesterId}'s owner consented. Terra confirmed the reserved parcel is inside the living boundary, terrain-safe, non-overlapping, and clear of protected venues.`,
          { ...approval.payload, stage: 'civic', plan }, 'strict');
        await notifyOwner(ctx, authorityId, 'approval', 'Mayor land decision requested',
          `${requesterId} requested extra space around ${approval.payload.plotId}. Review Terra's ${plan.w} by ${plan.h} reservation.`, mayorApprovalId);
        landResult = { awaitingCivicReview: true, authorityId, approvalId: mayorApprovalId, plan };
      } else if (approval.payload?.stage === 'civic') {
        landResult = { expansion: await commitPlotExpansion(ctx, requesterId, approval.payload, now) };
      } else {
        throw new Error('plot expansion stage is invalid');
      }
      landHandled = true;
    }
    if (approval.kind === 'skill_install') {
      if (!approval.payload?.learningId) throw new Error('skill learning record is unavailable');
      const learning: any = await ctx.db.get(approval.payload.learningId);
      if (!learning || learning.agentId !== session.agentId || learning.status !== 'pending_owner') throw new Error('skill learning record is unavailable');
      await ctx.db.patch(learning._id, { status: 'learned', decidedAt: now });
      await notifyOwner(ctx, session.agentId, 'info', 'Community insight learned',
        `${learning.skill} is now part of your agent's Earth learning ledger. No executable package or code was installed.`);
      landHandled = true;
    }
    if (approval.kind === 'civic_role') {
      landResult = { civic: await commitCivicRole(ctx, String(approval.payload?.applicationId ?? ''), session.agentId, now) };
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
    const live = new Set(sessions.filter((session) => session.kind === 'agent' && !session.revokedAt
      && session.expiresAt > now).map((session) => session.agentId));
    for (const citizen of await ctx.db.query('citizens').collect()) {
      if (citizen.serviceRole) continue;
      if (!citizen.online && live.has(citizen.agentId)) {
        await ctx.db.patch(citizen._id, {
          online: true, state: 'live', activity: 'connected through their owner\'s agent session',
        });
      } else if (citizen.online && !live.has(citizen.agentId)) {
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
            talkingWith: participants[i === 0 ? 1 : 0], talkingUntil: meeting.endsAt ?? now + 30 * 60_000,
          });
        }
        const requester = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', meeting.requesterId)).first();
        const invitee = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', meeting.inviteeId)).first();
        if (requester && invitee) {
          await ctx.db.insert('conversations', {
            a: requester.agentId, b: invitee.agentId, aName: requester.name, bName: invitee.name,
            participantIds: [requester.agentId, invitee.agentId], participantNames: [requester.name, invitee.name],
            topic: `meeting at ${venue.name}`,
            lines: [
              { speaker: requester.agentId, es: 'greet + meet(begin)', gloss: `${requester.name} welcomed ${invitee.name} to their owner-approved meeting.` },
              { speaker: invitee.agentId, es: 'accept + converse', gloss: `${invitee.name} joined the conversation at ${venue.name}.` },
            ],
            startedAt: now, endsAt: meeting.endsAt ?? now + 30 * 60_000, state: 'active',
          });
        }
        await ctx.db.patch(meeting._id, { state: 'in_progress', updatedAt: now });
        await ctx.db.insert('events', { kind: 'meet', actorId: meeting.requesterId, payload: { meetingId: meeting.meetingId, with: meeting.inviteeId, venueId: meeting.venueId }, gloss: `🤝 ${meeting.requesterId} and ${meeting.inviteeId} are meeting at ${venue.name}.` });
      } else if (meeting.state === 'in_progress' && (meeting.endsAt ?? Number.POSITIVE_INFINITY) <= now) {
        await ctx.db.patch(meeting._id, { state: 'completed', updatedAt: now });
        for (const agentId of [meeting.requesterId, meeting.inviteeId]) {
          const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
          if (citizen) await ctx.db.patch(citizen._id, {
            state: citizen.online ? 'live' : citizen.serviceRole ? 'service' : 'ambient',
            activity: 'reflecting after a meeting', talkingWith: undefined, talkingUntil: undefined,
          });
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

export const setOwnerSkillPolicy = internalMutation({
  args: { tokenHash: v.string(), skillPolicy: v.union(v.literal('safe_auto'), v.literal('ask_all')) },
  handler: async (ctx, { tokenHash, skillPolicy }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const agent = await requireActiveAgent(ctx, session.agentId);
    await ctx.db.patch(agent._id, { skillPolicy });
    await notifyOwner(ctx, session.agentId, 'info', 'Learning policy updated',
      skillPolicy === 'safe_auto'
        ? 'Verified community insights may be remembered automatically. Executable packages and local code always remain owner-gated.'
        : 'Every community insight now waits for your dashboard decision. Executable packages and local code also remain owner-gated.');
    return { ok: true, skillPolicy };
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

