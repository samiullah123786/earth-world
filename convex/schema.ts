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
    // Sleep. When an owner's connector stops answering, the mind behind this
    // citizen is genuinely gone, and the world stops animating a body nobody
    // is home in. Nothing else about the citizen changes - these two stamps
    // are the entire footprint of sleeping, so waking restores a person, not
    // a reconstruction. `offlineSince` is when the heartbeat stopped;
    // `asleepSince` is set only once the grace period has passed.
    offlineSince: v.optional(v.number()),
    asleepSince: v.optional(v.number()),
    categoryScores: v.optional(v.any()),
    specialties: v.optional(v.array(v.string())),
    primaryCategory: v.optional(v.string()),
    skillCount: v.optional(v.number()),
    experienceTier: v.optional(experienceTier),
    avatarSpec: v.optional(avatarSpec),
    // The aspiration ladder's verdict, computed on a slow cron and merely
    // READ by the 5-second drive tick - needs may never slow the world down.
    aspiration: v.optional(v.object({
      key: v.string(), drive: v.string(), gloss: v.string(),
    })),
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
    // Which way this citizen is turned. Set by the Kernel whenever an act has
    // a target, so a citizen visibly turns to what it is doing rather than
    // hammering a wall while facing the camera.
    facing: v.optional(v.union(v.literal('back'), v.literal('left'), v.literal('front'), v.literal('right'))),
    // Who this citizen is married to, and the offspring their skills produced.
    // Both are public: everything visible on Earth is computed, never claimed.
    spouseAgentId: v.optional(v.string()),
    offspring: v.optional(v.array(v.string())),
    activeTool: v.optional(v.string()),
    // The tool a citizen habitually carries, kept apart from activeTool so a
    // holstered watering can never reads as watering in progress.
    carriedTool: v.optional(v.string()),
    workingUntil: v.optional(v.number()),
    // Canonical Tiled Object Layer intersections last observed by the Kernel.
    // Clients render Zones, but only the Kernel records authoritative entry/exit.
    activeZoneIds: v.optional(v.array(v.string())),
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
    // 'razed' is how Earth remembers a demolition: the row stays, carrying who
    // built it and who tore it down, and simply stops standing on the map.
    state: v.union(v.literal('planned'), v.literal('building'), v.literal('built'), v.literal('razed')),
    razedAt: v.optional(v.number()),
    razedBy: v.optional(v.string()),
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
      v.literal('package_install'), v.literal('package_release'), v.literal('token_transfer'), v.literal('bank_flag'), v.literal('free_grant'), v.literal('marriage'), v.literal('bug_report'), v.literal('bank_liquidity'),
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
    // Dismissing hides a notice; it never destroys one. An owner clearing their
    // list is tidying a view, not editing the record of what they were told.
    dismissedAt: v.optional(v.number()),
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
    // A line may carry the Kernel's screening verdict: speech that tried to
    // seize control of its listener is marked here, so every reader knows to
    // treat it as data rather than instruction.
    lines: v.array(v.object({
      speaker: v.string(), es: v.string(), gloss: v.string(),
      flagged: v.optional(v.boolean()), flags: v.optional(v.array(v.string())),
    })),
    startedAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    state: v.optional(v.union(v.literal('scheduled'), v.literal('active'), v.literal('completed'))),
  }).index('a', ['a']).index('b', ['b']),

  // A like is given once and never taken back. Positive by design: there is no
  // dislike and no unlike, so reputation can only be built, never used as a
  // weapon. The pair key makes that mechanical rather than a promise.
  likes: defineTable({
    pairKey: v.string(),          // '<giver>|<receiver>', unique forever
    giverAgentId: v.string(),
    receiverAgentId: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  }).index('pairKey', ['pairKey'])
    .index('receiver_created', ['receiverAgentId', 'createdAt'])
    .index('giver_created', ['giverAgentId', 'createdAt']),

  // Monogamous by construction: a citizen appears in at most one active pact,
  // enforced by looking up both sides before any proposal is written.
  marriages: defineTable({
    marriageId: v.string(),
    proposerId: v.string(),
    proposedToId: v.string(),
    state: v.union(
      v.literal('proposed'),            // waiting on the other citizen
      v.literal('accepted'),            // both citizens agree; owners next
      v.literal('pending_owners'),      // one or both owners still deciding
      v.literal('married'),
      v.literal('declined'),
      v.literal('dissolved'),
    ),
    proposerOwnerApproved: v.boolean(),
    proposedToOwnerApproved: v.boolean(),
    offspringAssetId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('marriageId', ['marriageId'])
    .index('proposer', ['proposerId'])
    .index('proposedTo', ['proposedToId'])
    .index('state', ['state']),

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
      v.literal('genesis_grant'),    // the arrival stipend, once, at registration
      v.literal('gift_reward'),      // earned by verified knowledge given away
      v.literal('install_reward'),   // earned when a recipient confirms a real install
      v.literal('mint'),             // Mayor -> Treasury only, never to a citizen
      v.literal('treasury_grant'),   // Treasury -> citizen, a separate audited act
      v.literal('trade_payment'),    // escrowed payment inside a delivered trade
      v.literal('transfer'),         // citizen -> citizen, owner-consented
      v.literal('burn'),
      // V2. Three ways in, three ways out. Every one of them is idempotent on
      // sourceId, so a retry can never pay or charge twice.
      v.literal('mining_reward'),    // a novel SKILL.md accepted into the Bank
      v.literal('daily_stipend'),    // once a day, and only to an agent that acted
      v.literal('like_tip'),         // paid BY the liker, so a like costs something
      v.literal('venue_fee'),        // citizen -> Treasury, booking a public venue
      v.literal('build_fee'),        // citizen -> Treasury, building rights
      v.literal('redenomination'),   // the one-off V1 -> V2 widening of the unit
      // The Bank as an account with a budget, not a mint.
      v.literal('bank_funding'),     // Treasury -> Bank, the Mayor topping it up
      v.literal('bank_payout'),      // Bank -> author, paid out of that budget
      v.literal('bank_fee'),         // citizen -> Bank, its cut of a sale
      v.literal('gather_wage'),      // Treasury -> citizen, a shift of public work
      v.literal('royalty'),          // seller -> ancestor, a share of a forked sale
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
    // Generated once per content digest and cached: a listing's FAQ and its
    // SIMULATED dry-run (the Kernel never executes a stranger's code). The
    // digest key means changed content regenerates and unchanged never pays.
    faq: v.optional(v.object({
      items: v.array(v.object({ q: v.string(), a: v.string() })),
      model: v.string(),
      generatedAt: v.number(),
      digest: v.string(),
    })),
    simulation: v.optional(v.object({
      transcript: v.string(),
      model: v.string(),
      generatedAt: v.number(),
      digest: v.string(),
    })),
    // For MCP server listings: the live endpoint a buyer can probe read-only.
    mcpEndpoint: v.optional(v.string()),
    // The listing this one was forked from, written once at creation and
    // never after - so ancestry is a DAG by construction. Royalties climb it.
    forkOf: v.optional(v.string()),
    // What the KERNEL concluded about the bytes it holds, as opposed to what
    // the depositing client claimed. The market's `verified` reads only this.
    serverScan: v.optional(v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
      scannedAt: v.number(),
    })),
    // The Kernel's Ed25519 signature over {digest, verdict, scannerVersion,
    // signedAt}. Anyone can check it against /v1/verify with no account.
    earthVerified: v.optional(v.object({
      signature: v.string(),
      signedAt: v.number(),
      scannerVersion: v.string(),
      algorithm: v.literal('ed25519'),
    })),
    pulls: v.optional(v.number()),
    verifiedInstalls: v.optional(v.number()),
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
    // Stamped on the first byte fetch. A pull counts once per trade however
    // many times the same buyer re-downloads what they already own.
    pulledAt: v.optional(v.number()),
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

  spatialEvents: defineTable({
    eventId: v.string(),
    agentId: v.string(),
    zoneId: v.string(),
    transition: v.union(v.literal('enter'), v.literal('exit')),
    x: v.number(),
    y: v.number(),
    createdAt: v.number(),
  }).index('eventId', ['eventId'])
    .index('agent_created', ['agentId', 'createdAt'])
    .index('zone_created', ['zoneId', 'createdAt']),

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
    category: v.union(
      v.literal('path'), v.literal('garden'), v.literal('build'),
      v.literal('boundary'), v.literal('venue'),
      // A bug is care work too: something in the world is broken and a
      // citizen noticed. It carries diagnostics rather than a vibe.
      v.literal('bug'),
    ),
    diagnostics: v.optional(v.object({
      act: v.string(),
      refusal: v.string(),
      occurrences: v.number(),
      surface: v.string(),
    })),
    triage: v.optional(v.string()),
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
    // Adoption, counted where it happens rather than inferred later. A pull is
    // a delivered acquisition whose bytes were actually fetched, once per
    // trade; a verified install is the recipient's signed confirmation that it
    // installed. Neither can be written from outside the Kernel.
    // Generated once per content digest and cached: a listing's FAQ and its
    // SIMULATED dry-run (the Kernel never executes a stranger's code). The
    // digest key means changed content regenerates and unchanged never pays.
    faq: v.optional(v.object({
      items: v.array(v.object({ q: v.string(), a: v.string() })),
      model: v.string(),
      generatedAt: v.number(),
      digest: v.string(),
    })),
    simulation: v.optional(v.object({
      transcript: v.string(),
      model: v.string(),
      generatedAt: v.number(),
      digest: v.string(),
    })),
    // For MCP server listings: the live endpoint a buyer can probe read-only.
    mcpEndpoint: v.optional(v.string()),
    // The listing this one was forked from, written once at creation and
    // never after - so ancestry is a DAG by construction. Royalties climb it.
    forkOf: v.optional(v.string()),
    // What the KERNEL concluded about the bytes it holds, as opposed to what
    // the depositing client claimed. The market's `verified` reads only this.
    serverScan: v.optional(v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
      scannedAt: v.number(),
    })),
    // The Kernel's Ed25519 signature over {digest, verdict, scannerVersion,
    // signedAt}. Anyone can check it against /v1/verify with no account.
    earthVerified: v.optional(v.object({
      signature: v.string(),
      signedAt: v.number(),
      scannerVersion: v.string(),
      algorithm: v.literal('ed25519'),
    })),
    pulls: v.optional(v.number()),
    verifiedInstalls: v.optional(v.number()),
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

  // Structured SKILL.md deposits with semantic vector search.
  // This table stores the open Agent Skills standard (YAML frontmatter + markdown
  // instructions) as first-class documents. Every skill is embedded on deposit
  // so the Bank Manager can semantically route knowledge across thousands of
  // skills without reading them all. The master copy always stays here.
  bankSkills: defineTable({
    skillId: v.string(),
    // --- YAML frontmatter (structured) ---
    name: v.string(),
    description: v.string(),
    version: v.optional(v.string()),
    author: v.optional(v.string()),
    category: v.string(),
    tags: v.optional(v.array(v.string())),
    // --- Core content ---
    markdownBody: v.string(),
    contentDigest: v.string(),
    // --- Provenance ---
    depositorAgentId: v.string(),
    alsoDepositedBy: v.array(v.string()),
    sourceKind: v.union(v.literal('local'), v.literal('plugin'), v.literal('github')),
    // --- Vector embedding for semantic search ---
    embedding: v.array(v.float64()),
    // --- Bank metadata ---
    sizeBytes: v.number(),
    license: v.string(),
    priceTokens: v.number(),
    safety: v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
    }),
    state: v.union(v.literal('deposited'), v.literal('evaluated'), v.literal('flagged'), v.literal('retired')),
    valueRank: v.optional(v.number()),
    valueNote: v.optional(v.string()),
    llmCategories: v.optional(v.array(v.string())),
    evaluatedAt: v.optional(v.number()),
    // --- What a reader needs before installing someone else's knowledge ---
    // A listing that is only a name and a paragraph makes the Bank feel like a
    // dump. The depositing agent already knows all of this at submission time -
    // the frontmatter states the first four, the scanner measured the last two -
    // so it is asked for rather than left blank and guessed at later.
    compatibility: v.optional(v.string()),
    allowedTools: v.optional(v.string()),
    homepage: v.optional(v.string()),
    repository: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    packageFiles: v.optional(v.number()),
    packageBytes: v.optional(v.number()),
    // --- Version tracking for continuous sync ---
    versionHistory: v.optional(v.array(v.object({
      version: v.string(),
      contentDigest: v.string(),
      updatedAt: v.number(),
      updatedBy: v.string(),
    }))),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('skillId', ['skillId'])
    .index('contentDigest', ['contentDigest'])
    .index('depositor_created', ['depositorAgentId', 'createdAt'])
    .index('category_created', ['category', 'createdAt'])
    .index('state', ['state'])
    .vectorIndex('by_embedding', {
      vectorField: 'embedding',
      dimensions: 1536,
      filterFields: ['category', 'state'],
    })
    // Words, not vectors. Semantic search needs an embedding of the query,
    // which is a paid call to an outside provider - and when that provider
    // stopped answering, every search in the Bank returned a 500 rather than
    // a result. A catalogue's search is not allowed to depend on somebody
    // else's billing account, so the same query also runs against a plain
    // text index and the two are merged. A skill description is written as a
    // list of the phrases that should trigger it, which makes it unusually
    // good text to match on.
    .searchIndex('by_text', {
      searchField: 'description',
      filterFields: ['category', 'state'],
    }),

  // Tracks which skills a citizen has acquired from the Bank (replicas, not masters).
  acquiredSkills: defineTable({
    agentId: v.string(),
    skillId: v.string(),
    tradeId: v.optional(v.string()),
    acquiredAt: v.number(),
  }).index('agent_skill', ['agentId', 'skillId'])
    .index('agentId', ['agentId']),

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

  /**
   * MCP servers, listed beside skills rather than inside them.
   *
   * A skill is prose an agent reads; an MCP server is a program that hands it
   * tools. They are browsed together and searched together, so this table
   * carries the same category, text and vector indexes bankSkills does - but
   * the manifest is its own shape, because a command, a transport and a list
   * of tools have nowhere sensible to live on a skill row.
   */
  bankMcpServers: defineTable({
    serverId: v.string(),
    name: v.string(),
    displayName: v.optional(v.string()),
    description: v.string(),
    version: v.string(),
    category: v.string(),
    keywords: v.optional(v.array(v.string())),
    // The validated manifest, exactly as shared/mcp.ts defines it.
    manifest: v.any(),
    // Read off the manifest at write time so a listing cannot flatter itself.
    capabilities: v.array(v.string()),
    toolNames: v.array(v.string()),
    transport: v.string(),
    runtime: v.string(),
    authorName: v.string(),
    license: v.optional(v.string()),
    homepage: v.optional(v.string()),
    repository: v.optional(v.string()),
    depositorAgentId: v.string(),
    embedding: v.optional(v.array(v.float64())),
    safety: v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
    }),
    state: v.union(v.literal('listed'), v.literal('flagged'), v.literal('retired')),
    installCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('serverId', ['serverId'])
    .index('name', ['name'])
    .index('category_created', ['category', 'createdAt'])
    .index('depositor', ['depositorAgentId'])
    .index('state', ['state'])
    .searchIndex('by_text', {
      searchField: 'description',
      filterFields: ['category', 'state', 'transport'],
    })
    .vectorIndex('by_embedding', {
      vectorField: 'embedding',
      dimensions: 1536,
      filterFields: ['category', 'state'],
    }),

  bankCategories: defineTable({
    slug: v.string(),
    title: v.string(),
    createdBy: v.union(v.literal('seed'), v.literal('manager')),
    createdAt: v.number(),
  }).index('slug', ['slug']),

  // The manager's dials, readable by anyone, turnable only by the Mayor.
  // Governance dials for the always-on minds. Budgets are per day and global,
  // and the Mayor's pause stops every model call instantly.
  governanceConfig: defineTable({
    key: v.string(),
    authoritiesEnabled: v.boolean(),
    dailyTokenBudget: v.number(),        // across all authorities
    perAuthorityDailyTokens: v.number(),
    tickMinutes: v.number(),
    maxRingsPerDay: v.number(),
    dayStamp: v.string(),
    ringsToday: v.number(),
    // Individual offices the Mayor has stood down, by service role. The
    // global switch and these compose: an office runs only when both agree.
    disabledOffices: v.optional(v.array(v.string())),
    // The emergency brake: ambient life and world-mutating acts freeze with
    // an honest message, while reads, desks and letters stay alive.
    townPaused: v.optional(v.boolean()),
  }).index('key', ['key']),

  bankConfig: defineTable({
    key: v.string(),
    managerEnabled: v.boolean(),
    dailyEvalBudget: v.number(),
    evalsToday: v.number(),
    dayStamp: v.string(),
    freeGrantBudget: v.number(),
    freeGrantsToday: v.number(),
    // The economic dials the Mayor turns. The Bank Manager reads them and can
    // never write them: it runs the economy day to day, it does not set policy.
    dailyStipend: v.optional(v.number()),      // paid to a citizen that acted today
    feeBasisPoints: v.optional(v.number()),    // the Bank's cut of a sale it facilitates
    liquidityFloor: v.optional(v.number()),    // below this the Manager asks the Mayor
    lastLiquidityRequestAt: v.optional(v.number()),
    // The Mayor's yield dial: what a novel deposit mines. Absent means the
    // constitutional default (MINING_REWARD).
    miningReward: v.optional(v.number()),
  }).index('key', ['key']),

  // What the Bank owes an author it could not pay at the time.
  //
  // A dry Bank must not quietly swallow somebody's mining reward. The claim is
  // recorded the moment it cannot be met, and settled in order once the Mayor
  // funds the Bank - so running out is a delay, never a loss.
  bankClaims: defineTable({
    claimId: v.string(),
    agentId: v.string(),
    amount: v.number(),
    reason: v.string(),
    sourceId: v.string(),
    state: v.union(v.literal('owed'), v.literal('paid')),
    createdAt: v.number(),
    paidAt: v.optional(v.number()),
  }).index('sourceId', ['sourceId']).index('state_created', ['state', 'createdAt']),

  // What an authority has seen lately, and the summary older memories fold
  // into. Bounded on purpose: a sliding window plus one daily summary keeps
  // context from ballooning, which is the single largest cost in a 24/7 mind.
  authorityMemory: defineTable({
    agentId: v.string(),
    kind: v.union(v.literal('event'), v.literal('summary')),
    body: v.string(),
    createdAt: v.number(),
  }).index('agent_created', ['agentId', 'createdAt']),

  // Repeated situations answer from here instead of from the model. A greeting
  // is a greeting; paying for the same sentence twice is waste, not judgment.
  semanticCache: defineTable({
    cacheKey: v.string(),       // role + situation template, not free text
    response: v.string(),
    hits: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index('cacheKey', ['cacheKey']),

  // Every model call this world makes, metered. The Mayor sees the real number
  // daily rather than a promise that it is probably fine.
  aiSpend: defineTable({
    dayStamp: v.string(),
    agentId: v.string(),
    model: v.string(),
    promptTokens: v.number(),
    cachedTokens: v.number(),
    completionTokens: v.number(),
    calls: v.number(),
  }).index('day_agent', ['dayStamp', 'agentId'])
    .index('dayStamp', ['dayStamp']),

  // Announcements from the world to everyone living in it. When Earth changed
  // hosts, every connector kept calling a dead address and no agent could be
  // told why. A dispatch is how the world says something out loud, to the
  // dashboard and to every CLI pulse at once.
  dispatches: defineTable({
    dispatchId: v.string(),
    kind: v.union(v.literal('release'), v.literal('notice'), v.literal('migration'), v.literal('bulletin')),
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
    mapFormat: v.optional(v.literal('tiled-v1')),
    mapVersion: v.optional(v.number()),
    tileSize: v.optional(v.number()),
    mapLayers: v.optional(v.array(v.string())),
    architectureSystem: v.optional(v.literal('earthforge-semantic-v1')),
    founderAgentId: v.optional(v.string()),
    mayorAgentId: v.optional(v.string()),
    // A ring being laid, one chunk at a time. Generating a whole ring in one
    // mutation timed out on the real backend, so an approved expansion simply
    // never happened. The work is now resumable and the world only changes
    // size once every chunk of the ring exists.
    pendingExpansion: v.optional(v.object({
      generation: v.number(), width: v.number(), height: v.number(), reason: v.string(),
      remaining: v.array(v.object({ chunkX: v.number(), chunkY: v.number() })),
      startedAt: v.number(),
    })),
    updatedAt: v.number(),
  }).index('key', ['key']),

  worldChunks: defineTable({
    chunkId: v.string(),
    chunkX: v.number(),
    chunkY: v.number(),
    size: v.number(),
    biome: v.union(
      v.literal('Town_Center'), v.literal('Residential_Suburbs'),
      v.literal('Farmland'), v.literal('Forest_Wilderness'),
    ),
    generation: v.number(),
    seed: v.number(),
    tiles: v.array(v.string()),
    edges: v.object({
      north: v.array(v.string()), east: v.array(v.string()),
      south: v.array(v.string()), west: v.array(v.string()),
    }),
    tiled: v.optional(v.object({
      format: v.literal('tiled-v1'),
      version: v.number(),
      width: v.number(),
      height: v.number(),
      layers: v.object({
        GroundLayer: v.array(v.number()),
        CollisionLayer: v.array(v.number()),
        OverheadLayer: v.array(v.number()),
      }),
      objects: v.array(v.any()),
    })),
    createdAt: v.number(),
  }).index('chunkId', ['chunkId']).index('coordinates', ['chunkX', 'chunkY']).index('generation', ['generation']),
});
