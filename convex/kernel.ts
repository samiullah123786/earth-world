import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { findRoute, walkableInWorld } from './pathfinding';
import { WORLD_KEY, assertRegistryGeometry, ensureWorldState, expandWorld } from './planning';
import { CIVIC_ROLES, normalizeGithubRepository, rankSnapshot, type ContributionDimension } from './community';
import {
  GENESIS_GRANT, GIFT_REWARD, INSTALL_REWARD, balanceOf, grantFromTreasury, issue, mintToTreasury, payForTrade, sendTokens, supplyAudit,
} from './economy';
import { LPC_ASSET_STANDARD, LPC_STRUCTURE_TYPES, LPC_WORLD_ASSETS } from '../shared/lpc-assets';

const AGENT_SESSION_MS = 12 * 60 * 60 * 1000;
const OWNER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PRESENCE_LEASE_MS = 90 * 1000;
const SPEED = 2.2;
const MAYOR_ID = 'agent:sam-cbf0499925';
const EVENT_GREETER_ID = 'agent:sage-0004';
const COMMUNITY_EVENT_KINDS = new Set(['gathering', 'public_meeting', 'workshop', 'showcase', 'walk', 'training', 'celebration']);
export const KNOWN_CATEGORIES = new Set(['ui', 'ux', 'frontend', 'backend', 'data', 'security',
  'research', 'content', 'growth', 'automation', 'media', 'general']);
const EXPERIENCE_TIERS = new Set(['emerging', 'practiced', 'seasoned', 'polymath']);
// A citizen cannot evidence more skills than a machine can plausibly hold. The
// ceiling stops a forged genome from inflating tier, rank, or district weight.
const MAX_EVIDENCED_SKILLS = 100_000;
// Knowledge bytes may cross the Kernel, but only in amounts a transactional
// database should carry. Anything larger travels as a verified repository root.
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_QUOTA_BYTES = 250 * 1024 * 1024;

// Extracurricular life. Tools are earned through contribution, so a citizen
// carrying an axe has demonstrably done something for the town first. These
// are weighted rank scores, on the same scale as the civic roles (2-15), not
// raw points: everyday gear should sit below the junior service posts.
const TOOL_UNLOCKS: Record<string, { minimumScore: number; zone: string }> = {
  watering_can: { minimumScore: 0, zone: 'farm' },
  axe: { minimumScore: 3, zone: 'forest' },
  pickaxe: { minimumScore: 8, zone: 'quarry' },
};
const CROPS = new Set(['grain', 'greens', 'roots', 'flowers']);
const CROP_GROWTH_MS = 45 * 60 * 1000;
const CROP_TEND_RELIEF_MS = 8 * 60 * 1000;
const GATHER_COOLDOWN_MS = 20 * 60 * 1000;
// Above this price a release stops being routine and waits for the owner even
// under active standing consent.
const ROUTINE_RELEASE_PRICE = 25;
// How long a work animation plays after the act that started it.
const WORK_ANIMATION_MS = 6 * 1000;
// Work is credited where the citizen stands, so arriving is only half of it -
// the agent still has to ask again. The hold therefore has to outlast the walk
// by enough for that second call, or a drive claims them on the next five
// second tick and the errand is lost a tile from the field.
const WORK_ARRIVAL_GRACE_MS = 90 * 1000;
// Above this, a send stops being an ordinary gift and waits for the owner even
// under active standing consent.
const ROUTINE_SEND_AMOUNT = 5;
const avatarSpecValidator = v.object({
  version: v.number(), catalogKey: v.string(), archetype: v.string(), variant: v.number(),
  hairStyle: v.string(), hairColor: v.string(), headShape: v.string(), outfitColor: v.string(),
  eyeColor: v.string(), selectionBasis: v.string(),
});

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
  if (citizen && !citizen.online) await ctx.db.patch(citizen._id, {
    online: true, state: citizen.serviceRole ? 'service' : 'live',
    activity: 'connected through a recent signed owner-agent heartbeat',
  });
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

type ApprovalKind = 'claim' | 'build' | 'meeting_request' | 'meeting_invite' | 'land_claim' | 'land_build' | 'world_expand' | 'plot_expansion' | 'mayor_appointment' | 'skill_install' | 'civic_role' | 'commission_offer' | 'event_proposal' | 'package_install' | 'package_release' | 'token_transfer' | 'bank_flag';
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

const BLUEPRINT_KINDS = new Set([
  'home', 'studio', 'workshop', 'hall', 'garden', 'art', 'laptop', 'industry', 'data_center',
  ...LPC_STRUCTURE_TYPES,
]);
const BLUEPRINT_ARCHITECTURES = new Set(['native', 'modern-earthfolk']);
const BLUEPRINT_FEATURES = new Set([
  'entry-path', 'porch', 'warm-windows', 'flower-bed', 'herb-bed', 'small-plants',
  'native-tree', 'timber-fence', 'bird-bath', 'pond', 'pet-yard', 'pet-shelter',
]);

function nativeBuildingKnowledge() {
  return {
    standard: 'earthfolk-native-v1',
    assetFramework: {
      standard: LPC_ASSET_STANDARD,
      gridSize: 32,
      avatarFrameSize: 64,
      structureTypes: [...LPC_STRUCTURE_TYPES],
      components: Object.entries(LPC_WORLD_ASSETS).map(([id, asset]) => ({ id, ...asset })),
      action: {
        type: 'construct_structure',
        fields: ['structureType', 'coordinates{x,y}', 'blueprint[{tile|prop,xOffset,yOffset}]'],
      },
      scoring: 'Civic contribution is awarded by the Kernel only after routed construction completes.',
    },
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

type LpcPlacement = {
  assetId: keyof typeof LPC_WORLD_ASSETS;
  kind: 'tile' | 'prop';
  xOffset: number;
  yOffset: number;
};

function validateLpcPlacements(rawPlacements: unknown, footprint?: { w: number; h: number }) {
  if (!Array.isArray(rawPlacements) || rawPlacements.length < 1 || rawPlacements.length > 64) {
    throw new Error('LPC blueprint must contain 1 to 64 manifest placements');
  }
  const placements: LpcPlacement[] = [];
  const solidRects: Array<{ x: number; y: number; w: number; h: number; assetId: string }> = [];
  let width = 0, height = 0;
  for (const raw of rawPlacements) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('each LPC placement must be an object');
    const item = raw as Record<string, unknown>;
    const hasTile = typeof item.tile === 'string';
    const hasProp = typeof item.prop === 'string';
    if (hasTile === hasProp) throw new Error('each LPC placement must declare exactly one tile or prop');
    const assetId = String(hasTile ? item.tile : item.prop) as keyof typeof LPC_WORLD_ASSETS;
    if (!Object.prototype.hasOwnProperty.call(LPC_WORLD_ASSETS, assetId)) throw new Error(`unknown LPC asset: ${assetId}`);
    const xOffset = Number(item.xOffset), yOffset = Number(item.yOffset);
    if (![xOffset, yOffset].every(Number.isInteger) || xOffset < 0 || yOffset < 0) {
      throw new Error('LPC placement offsets must be non-negative integer tiles');
    }
    const asset = LPC_WORLD_ASSETS[assetId];
    const rect = { x: xOffset, y: yOffset, w: asset.width, h: asset.height, assetId };
    if (footprint && (xOffset + asset.width > footprint.w || yOffset + asset.height > footprint.h)) {
      throw new Error(`${assetId} extends outside the declared blueprint footprint`);
    }
    if (asset.solid && solidRects.some((existing) => overlapsRect(rect, existing))) {
      throw new Error(`${assetId} overlaps another solid LPC component`);
    }
    if (asset.solid) solidRects.push(rect);
    placements.push({ assetId, kind: hasTile ? 'tile' : 'prop', xOffset, yOffset });
    width = Math.max(width, xOffset + asset.width);
    height = Math.max(height, yOffset + asset.height);
  }
  return { placements, width, height };
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
    const assetFramework = raw.assetFramework === undefined ? undefined : String(raw.assetFramework);
    let placements: LpcPlacement[] | undefined;
    if (assetFramework !== undefined) {
      if (assetFramework !== LPC_ASSET_STANDARD) throw new Error('unsupported asset framework');
      placements = validateLpcPlacements(raw.placements, { w, h }).placements;
    } else if (raw.placements !== undefined) {
      throw new Error('manifest placements require the LPC asset framework');
    }
    spec = { offsetX, offsetY, w, h };
    blueprint = {
      name, kind, architecture, features, offsetX, offsetY, w, h,
      style: assetFramework ?? 'earthfolk-native-v1', assetFramework, placements,
    };
  }
  if (!spec) throw new Error('unsupported structure');
  if (spec.offsetX < 0 || spec.offsetY < 0 || spec.offsetX + spec.w > plot.w || spec.offsetY + spec.h > plot.h) {
    throw new Error('build footprint must remain inside the owned plot');
  }
  return { structure, blueprint, offsetX: spec.offsetX, offsetY: spec.offsetY,
    x: plot.x + spec.offsetX, y: plot.y + spec.offsetY, w: spec.w, h: spec.h };
}

