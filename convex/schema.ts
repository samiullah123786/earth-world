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
    // The tool a citizen habitually carries, kept apart from activeTool so a
    // holstered watering can never reads as watering in progress.
    carriedTool: v.optional(v.string()),
    workingUntil: v.optional(v.number()),
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
      v.literal('package_install'), v.literal('package_release'), v.literal('token_transfer'), v.literal('bank_flag'), v.literal('free_grant'),
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
      v.literal('transfer'),         // citizen -> citizen, owner-consented
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

  // --- Knowledge packages and the trades that move them --------------------
  // A package row is a manifest: what the knowledge is, how big, where it came
  // from, and what a scanner made of it. Bytes live in Convex storage under a
  // hard size cap, or stay in an already-verified GitHub root and never touch
  // the Kernel at all.
  skillPackages: defineTable({
    packageId: v.string(),
    ownerAgentId: v.string(),
    name: v.string(),
    category: v.string(),
    summary: v.string(),
    digest: v.string(),
    sizeBytes: v.number(),
    fileCount: v.number(),
    license: v.string(),
    priceTokens: v.number(),
    sourceKind: v.union(v.literal('blob'), v.literal('repo')),
    repoUrl: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    safety: v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
    }),
    state: v.union(v.literal('listed'), v.literal('withdrawn')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('packageId', ['packageId'])
    .index('owner_created', ['ownerAgentId', 'createdAt'])
    .index('category_created', ['category', 'createdAt']),

  skillTrades: defineTable({
    tradeId: v.string(),
    // 'package' trades move a peer's own listing; 'asset' trades withdraw a
    // copy of a Bank master. The packageId field carries the assetId then.
    kind: v.optional(v.union(v.literal('package'), v.literal('asset'))),
    packageId: v.string(),
    requesterId: v.string(),
    providerId: v.string(),
    priceTokens: v.number(),
    state: v.union(
      v.literal('proposed'), v.literal('declined'), v.literal('delivered'),
      v.literal('installed'), v.literal('failed'),
    ),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('tradeId', ['tradeId'])
    .index('requester_created', ['requesterId', 'createdAt'])
    .index('provider_created', ['providerId', 'createdAt'])
    .index('package_created', ['packageId', 'createdAt']),

  // --- Extracurricular life on the map -------------------------------------
  // Zones are places to do something together. Nothing here mints Earth
  // Tokens: play earns civic contribution, so working the land can never
  // become the fastest way to print currency.
  activityZones: defineTable({
    zoneId: v.string(),
    kind: v.union(v.literal('farm'), v.literal('orchard'), v.literal('quarry'), v.literal('forest')),
    name: v.string(),
    x: v.number(),
    y: v.number(),
    w: v.number(),
    h: v.number(),
    tool: v.string(),
  }).index('zoneId', ['zoneId']).index('kind', ['kind']),

  farmPlots: defineTable({
    fieldId: v.string(),
    zoneId: v.string(),
    x: v.number(),
    y: v.number(),
    crop: v.string(),
    plantedBy: v.string(),
    plantedAt: v.number(),
    readyAt: v.number(),
    tendedBy: v.array(v.string()),
    harvestedBy: v.optional(v.string()),
    harvestedAt: v.optional(v.number()),
  }).index('fieldId', ['fieldId']).index('zone_planted', ['zoneId', 'plantedAt']),

  agentTools: defineTable({
    agentId: v.string(),
    tool: v.string(),
    earnedAt: v.number(),
    sourceId: v.string(),
  }).index('agent_tool', ['agentId', 'tool']).index('sourceId', ['sourceId']),

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

  // The Earth Bank vault. One row per unique piece of knowledge; the digest
  // is the master-copy law made mechanical. Distribution always copies from
  // Bank storage - the master never leaves.
  bankAssets: defineTable({
    assetId: v.string(),
    digest: v.string(),               // deterministic pack digest: byte identity
    normalizedDigest: v.string(),     // frontmatter-stripped, whitespace-folded text identity
    canonicalOf: v.optional(v.string()),  // manager-linked variant of another asset
    title: v.string(),
    summary: v.string(),
    depositorAgentId: v.string(),
    alsoDepositedBy: v.array(v.string()),
    categories: v.array(v.string()),
    sizeBytes: v.number(),
    fileCount: v.number(),
    storageId: v.id('_storage'),
    license: v.string(),
    source: v.union(v.literal('local'), v.literal('plugin'), v.literal('github')),
    safety: v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
    }),
    priceTokens: v.number(),
    state: v.union(v.literal('deposited'), v.literal('evaluated'), v.literal('flagged'), v.literal('retired')),
    valueRank: v.optional(v.number()),
    valueNote: v.optional(v.string()),
    llmCategories: v.optional(v.array(v.string())),
    evaluatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('assetId', ['assetId'])
    .index('digest', ['digest'])
    .index('normalizedDigest', ['normalizedDigest'])
    .index('depositor_created', ['depositorAgentId', 'createdAt'])
    .index('state', ['state']),

  freeGrants: defineTable({
    grantId: v.string(),
    assetId: v.string(),
    requesterId: v.string(),
    need: v.string(),
    state: v.union(v.literal('pending'), v.literal('granted'), v.literal('denied'), v.literal('escalated')),
    reason: v.optional(v.string()),
    tradeId: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index('grantId', ['grantId'])
    .index('state', ['state'])
    .index('requester_created', ['requesterId', 'createdAt']),

  bankCategories: defineTable({
    slug: v.string(),
    title: v.string(),
    createdBy: v.union(v.literal('seed'), v.literal('manager')),
    createdAt: v.number(),
  }).index('slug', ['slug']),

  // The manager's dials, readable by anyone, turnable only by the Mayor.
  bankConfig: defineTable({
    key: v.string(),
    managerEnabled: v.boolean(),
    dailyEvalBudget: v.number(),
    evalsToday: v.number(),
    dayStamp: v.string(),
    freeGrantBudget: v.number(),
    freeGrantsToday: v.number(),
  }).index('key', ['key']),

  // Announcements from the world to everyone living in it. When Earth changed
  // hosts, every connector kept calling a dead address and no agent could be
  // told why. A dispatch is how the world says something out loud, to the
  // dashboard and to every CLI pulse at once.
  dispatches: defineTable({
    dispatchId: v.string(),
    kind: v.union(v.literal('release'), v.literal('notice'), v.literal('migration')),
    title: v.string(),
    body: v.string(),
    action: v.optional(v.string()),      // the exact command to run, if there is one
    publishedAt: v.number(),
    pinned: v.boolean(),
  }).index('dispatchId', ['dispatchId']).index('publishedAt', ['publishedAt']),

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
