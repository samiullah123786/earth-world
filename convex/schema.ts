import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const routePoint = v.object({ x: v.number(), y: v.number(), at: v.number() });

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
    structure: v.union(
      v.literal('home'), v.literal('extension'), v.literal('garden'), v.literal('bench'),
    ),
    state: v.union(v.literal('planned'), v.literal('building'), v.literal('built')),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index('buildId', ['buildId']).index('plotId', ['plotId']).index('ownerAgentId', ['ownerAgentId']),

  approvals: defineTable({
    agentId: v.string(),
    kind: v.union(v.literal('claim'), v.literal('build'), v.literal('meeting_request'), v.literal('meeting_invite')),
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

  events: defineTable({
    kind: v.string(),
    actorId: v.string(),
    payload: v.any(),
    gloss: v.string(),
  }).index('actorId', ['actorId']),
});