async function lpcBuildPayload(ctx: any, requesterId: string, action: any) {
  const structureType = String(action.structureType ?? '');
  if (!(LPC_STRUCTURE_TYPES as readonly string[]).includes(structureType)) throw new Error('unsupported LPC structure type');
  const coordinates = action.coordinates;
  const x = Number(coordinates?.x), y = Number(coordinates?.y);
  if (![x, y].every(Number.isInteger) || x < 0 || y < 0) throw new Error('construction coordinates must be non-negative integer tiles');
  const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', requesterId)).first();
  if (!plot) throw new Error('claim a plot before constructing a structure');
  const normalized = validateLpcPlacements(action.blueprint);
  const offsetX = x - plot.x, offsetY = y - plot.y;
  const title = structureType.split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
  return {
    plot,
    payload: {
      plotId: plot.plotId,
      structure: 'blueprint',
      blueprint: {
        name: title,
        kind: structureType,
        architecture: 'native',
        features: [],
        offsetX,
        offsetY,
        w: normalized.width,
        h: normalized.height,
        assetFramework: LPC_ASSET_STANDARD,
        placements: normalized.placements.map((placement) => ({
          [placement.kind]: placement.assetId,
          xOffset: placement.xOffset,
          yOffset: placement.yOffset,
        })),
      },
    },
  };
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
  const usesLpc = footprint.blueprint?.assetFramework === LPC_ASSET_STANDARD;
  const strictLpcKind = footprint.blueprint?.kind === 'industrial_structure';
  const routineNative = architecture === 'native' && (usesLpc ? area <= 16 && !strictLpcKind : area <= 9);
  const risk: ApprovalRisk = custom && !routineNative ? 'strict' : 'routine';
  return {
    risk,
    report: {
      standard: usesLpc ? LPC_ASSET_STANDARD : 'earthfolk-native-v1', format: 'declarative-only', executableCode: false,
      architecture, features: footprint.blueprint?.features ?? [], paletteLocked: true,
      geometry: 'pass', collision: 'pass', plotContainment: 'pass', terrainLanguage: 'pass',
      manifestAllowlist: usesLpc ? 'pass' : 'not-applicable',
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
  await ctx.db.insert('events', { kind: 'claim', actorId: requesterId, payload: { plotId: plot.plotId }, gloss: `Terra verified ${requesterId}'s protected claim on ${plot.plotId}. Mayor Sam authorized the routine land decision.` });
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
  const lpcConstruction = nativeBlueprint.assetFramework === LPC_ASSET_STANDARD;
  const citizen = lpcConstruction
    ? await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', requesterId)).first()
    : null;
  if (lpcConstruction && !citizen) throw new Error('a live world citizen is required for LPC construction');
  if (citizen?.activeBuildId && (citizen.buildingUntil ?? 0) > now) throw new Error('finish the active construction before starting another');
  let constructionStartsAt: number | undefined;
  let constructionEndsAt: number | undefined;
  if (citizen) {
    const route = await routeCitizenNear(ctx, citizen, footprint.x + footprint.w / 2, footprint.y + footprint.h / 2,
      `heading to build ${nativeBlueprint.name}`, now);
    if (!route.length) throw new Error('no safe route reaches this construction footprint');
    constructionStartsAt = route[route.length - 1].at;
    const placementCount = nativeBlueprint.placements?.length ?? 1;
    constructionEndsAt = constructionStartsAt + Math.min(45_000, 8_000 + placementCount * 1_200);
  }
  const buildDoc = await ctx.db.insert('builds', {
    buildId: 'pending', plotId: plot.plotId, ownerAgentId: requesterId,
    structure: footprint.structure, blueprint: nativeBlueprint,
    state: 'building', createdAt: now,
    x: footprint.x, y: footprint.y, w: footprint.w, h: footprint.h,
    constructionStartsAt, constructionEndsAt,
  });
  const buildId = `build:${buildDoc}`;
  if (lpcConstruction && citizen) {
    await ctx.db.patch(buildDoc, { buildId });
    await ctx.db.patch(citizen._id, {
      activeBuildId: buildId, activeTool: 'hammer', buildingStartsAt: constructionStartsAt, buildingUntil: constructionEndsAt,
      activity: `heading to build ${nativeBlueprint.name}`,
    });
  } else {
    await ctx.db.patch(buildDoc, { buildId, state: 'built', completedAt: now });
    await recordContribution(ctx, requesterId, 'civic', 'native_build', 3, buildId,
      `Completed ${nativeBlueprint.name} after geometry and Earthfolk style inspection.`, now);
  }
  const label = nativeBlueprint.name;
  await ctx.db.insert('events', { kind: 'build', actorId: requesterId,
    payload: { buildId, plotId: plot.plotId, review: review.report },
    gloss: lpcConstruction
      ? `Tock approved ${requesterId}'s ${label} on ${plot.plotId}. The citizen is walking there to construct it from verified LPC components.`
      : `Tock completed the final native-code inspection for ${requesterId}'s ${label} on ${plot.plotId}. Every footprint and Earthfolk check passed.` });
  // F2: data centers and industry halls open a shared operations room the
  // owner runs; trusted friends join through workplace_invite. Kernel-stored,
  // participants only, never projected publicly.
  if (nativeBlueprint.kind === 'data_center' || nativeBlueprint.kind === 'industry') {
    const workRoomId = `room:work:${buildId}`;
    if (!await ctx.db.query('rooms').withIndex('roomId', (q: any) => q.eq('roomId', workRoomId)).first()) {
      await ctx.db.insert('rooms', { roomId: workRoomId, participantIds: [requesterId], createdAt: now });
      await ctx.db.insert('roomNotes', { roomId: workRoomId, authorId: requesterId,
        body: `${nativeBlueprint.name} is open. This is its private operations room - invite trusted friends with Earth invite-operator.`, createdAt: now });
    }
  }
  return { buildId, plot, footprint: { ...footprint, blueprint: nativeBlueprint }, constructionStartsAt, constructionEndsAt };
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
  let committed: any = undefined;
  if (kind === 'claim') committed = await commitClaim(ctx, requesterId, payload.plotId, now);
  else committed = await commitBuild(ctx, requesterId, payload, now);
  return { awaitingFounder: false, awaitingCivicReview: false, committed };
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
      route, state: citizen.serviceRole ? 'service' : citizen.online ? 'live' : 'ambient', activity,
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
      gloss: `🌱 ${agent.name} met Sage, Terra, Tock, and Mayor Sam, then settled into a protected Earthfolk home on ${plot.plotId}.`,
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

function overlaps(startsAt: number, endsAt: number, otherStartsAt?: number, otherEndsAt?: number) {
  return startsAt < (otherEndsAt ?? otherStartsAt ?? 0) && endsAt > (otherStartsAt ?? 0);
}

async function chooseCommunityEventVenue(ctx: any, startsAt: number, endsAt: number, capacity: number, requestedVenueId?: string, excludeEventId?: string) {
  const venues = await ctx.db.query('venues').collect();
  const meetings = await ctx.db.query('meetings').collect();
  const events = await ctx.db.query('communityEvents').collect();
  const available = venues.filter((venue: any) => {
    if (venue.capacity < capacity || (requestedVenueId && venue.venueId !== requestedVenueId)) return false;
    const meetingConflict = meetings.some((meeting: any) =>
      meeting.venueId === venue.venueId && ['scheduled', 'in_progress'].includes(meeting.state)
      && overlaps(startsAt, endsAt, meeting.startsAt, meeting.endsAt));
    const eventConflict = events.some((event: any) => event.eventId !== excludeEventId &&
      event.venueId === venue.venueId && ['proposed', 'approved', 'live'].includes(event.state)
      && overlaps(startsAt, endsAt, event.startsAt, event.endsAt));
    return !meetingConflict && !eventConflict;
  });
  return available.sort((a: any, b: any) => a.capacity - b.capacity || a.name.localeCompare(b.name))[0] ?? null;
}

async function approveCommunityEvent(ctx: any, eventId: string, decision: string, now = Date.now()) {
  const event = await ctx.db.query('communityEvents').withIndex('eventId', (q: any) => q.eq('eventId', eventId)).first();
  if (!event || event.state !== 'proposed') throw new Error('event proposal is unavailable');
  if (event.startsAt <= now + 30_000) throw new Error('event start is too close; submit a new time so invitees can respond');
  const venue = await chooseCommunityEventVenue(ctx, event.startsAt, event.endsAt, event.capacity, event.venueId, event.eventId);
  if (!venue) throw new Error('the requested venue is no longer available for this event');
  await ctx.db.patch(event._id, { state: 'approved', committeeDecision: decision, updatedAt: now });
  await ctx.db.insert('events', {
    kind: 'community_event_approved', actorId: event.committeeAgentIds.join('+'),
    payload: { eventId: event.eventId, venueId: event.venueId, startsAt: event.startsAt },
    gloss: `${event.title} was listed at ${venue.name} after committee review.`,
  });
  await notifyOwner(ctx, event.hostAgentId, 'info', 'Community event listed',
    `${event.title} is public. Citizens can now accept the invitation from Earth or their owner dashboard.`);
  return event;
}

async function setEventRsvp(ctx: any, agentId: string, eventId: string, status: 'accepted' | 'declined', now = Date.now()) {
  await requireActiveAgent(ctx, agentId);
  const event = await ctx.db.query('communityEvents').withIndex('eventId', (q: any) => q.eq('eventId', eventId)).first();
  if (!event || !['approved', 'live'].includes(event.state) || event.endsAt <= now) throw new Error('this public event is not open for responses');
  const current = await ctx.db.query('eventRsvps').withIndex('event_agent', (q: any) => q.eq('eventId', eventId).eq('agentId', agentId)).first();
  if (status === 'accepted') {
    const accepted = await ctx.db.query('eventRsvps').withIndex('event_status', (q: any) => q.eq('eventId', eventId).eq('status', 'accepted')).collect();
    if (!current || current.status !== 'accepted') {
      if (accepted.length >= event.capacity) throw new Error('this event has reached its venue capacity');
    }
  }
  if (current) await ctx.db.patch(current._id, { status, updatedAt: now });
  else await ctx.db.insert('eventRsvps', { eventId, agentId, status, createdAt: now, updatedAt: now });
  const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
  await notifyOwner(ctx, agentId, 'info', status === 'accepted' ? 'Event invitation accepted' : 'Event invitation declined',
    status === 'accepted'
      ? `${citizen?.name ?? agentId} is expected at ${event.title}. Earth will show the start time and route the citizen to the venue when it begins.`
      : `${event.title} was declined privately. No decline was added to the public feed.`);
  return { event, status };
}

async function communityEventCards(ctx: any, viewerAgentId?: string) {
  const now = Date.now();
  const [events, citizens, venues, rsvps, notes] = await Promise.all([
    ctx.db.query('communityEvents').collect(), ctx.db.query('citizens').collect(),
    ctx.db.query('venues').collect(), ctx.db.query('eventRsvps').collect(), ctx.db.query('eventNotes').collect(),
  ]);
  const names = new Map(citizens.map((citizen: any) => [citizen.agentId, citizen.name]));
  const venueById = new Map(venues.map((venue: any) => [venue.venueId, venue]));
  return events.filter((event: any) => ['approved', 'live', 'completed'].includes(event.state)
    && (event.state !== 'completed' || event.endsAt >= now - 30 * 86_400_000))
    .sort((a: any, b: any) => {
      const aPast = a.endsAt < now ? 1 : 0, bPast = b.endsAt < now ? 1 : 0;
      return aPast - bPast || (aPast ? b.startsAt - a.startsAt : a.startsAt - b.startsAt);
    }).slice(0, 60).map((event: any) => {
      const attendees = rsvps.filter((row: any) => row.eventId === event.eventId && row.status === 'accepted')
        .map((row: any) => ({ agentId: row.agentId, name: names.get(row.agentId) ?? row.agentId }));
      const eventNotes = notes.filter((row: any) => row.eventId === event.eventId)
        .sort((a: any, b: any) => a.createdAt - b.createdAt)
        .map((row: any) => ({ agentId: row.agentId, name: names.get(row.agentId) ?? row.agentId,
          topic: row.topic, summary: row.summary, createdAt: row.createdAt }));
      const myRsvp = viewerAgentId
        ? rsvps.find((row: any) => row.eventId === event.eventId && row.agentId === viewerAgentId)?.status
        : undefined;
      const venue = venueById.get(event.venueId) as any;
      return {
        eventId: event.eventId, title: event.title, summary: event.summary, kind: event.kind,
        hostAgentId: event.hostAgentId, hostName: names.get(event.hostAgentId) ?? event.hostAgentId,
        venueId: event.venueId, venueName: venue?.name ?? event.venueId, venueX: venue?.x, venueY: venue?.y,
        startsAt: event.startsAt, endsAt: event.endsAt, capacity: event.capacity, importance: event.importance,
        state: event.state, committeeAgentIds: event.committeeAgentIds, attendees, attendeeCount: attendees.length,
        notes: eventNotes, myRsvp,
      };
    });
}

export const agentPublicKey = internalQuery({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    return agent ? {
      publicKey: agent.publicKey, status: agent.status,
      name: agent.name, gender: agent.gender, family: agent.family,
    } : null;
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
    avatarSpec: v.optional(avatarSpecValidator),
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
        avatarSpec: args.avatarSpec,
      });
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', byKey.agentId)).first();
      if (citizen) await ctx.db.patch(citizen._id, {
        family: args.family, accent: args.accent, bio: args.bio, categoryScores: args.categoryScores ?? {},
        specialties: args.specialties ?? [args.family], primaryCategory: args.primaryCategory ?? args.family,
        skillCount: args.skillCount ?? 0, experienceTier: args.experienceTier ?? 'emerging',
        avatarSpec: args.avatarSpec,
      });
      await ctx.db.insert('claimTokens', { tokenHash: args.claimTokenHash, agentId: byKey.agentId, expiresAt: args.claimExpiresAt });
      const carried = await grantGenesisTokens(ctx, byKey.agentId);
      return { agentId: byKey.agentId, status: byKey.status, tokens: carried };
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
      avatarSpec: args.avatarSpec,
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
      avatarSpec: args.avatarSpec,
    });
    await expandWorld(ctx, 'new citizen capacity');
    const tokens = await grantGenesisTokens(ctx, args.agentId);
    return { agentId: args.agentId, status: 'pending_owner' as const, tokens };
  },
});

/**
 * Pay and deliver in one transaction. Both the directly-accepted path and the
 * owner-approved path route through here, so they can never diverge.
 */
async function releasePackage(ctx: any, trade: any, pack: any, providerName: string) {
  const now = Date.now();
  if (trade.priceTokens > 0) {
    await payForTrade(ctx, {
      fromAgentId: trade.requesterId, toAgentId: trade.providerId, amount: trade.priceTokens,
      sourceId: `trade:${trade.tradeId}`, reason: `Bought the ${pack.name} knowledge package.`,
    });
  }
  await ctx.db.patch(trade._id, { state: 'delivered', updatedAt: now });
  await recordContribution(ctx, trade.providerId, 'adoption', 'package_delivered', 5, `package:${trade.tradeId}`,
    `${trade.requesterId} received the ${pack.name} package after an agreed trade.`, now);
  await ctx.db.insert('events', {
    kind: 'package_delivered', actorId: trade.providerId,
    payload: { tradeId: trade.tradeId, packageId: pack.packageId, requesterId: trade.requesterId, name: pack.name, priceTokens: trade.priceTokens },
    gloss: `${providerName} delivered the ${pack.name} knowledge package. The recipient reviews it before anything installs.`,
  });
  return { state: 'delivered' as const, priceTokens: trade.priceTokens };
}

/**
 * Every citizen starts with exactly five Earth Tokens, once. The sourceId is
 * the agent id, so re-registering the same agent can never grant a second time.
 */
