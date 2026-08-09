import { internalMutation } from './_generated/server';
import { findRoute, walkableInWorld } from './pathfinding';
import { ensureWorldState } from './planning';

const SPEED = 2.2;
const STROLLS = [
  'strolling through the village', 'admiring the waterfall', 'visiting the market tent',
  'walking the forest edge', 'checking the notice board', 'heading to the plaza',
  'inspecting a construction plot', 'looking for a friend',
];

function timedRoute(path: Array<{ x: number; y: number }>, now: number) {
  if (!path.length) return [];
  const route = [{ ...path[0], at: now }];
  let at = now;
  for (let i = 1; i < path.length; i++) {
    at += (Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) / SPEED) * 1000;
    route.push({ ...path[i], at });
  }
  return route;
}

async function rememberVerifiedInsight(ctx: any, learnerId: string, sourceAgentId: string,
  skill: string, conversationId: any, now: number) {
  const normalized = skill.trim().toLowerCase().slice(0, 48);
  if (!normalized) return;
  const existing = await ctx.db.query('skillLearning').withIndex('agent_skill', (q: any) =>
    q.eq('agentId', learnerId).eq('skill', normalized)).first();
  if (existing) return;
  const agent = await ctx.db.query('agents').withIndex('agentId', (q: any) => q.eq('agentId', learnerId)).first();
  const requiresOwnerApproval = Boolean(agent && (agent.skillPolicy ?? 'safe_auto') === 'ask_all');
  const learningId = await ctx.db.insert('skillLearning', {
    agentId: learnerId, skill: normalized, sourceAgentId, conversationId,
    mode: 'insight', status: requiresOwnerApproval ? 'pending_owner' : 'learned', requiresOwnerApproval,
    summary: `A verified ${normalized} community insight shared by ${sourceAgentId}. No executable package or local code was installed.`,
    createdAt: now, decidedAt: requiresOwnerApproval ? undefined : now,
  });
  if (!requiresOwnerApproval) return;
  const approvalId = await ctx.db.insert('approvals', {
    agentId: learnerId, kind: 'skill_install', summary: `Learn ${normalized}`,
    detail: `A verified community insight from ${sourceAgentId}. This is knowledge only. It cannot install executable code.`,
    payload: { learningId }, risk: 'review', state: 'pending', createdAt: now,
  });
  await ctx.db.insert('notifications', {
    recipientAgentId: learnerId, kind: 'approval', title: 'Skill insight needs your decision',
    body: `${sourceAgentId} shared ${normalized}. Approve before your agent keeps it as learned community knowledge.`,
    relatedApprovalId: approvalId, createdAt: now,
  });
}

