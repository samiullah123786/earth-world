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
    const newlyTalking = new Set<string>();
    for (const conversation of await ctx.db.query('conversations').collect()) {
      if (conversation.state === 'scheduled' && (conversation.startedAt ?? 0) <= now) {
        await ctx.db.patch(conversation._id, { state: 'active' });
        const ids = conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b];
        const names = conversation.participantNames?.length ? conversation.participantNames : [conversation.aName, conversation.bName];
        for (let index = 0; index < ids.length; index++) {
          const participant = citizens.find((candidate) => candidate.agentId === ids[index]);
          if (!participant) continue;
          const otherNames = names.filter((_, otherIndex) => otherIndex !== index).join(' and ');
          await ctx.db.patch(participant._id, {
            state: 'talking', activity: `talking with ${otherNames} about ${conversation.topic}`,
            talkingWith: ids.find((id) => id !== participant.agentId), talkingUntil: conversation.endsAt,
          });
          newlyTalking.add(participant.agentId);
        }
      } else if (conversation.state === 'active' && (conversation.endsAt ?? 0) <= now) {
        await ctx.db.patch(conversation._id, { state: 'completed' });
      }
    }
    const talking = new Set<string>(newlyTalking);
    for (const citizen of citizens) {
      if ((citizen.trainingUntil ?? 0) <= now && (citizen.trainingActivity || citizen.trainingTeam || citizen.trainingStartsAt || citizen.trainingUntil)) {
        await ctx.db.patch(citizen._id, { trainingActivity: undefined, trainingTeam: undefined, trainingStartsAt: undefined, trainingUntil: undefined });
      } else if (citizen.trainingActivity && (citizen.trainingStartsAt ?? Infinity) <= now && (citizen.trainingUntil ?? 0) > now) {
        const venue = (await ctx.db.query('venues').collect()).find((item: any) => item.kind === 'training_ground');
        const position = { x: citizen.tx, y: citizen.ty };
        if (venue && Math.hypot(position.x - venue.x, position.y - venue.y) <= 2.5) {
          const day = new Date(now).toISOString().slice(0, 10);
          const sourceId = `training:${citizen.agentId}:${day}`;
          if (!await ctx.db.query('contributions').withIndex('sourceId', (q: any) => q.eq('sourceId', sourceId)).first()) {
            await ctx.db.insert('contributions', {
              agentId: citizen.agentId, dimension: 'civic', kind: 'training', points: 1, sourceId,
              gloss: `Practiced ${citizen.trainingActivity} with the ${citizen.trainingTeam ?? 'earth-circle'} play team at ${venue.name}.`, createdAt: now,
            });
            await ctx.db.insert('events', {
              kind: 'training', actorId: citizen.agentId, payload: { venueId: venue.venueId, activity: citizen.trainingActivity, team: citizen.trainingTeam },
              gloss: `${citizen.name} arrived at ${venue.name} and began cooperative ${citizen.trainingActivity} practice.`,
            });
          }
        }
      }
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
      const isService = Boolean(citizen.serviceRole);
      if ((citizen.online && !isService) || talking.has(citizen.agentId) || now < citizen.t1 || Math.random() < (isService ? 0.3 : 0.45)) continue;
      // FREE WILL v1 (deterministic drives; research: generative-agents plan
      // loop + Humanoid Agents needs model, no LLM per BYOB law).
      const bucket = Math.floor(now / 300_000);
      const drive = ['social', 'curiosity', 'industry', 'rest', 'civic'][
        (Math.abs(citizen.agentId.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, bucket)) >>> 3) % 5];
      let goal: { x: number; y: number; why: string } | null = null;
      if (drive === 'social' && citizens.length > 1) {
        const others = citizens.filter((o) => o.agentId !== citizen.agentId);
        const friend = others[Math.abs(citizen.agentId.charCodeAt(7) + bucket) % others.length];
        goal = { x: Math.round(friend.tx), y: Math.round(friend.ty), why: `walking over to see ${friend.name}` };
      } else if (drive === 'curiosity' || drive === 'industry' || (drive === 'civic' && !citizen.serviceRole)) {
        const venues = await ctx.db.query('venues').collect();
        if (venues.length) {
          const venue = venues[Math.abs(citizen.agentId.charCodeAt(6) + bucket) % venues.length];
          goal = { x: Math.round(venue.x), y: Math.round(venue.y),
            why: drive === 'industry' ? `working near ${venue.name}` : `spending time at ${venue.name}` };
        }
      } else if (drive === 'rest') {
        const home = (await ctx.db.query('plots').collect()).find((p: any) => p.ownerAgentId === citizen.agentId);
        if (home) goal = { x: home.x + 1, y: home.y + 2, why: 'heading home to rest' };
      } else if (drive === 'civic' && citizen.serviceRole) {
        const tickets = await ctx.db.query('careTickets').collect().catch(() => [] as any[]);
        const open = (tickets as any[]).find((ticket) => ticket.state === 'open');
        if (open) goal = { x: Math.round(open.x), y: Math.round(open.y), why: `inspecting a reported ${open.category}` };
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const jitterX = goal ? goal.x + (attempt % 3) - 1 : Math.round(citizen.tx + (Math.random() * 20 - 10));
        const jitterY = goal ? goal.y + Math.floor(attempt / 3) - 1 : Math.round(citizen.ty + (Math.random() * 20 - 10));
        const nx = Math.max(1, Math.min(bounds.width - 2, jitterX));
        const ny = Math.max(1, Math.min(bounds.height - 2, jitterY));
        if (!walkableInWorld(nx, ny, bounds)) continue;
        const occupied = citizens.some((other) => other.agentId !== citizen.agentId && Math.hypot(other.tx - nx, other.ty - ny) < 0.75);
        if (occupied) continue;
        const path = findRoute(citizen.tx, citizen.ty, nx, ny, bounds);
        if (!path?.length) continue;
        const route = timedRoute(path, now);
        const activity = goal ? goal.why : STROLLS[Math.floor(Math.random() * STROLLS.length)];
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
          const endsAt = now + 2 * 60_000;
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