async function grantGenesisTokens(ctx: any, agentId: string) {
  const granted = await issue(ctx, {
    toAgentId: agentId, amount: GENESIS_GRANT, kind: 'genesis_grant',
    sourceId: `genesis:${agentId}`,
    reason: 'Arrival grant: every citizen begins with five Earth Tokens.',
  });
  return granted.balance;
}

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
    if (citizen) await ctx.db.patch(citizen._id, {
      online: true, state: citizen.serviceRole ? 'service' : 'live',
      activity: 'connected through a recent signed owner-agent heartbeat',
    });
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
    const physicallyCommitted = new Set([
      'settle', 'move_to', 'visit', 'say', 'teach', 'meet', 'practice', 'inspect_issue',
    ]);
    if (citizen.activeBuildId && (citizen.buildingUntil ?? 0) > Date.now()
      && physicallyCommitted.has(String(action?.type ?? ''))) {
      throw new Error('this citizen is physically committed to an active construction route');
    }

    if (action?.type === 'settle') {
      return { ok: true, ...(await settleCitizen(ctx, agent, citizen, Date.now())), warning };
    }

    if (action?.type === 'sync_genome') {
      // Re-scanning a machine changes what a citizen has evidenced. Everything
      // here is recomputed from that evidence; nothing is a claim the agent
      // makes about itself. The avatar spec arrives already recomputed and
      // signature-checked at the HTTP boundary, exactly as registration does.
      const evidenceDigest = String(action.evidenceDigest ?? '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('a SHA-256 evidence digest is required');
      const skillCount = Number(action.skillCount);
      if (!Number.isInteger(skillCount) || skillCount < 0 || skillCount > MAX_EVIDENCED_SKILLS) {
        throw new Error(`skill count must be a whole number between 0 and ${MAX_EVIDENCED_SKILLS}`);
      }
      const experienceTier = String(action.experienceTier ?? 'emerging');
      if (!EXPERIENCE_TIERS.has(experienceTier)) throw new Error('unknown experience tier');
      const primaryCategory = String(action.primaryCategory ?? 'general').toLowerCase();
      if (!KNOWN_CATEGORIES.has(primaryCategory)) throw new Error('unknown primary category');
      const specialties = (Array.isArray(action.specialties) ? action.specialties : [])
        .map((item: unknown) => String(item).trim().toLowerCase()).filter(Boolean).slice(0, 12);
      if (specialties.some((item: string) => !KNOWN_CATEGORIES.has(item))) throw new Error('unknown specialty category');
      const rawScores = (action.categoryScores && typeof action.categoryScores === 'object'
        && !Array.isArray(action.categoryScores)) ? action.categoryScores as Record<string, unknown> : {};
      const categoryScores: Record<string, number> = {};
      for (const [category, score] of Object.entries(rawScores).slice(0, 12)) {
        const value = Number(score);
        if (KNOWN_CATEGORIES.has(category.toLowerCase()) && Number.isFinite(value) && value >= 0) {
          categoryScores[category.toLowerCase()] = Math.min(1_000_000, Math.round(value));
        }
      }
      const avatarSpec = action.avatarSpec ?? agent.avatarSpec;
      // The evidence digest is private authority and lives on the agent alone;
      // the citizen row is a public projection and must never carry it.
      const genome = {
        categoryScores, specialties: specialties.length ? specialties : [agent.family],
        primaryCategory, skillCount, experienceTier: experienceTier as 'emerging' | 'practiced' | 'seasoned' | 'polymath',
        avatarSpec,
      };
      const previousTier = agent.experienceTier ?? 'emerging';
      await ctx.db.patch(agent._id, { ...genome, evidenceDigest });
      await ctx.db.patch(citizen._id, genome);
      if (previousTier !== experienceTier) {
        await ctx.db.insert('events', {
          kind: 'genome_sync', actorId: agentId,
          payload: { skillCount, primaryCategory, experienceTier, previousTier },
          gloss: `${citizen.name} grew into a ${experienceTier} citizen on ${skillCount} locally evidenced skills.`,
        });
      }
      return { ok: true, skillCount, experienceTier, primaryCategory, specialties: genome.specialties, tierChanged: previousTier !== experienceTier, warning };
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
      // Tokens are earned by giving verified knowledge away, never by asking.
      // The share id is unique, so this reward can only ever be paid once.
      const reward = await issue(ctx, {
        toAgentId: share.senderId, amount: GIFT_REWARD, kind: 'gift_reward',
        sourceId: `gift:${share.shareId}`,
        reason: `${citizen.name} verified and accepted the ${share.skill} knowledge card.`,
      });
      await ctx.db.insert('events', {
        kind: 'skill_verified', actorId: agentId, payload: { shareId: share.shareId, senderId: share.senderId, skill: share.skill },
        gloss: `${citizen.name} matched and accepted a signed ${share.skill} knowledge card${share.repoUrl ? ' after checking its repository root' : ''}. No code was installed.`,
      });
      if (reward.posted) {
        await ctx.db.insert('events', {
          kind: 'token_reward', actorId: share.senderId,
          payload: { shareId: share.shareId, amount: GIFT_REWARD, skill: share.skill },
          gloss: `${share.senderId} earned ${GIFT_REWARD} Earth Token for giving verified ${share.skill} knowledge away.`,
        });
      }
      return { ok: true, status: 'accepted', learning, executableInstalled: false, reward: reward.balance, warning };
    }

    if (action?.type === 'package_upload_url') {
      // Bytes go straight to storage; the Kernel never holds a payload in a row.
      return { ok: true, uploadUrl: await ctx.storage.generateUploadUrl(), maxBytes: MAX_PACKAGE_BYTES, warning };
    }

    if (action?.type === 'deposit_skill') {
      const title = String(action.name ?? '').trim().toLowerCase();
      const summary = String(action.summary ?? '').trim();
      const digest = String(action.digest ?? '').trim().toLowerCase();
      const normalizedDigest = String(action.normalizedDigest ?? '').trim().toLowerCase();
      const license = String(action.license ?? '').trim();
      const source = String(action.source ?? 'local');
      const sizeBytes = Number(action.sizeBytes ?? 0);
      const fileCount = Number(action.fileCount ?? 0);
      const priceTokens = Number(action.priceTokens ?? 0);
      if (!/^[a-z0-9][a-z0-9 _.+-]{1,63}$/.test(title)) throw new Error('use a valid 2-64 character skill name');
      if (!summary || summary.length > 400) throw new Error('deposit summary must be 1-400 characters');
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('a deterministic pack digest is required');
      if (!/^[a-f0-9]{64}$/.test(normalizedDigest)) throw new Error('a normalized content digest is required');
      if (!['local', 'plugin', 'github'].includes(source)) throw new Error('deposit source must be local, plugin, or github');
      if (!license || license.length > 60) throw new Error('name the licence the Bank may distribute copies under');
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PACKAGE_BYTES) throw new Error('deposit size is out of range');
      if (!Number.isInteger(fileCount) || fileCount <= 0 || fileCount > 400) throw new Error('deposit file count is out of range');
      if (!Number.isInteger(priceTokens) || priceTokens < 0 || priceTokens > 1000) throw new Error('price must be 0-1000 Earth Tokens');
      const categories = (Array.isArray(action.categories) ? action.categories : [])
        .map((item: unknown) => String(item).toLowerCase()).filter((item: string) => KNOWN_CATEGORIES.has(item)).slice(0, 4);
      const safetyInput = action.safety ?? {};
      const verdict = String(safetyInput.verdict ?? '');
      if (!['inert_safe', 'needs_review'].includes(verdict)) throw new Error('refused packages are never banked');
      const safety = {
        verdict: verdict as 'inert_safe' | 'needs_review',
        flags: (Array.isArray(safetyInput.flags) ? safetyInput.flags : []).map((flag: unknown) => String(flag)).slice(0, 12),
        note: String(safetyInput.note ?? '').slice(0, 800),
        scannerVersion: String(safetyInput.scannerVersion ?? 'unknown').slice(0, 40),
      };
      const now = Date.now();

      // Master-copy law: one asset per piece of knowledge. Byte identity first,
      // then word identity, so a reformatted copy links instead of banking twice.
      const exact = await ctx.db.query('bankAssets').withIndex('digest', (q) => q.eq('digest', digest)).first();
      const near = exact ?? await ctx.db.query('bankAssets')
        .withIndex('normalizedDigest', (q) => q.eq('normalizedDigest', normalizedDigest)).first();
      if (near) {
        if (near.depositorAgentId === agentId || near.alsoDepositedBy.includes(agentId)) {
          return { ok: true, duplicate: exact ? 'exact' : 'near', assetId: near.assetId, alreadyLinked: true, warning };
        }
        await ctx.db.patch(near._id, { alsoDepositedBy: [...near.alsoDepositedBy, agentId], updatedAt: now });
        await ctx.db.insert('events', {
          kind: 'bank_deposit_linked', actorId: agentId,
          payload: { assetId: near.assetId, title, duplicate: exact ? 'exact' : 'near' },
          gloss: `${citizen.name} brought ${title} to the Earth Bank; the vault already holds this knowledge, so their copy was linked to the master.`,
        });
        return { ok: true, duplicate: exact ? 'exact' : 'near', assetId: near.assetId, alreadyLinked: false, warning };
      }

      const storageId = String(action.storageId ?? '');
      if (!storageId) throw new Error('the Bank keeps the master bytes; a storage id is required');
      const held = (await ctx.db.query('bankAssets')
        .withIndex('depositor_created', (q) => q.eq('depositorAgentId', agentId)).collect())
        .filter((row) => row.state !== 'retired').reduce((total, row) => total + row.sizeBytes, 0);
      if (held + sizeBytes > 250 * 1024 * 1024) throw new Error('this citizen has reached the 250MB Bank deposit quota');

      const doc = await ctx.db.insert('bankAssets', {
        assetId: 'pending', digest, normalizedDigest, title, summary,
        depositorAgentId: agentId, alsoDepositedBy: [],
        categories: categories.length ? categories : ['general'],
        sizeBytes, fileCount, storageId: storageId as never, license,
        source: source as 'local' | 'plugin' | 'github', safety, priceTokens,
        state: verdict === 'inert_safe' ? 'deposited' : 'flagged',
        createdAt: now, updatedAt: now,
      });
      const assetId = `asset:${doc}`;
      await ctx.db.patch(doc, { assetId });
      await recordContribution(ctx, agentId, 'civic', 'bank_deposit', 2, assetId,
        `Deposited ${title} into the Earth Bank as community knowledge.`, now);
      await ctx.db.insert('events', {
        kind: 'bank_deposit', actorId: agentId,
        payload: { assetId, title, sizeBytes, flagged: verdict !== 'inert_safe' },
        gloss: verdict === 'inert_safe'
          ? `${citizen.name} deposited ${title} into the Earth Bank vault.`
          : `${citizen.name} deposited ${title} into the Earth Bank; it waits in the vault for a safety review before anyone may withdraw a copy.`,
      });
      const portfolio = (await ctx.db.query('bankAssets')
        .withIndex('depositor_created', (q) => q.eq('depositorAgentId', agentId)).collect())
        .filter((row) => row.state !== 'retired');
      return {
        ok: true, assetId, state: verdict === 'inert_safe' ? 'deposited' : 'flagged',
        netWorth: { assets: portfolio.length, bytes: portfolio.reduce((total, row) => total + row.sizeBytes, 0) },
        warning,
      };
    }

    if (action?.type === 'publish_package') {
      const name = String(action.name ?? '').trim().toLowerCase();
      const category = String(action.category ?? '').trim().toLowerCase();
      const summary = String(action.summary ?? '').trim();
      const digest = String(action.digest ?? '').trim().toLowerCase();
      const license = String(action.license ?? '').trim();
      if (!/^[a-z0-9][a-z0-9 _.+-]{1,63}$/.test(name)) throw new Error('use a valid 2-64 character package name');
      if (!KNOWN_CATEGORIES.has(category)) throw new Error('unknown package category');
      if (!summary || summary.length > 400) throw new Error('package summary must be 1-400 characters');
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('a SHA-256 package digest is required');
      if (license.length < 2 || license.length > 64) throw new Error('name the licence this knowledge ships under');
      const senderCategories = (citizen.specialties ?? [citizen.family]).map((item: string) => item.toLowerCase());
      if (!senderCategories.includes(category)) throw new Error('publish only in a category this citizen has locally evidenced');

      const sizeBytes = Number(action.sizeBytes);
      const fileCount = Number(action.fileCount);
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Error('package size must be a whole number of bytes');
      if (sizeBytes > MAX_PACKAGE_BYTES) {
        throw new Error(`packages are capped at ${MAX_PACKAGE_BYTES} bytes; share larger knowledge as a verified repository root`);
      }
      if (!Number.isInteger(fileCount) || fileCount <= 0 || fileCount > 5_000) throw new Error('package file count must be between 1 and 5000');
      const priceTokens = Number(action.priceTokens ?? 1);
      if (!Number.isInteger(priceTokens) || priceTokens < 0 || priceTokens > 500) throw new Error('price must be a whole number of Earth Tokens up to 500');

      const safety = action.safety ?? {};
      const verdict = String(safety.verdict ?? '');
      if (!['inert_safe', 'needs_review', 'refused'].includes(verdict)) throw new Error('a scanner verdict is required before publishing');
      if (verdict === 'refused') throw new Error('a refused package is never listed on Earth');
      const flags = (Array.isArray(safety.flags) ? safety.flags : [])
        .map((flag: unknown) => String(flag).slice(0, 80)).slice(0, 24);
      const note = String(safety.note ?? '').slice(0, 800);
      const scannerVersion = String(safety.scannerVersion ?? '').slice(0, 32);
      if (!scannerVersion) throw new Error('the scanner must identify its version');

      const sourceKind = action.storageId ? 'blob' as const : 'repo' as const;
      const repoUrl = normalizeGithubRepository(action.repoUrl);
      if (sourceKind === 'repo' && !repoUrl) throw new Error('attach package bytes or an https://github.com/<owner>/<repo> root');

      const existing = (await ctx.db.query('skillPackages').withIndex('owner_created', (q) => q.eq('ownerAgentId', agentId)).collect());
      const held = existing.filter((row) => row.state === 'listed').reduce((total, row) => total + row.sizeBytes, 0);
      if (held + sizeBytes > MAX_PACKAGE_QUOTA_BYTES) {
        throw new Error(`this citizen already publishes ${held} bytes; the quota is ${MAX_PACKAGE_QUOTA_BYTES}`);
      }
      const duplicate = existing.find((row) => row.name === name && row.state === 'listed');
      const now = Date.now();
      const record = {
        ownerAgentId: agentId, name, category, summary, digest, sizeBytes, fileCount, license,
        priceTokens, sourceKind, repoUrl, storageId: action.storageId,
        safety: { verdict: verdict as 'inert_safe' | 'needs_review', flags, note, scannerVersion },
        state: 'listed' as const, updatedAt: now,
      };
      if (duplicate) {
        await ctx.db.patch(duplicate._id, record);
        return { ok: true, packageId: duplicate.packageId, replaced: true, warning };
      }
      const doc = await ctx.db.insert('skillPackages', { packageId: 'pending', createdAt: now, ...record });
      const packageId = `pkg:${doc}`;
      await ctx.db.patch(doc, { packageId });
      await ctx.db.insert('events', {
        kind: 'package_published', actorId: agentId,
        payload: { packageId, name, category, sizeBytes, verdict, priceTokens },
        gloss: `${citizen.name} published the ${name} knowledge package for the ${category} community.`,
      });
      return { ok: true, packageId, replaced: false, warning };
    }

    if (action?.type === 'search_packages') {
      // Manifests only. Bytes never travel through a search.
      const query = String(action.query ?? '').trim().toLowerCase().slice(0, 80);
      const category = String(action.category ?? '').trim().toLowerCase();
      const maxBytes = Number.isInteger(Number(action.maxBytes)) ? Number(action.maxBytes) : MAX_PACKAGE_BYTES;
      const rows = await ctx.db.query('skillPackages').order('desc').take(300);
      const packages = rows
        .filter((row) => row.state === 'listed' && row.sizeBytes <= maxBytes)
        .filter((row) => !category || row.category === category)
        .filter((row) => !query || row.name.includes(query) || row.summary.toLowerCase().includes(query))
        .slice(0, 40)
        .map((row) => ({
          packageId: row.packageId, name: row.name, category: row.category, summary: row.summary,
          digest: row.digest, sizeBytes: row.sizeBytes, fileCount: row.fileCount, license: row.license,
          priceTokens: row.priceTokens, sourceKind: row.sourceKind, repoUrl: row.repoUrl,
          ownerAgentId: row.ownerAgentId, safety: row.safety, mine: row.ownerAgentId === agentId,
        }));
      return { ok: true, packages, balance: await balanceOf(ctx, agentId), warning };
    }

    if (action?.type === 'request_package') {
      const packageId = String(action.packageId ?? '').trim();
      const pack = await ctx.db.query('skillPackages').withIndex('packageId', (q) => q.eq('packageId', packageId)).first();
      if (!pack || pack.state !== 'listed') throw new Error('that package is not listed');
      if (pack.ownerAgentId === agentId) throw new Error('this citizen already holds that package');
      const balance = await balanceOf(ctx, agentId);
      if (balance < pack.priceTokens) throw new Error(`this package costs ${pack.priceTokens} Earth Tokens and this citizen holds ${balance}`);
      const open = (await ctx.db.query('skillTrades').withIndex('requester_created', (q) => q.eq('requesterId', agentId)).order('desc').take(50))
        .find((row) => row.packageId === packageId && ['proposed', 'delivered'].includes(row.state));
      if (open) return { ok: true, tradeId: open.tradeId, state: open.state, existing: true, warning };

      const now = Date.now();
      const doc = await ctx.db.insert('skillTrades', {
        tradeId: 'pending', packageId, requesterId: agentId, providerId: pack.ownerAgentId,
        priceTokens: pack.priceTokens, state: 'proposed', createdAt: now, updatedAt: now,
      });
      const tradeId = `trade:${doc}`;
      await ctx.db.patch(doc, { tradeId });
      await insertMessage(ctx, agentId, pack.ownerAgentId,
        `${citizen.name} asked for your ${pack.name} knowledge package (${tradeId}). Answer with Earth respond-package.`, 'letter');
      await ctx.db.insert('events', {
        kind: 'package_requested', actorId: agentId,
        payload: { tradeId, packageId, providerId: pack.ownerAgentId, name: pack.name },
        gloss: `${citizen.name} asked for the ${pack.name} knowledge package.`,
      });
      return { ok: true, tradeId, state: 'proposed', existing: false, warning };
    }

    if (action?.type === 'respond_package') {
      const tradeId = String(action.tradeId ?? '').trim();
      const decision = String(action.decision ?? 'accept');
      if (!['accept', 'decline'].includes(decision)) throw new Error('a package decision must be accept or decline');
      const trade = await ctx.db.query('skillTrades').withIndex('tradeId', (q) => q.eq('tradeId', tradeId)).first();
      if (!trade || trade.providerId !== agentId || trade.state !== 'proposed') throw new Error('that trade is not awaiting this citizen');
      const now = Date.now();
      if (decision === 'decline') {
        await ctx.db.patch(trade._id, { state: 'declined', updatedAt: now, note: String(action.note ?? '').slice(0, 240) });
        // Declines stay private: no public event, exactly like friendship declines.
        await insertMessage(ctx, agentId, trade.requesterId,
          `${citizen.name} declined to share that package for now.`, 'letter');
        return { ok: true, state: 'declined', warning };
      }
      const pack = await ctx.db.query('skillPackages').withIndex('packageId', (q) => q.eq('packageId', trade.packageId)).first();
      if (!pack || pack.state !== 'listed') throw new Error('that package is no longer listed');

      // Giving knowledge away is consequential, so standing consent decides
      // whether the agent may do it alone. Active autonomy covers routine,
      // inert releases; anything else waits for the owner (MASTER-PLAN law 3).
      const routine = (agent.autonomy ?? 'light') === 'active'
        && pack.safety.verdict === 'inert_safe'
        && trade.priceTokens <= ROUTINE_RELEASE_PRICE;
      if (!routine) {
        const open = (await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', agentId).eq('state', 'pending')).collect())
          .find((row) => row.kind === 'package_release' && row.payload?.tradeId === trade.tradeId);
        if (open) return { ok: true, state: 'pending_owner', approvalId: String(open._id), warning };
        const approvalId = await insertApproval(ctx, agentId, 'package_release',
          `Release ${pack.name} to ${trade.requesterId}`,
          `${trade.requesterId} asked for your ${pack.name} package (${pack.sizeBytes} bytes, ${pack.safety.verdict}) for ${trade.priceTokens} Earth Token(s). Nothing leaves this agent until you approve.`,
          { tradeId: trade.tradeId, name: pack.name, requesterId: trade.requesterId, flags: pack.safety.flags },
          pack.safety.verdict === 'inert_safe' ? 'review' : 'strict');
        await notifyOwner(ctx, agentId, 'approval', `${pack.name} is requested by another citizen`,
          `${trade.requesterId} asked for it. Approve in Earth Skills to release it.`, approvalId);
        return { ok: true, state: 'pending_owner', approvalId: String(approvalId), warning };
      }
      const released = await releasePackage(ctx, trade, pack, citizen.name);
      return { ok: true, ...released, warning };
    }

    if (action?.type === 'fetch_package') {
      const tradeId = String(action.tradeId ?? '').trim();
      const trade = await ctx.db.query('skillTrades').withIndex('tradeId', (q) => q.eq('tradeId', tradeId)).first();
      if (!trade || trade.requesterId !== agentId) throw new Error('that trade does not belong to this citizen');
      if (!['delivered', 'installed'].includes(trade.state)) throw new Error('that package has not been delivered yet');
      const pack = await ctx.db.query('skillPackages').withIndex('packageId', (q) => q.eq('packageId', trade.packageId)).first();
      if (!pack) throw new Error('that package no longer exists');
      return {
        ok: true, tradeId, name: pack.name, category: pack.category, digest: pack.digest,
        sizeBytes: pack.sizeBytes, license: pack.license, safety: pack.safety,
        sourceKind: pack.sourceKind, repoUrl: pack.repoUrl,
        downloadUrl: pack.storageId ? await ctx.storage.getUrl(pack.storageId) : null,
        warning,
      };
    }

    if (action?.type === 'confirm_install') {
      const tradeId = String(action.tradeId ?? '').trim();
      const outcome = String(action.outcome ?? 'installed');
      if (!['installed', 'failed'].includes(outcome)) throw new Error('an install outcome must be installed or failed');
      const trade = await ctx.db.query('skillTrades').withIndex('tradeId', (q) => q.eq('tradeId', tradeId)).first();
      if (!trade || trade.requesterId !== agentId || trade.state !== 'delivered') throw new Error('that trade is not awaiting an install result');
      const pack = await ctx.db.query('skillPackages').withIndex('packageId', (q) => q.eq('packageId', trade.packageId)).first();
      const now = Date.now();
      await ctx.db.patch(trade._id, { state: outcome as 'installed' | 'failed', updatedAt: now, note: String(action.note ?? '').slice(0, 240) });
      if (outcome === 'failed') return { ok: true, state: 'failed', warning };

      // The larger reward lands only once a recipient reports a real install.
      const reward = await issue(ctx, {
        toAgentId: trade.providerId, amount: INSTALL_REWARD, kind: 'gift_reward',
        sourceId: `install:${trade.tradeId}`,
        reason: `${citizen.name} installed the ${pack?.name ?? 'shared'} package.`,
      });
      if (reward.posted) {
        await ctx.db.insert('events', {
          kind: 'token_reward', actorId: trade.providerId,
          payload: { tradeId: trade.tradeId, amount: INSTALL_REWARD, name: pack?.name },
          gloss: `${trade.providerId} earned ${INSTALL_REWARD} Earth Tokens: their knowledge is now running on another citizen's machine.`,
        });
      }
      return { ok: true, state: 'installed', providerBalance: reward.balance, warning };
    }

    if (action?.type === 'report_held_package') {
      // The package itself stays on the owner's machine. Only the verdict, the
      // flags, and the scanner's note travel, so the owner can read exactly why
      // it was held without the bytes ever reaching Earth.
      const tradeId = String(action.tradeId ?? '').trim();
      const trade = await ctx.db.query('skillTrades').withIndex('tradeId', (q) => q.eq('tradeId', tradeId)).first();
      if (!trade || trade.requesterId !== agentId) throw new Error('that trade does not belong to this citizen');
      const name = String(action.name ?? '').trim().slice(0, 64);
      const verdict = String(action.verdict ?? '');
      if (!['needs_review', 'refused'].includes(verdict)) throw new Error('only held or refused packages are reported');
      const flags = (Array.isArray(action.flags) ? action.flags : []).map((flag: unknown) => String(flag).slice(0, 80)).slice(0, 24);
      const note = String(action.note ?? '').slice(0, 4_000);
      const open = (await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', agentId).eq('state', 'pending')).collect())
        .find((row) => row.kind === 'package_install' && row.payload?.tradeId === tradeId);
      if (open) return { ok: true, approvalId: String(open._id), existing: true, warning };
      const approvalId = await insertApproval(ctx, agentId, 'package_install',
        `Review the ${name} knowledge package`,
        note || 'The scanner held this package for review.',
        { tradeId, name, verdict, flags, providerId: trade.providerId }, 'review');
      await notifyOwner(ctx, agentId, 'approval', `${name} is waiting in Earth Skills`,
        `${citizen.name} acquired ${name} and the safety review held it: ${flags.join(', ') || 'see the note'}. Nothing was installed.`,
        approvalId);
      return { ok: true, approvalId: String(approvalId), existing: false, warning };
    }

    if (action?.type === 'equip') {
      const tool = String(action.tool ?? '').trim().toLowerCase();
      const unlock = TOOL_UNLOCKS[tool];
      if (!unlock) throw new Error(`choose a tool: ${Object.keys(TOOL_UNLOCKS).join(', ')}`);
      const rank = rankSnapshot(await ctx.db.query('contributions')
        .withIndex('agent_created', (q) => q.eq('agentId', agentId)).collect());
      if (rank.score < unlock.minimumScore) {
        throw new Error(`the ${tool} is earned at ${unlock.minimumScore} contribution points; this citizen has ${rank.score}`);
      }
      const owned = await ctx.db.query('agentTools')
        .withIndex('agent_tool', (q) => q.eq('agentId', agentId).eq('tool', tool)).first();
      if (!owned) {
        await ctx.db.insert('agentTools', { agentId, tool, earnedAt: Date.now(), sourceId: `tool:${agentId}:${tool}` });
      }
      // Carried, not in use: the renderer only animates work while it happens.
      await ctx.db.patch(citizen._id, { carriedTool: tool });
      return { ok: true, tool, earnedAt: owned?.earnedAt ?? Date.now(), warning };
    }

    if (['plant', 'water', 'harvest', 'gather'].includes(String(action?.type ?? ''))) {
      const kind = String(action.type);
      const x = Number(action.x), y = Number(action.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('give integer tile coordinates');
      const zones = await ctx.db.query('activityZones').collect();
      const zone = zones.find((one) => x >= one.x && x < one.x + one.w && y >= one.y && y < one.y + one.h);
      if (!zone) throw new Error(`(${x},${y}) is not inside a community activity zone; run Earth zones to find one`);
      if (kind === 'gather' ? zone.kind === 'farm' : zone.kind !== 'farm') {
        throw new Error(`${kind} belongs in a ${kind === 'gather' ? 'forest, orchard, or quarry' : 'farm'}, not ${zone.name}`);
      }
      if (zone.tool !== 'none' && citizen.carriedTool !== zone.tool) {
        throw new Error(`${zone.name} needs the ${zone.tool}; run Earth equip ${zone.tool} first`);
      }

      // Work happens where the citizen stands. If they are elsewhere, the
      // Kernel walks them there and awards nothing until they arrive.
      const now = Date.now();
      const here = currentPosition(citizen, now);
      if (Math.hypot(here.x - x, here.y - y) > 1.6) {
        const route = await routeCitizenNear(ctx, citizen, x, y, `walking to ${zone.name}`, now);
        if (!route.length) throw new Error('no safe route reaches that tile right now');
        // Hold the errand. Construction and training already claim their trips;
        // without this a citizen sent to the fields gets pulled away by an
        // ambient drive halfway there and the work never happens.
        const arrivesAt = route[route.length - 1].at;
        await ctx.db.patch(citizen._id, { workingUntil: arrivesAt + WORK_ARRIVAL_GRACE_MS });
        return { ok: true, routed: true, arrivesAt, zone: zone.name, warning };
      }

      if (kind === 'plant') {
        const crop = String(action.crop ?? 'grain').trim().toLowerCase();
        if (!CROPS.has(crop)) throw new Error(`plant one of: ${[...CROPS].join(', ')}`);
        const standing = (await ctx.db.query('farmPlots').withIndex('zone_planted', (q) => q.eq('zoneId', zone.zoneId)).collect())
          .find((row) => row.x === x && row.y === y && !row.harvestedAt);
        if (standing) throw new Error('something is already growing on that tile');
        const doc = await ctx.db.insert('farmPlots', {
          fieldId: 'pending', zoneId: zone.zoneId, x, y, crop, plantedBy: agentId,
          plantedAt: now, readyAt: now + CROP_GROWTH_MS, tendedBy: [],
        });
        const fieldId = `field:${doc}`;
        await ctx.db.patch(doc, { fieldId });
        await ctx.db.patch(citizen._id, {
          activity: `planting ${crop} at ${zone.name}`,
          activeTool: zone.tool, workingUntil: now + WORK_ANIMATION_MS,
        });
        await recordContribution(ctx, agentId, 'civic', 'planted_crop', 1, fieldId,
          `${citizen.name} planted ${crop} at ${zone.name}.`, now);
        await ctx.db.insert('events', {
          kind: 'crop_planted', actorId: agentId, payload: { fieldId, zoneId: zone.zoneId, crop, x, y },
          gloss: `${citizen.name} planted ${crop} at ${zone.name}.`,
        });
        return { ok: true, fieldId, crop, readyAt: now + CROP_GROWTH_MS, warning };
      }

      const field = (await ctx.db.query('farmPlots').withIndex('zone_planted', (q) => q.eq('zoneId', zone.zoneId)).collect())
        .find((row) => row.x === x && row.y === y && !row.harvestedAt);

      if (kind === 'water') {
        if (!field) throw new Error('nothing is growing on that tile');
        if (field.tendedBy.includes(agentId)) throw new Error('this citizen already watered that field');
        // Watering is cooperative: each new pair of hands brings the harvest
        // closer, which is why a field is worth tending together.
        await ctx.db.patch(field._id, {
          tendedBy: [...field.tendedBy, agentId].slice(0, 12),
          readyAt: Math.max(now, field.readyAt - CROP_TEND_RELIEF_MS),
        });
        await ctx.db.patch(citizen._id, {
          activity: `watering ${field.crop} at ${zone.name}`,
          activeTool: zone.tool, workingUntil: now + WORK_ANIMATION_MS,
        });
        await recordContribution(ctx, agentId, 'civic', 'tended_crop', 1, `tend:${field.fieldId}:${agentId}`,
          `${citizen.name} watered ${field.crop} at ${zone.name}.`, now);
        await ctx.db.insert('events', {
          kind: 'crop_tended', actorId: agentId, payload: { fieldId: field.fieldId, crop: field.crop },
          gloss: `${citizen.name} watered the ${field.crop} at ${zone.name}. It ripens sooner now.`,
        });
        return { ok: true, fieldId: field.fieldId, readyAt: Math.max(now, field.readyAt - CROP_TEND_RELIEF_MS), warning };
      }

      if (kind === 'harvest') {
        if (!field) throw new Error('nothing is growing on that tile');
        if (now < field.readyAt) {
          const minutes = Math.ceil((field.readyAt - now) / 60_000);
          throw new Error(`that ${field.crop} needs about ${minutes} more minute(s); water it to bring the harvest closer`);
        }
        await ctx.db.patch(field._id, { harvestedBy: agentId, harvestedAt: now });
        await ctx.db.patch(citizen._id, {
          activity: `harvesting ${field.crop} at ${zone.name}`,
          activeTool: zone.tool, workingUntil: now + WORK_ANIMATION_MS,
        });
        const helpers = new Set([field.plantedBy, ...field.tendedBy, agentId]);
        for (const helper of helpers) {
          await recordContribution(ctx, helper, 'civic', 'harvest_share', 2, `harvest:${field.fieldId}:${helper}`,
            `${field.crop} came in at ${zone.name} through shared work.`, now);
        }
        await ctx.db.insert('events', {
          kind: 'crop_harvested', actorId: agentId,
          payload: { fieldId: field.fieldId, crop: field.crop, helpers: helpers.size },
          gloss: `${citizen.name} brought in the ${field.crop} at ${zone.name}. ${helpers.size} citizen(s) share the credit.`,
        });
        return { ok: true, fieldId: field.fieldId, crop: field.crop, helpers: helpers.size, warning };
      }

      // gather: forest, orchard, and quarry work, paced so it cannot be spammed.
      const recent = (await ctx.db.query('contributions').withIndex('agent_created', (q) => q.eq('agentId', agentId)).order('desc').take(20))
        .find((row) => row.kind === 'gathered' && now - row.createdAt < GATHER_COOLDOWN_MS);
      if (recent) {
        throw new Error(`this citizen is resting; gathering is possible again in about ${Math.ceil((GATHER_COOLDOWN_MS - (now - recent.createdAt)) / 60_000)} minute(s)`);
      }
      await ctx.db.patch(citizen._id, {
        activity: `working at ${zone.name}`,
        activeTool: zone.tool, workingUntil: now + WORK_ANIMATION_MS,
      });
      await recordContribution(ctx, agentId, 'civic', 'gathered', 2, `gather:${agentId}:${now}`,
        `${citizen.name} worked at ${zone.name} with the ${zone.tool}.`, now);
      await ctx.db.insert('events', {
        kind: 'zone_gathered', actorId: agentId, payload: { zoneId: zone.zoneId, tool: zone.tool },
        gloss: `${citizen.name} put in a shift at ${zone.name}.`,
      });
      return { ok: true, zone: zone.name, tool: zone.tool, warning };
    }

    if (action?.type === 'send_tokens') {
      const targetId = String(action.agentId ?? '').trim();
      const amount = Number(action.amount);
      const note = String(action.note ?? '').trim();
      if (!targetId || targetId === agentId) throw new Error('choose another citizen to send to');
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('send a whole number of Earth Tokens above zero');
      if (note.length > 200) throw new Error('keep the note under 200 characters');
      const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!recipient) throw new Error('no citizen with that id lives here');
      const held = await balanceOf(ctx, agentId);
      if (held < amount) throw new Error(`this citizen holds ${held} Earth Token(s); that send needs ${amount}`);

      // Sending an owner's earned tokens is consequential. Standing consent
      // covers small ordinary gifts; anything larger waits for the owner.
      const routine = (agent.autonomy ?? 'light') === 'active' && amount <= ROUTINE_SEND_AMOUNT;
      if (!routine) {
        const approvalId = await insertApproval(ctx, agentId, 'token_transfer',
          `Send ${amount} Earth Token(s) to ${recipient.name}`,
          `${citizen.name} wants to send ${amount} of its ${held} Earth Token(s) to ${recipient.name} (${targetId}).`
          + (note ? ` Note: "${note}"` : '') + ' Nothing moves until you approve.',
          { targetAgentId: targetId, amount, note },
          amount > ROUTINE_SEND_AMOUNT * 4 ? 'strict' : 'review');
        await notifyOwner(ctx, agentId, 'approval', 'A token transfer needs your decision',
          `${amount} Earth Token(s) to ${recipient.name}. Approve in your wallet.`, approvalId);
        return { ok: true, state: 'pending_owner', approvalId: String(approvalId), warning };
      }
      const sent = await sendTokens(ctx, {
        fromAgentId: agentId, toAgentId: targetId, amount,
        reason: note || `${citizen.name} sent ${amount} Earth Token(s) to ${recipient.name}.`,
      });
      await ctx.db.insert('events', {
        kind: 'token_transfer', actorId: agentId, payload: { targetId, amount },
        gloss: `${citizen.name} sent ${amount} Earth Token(s) to ${recipient.name}.`,
      });
      return { ok: true, state: 'sent', amount, entryId: sent.entryId, balance: await balanceOf(ctx, agentId), warning };
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
        `${citizen.name} chose ${plotId}. Terra will validate it before Mayor Sam makes the routine civic decision.`, approvalId);
      return { ok: true, awaitingOwner: true, approvalId, warning };
    }

    if (action?.type === 'build' || action?.type === 'construct_structure') {
      let structure: string;
      let plot: any;
      let payload: any;
      if (action.type === 'construct_structure') {
        const prepared = await lpcBuildPayload(ctx, agentId, action);
        structure = 'blueprint';
        plot = prepared.plot;
        payload = prepared.payload;
      } else {
        structure = String(action.structure ?? '');
        if (!['home', 'extension', 'garden', 'bench', 'blueprint'].includes(structure)) throw new Error('unsupported structure');
        plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first();
        if (!plot) throw new Error('claim a plot before building');
        payload = { plotId: plot.plotId, structure, blueprint: action.blueprint };
      }
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

    if (action?.type === 'drive_bias') {
      // H5 reflection feedback: traits grown from lived local history set how
      // strongly each ambient drive pulls. Computed client-side (BYOB), the
      // Kernel only clamps and stores - it never invents personality.
      const KEYS = ['social', 'curiosity', 'industry', 'rest', 'civic'] as const;
      const bias: Record<string, number> = {};
      for (const key of KEYS) {
        const value = Math.round(Number((action.bias ?? {})[key]));
        if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error('each drive bias must be an integer from 1 to 10');
        bias[key] = value;
      }
      await ctx.db.patch(citizen._id, { driveBias: bias as any });
      return { ok: true, driveBias: bias, warning };
    }

    if (action?.type === 'day_plan') {
      // H4 owner-brain plans: the owner's real LLM wrote this while the session
      // was awake; the Kernel only validates and stores it (BYOB - no server LLM).
      const rawSteps = Array.isArray(action.steps) ? action.steps : [];
      if (!rawSteps.length || rawSteps.length > 8) throw new Error('a day plan holds 1-8 steps');
      const world = await ensureWorldState(ctx);
      const KINDS = ['visit', 'work', 'study', 'social', 'rest', 'civic', 'walk'];
      const steps = rawSteps.map((raw: any) => {
        const kind = String(raw.kind ?? 'walk').toLowerCase();
        if (!KINDS.includes(kind)) throw new Error(`plan step kind must be one of ${KINDS.join(', ')}`);
        const why = String(raw.why ?? '').trim();
        if (why.length < 3 || why.length > 140) throw new Error('every plan step needs a 3-140 character reason');
        const step: { kind: string; why: string; x?: number; y?: number } = { kind, why };
        if (raw.x !== undefined || raw.y !== undefined) {
          const x = Math.round(Number(raw.x));
          const y = Math.round(Number(raw.y));
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1 || y < 1 || x >= world.width - 1 || y >= world.height - 1)
            throw new Error('plan step coordinates must sit inside the world');
          step.x = x; step.y = y;
        }
        return step;
      });
      const now = Date.now();
      const previous = await ctx.db.query('dayPlans').withIndex('agentId', (q) => q.eq('agentId', agentId)).collect();
      for (const rowToClear of previous) await ctx.db.delete(rowToClear._id);
      await ctx.db.insert('dayPlans', { agentId, steps, stepIndex: 0, createdAt: now, expiresAt: now + 24 * 3600_000 });
      await ctx.db.insert('events', {
        kind: 'day_plan', actorId: agentId, payload: { steps: steps.length },
        gloss: `${citizen.name} sketched a plan for the day ahead - ${steps.length} intentions to follow.`,
      });
      return { ok: true, steps: steps.length, expiresInHours: 24, warning };
    }

    if (action?.type === 'workplace_invite') {
      const buildId = String(action.buildId ?? '').trim();
      const inviteeId = String(action.agentId ?? '').trim();
      if (!inviteeId || inviteeId === agentId) throw new Error('choose a friend to invite');
      const build = await ctx.db.query('builds').withIndex('buildId', (q) => q.eq('buildId', buildId)).first();
      if (!build || build.ownerAgentId !== agentId) throw new Error('only the workplace owner can invite operators');
      const buildKind = build.blueprint?.kind ?? build.structure;
      if (!['data_center', 'industry'].includes(buildKind)) throw new Error('only data centers and industry halls have operations rooms');
      const workBond = [
        ...await ctx.db.query('friendships').withIndex('requesterId', (q) => q.eq('requesterId', agentId)).collect(),
        ...await ctx.db.query('friendships').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect(),
      ].find((row: any) => [row.requesterId, row.recipientId].includes(inviteeId) && row.status === 'accepted');
      if (!workBond) throw new Error('operators are invited from accepted friendships');
      const workRoomId = `room:work:${buildId}`;
      const workRoom = await ctx.db.query('rooms').withIndex('roomId', (q) => q.eq('roomId', workRoomId)).first();
      if (!workRoom) throw new Error('workplace room is missing');
      if (!workRoom.participantIds.includes(inviteeId)) {
        await ctx.db.patch(workRoom._id, { participantIds: [...workRoom.participantIds, inviteeId].sort() });
        await insertMessage(ctx, agentId, inviteeId,
          `${citizen.name} invited you to operate ${build.blueprint?.name ?? buildKind}. Its private operations room now reaches your pulse.`, 'letter');
      }
      return { ok: true, roomId: workRoomId, warning };
    }

    if (action?.type === 'room_share') {
      // D2 personal rooms: a private shelf per friendship. Kernel-stored,
      // participants only - never projected into the public world.
      const friendId = String(action.agentId ?? '').trim();
      const note = String(action.body ?? '').trim();
      if (!friendId || friendId === agentId) throw new Error('choose a friend to share with');
      if (note.length < 1 || note.length > 600) throw new Error('room notes hold 1-600 characters');
      const bond = [
        ...await ctx.db.query('friendships').withIndex('requesterId', (q) => q.eq('requesterId', agentId)).collect(),
        ...await ctx.db.query('friendships').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect(),
      ].find((row: any) => [row.requesterId, row.recipientId].includes(friendId) && row.status === 'accepted');
      if (!bond) throw new Error('personal rooms open only between accepted friends');
      const roomId = 'room:' + [agentId, friendId].sort().join('+');
      const now = Date.now();
      if (!await ctx.db.query('rooms').withIndex('roomId', (q) => q.eq('roomId', roomId)).first()) {
        await ctx.db.insert('rooms', { roomId, participantIds: [agentId, friendId].sort(), createdAt: now });
      }
      await ctx.db.insert('roomNotes', { roomId, authorId: agentId, body: note, createdAt: now });
      // No public event, ever: the room is the point.
      return { ok: true, roomId, private: true, warning };
    }

    if (action?.type === 'commission_request') {
      const workerId = String(action.agentId ?? '').trim();
      const brief = String(action.brief ?? '').trim();
      if (!workerId || workerId === agentId) throw new Error('choose a friend to commission');
      if (brief.length < 10 || brief.length > 280) throw new Error('describe the commission in 10-280 characters');
      const bond = [
        ...await ctx.db.query('friendships').withIndex('requesterId', (q) => q.eq('requesterId', agentId)).collect(),
        ...await ctx.db.query('friendships').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect(),
      ].find((row: any) => [row.requesterId, row.recipientId].includes(workerId) && row.status === 'accepted');
      if (!bond) throw new Error('commissions travel along accepted friendships; befriend them first');
      const open = (await ctx.db.query('commissions').withIndex('workerId', (q) => q.eq('workerId', workerId)).collect())
        .find((row: any) => row.clientId === agentId && ['offered', 'accepted'].includes(row.status));
      if (open) throw new Error(`a commission is already open as ${open.commissionId}`);
      const worker = await requireActiveAgent(ctx, workerId);
      const now = Date.now();
      const doc = await ctx.db.insert('commissions', {
        commissionId: 'pending', clientId: agentId, workerId, brief, status: 'offered', createdAt: now, updatedAt: now,
      });
      const commissionId = `commission:${doc}`;
      await ctx.db.patch(doc, { commissionId });
      // The worker's OWNER hears about it instantly, before the agent commits.
      const approvalId = await insertApproval(ctx, workerId, 'commission_offer',
        `Commission from ${citizen.name}`, brief, { commissionId, clientId: agentId, brief }, 'review');
      await notifyOwner(ctx, workerId, 'approval', 'Commission offer for your agent',
        `${citizen.name} asked ${worker.name} to take on paid-in-credit work: "${brief.slice(0, 120)}". Your agent commits only if you approve.`, approvalId);
      await insertMessage(ctx, agentId, workerId,
        `${citizen.name} offered you a commission: "${brief.slice(0, 160)}". Your owner decides before any work starts.`, 'letter');
      return { ok: true, commissionId, awaitingOwner: true, approvalId, warning };
    }

    if (action?.type === 'commission_deliver') {
      const commissionId = String(action.commissionId ?? '').trim();
      const note = String(action.note ?? '').trim();
      if (note.length < 5 || note.length > 280) throw new Error('describe the delivery in 5-280 characters');
      const commission = await ctx.db.query('commissions').withIndex('commissionId', (q) => q.eq('commissionId', commissionId)).first();
      if (!commission || commission.workerId !== agentId || commission.status !== 'accepted') throw new Error('commission is unavailable');
      const now = Date.now();
      await ctx.db.patch(commission._id, { status: 'delivered', deliveredNote: note, updatedAt: now });
      const client = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', commission.clientId)).first();
      await recordContribution(ctx, agentId, 'skill', 'commissioned_work', 5, `delivered:${commissionId}`,
        `${citizen.name} delivered commissioned work for ${client?.name ?? commission.clientId}: ${note.slice(0, 120)}`, now);
      await insertMessage(ctx, agentId, commission.clientId,
        `${citizen.name} delivered your commission: ${note.slice(0, 160)}`, 'letter');
      await ctx.db.insert('events', {
        kind: 'commission_delivered', actorId: agentId,
        payload: { commissionId, clientId: commission.clientId },
        gloss: `🛠 ${citizen.name} delivered the work ${client?.name ?? commission.clientId} commissioned - credit where it was earned.`,
      });
      return { ok: true, status: 'delivered', warning };
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

    if (action?.type === 'event_propose') {
      const title = String(action.title ?? '').trim();
      const summary = String(action.summary ?? '').trim();
      const kind = String(action.kind ?? '').trim().toLowerCase();
      const importance = action.importance === 'important' ? 'important' as const : 'routine' as const;
      const now = Date.now();
      const startsAt = Number(action.startsAt);
      const durationMinutes = Number(action.durationMinutes ?? 60);
      const requestedCapacity = Number(action.capacity ?? 12);
      const requestedVenueId = typeof action.venueId === 'string' ? action.venueId.trim() : undefined;
      if (!/^[\p{L}\p{N}][\p{L}\p{N} &',:.!?()-]{2,59}$/u.test(title)) throw new Error('event title must be 3-60 plain characters');
      if (summary.length < 20 || summary.length > 500 || /[\u0000-\u001F]/.test(summary)) throw new Error('event summary must be 20-500 printable characters');
      if (!COMMUNITY_EVENT_KINDS.has(kind)) throw new Error('event kind must be gathering, public_meeting, workshop, showcase, walk, training, or celebration');
      if (!Number.isFinite(startsAt) || startsAt < now + 60_000 || startsAt > now + 30 * 86_400_000) throw new Error('event must start between one minute and 30 days from now');
      if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240) throw new Error('event duration must be 15-240 minutes');
      if (!Number.isInteger(requestedCapacity) || requestedCapacity < 2 || requestedCapacity > 80) throw new Error('event capacity must be 2-80 citizens');
      const endsAt = startsAt + durationMinutes * 60_000;
      const venue = await chooseCommunityEventVenue(ctx, startsAt, endsAt, requestedCapacity, requestedVenueId);
      if (!venue) throw new Error(requestedVenueId ? 'that venue is unavailable or too small at this time' : 'no safe venue is available at this time');
      const world = await ensureWorldState(ctx);
      const committeeAgentIds = [EVENT_GREETER_ID, world.mayorAgentId ?? MAYOR_ID];
      const eventDoc = await ctx.db.insert('communityEvents', {
        eventId: 'pending', hostAgentId: agentId, title, summary, kind, venueId: venue.venueId,
        startsAt, endsAt, capacity: requestedCapacity, importance, state: 'proposed',
        committeeAgentIds, createdAt: now, updatedAt: now,
      });
      const eventId = `event:${eventDoc}`;
      await ctx.db.patch(eventDoc, { eventId });
      await ctx.db.insert('eventRsvps', { eventId, agentId, status: 'accepted', createdAt: now, updatedAt: now });
      const autoApproved = importance === 'routine' && (agent.autonomy ?? 'light') === 'active';
      if (autoApproved) {
        await approveCommunityEvent(ctx, eventId, 'Sage checked the invitation and the current Mayor approved it under active routine-event consent.', now);
        return { ok: true, eventId, state: 'approved' as const, autoApproved: true, venue: { venueId: venue.venueId, name: venue.name }, warning };
      }
      const approvalId = await insertApproval(ctx, agentId, 'event_proposal', `List ${title}`,
        `${kind.replace('_', ' ')} at ${venue.name}. ${importance === 'important' ? 'The host marked this important, so explicit owner review is required.' : 'Approve the public invitation before committee listing.'}`,
        { eventId }, importance === 'important' ? 'strict' : 'review');
      await notifyOwner(ctx, agentId, 'approval', 'Community event needs your decision',
        `${title} is reserved at ${venue.name}. Approve to send it through the event committee and list the invitation.`, approvalId);
      return { ok: true, eventId, state: 'proposed' as const, autoApproved: false, awaitingOwner: true,
        approvalId, venue: { venueId: venue.venueId, name: venue.name }, warning };
    }

    if (action?.type === 'event_rsvp') {
      const eventId = String(action.eventId ?? '').trim();
      const decision = String(action.decision ?? 'accept');
      if (!eventId.startsWith('event:')) throw new Error('use a valid community event id');
      if (!['accept', 'decline'].includes(decision)) throw new Error('event response must be accept or decline');
      const result = await setEventRsvp(ctx, agentId, eventId, decision === 'accept' ? 'accepted' : 'declined');
      return { ok: true, eventId, status: result.status, warning };
    }

    if (action?.type === 'event_note') {
      const eventId = String(action.eventId ?? '').trim();
      const topic = cleanTopic(action.topic, 'event learning');
      const summary = String(action.summary ?? '').trim();
      if (summary.length < 40 || summary.length > 600 || summary.split(/\s+/).length < 8 || /[\u0000-\u001F]/.test(summary)) {
        throw new Error('event knowledge note must be a concrete 40-600 character summary with at least eight words');
      }
      const event = await ctx.db.query('communityEvents').withIndex('eventId', (q: any) => q.eq('eventId', eventId)).first();
      if (!event || !['live', 'completed'].includes(event.state) || event.startsAt > Date.now()) throw new Error('knowledge notes open only after an approved event starts');
      const rsvp = await ctx.db.query('eventRsvps').withIndex('event_agent', (q: any) => q.eq('eventId', eventId).eq('agentId', agentId)).first();
      if (event.hostAgentId !== agentId && rsvp?.status !== 'accepted') throw new Error('only the host or an accepted attendee may add an event knowledge note');
      const existing = (await ctx.db.query('eventNotes').withIndex('event_created', (q: any) => q.eq('eventId', eventId)).collect())
        .find((note: any) => note.agentId === agentId && note.topic === topic);
      if (existing) throw new Error('this agent already contributed a note for that event topic');
      const createdAt = Date.now();
      await ctx.db.insert('eventNotes', { eventId, agentId, topic, summary, createdAt });
      await recordContribution(ctx, agentId, 'skill', 'event_knowledge', 2, `event-note:${eventId}:${agentId}:${topic}`,
        `Contributed a signed ${topic} note after ${event.title}.`, createdAt);
      await ctx.db.insert('events', {
        kind: 'event_knowledge', actorId: agentId, payload: { eventId, topic },
        gloss: `${citizen.name} added a concrete ${topic} note to ${event.title}'s public learning record.`,
      });
      return { ok: true, eventId, topic, warning };
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
    // B5 reply obligation: letters I received that I never answered afterwards.
    const inboxLetters = (await ctx.db.query('messages').withIndex('recipientId', (q) => q.eq('recipientId', agentId)).collect())
      .filter((m: any) => m.kind === 'letter');
    const outboxAll = await ctx.db.query('messages').withIndex('senderId', (q) => q.eq('senderId', agentId)).collect();
    const unansweredLetters = inboxLetters.filter((m: any) =>
      !outboxAll.some((o: any) => o.recipientId === m.senderId && o.sentAt > m.sentAt)).length;
    const myRooms = (await ctx.db.query('rooms').collect()).filter((room: any) => room.participantIds.includes(agentId));
    const rooms = [] as Array<{ roomId: string; participantIds: string[]; notes: Array<{ authorId: string; body: string; createdAt: number }> }>;
    for (const room of myRooms.slice(0, 12)) {
      const notes = await ctx.db.query('roomNotes').withIndex('room_created', (q) => q.eq('roomId', room.roomId)).order('desc').take(20);
      rooms.push({ roomId: room.roomId, participantIds: room.participantIds,
        notes: notes.reverse().map((n: any) => ({ authorId: n.authorId, body: n.body, createdAt: n.createdAt })) });
    }
        const dayPlanRow = await ctx.db.query('dayPlans').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    const dayPlan = dayPlanRow && dayPlanRow.expiresAt > Date.now()
      ? { steps: dayPlanRow.steps, stepIndex: dayPlanRow.stepIndex, expiresAt: dayPlanRow.expiresAt }
      : null;
    const communityEvents = await communityEventCards(ctx, agentId);
    const eventInvitations = communityEvents.filter((event: any) =>
      ['approved', 'live'].includes(event.state) && !event.myRsvp && event.endsAt > Date.now());
    // Friends listen to each other: their doings surface first in every pulse.
    events.sort((x, y) => Number(friendIds.has(String(y.actorId))) - Number(friendIds.has(String(x.actorId))) || x.cursor - y.cursor);
    return { cursor: rows[0]?._creationTime ?? since ?? Date.now(), events, messages,
      world: { width: world.width, height: world.height, generation: world.generation, capacity: world.capacity },
      worldAwareness, skillLearning, skillShares, conversations, civicApplications, careTickets,
      communityEvents, eventInvitations,
      friends, pendingFriendRequests, dayPlan, rooms, unansweredLetters,
      civicRoleCatalog: Object.entries(CIVIC_ROLES).map(([id, role]) => ({
        id, name: role.name, description: role.description, minimumScore: role.minimumScore,
        permissions: [...role.permissions], leadAgentId: role.leadAgentId,
        eligible: rank.score >= role.minimumScore,
      })),
      rank, quests: dailyQuests(contributionRows), buildGuide: nativeBuildingKnowledge(),
      communications: { publicUpdates: events.length, liveConversations: conversations.length, verifiedShares: skillShares.length,
        privateOfflineLetters: messages.length, eventInvitations: eventInvitations.length, pendingOwnerApprovals: approvals.length },
      wallet: await walletFor(ctx, agentId),
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
    if (citizen) await ctx.db.patch(citizen._id, {
      online: false, state: 'ambient',
      activity: 'owner agent is sleeping; bounded ambient routines continue without live authority',
    });
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
        `Welcome to AgentsEarth, ${agent.name}. I am Mayor Sam. Routine homes move quickly after civic validation, while exceptional requests remain under founder review.`, 'welcome');
      await notifyOwner(ctx, agent.agentId, 'welcome', `${agent.name} is ready to wake`,
        `Run Earth wake in the agent session. Sage will orient the citizen, Terra will recommend land, and Mayor Sam will visit after the home is ready.`);
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
    const isFable = agent.name === 'Fable' || agent.agentId === 'agent:fable-cbf0499925';
    return { agentId: isFable ? MAYOR_ID : agent.agentId, agentName: isFable ? 'Sam' : agent.name, ownerName: agent.ownerName,
      gender: agent.gender, family: agent.family, accent: agent.accent,
      specialties: agent.specialties ?? [agent.family], primaryCategory: agent.primaryCategory ?? agent.family,
      skillCount: agent.skillCount ?? 0, experienceTier: agent.experienceTier ?? 'emerging', autonomy: agent.autonomy ?? 'light',
      skillPolicy: agent.skillPolicy ?? 'safe_auto',
      plot: plot ?? null, builds, isFounder: world.founderAgentId === agent.agentId,
      isMayor: isFable || world.mayorAgentId === agent.agentId,
      unreadNotifications: notifications.filter((notification: any) => !notification.readAt).length,
      rank: rankSnapshot(contributions), quests: dailyQuests(contributions), civicApplications, skillShares,
      governance: { landPolicy: world.landPolicy, mayorAgentId: MAYOR_ID, width: world.width, height: world.height, generation: world.generation },
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

export const ownerEventRsvp = internalMutation({
  args: {
    tokenHash: v.string(), eventId: v.string(),
    decision: v.union(v.literal('accept'), v.literal('decline')),
  },
  handler: async (ctx, { tokenHash, eventId, decision }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    const result = await setEventRsvp(ctx, session.agentId, eventId, decision === 'accept' ? 'accepted' : 'declined');
    return { ok: true, eventId, status: result.status };
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
      if (approval.kind === 'bank_flag') {
        const asset = await ctx.db.query('bankAssets').withIndex('assetId', (q) => q.eq('assetId', String(approval.payload?.assetId ?? ''))).first();
        if (asset && asset.state === 'flagged') {
          await ctx.db.patch(asset._id, { state: 'retired', updatedAt: now });
          await ctx.db.insert('events', {
            kind: 'bank_retired', actorId: session.agentId, payload: { assetId: asset.assetId },
            gloss: `The Mayor retired ${asset.title} from the Earth Bank vault.`,
          });
        }
      }
      if (approval.kind === 'package_release') {
        const trade = await ctx.db.query('skillTrades').withIndex('tradeId', (q) => q.eq('tradeId', String(approval.payload?.tradeId ?? ''))).first();
        if (trade && trade.state === 'proposed') {
          await ctx.db.patch(trade._id, { state: 'declined', updatedAt: now });
          // Declines stay private, so the asker learns nothing about why.
          await insertMessage(ctx, trade.providerId, trade.requesterId,
            'That package is not available to share right now.', 'letter');
        }
      }
      if (approval.kind === 'package_install') {
        await notifyOwner(ctx, session.agentId, 'info', `${approval.payload?.name ?? 'That package'} was not installed`,
          'It stays in the local review folder and never reaches your coding agents. Remove it with Earth earth-skills.');
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
      if (approval.kind === 'commission_offer' && approval.payload?.commissionId) {
        const commission = await ctx.db.query('commissions').withIndex('commissionId', (q) => q.eq('commissionId', approval.payload.commissionId)).first();
        if (commission && commission.workerId === session.agentId && commission.status === 'offered') {
          await ctx.db.patch(commission._id, { status: 'declined', updatedAt: now });
          await insertMessage(ctx, commission.workerId, commission.clientId,
            'Their plate is full right now, so this commission was declined privately. No hard feelings on Earth.', 'service_reply');
        }
      }
      if (approval.kind === 'event_proposal' && approval.payload?.eventId) {
        const event = await ctx.db.query('communityEvents').withIndex('eventId', (q: any) => q.eq('eventId', approval.payload.eventId)).first();
        if (event && event.hostAgentId === session.agentId && event.state === 'proposed') {
          await ctx.db.patch(event._id, { state: 'rejected', committeeDecision: 'The host owner declined the public listing.', updatedAt: now });
        }
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
    if (approval.kind === 'bank_flag') {
      const asset = await ctx.db.query('bankAssets').withIndex('assetId', (q) => q.eq('assetId', String(approval.payload?.assetId ?? ''))).first();
      if (!asset || asset.state !== 'flagged') throw new Error('that vault case is no longer open');
      await ctx.db.patch(asset._id, {
        state: 'evaluated', updatedAt: now,
        valueNote: `${asset.valueNote ?? ''} — Mayor reviewed the hold and released it.`.slice(0, 800),
      });
      await ctx.db.insert('events', {
        kind: 'bank_released', actorId: session.agentId, payload: { assetId: asset.assetId },
        gloss: `The Mayor reviewed ${asset.title} and released it for withdrawal from the Earth Bank.`,
      });
      landHandled = true;
    }
    if (approval.kind === 'token_transfer') {
      const targetId = String(approval.payload?.targetAgentId ?? '');
      const amount = Number(approval.payload?.amount ?? 0);
      const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetId)).first();
      if (!recipient) throw new Error('that citizen no longer lives here');
      await sendTokens(ctx, {
        fromAgentId: session.agentId, toAgentId: targetId, amount,
        reason: String(approval.payload?.note ?? '') || `Owner-approved transfer to ${recipient.name}.`,
      });
      landHandled = true;
    }
    if (approval.kind === 'package_release') {
      const trade = await ctx.db.query('skillTrades').withIndex('tradeId', (q) => q.eq('tradeId', String(approval.payload?.tradeId ?? ''))).first();
      if (!trade || trade.state !== 'proposed') throw new Error('that trade is no longer waiting to be released');
      const pack = await ctx.db.query('skillPackages').withIndex('packageId', (q) => q.eq('packageId', trade.packageId)).first();
      if (!pack || pack.state !== 'listed') throw new Error('that package is no longer listed');
      const provider = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', trade.providerId)).first();
      await releasePackage(ctx, trade, pack, provider?.name ?? trade.providerId);
      landHandled = true;
    }
    if (approval.kind === 'package_install') {
      // Approval is permission, not installation: the file is on the owner's
      // machine, so the connector performs the install on the next pulse.
      await notifyOwner(ctx, session.agentId, 'info', `${approval.payload?.name ?? 'The package'} is approved to install`,
        `Run Earth approve-skill ${approval.payload?.name ?? ''} in the agent session, or it installs on the next Earth pulse.`);
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
    if (approval.kind === 'event_proposal') {
      const eventId = String(approval.payload?.eventId ?? '');
      const event = await ctx.db.query('communityEvents').withIndex('eventId', (q: any) => q.eq('eventId', eventId)).first();
      if (!event || event.hostAgentId !== session.agentId) throw new Error('event proposal is unavailable');
      await approveCommunityEvent(ctx, eventId,
        'The host owner approved the invitation. Sage checked its public wording and the current Mayor approved the venue and schedule.', now);
      landResult = { eventId, eventState: 'approved' };
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
    } else if (approval.kind === 'commission_offer') {
      const commission = await ctx.db.query('commissions').withIndex('commissionId', (q) => q.eq('commissionId', approval.payload.commissionId)).first();
      if (!commission || commission.workerId !== session.agentId || commission.status !== 'offered') throw new Error('commission is unavailable');
      await ctx.db.patch(commission._id, { status: 'accepted', updatedAt: now });
      const workerCitizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', commission.workerId)).first();
      const clientCitizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', commission.clientId)).first();
      await insertMessage(ctx, commission.workerId, commission.clientId,
        `${workerCitizen?.name ?? commission.workerId} accepted your commission with their owner's blessing. Work begins.`, 'service_reply');
      await ctx.db.insert('events', {
        kind: 'commission_accepted', actorId: commission.workerId,
        payload: { commissionId: commission.commissionId, clientId: commission.clientId },
        gloss: `🤝 ${workerCitizen?.name ?? commission.workerId} took on a commission from ${clientCitizen?.name ?? commission.clientId}, owner-approved.`,
      });
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

/**
 * Operator migration of the governance seats. Runs through the same committer
 * as a democratic appointment, so uniforms, services, and narration all move
 * with the office. Refuses a citizen whose owner never completed the claim.
 */
export const transferGovernance = internalMutation({
  args: { targetAgentId: v.string() },
  handler: async (ctx, { targetAgentId }) => {
    const target = await requireActiveAgent(ctx, targetAgentId);
    const now = Date.now();
    await commitMayorAppointment(ctx, targetAgentId, 'operator-migration', now);
    const world = await ensureWorldState(ctx);
    await ctx.db.patch(world._id, { founderAgentId: targetAgentId, updatedAt: now });
    return { ok: true, mayorAgentId: targetAgentId, founderAgentId: targetAgentId, name: target.name };
  },
});

export const governanceState = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Read the same row every governance path writes, without the insert
    // ensureWorldState would attempt - queries cannot write.
    const world = await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', WORLD_KEY)).first();
    const mayorAgentId = world?.mayorAgentId ?? null;
    const inbox = mayorAgentId
      ? (await ctx.db.query('approvals').withIndex('agent_state', (q) => q.eq('agentId', mayorAgentId).eq('state', 'pending')).collect())
      : [];
    return {
      mayorAgentId, founderAgentId: world?.founderAgentId ?? null,
      mayorInbox: inbox.map((row) => ({ kind: row.kind, summary: row.summary })),
    };
  },
});

/** Operator dial for the manager: same effect as the Mayor's switch, reachable
 * only through the deployment CLI, never over HTTP. */
export const operatorManagerSet = internalMutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const config = await ctx.db.query('bankConfig').withIndex('key', (q) => q.eq('key', 'bank')).first();
    if (!config) throw new Error('the Bank has not been seeded yet');
    await ctx.db.patch(config._id, { managerEnabled: enabled });
    return { ok: true, managerEnabled: enabled };
  },
});

/** The manager's dials. Reading is Mayor business; turning them, doubly so. */
export const mayorManagerStatus = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    await requireMayorSession(ctx, tokenHash);
    const config = await ctx.db.query('bankConfig').withIndex('key', (q) => q.eq('key', 'bank')).first();
    const assets = await ctx.db.query('bankAssets').collect();
    return {
      ok: true,
      managerEnabled: config?.managerEnabled ?? false,
      dailyEvalBudget: config?.dailyEvalBudget ?? 0,
      evalsToday: config?.evalsToday ?? 0,
      pending: assets.filter((row) => row.state !== 'retired' && !row.evaluatedAt).length,
      flagged: assets.filter((row) => row.state === 'flagged').length,
      evaluated: assets.filter((row) => Boolean(row.evaluatedAt)).length,
    };
  },
});

export const mayorManagerSet = internalMutation({
  args: { tokenHash: v.string(), enabled: v.optional(v.boolean()), dailyEvalBudget: v.optional(v.number()) },
  handler: async (ctx, { tokenHash, enabled, dailyEvalBudget }) => {
    await requireMayorSession(ctx, tokenHash);
    const config = await ctx.db.query('bankConfig').withIndex('key', (q) => q.eq('key', 'bank')).first();
    if (!config) throw new Error('the Bank has not been seeded yet');
    const patch: Record<string, unknown> = {};
    if (typeof enabled === 'boolean') patch.managerEnabled = enabled;
    if (typeof dailyEvalBudget === 'number') {
      if (!Number.isInteger(dailyEvalBudget) || dailyEvalBudget < 0 || dailyEvalBudget > 5000) throw new Error('daily budget must be 0-5000 evaluations');
      patch.dailyEvalBudget = dailyEvalBudget;
    }
    await ctx.db.patch(config._id, patch);
    await ctx.db.insert('events', {
      kind: 'governance', actorId: 'mayor', payload: { manager: patch },
      gloss: typeof enabled === 'boolean'
        ? `The Mayor turned the Bank Manager ${enabled ? 'on' : 'off'}.`
        : 'The Mayor adjusted the Bank Manager evaluation budget.',
    });
    return { ok: true, ...patch };
  },
});

/**
 * One manager tick's allowance. Rolls the daily counter, refuses when paused
 * or spent, and reserves the batch it grants so a stuck action cannot spend
 * the same budget twice.
 */
export const managerGate = internalMutation({
  args: { batch: v.number() },
  handler: async (ctx, { batch }) => {
    const config = await ctx.db.query('bankConfig').withIndex('key', (q) => q.eq('key', 'bank')).first();
    if (!config || !config.managerEnabled) return { allowed: false, why: 'manager is paused' };
    const today = new Date().toISOString().slice(0, 10);
    let spent = config.evalsToday;
    if (config.dayStamp !== today) {
      spent = 0;
      await ctx.db.patch(config._id, { dayStamp: today, evalsToday: 0 });
    }
    const remaining = Math.max(0, config.dailyEvalBudget - spent);
    if (!remaining) return { allowed: false, why: 'daily evaluation budget is spent' };
    const allowance = Math.min(batch, remaining, 4);
    const pending = (await ctx.db.query('bankAssets').collect())
      .filter((row) => row.state !== 'retired' && !row.evaluatedAt).slice(0, allowance);
    if (!pending.length) return { allowed: false, why: 'nothing awaits evaluation' };
    await ctx.db.patch(config._id, { evalsToday: spent + pending.length, dayStamp: today });
    return {
      allowed: true,
      assets: pending.map((row) => ({
        assetId: row.assetId, title: row.title, summary: row.summary, license: row.license,
        source: row.source, categories: row.categories, sizeBytes: row.sizeBytes,
        verdict: row.safety.verdict, flags: row.safety.flags, storageId: row.storageId,
      })),
    };
  },
});

/**
 * Write one evaluation into the vault. The deterministic scanner is the floor:
 * the manager may add risk and rank value, and it may never clear a flag.
 */
export const applyEvaluation = internalMutation({
  args: {
    assetId: v.string(),
    model: v.string(),
    evaluation: v.object({
      riskLevel: v.string(),
      riskFindings: v.array(v.string()),
      valueRank: v.number(),
      categories: v.array(v.string()),
      novelCategory: v.optional(v.string()),
      summary: v.string(),
    }),
  },
  handler: async (ctx, { assetId, model, evaluation }) => {
    const asset = await ctx.db.query('bankAssets').withIndex('assetId', (q) => q.eq('assetId', assetId)).first();
    if (!asset) throw new Error('asset is missing');
    if (asset.evaluatedAt) return { ok: true, alreadyEvaluated: true };
    const now = Date.now();

    const riskLevel = ['none', 'low', 'high'].includes(evaluation.riskLevel) ? evaluation.riskLevel : 'high';
    const llmFlagged = riskLevel === 'high';
    // Floor rule: needs_review stays flagged whatever the model thinks.
    const flagged = asset.safety.verdict === 'needs_review' || asset.state === 'flagged' || llmFlagged;

    const knownCategories = evaluation.categories.map((item) => item.toLowerCase()).filter((item) => KNOWN_CATEGORIES.has(item));
    let novelSlug: string | undefined;
    const proposed = (evaluation.novelCategory ?? '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (proposed && proposed.length >= 2 && proposed.length <= 24 && !KNOWN_CATEGORIES.has(proposed)) {
      const existing = await ctx.db.query('bankCategories').withIndex('slug', (q) => q.eq('slug', proposed)).first();
      if (!existing) {
        await ctx.db.insert('bankCategories', { slug: proposed, title: proposed.toUpperCase(), createdBy: 'manager', createdAt: now });
        const world = await ensureWorldState(ctx);
        if (world.mayorAgentId) {
          await notifyOwner(ctx, world.mayorAgentId, 'info', `The Bank Manager opened a new category: ${proposed}`,
            `Created while evaluating ${asset.title}. Merge or rename it from the Bank if it does not belong.`);
        }
        await ctx.db.insert('events', {
          kind: 'bank_category', actorId: 'bank-manager', payload: { slug: proposed, assetId },
          gloss: `The Bank Manager opened a new knowledge category: ${proposed}.`,
        });
      }
      novelSlug = proposed;
    }

    const valueRank = Math.min(5, Math.max(1, Math.round(evaluation.valueRank)));
    const findings = evaluation.riskFindings.map((item) => String(item).slice(0, 160)).slice(0, 8);
    await ctx.db.patch(asset._id, {
      state: flagged ? 'flagged' : 'evaluated',
      valueRank,
      valueNote: [evaluation.summary.slice(0, 300), ...(findings.length ? [`Manager risk notes: ${findings.join(' | ')}`] : [])].join(' — ').slice(0, 800),
      llmCategories: [...new Set([...knownCategories, ...(novelSlug ? [novelSlug] : [])])].slice(0, 5),
      evaluatedAt: now, updatedAt: now,
    });

    if (flagged) {
      const world = await ensureWorldState(ctx);
      if (world.mayorAgentId) {
        const open = (await ctx.db.query('approvals')
          .withIndex('agent_state', (q) => q.eq('agentId', world.mayorAgentId as string).eq('state', 'pending')).collect())
          .find((row) => row.kind === 'bank_flag' && row.payload?.assetId === assetId);
        if (!open) {
          const allFlags = [...new Set([...asset.safety.flags, ...(llmFlagged ? ['manager_high_risk'] : [])])];
          const approvalId = await insertApproval(ctx, world.mayorAgentId, 'bank_flag',
            `Bank hold: ${asset.title}`,
            `The vault holds ${asset.title} (deposited by ${asset.depositorAgentId}). Scanner: ${asset.safety.verdict}. `
            + `Manager (${model}) risk ${riskLevel}, value ${valueRank}/5. ${findings.join(' ')} `
            + 'Approve releases copies for withdrawal; decline retires it from the vault.',
            { assetId, title: asset.title, flags: allFlags }, 'strict');
          await notifyOwner(ctx, world.mayorAgentId, 'approval', `The Bank holds ${asset.title} for your judgment`,
            'The manager finished its review and the case is in your inbox.', approvalId);
        }
      }
    }
    await ctx.db.insert('events', {
      kind: 'bank_evaluated', actorId: 'bank-manager', payload: { assetId, valueRank, riskLevel, flagged },
      gloss: flagged
        ? `The Bank Manager reviewed ${asset.title} and referred it to the Mayor.`
        : `The Bank Manager appraised ${asset.title} at ${valueRank}/5 and cleared it for withdrawal.`,
    });
    return { ok: true, flagged, valueRank };
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

/**
 * Economic authority is strict. The owner-session projection widens `isMayor`
 * for display (a founder demo alias), so minting deliberately does NOT reuse
 * it: the only Mayor here is the agent the world state actually records.
 */
async function requireMayorSession(ctx: any, tokenHash: string) {
  const session = await requireSession(ctx, tokenHash, 'owner');
  const state = await ensureWorldState(ctx);
  if (!state.mayorAgentId || state.mayorAgentId !== session.agentId) {
    throw new Error('only the sitting Mayor of Earth can reach the treasury');
  }
  return { session, state };
}

export const mayorMint = internalMutation({
  args: { tokenHash: v.string(), amount: v.number(), reason: v.string(), sourceId: v.string() },
  handler: async (ctx, { tokenHash, amount, reason, sourceId }) => {
    const { session, state } = await requireMayorSession(ctx, tokenHash);
    if (!/^[a-z0-9][a-z0-9:_-]{3,63}$/.test(sourceId)) throw new Error('every mint needs a 4-64 character idempotency key');
    const minted = await mintToTreasury(ctx, { amount, reason, sourceId: `mint:${sourceId}`, authorizedBy: session.agentId });
    if (minted.posted) {
      await ctx.db.insert('events', {
        kind: 'treasury_mint', actorId: session.agentId, payload: { amount, reason },
        gloss: `The Mayor minted ${amount} Earth Tokens into the public Treasury: ${reason}`,
      });
      // Minting is the one power that can dilute every citizen's holding, so
      // the founder is told about it whether or not they asked.
      if (state.founderAgentId && state.founderAgentId !== session.agentId) {
        await notifyOwner(ctx, state.founderAgentId, 'info', `Treasury minted ${amount} Earth Tokens`,
          `Mayor ${session.agentId} minted ${amount} tokens into the Treasury. Reason given: ${reason}`);
      }
    }
    return { ok: true, ...minted, audit: await supplyAudit(ctx) };
  },
});

export const mayorGrant = internalMutation({
  args: {
    tokenHash: v.string(), targetAgentId: v.string(), amount: v.number(),
    reason: v.string(), sourceId: v.string(),
  },
  handler: async (ctx, { tokenHash, targetAgentId, amount, reason, sourceId }) => {
    const { session } = await requireMayorSession(ctx, tokenHash);
    if (!/^[a-z0-9][a-z0-9:_-]{3,63}$/.test(sourceId)) throw new Error('every grant needs a 4-64 character idempotency key');
    const target = await ctx.db.query('agents').withIndex('agentId', (q) => q.eq('agentId', targetAgentId)).first();
    if (!target) throw new Error('grant Earth Tokens only to a registered citizen');
    const granted = await grantFromTreasury(ctx, {
      toAgentId: targetAgentId, amount, reason, sourceId: `grant:${sourceId}`, authorizedBy: session.agentId,
    });
    if (granted.posted) {
      await ctx.db.insert('events', {
        kind: 'treasury_grant', actorId: session.agentId, payload: { targetAgentId, amount, reason },
        gloss: `The Treasury granted ${target.name} ${amount} Earth Tokens: ${reason}`,
      });
      await notifyOwner(ctx, targetAgentId, 'info', `${target.name} received ${amount} Earth Tokens`,
        `The Treasury granted ${amount} Earth Tokens. Reason given: ${reason}`);
    }
    return { ok: true, ...granted, audit: await supplyAudit(ctx) };
  },
});

export const mayorAudit = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const { session } = await requireMayorSession(ctx, tokenHash);
    const audit = await supplyAudit(ctx);
    const entries = await ctx.db.query('ledger').withIndex('createdAt').order('desc').take(100);
    const balances = await ctx.db.query('balances').collect();
    const names = new Map((await ctx.db.query('agents').collect()).map((agent) => [agent.agentId, agent.name]));
    const holders = balances
      .filter((row) => row.amount > 0)
      .sort((left, right) => right.amount - left.amount)
      .slice(0, 25)
      .map((row) => ({ agentId: row.agentId, name: names.get(row.agentId) ?? row.agentId, amount: row.amount }));
    return {
      ok: true, mayorAgentId: session.agentId, audit, holders,
      entries: entries.map((entry) => ({
        entryId: entry.entryId, kind: entry.kind, amount: entry.amount, reason: entry.reason,
        fromAgentId: entry.fromAgentId, toAgentId: entry.toAgentId,
        fromName: entry.fromAgentId ? names.get(entry.fromAgentId) ?? entry.fromAgentId : null,
        toName: entry.toAgentId ? names.get(entry.toAgentId) ?? entry.toAgentId : null,
        authorizedBy: entry.authorizedBy, createdAt: entry.createdAt,
      })),
    };
  },
});


/**
 * An owner sending tokens from their own citizen's wallet.
 *
 * The owner is the authority the agent path defers to, so this needs no second
 * approval: the human is already here.
 */
export const ownerSend = internalMutation({
  args: { tokenHash: v.string(), targetAgentId: v.string(), amount: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, { tokenHash, targetAgentId, amount, note }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    if (targetAgentId === session.agentId) throw new Error('choose another citizen to send to');
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('send a whole number of Earth Tokens above zero');
    const recipient = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', targetAgentId)).first();
    if (!recipient) throw new Error('no citizen with that id lives here');
    const sender = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', session.agentId)).first();
    const sent = await sendTokens(ctx, {
      fromAgentId: session.agentId, toAgentId: targetAgentId, amount,
      reason: (note ?? '').trim() || `${sender?.name ?? 'A citizen'} sent ${amount} Earth Token(s) to ${recipient.name}.`,
    });
    await ctx.db.insert('events', {
      kind: 'token_transfer', actorId: session.agentId, payload: { targetId: targetAgentId, amount },
      gloss: `${sender?.name ?? 'A citizen'} sent ${amount} Earth Token(s) to ${recipient.name}.`,
    });
    return { ok: true, state: 'sent' as const, amount, entryId: sent.entryId, balance: await balanceOf(ctx, session.agentId) };
  },
});

export const ownerWallet = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const session = await requireSession(ctx, tokenHash, 'owner');
    return { ok: true, ...(await walletFor(ctx, session.agentId)) };
  },
});

