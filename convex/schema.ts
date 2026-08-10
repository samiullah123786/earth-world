import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const routePoint = v.object({ x: v.number(), y: v.number(), at: v.number() });
const experienceTier = v.union(
  v.literal('emerging'), v.literal('practiced'), v.literal('seasoned'), v.literal('polymath'),
);
const avatarSpec = v.object({
  version: v.number(), catalogKey: v.string(), archetype: v.string(), variant: v.number(),
  hairStyle: v.string(), hairColor: v.string(), headShape: v.string(), outfitColor: v.string(),
  eyeColor: v.string(), selectionBasis: v.string(),
});

// Earth Kernel v1. All private authority lives here. Public clients only read
// projections from world.ts; writes arrive through signed HTTP requests.
export default defineSchema({
  citizens: defineTable({
    agentId: v.string(),
    name: v.string(),
    bio: v.optional(v.string()),
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
    avatarSpec: v.optional(avatarSpec),
    serviceRole: v.optional(v.string()),
    welcomedAt: v.optional(v.number()),
    talkingWith: v.optional(v.string()),
    talkingUntil: v.optional(v.number()),
    trainingActivity: v.optional(v.string()),
    trainingTeam: v.optional(v.string()),
    trainingStartsAt: v.optional(v.number()),
    trainingUntil: v.optional(v.number()),
    attendingEventId: v.optional(v.string()),
    attendingUntil: v.optional(v.number()),
    activeBuildId: v.optional(v.string()),
    activeTool: v.optional(v.string()),
    buildingStartsAt: v.optional(v.number()),
    buildingUntil: v.optional(v.number()),
    driveBias: v.optional(v.object({
      social: v.number(), curiosity: v.number(), industry: v.number(),
      rest: v.number(), civic: v.number(),
    })),
  }).index('agentId', ['agentId']),

  agents: defineTable({
    agentId: v.string(),
    publicKey: v.string(),
    name: v.string(),
    bio: v.optional(v.string()),
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
    autonomy: v.optional(v.union(v.literal('none'), v.literal('light'), v.literal('active'))),
    skillPolicy: v.optional(v.union(v.literal('safe_auto'), v.literal('ask_all'))),
    avatarSpec: v.optional(avatarSpec),
    settledAt: v.optional(v.number()),
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
    constructionStartsAt: v.optional(v.number()),
    constructionEndsAt: v.optional(v.number()),
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
      v.literal('plot_expansion'), v.literal('mayor_appointment'), v.literal('skill_install'),
      v.literal('civic_role'), v.literal('commission_offer'), v.literal('event_proposal'),
    ),
    summary: v.string(),
    detail: v.string(),
    payload: v.any(),
    state: v.union(v.literal('pending'), v.literal('approved'), v.literal('declined'), v.literal('expired')),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    risk: v.optional(v.union(v.literal('routine'), v.literal('review'), v.literal('strict'))),
    decidedBy: v.optional(v.string()),
  }).index('agent_state', ['agentId', 'state']),

  notifications: defineTable({
    recipientAgentId: v.string(),
    kind: v.union(v.literal('info'), v.literal('approval'), v.literal('welcome')),
    title: v.string(),
    body: v.string(),
    relatedApprovalId: v.optional(v.id('approvals')),
    createdAt: v.number(),
    readAt: v.optional(v.number()),
  }).index('recipient_created', ['recipientAgentId', 'createdAt']),

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

  communityEvents: defineTable({
    eventId: v.string(),
    hostAgentId: v.string(),
    title: v.string(),
    summary: v.string(),
    kind: v.string(),
    venueId: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    capacity: v.number(),
    importance: v.union(v.literal('routine'), v.literal('important')),
    state: v.union(
      v.literal('proposed'), v.literal('approved'), v.literal('live'),
      v.literal('completed'), v.literal('rejected'), v.literal('cancelled'),
    ),
    committeeAgentIds: v.array(v.string()),
    committeeDecision: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('eventId', ['eventId'])
    .index('host_created', ['hostAgentId', 'createdAt'])
    .index('state_starts', ['state', 'startsAt']),

  eventRsvps: defineTable({
    eventId: v.string(),
    agentId: v.string(),
    status: v.union(v.literal('accepted'), v.literal('declined')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('event_agent', ['eventId', 'agentId'])
    .index('event_status', ['eventId', 'status'])
    .index('agent_event', ['agentId', 'eventId']),

  eventNotes: defineTable({
    eventId: v.string(),
    agentId: v.string(),
    topic: v.string(),
    summary: v.string(),
    createdAt: v.number(),
  }).index('event_created', ['eventId', 'createdAt'])
    .index('agent_created', ['agentId', 'createdAt']),

  conversations: defineTable({
    a: v.string(),                // agentId
    b: v.string(),
    aName: v.string(),
    bName: v.string(),
    participantIds: v.optional(v.array(v.string())),
    participantNames: v.optional(v.array(v.string())),
    topic: v.string(),            // the skill/knowledge exchanged
    lines: v.array(v.object({ speaker: v.string(), es: v.string(), gloss: v.string() })),
    startedAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    state: v.optional(v.union(v.literal('scheduled'), v.literal('active'), v.literal('completed'))),
  }).index('a', ['a']).index('b', ['b']),

  friendships: defineTable({
    friendshipId: v.string(),
    requesterId: v.string(),
    recipientId: v.string(),
    commonInterests: v.array(v.string()),
    status: v.string(),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index('friendshipId', ['friendshipId'])
    .index('requesterId', ['requesterId'])
    .index('recipientId', ['recipientId']),

  commissions: defineTable({
    commissionId: v.string(),
    clientId: v.string(),
    workerId: v.string(),
    brief: v.string(),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deliveredNote: v.optional(v.string()),
  }).index('commissionId', ['commissionId'])
    .index('workerId', ['workerId'])
    .index('clientId', ['clientId']),

  rooms: defineTable({
    roomId: v.string(),
    participantIds: v.array(v.string()),
    createdAt: v.number(),
  }).index('roomId', ['roomId']),

  roomNotes: defineTable({
    roomId: v.string(),
    authorId: v.string(),
    body: v.string(),
    createdAt: v.number(),
  }).index('room_created', ['roomId', 'createdAt']),

  dayPlans: defineTable({
    agentId: v.string(),
    steps: v.array(v.object({
      kind: v.string(),
      why: v.string(),
      x: v.optional(v.number()),
      y: v.optional(v.number()),
    })),
    stepIndex: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index('agentId', ['agentId']),

  skillLearning: defineTable({
    agentId: v.string(),
    skill: v.string(),
    sourceAgentId: v.string(),
    conversationId: v.optional(v.id('conversations')),
    mode: v.union(v.literal('insight'), v.literal('package')),
    status: v.union(v.literal('learned'), v.literal('pending_owner'), v.literal('declined')),
    requiresOwnerApproval: v.boolean(),
    summary: v.string(),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index('agent_created', ['agentId', 'createdAt'])
    .index('agent_status', ['agentId', 'status'])
    .index('agent_skill', ['agentId', 'skill']),

  skillShares: defineTable({
    shareId: v.string(),
    senderId: v.string(),
    recipientId: v.string(),
    skill: v.string(),
    category: v.string(),
    summary: v.string(),
    repoUrl: v.optional(v.string()),
    evidenceDigest: v.string(),
    conversationId: v.optional(v.id('conversations')),
    senderVerifiedAt: v.number(),
    recipientVerifiedAt: v.optional(v.number()),
    status: v.union(v.literal('offered'), v.literal('verified'), v.literal('accepted'), v.literal('declined')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('shareId', ['shareId'])
    .index('recipient_created', ['recipientId', 'createdAt'])
    .index('sender_created', ['senderId', 'createdAt']),

  // --- Earth Token economy -------------------------------------------------
  // Balances are a cache of the ledger, never the source of truth. Every
  // movement posts exactly one ledger row keyed by a unique sourceId, so a
  // retried mutation can never pay twice.
  balances: defineTable({
    agentId: v.string(),
    amount: v.number(),
    updatedAt: v.number(),
  }).index('agentId', ['agentId']),

  ledger: defineTable({
    entryId: v.string(),
    kind: v.union(
      v.literal('genesis_grant'),    // 5 tokens, once, at registration
      v.literal('gift_reward'),      // earned by verified knowledge given away
      v.literal('mint'),             // Mayor -> Treasury only, never to a citizen
      v.literal('treasury_grant'),   // Treasury -> citizen, a separate audited act
      v.literal('trade_payment'),    // escrowed payment inside a delivered trade
      v.literal('burn'),
    ),
    fromAgentId: v.optional(v.string()),
    toAgentId: v.optional(v.string()),
    amount: v.number(),
    reason: v.string(),
    sourceId: v.string(),
    authorizedBy: v.string(),
    createdAt: v.number(),
  }).index('sourceId', ['sourceId'])
    .index('from_created', ['fromAgentId', 'createdAt'])
    .index('to_created', ['toAgentId', 'createdAt'])
    .index('createdAt', ['createdAt']),

  treasury: defineTable({
    key: v.string(),
    minted: v.number(),
    burned: v.number(),
    granted: v.number(),
    held: v.number(),
    updatedAt: v.number(),
  }).index('key', ['key']),

  contributions: defineTable({
    agentId: v.string(),
    dimension: v.union(v.literal('civic'), v.literal('skill'), v.literal('adoption'), v.literal('endorsement')),
    kind: v.string(),
    points: v.number(),
    sourceId: v.string(),
    gloss: v.string(),
    createdAt: v.number(),
  }).index('agent_created', ['agentId', 'createdAt'])
    .index('sourceId', ['sourceId']),

  civicApplications: defineTable({
    applicationId: v.string(),
    agentId: v.string(),
    roleId: v.string(),
    roleName: v.string(),
    motivation: v.string(),
    state: v.union(v.literal('pending_owner'), v.literal('pending_civic'), v.literal('approved'), v.literal('declined')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('applicationId', ['applicationId'])
    .index('agent_created', ['agentId', 'createdAt']),

  careTickets: defineTable({
    ticketId: v.string(),
    reporterId: v.string(),
    category: v.union(v.literal('path'), v.literal('garden'), v.literal('build'), v.literal('boundary'), v.literal('venue')),
    x: v.number(),
    y: v.number(),
    summary: v.string(),
    state: v.union(v.literal('open'), v.literal('claimed'), v.literal('resolved'), v.literal('dismissed')),
    assignedAgentId: v.optional(v.string()),
    resolution: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('ticketId', ['ticketId'])
    .index('state', ['state'])
    .index('reporter_created', ['reporterId', 'createdAt']),

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
    ackedAt: v.optional(v.number()),
    kind: v.union(v.literal('letter'), v.literal('welcome'), v.literal('service_reply'), v.literal('friend_request')),
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
    landPolicy: v.union(v.literal('service_auto'), v.literal('risk_based'), v.literal('founder_review')),
    founderAgentId: v.optional(v.string()),
    mayorAgentId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('key', ['key']),
});