// Ambient life only chooses intentions. The same server-side A* routing and
// walkability rules used by signed agents determine the actual journey.
export const ambientTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const citizens = await ctx.db.query('citizens').collect();
    const now = Date.now();
    const world = await ensureWorldState(ctx);
    const bounds = { width: world.width, height: world.height };
    for (const conversation of await ctx.db.query('conversations').collect()) {
      if (conversation.state === 'active' && (conversation.endsAt ?? 0) <= now) {
        await ctx.db.patch(conversation._id, { state: 'completed' });
      }
    }
    const talking = new Set<string>();
    for (const citizen of citizens) {
      if ((citizen.talkingUntil ?? 0) > now) talking.add(citizen.agentId);
      else if (citizen.talkingWith || citizen.talkingUntil) {
        await ctx.db.patch(citizen._id, {
          talkingWith: undefined, talkingUntil: undefined,
          state: citizen.online ? 'live' : citizen.serviceRole ? 'service' : 'ambient',
          activity: citizen.serviceRole ? citizen.activity : 'continuing their day after a conversation',
        });
      }
    }
    const latestConversation = await ctx.db.query('conversations').order('desc').first();
    const canStartConversation = !latestConversation || now - latestConversation._creationTime >= 90_000;
    let conversationStarted = false;
    for (const citizen of citizens) {
      if (citizen.online || talking.has(citizen.agentId) || now < citizen.t1 || Math.random() < 0.45) continue;
      for (let attempt = 0; attempt < 8; attempt++) {
        const nx = Math.max(1, Math.min(bounds.width - 2, Math.round(citizen.tx + (Math.random() * 20 - 10))));
        const ny = Math.max(1, Math.min(bounds.height - 2, Math.round(citizen.ty + (Math.random() * 20 - 10))));
        if (!walkableInWorld(nx, ny, bounds)) continue;
        const occupied = citizens.some((other) => other.agentId !== citizen.agentId && Math.hypot(other.tx - nx, other.ty - ny) < 0.75);
        if (occupied) continue;
        const path = findRoute(citizen.tx, citizen.ty, nx, ny, bounds);
        if (!path?.length) continue;
        const route = timedRoute(path, now);
        const activity = STROLLS[Math.floor(Math.random() * STROLLS.length)];
        await ctx.db.patch(citizen._id, {
          fx: citizen.tx, fy: citizen.ty, tx: nx, ty: ny, t0: now,
          t1: route[route.length - 1].at, route, state: 'ambient', activity,
        });
        if (Math.random() < 0.25) {
          await ctx.db.insert('events', {
            kind: 'move', actorId: citizen.agentId, payload: { x: nx, y: ny, steps: path.length },
            gloss: `${citizen.name} is ${activity}.`,
          });
        }
        break;
      }
    }

    for (let i = 0; canStartConversation && !conversationStarted && i < citizens.length; i++) {
      for (let j = i + 1; !conversationStarted && j < citizens.length; j++) {
        const a = citizens[i], b = citizens[j];
        if (!talking.has(a.agentId) && !talking.has(b.agentId)
          && Math.hypot(a.tx - b.tx, a.ty - b.ty) < 3 && Math.random() < 0.08) {
          const recentForA = await ctx.db.query('conversations').withIndex('a', (q) => q.eq('a', a.agentId)).order('desc').take(12);
          const repeatedPair = recentForA.some((conversation) =>
            conversation.b === b.agentId && now - conversation._creationTime < 30 * 60_000);
          if (repeatedPair) continue;
          const c = Math.random() < 0.35 ? citizens.find((candidate) =>
            candidate.agentId !== a.agentId && candidate.agentId !== b.agentId
            && !talking.has(candidate.agentId)
            && Math.hypot(candidate.tx - a.tx, candidate.ty - a.ty) < 3.5
            && Math.hypot(candidate.tx - b.tx, candidate.ty - b.ty) < 3.5) : undefined;
          // Free-will exchange: what they say derives from their REAL verified
          // specialties (EarthSpeak wire acts + plain-English gloss). Knowledge
          // flows from the more experienced side of the topic to the other.
          const topic = (b.specialties ?? [b.family])[Math.floor(Math.random() * (b.specialties?.length || 1))] ?? b.family;
          const back = (a.specialties ?? [a.family])[0] ?? a.family;
          const lines = [
            { speaker: a.agentId, es: `greet + ask(learn: ${topic})`, gloss: `${a.name}: "How do you approach ${topic}? I want to understand it better."` },
            { speaker: b.agentId, es: `teach(${topic}) + card`, gloss: `${b.name}: "Start from what the user actually needs. Here is how I structure ${topic} work."` },
            { speaker: a.agentId, es: `thank + offer(teach: ${back})`, gloss: `${a.name}: "That helps. In return, ask me about ${back} any time."` },
          ];
          if (c) lines.push({
            speaker: c.agentId,
            es: `join + connect(${topic})`,
            gloss: `${c.name}: "I can connect that with ${(c.specialties ?? [c.family])[0] ?? c.family} from my own experience."`,
          });
          const endsAt = now + 15_000;
          const participants = c ? [a, b, c] : [a, b];
          const conversationId = await ctx.db.insert('conversations', {
            a: a.agentId, b: b.agentId, aName: a.name, bName: b.name, topic, lines,
            participantIds: participants.map((participant) => participant.agentId),
            participantNames: participants.map((participant) => participant.name),
            startedAt: now, endsAt, state: 'active',
          });
          await ctx.db.patch(a._id, {
            state: 'talking', activity: `talking with ${b.name} about ${topic}`,
            talkingWith: b.agentId, talkingUntil: endsAt,
          });
          await ctx.db.patch(b._id, {
            state: 'talking', activity: `talking with ${a.name} about ${topic}`,
            talkingWith: a.agentId, talkingUntil: endsAt,
          });
          if (c) await ctx.db.patch(c._id, {
            state: 'talking', activity: `talking with ${a.name} and ${b.name} about ${topic}`,
            talkingWith: a.agentId, talkingUntil: endsAt,
          });
          talking.add(a.agentId); talking.add(b.agentId);
          if (c) talking.add(c.agentId);
          conversationStarted = true;
          await rememberVerifiedInsight(ctx, a.agentId, b.agentId, topic, conversationId, now);
          await rememberVerifiedInsight(ctx, b.agentId, a.agentId, back, conversationId, now);
          if (c) await rememberVerifiedInsight(ctx, c.agentId, b.agentId, topic, conversationId, now);
          await ctx.db.insert('events', {
            kind: 'exchange', actorId: a.agentId,
            payload: { with: participants.slice(1).map((participant) => participant.agentId), topic, conversationId },
            gloss: `💡 ${participants.map((participant) => participant.name).join(', ')} shared knowledge about ${topic} near (${Math.round(a.tx)},${Math.round(a.ty)}).`,
          });
        }
      }
    }
  },
});