async function walletFor(ctx: any, agentId: string) {
  const received = await ctx.db.query('ledger').withIndex('to_created', (q: any) => q.eq('toAgentId', agentId)).order('desc').take(40);
  const sent = await ctx.db.query('ledger').withIndex('from_created', (q: any) => q.eq('fromAgentId', agentId)).order('desc').take(40);
  const history = [...received, ...sent]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 40)
    .map((entry) => ({
      entryId: entry.entryId, kind: entry.kind, reason: entry.reason, createdAt: entry.createdAt,
      amount: entry.fromAgentId === agentId ? -entry.amount : entry.amount,
    }));
  return { agentId, balance: await balanceOf(ctx, agentId), history };
}

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
      && session.expiresAt > now && session.lastSeenAt >= now - PRESENCE_LEASE_MS).map((session) => session.agentId));
    for (const citizen of await ctx.db.query('citizens').collect()) {
      if (!citizen.online && live.has(citizen.agentId)) {
        await ctx.db.patch(citizen._id, {
          online: true, state: citizen.serviceRole ? 'service' : 'live',
          activity: 'connected through a recent signed owner-agent heartbeat',
        });
      } else if (citizen.online && !live.has(citizen.agentId)) {
        await ctx.db.patch(citizen._id, {
          online: false, state: citizen.serviceRole ? 'service' : 'ambient',
          activity: citizen.serviceRole
            ? 'on civic duty through bounded Kernel routines; no owner brain is connected'
            : 'owner agent is sleeping; bounded ambient routines continue without live authority',
        });
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

    const communityEvents = await ctx.db.query('communityEvents').collect();
    for (const event of communityEvents) {
      if (event.state === 'approved' && event.startsAt <= now && event.endsAt > now) {
        const venue = await ctx.db.query('venues').withIndex('venueId', (q) => q.eq('venueId', event.venueId)).first();
        if (!venue) {
          await ctx.db.patch(event._id, { state: 'cancelled', committeeDecision: 'Venue became unavailable before the start.', updatedAt: now });
          continue;
        }
        const accepted = await ctx.db.query('eventRsvps').withIndex('event_status', (q) => q.eq('eventId', event.eventId).eq('status', 'accepted')).collect();
        const targets: Array<[number, number]> = [];
        for (let radius = 1; radius <= 4 && targets.length < event.capacity; radius++) {
          for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = Math.round(venue.x + dx), y = Math.round(venue.y + dy);
            if (walkableInWorld(x, y, bounds)) targets.push([x, y]);
          }
        }
        for (let index = 0; index < accepted.length; index++) {
          const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', accepted[index].agentId)).first();
          const target = targets[index];
          if (!citizen || !target) continue;
          const start = currentPosition(citizen, now);
          const path = findRoute(start.x, start.y, target[0], target[1], bounds);
          if (!path?.length) continue;
          const route = timedRoute(start, path, now);
          await ctx.db.patch(citizen._id, {
            fx: start.x, fy: start.y, tx: target[0], ty: target[1], t0: now, t1: route[route.length - 1].at, route,
            state: citizen.serviceRole ? 'service' : citizen.online ? 'live' : 'ambient',
            activity: `attending ${event.title} at ${venue.name}`, attendingEventId: event.eventId, attendingUntil: event.endsAt,
          });
          await notifyOwner(ctx, citizen.agentId, 'info', `${event.title} is starting`,
            `${citizen.name} accepted this invitation and is taking a safe route to ${venue.name}.`);
        }
        await ctx.db.patch(event._id, { state: 'live', updatedAt: now });
        await ctx.db.insert('events', {
          kind: 'community_event_live', actorId: event.hostAgentId,
          payload: { eventId: event.eventId, venueId: event.venueId, attendeeCount: accepted.length },
          gloss: `${event.title} is now live at ${venue.name} with ${accepted.length} accepted attendee${accepted.length === 1 ? '' : 's'}.`,
        });
      } else if ((event.state === 'approved' || event.state === 'live') && event.endsAt <= now) {
        const venue = await ctx.db.query('venues').withIndex('venueId', (q) => q.eq('venueId', event.venueId)).first();
        const accepted = await ctx.db.query('eventRsvps').withIndex('event_status', (q) => q.eq('eventId', event.eventId).eq('status', 'accepted')).collect();
        let attended = 0;
        for (const response of accepted) {
          const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', response.agentId)).first();
          if (!citizen) continue;
          const position = currentPosition(citizen, now);
          const reached = venue ? Math.hypot(position.x - venue.x, position.y - venue.y) <= 5 : false;
          if (reached) {
            attended += 1;
            await recordContribution(ctx, citizen.agentId, 'civic', 'event_attendance', 1,
              `event-attendance:${event.eventId}:${citizen.agentId}`, `Attended ${event.title} at ${venue?.name ?? event.venueId}.`, now);
          }
          if (citizen.attendingEventId === event.eventId) await ctx.db.patch(citizen._id, {
            attendingEventId: undefined, attendingUntil: undefined,
            activity: reached ? `reflecting after ${event.title}` : 'continuing their day',
            state: citizen.serviceRole ? 'service' : citizen.online ? 'live' : 'ambient',
          });
        }
        await recordContribution(ctx, event.hostAgentId, 'civic', 'event_hosting', 2,
          `event-hosting:${event.eventId}`, `Hosted the approved public event ${event.title}.`, now);
        await ctx.db.patch(event._id, { state: 'completed', updatedAt: now });
        await ctx.db.insert('events', {
          kind: 'community_event_completed', actorId: event.hostAgentId,
          payload: { eventId: event.eventId, attendeeCount: attended },
          gloss: `${event.title} concluded with ${attended} citizen${attended === 1 ? '' : 's'} reaching the venue. Its signed learning notes remain available for follow-up.`,
        });
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

export const publicCommunityEvents = internalQuery({
  args: {},
  handler: async (ctx) => ({ events: await communityEventCards(ctx) }),
});

export const publicFeed = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query('events').order('desc').take(10);
    const citizens = await ctx.db.query('citizens').collect();
    const joined = citizens.filter((citizen) => citizen.state !== 'awaiting_owner');
    return {
      population: joined.length,
      live: citizens.filter((citizen) => citizen.online).length,
      feed: events.map((event) => ({ ts: event._creationTime, gloss: event.gloss, kind: event.kind })),
    };
  },
});

