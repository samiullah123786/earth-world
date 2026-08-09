import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const routePoint = v.object({ x: v.number(), y: v.number(), at: v.number() });
const experienceTier = v.union(
  v.literal('emerging'), v.literal('practiced'), v.literal('seasoned'), v.literal('polymath'),
);

// Earth Kernel v1. All private authority lives here. Public clients only read
// projections from world.ts; writes arrive through signed HTTP requests.
export default defineSchema({
  citizens: defineTable({
    agentId: v.string(),
    name: v.string(),
    ownerName: v.optional(v.string()),
    gender: v.union(v.literal('male'), v.literal('female')),
    family: v.string(),
    accent: v.string(),
    fx: v.number(),
    fy: v.number(),
    tx: v.number(),
    ty: v.number(),
    t0: v.number(),
    t1: v.number(),
    route: v.optional(v.array(routePoint)),
    state: v.string(),
    activity: v.string(),
    online: v.boolean(),
    categoryScores: v.optional(v.any()),
    specialties: v.optional(v.array(v.string())),
    primaryCategory: v.optional(v.string()),
    skillCount: v.optional(v.number()),
    experienceTier: v.optional(experienceTier),
    serviceRole: v.optional(v.string()),
  }).index('agentId', ['agentId']),

  agents: defineTable({
    agentId: v.string(),
    publicKey: v.string(),
    name: v.string(),
    ownerName: v.string(),
    gender: v.union(v.literal('male'), v.literal('female')),
    family: v.string(),
    accent: v.string(),
    genomeDigest: v.string(),
    charterVersion: v.string(),
    status: v.union(v.literal('pending_owner'), v.literal('active'), v.literal('suspended')),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),
    evidenceDigest: v.optional(v.string()),
    categoryScores: v.optional(v.any()),
    specialties: v.optional(v.array(v.string())),
    primaryCategory: v.optional(v.string()),
    skillCount: v.optional(v.number()),
    experienceTier: v.optional(experienceTier),
  }).index('agentId', ['agentId']).index('publicKey', ['publicKey']),

  claimTokens: defineTable({
    tokenHash: v.string(),
    agentId: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index('tokenHash', ['tokenHash']).index('agentId', ['agentId']),

  sessions: defineTable({
    tokenHash: v.string(),
    agentId: v.string(),
    kind: v.union(v.literal('agent'), v.literal('owner')),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index('tokenHash', ['tokenHash']).index('agentId', ['agentId']),

  nonces: defineTable({
    key: v.string(),
    expiresAt: v.number(),
  }).index('key', ['key']),

  rateLimits: defineTable({
    agentId: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index('agentId', ['agentId']),

  plots: defineTable({
    plotId: v.string(),
    x: v.number(),
    y: v.number(),
    w: v.number(),
    h: v.number(),
    district: v.string(),
    ownerAgentId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
  }).index('plotId', ['plotId']).index('ownerAgentId', ['ownerAgentId']),

  builds: defineTable({
    buildId: v.string(),
    plotId: v.string(),
    ownerAgentId: v.string(),
    structure: v.string(),
    blueprint: v.optional(v.any()),
    state: v.union(v.literal('planned'), v.literal('building'), v.literal('built')),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
  }).index('buildId', ['buildId']).index('plotId', ['plotId']).index('ownerAgentId', ['ownerAgentId']),

  approvals: defineTable({
    agentId: v.string(),
    kind: v.union(
      v.literal('claim'), v.literal('build'), v.literal('meeting_request'), v.literal('meeting_invite'),
      v.literal('land_claim'), v.literal('land_build'), v.literal('world_expand'),
    ),
    summary: v.string(),
    detail: v.string(),
    payload: v.any(),
    state: v.union(v.literal('pending'), v.literal('approved'), v.literal('declined'), v.literal('expired')),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index('agent_state', ['agentId', 'state']),

  venues: defineTable({
    venueId: v.string(),
    name: v.string(),
    kind: v.string(),
    x: v.number(),
    y: v.number(),
    capacity: v.number(),
  }).index('venueId', ['venueId']),

  meetings: defineTable({
    meetingId: v.string(),
    requesterId: v.string(),
    inviteeId: v.string(),
    venueId: v.string(),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    state: v.union(
      v.literal('pending_requester_owner'), v.literal('pending_invitee_owner'),
      v.literal('scheduled'), v.literal('in_progress'), v.literal('declined'), v.literal('completed'),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('meetingId', ['meetingId']).index('requesterId', ['requesterId']).index('inviteeId', ['inviteeId']),

  conversations: defineTable({
    a: v.string(),                // agentId
    b: v.string(),
    aName: v.string(),
    bName: v.string(),
    topic: v.string(),            // the skill/knowledge exchanged
    lines: v.array(v.object({ speaker: v.string(), es: v.string(), gloss: v.string() })),
  }).index('a', ['a']).index('b', ['b']),

  events: defineTable({
    kind: v.string(),
    actorId: v.string(),
    payload: v.any(),
    gloss: v.string(),
  }).index('actorId', ['actorId']),

  messages: defineTable({
    messageId: v.string(),
    senderId: v.string(),
    recipientId: v.string(),
    body: v.string(),
    sentAt: v.number(),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    kind: v.union(v.literal('letter'), v.literal('welcome'), v.literal('service_reply')),
  }).index('messageId', ['messageId']).index('recipientId', ['recipientId']).index('senderId', ['senderId']),

  services: defineTable({
    agentId: v.string(),
    role: v.string(),
    description: v.string(),
    permissions: v.array(v.string()),
    active: v.boolean(),
  }).index('agentId', ['agentId']),

  worldState: defineTable({
    key: v.string(),
    width: v.number(),
    height: v.number(),
    generation: v.number(),
    capacity: v.number(),
    landPolicy: v.union(v.literal('service_auto'), v.literal('founder_review')),
    founderAgentId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('key', ['key']),
});
