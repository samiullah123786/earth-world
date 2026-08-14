import { internalMutation } from './_generated/server';
import { createRouter, findRoute, walkableInWorld } from './pathfinding';
import { ensureWorldState } from './planning';
import { loadWorldWalkability } from './worldGrid';
import { intersectingZoneIds, spatialTransitionKey } from '../shared/tiled-world';

const SPEED = 2.2;
const STROLLS = [
  'strolling through the village', 'admiring the waterfall', 'visiting the market tent',
  'walking the forest edge', 'checking the notice board', 'heading to the plaza',
  'inspecting a construction plot', 'looking for a friend',
];

/**
 * Every route is announced BEFORE it begins.
 *
 * Routes used to start at the server's "now", so by the time the update
 * crossed the network the walk was half over - or entirely over, leaving
 * viewers nothing to draw but the arrival. That is the teleport people saw.
 * Stamping the first step a moment in the future means every watcher
 * receives the whole path before the citizen lifts a foot, and every screen
 * plays the same walk at the same instant. (Scheduled movement: the standard
 * companion to entity interpolation.)
 */
const ROUTE_LEAD_MS = 900;

function timedRoute(path: Array<{ x: number; y: number }>, now: number) {
  if (!path.length) return [];
  const startAt = now + ROUTE_LEAD_MS;
  const route = [{ ...path[0], at: startAt }];
  let at = startAt;
  for (let i = 1; i < path.length; i++) {
    at += (Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) / SPEED) * 1000;
    route.push({ ...path[i], at });
  }
  return route;
}

function currentPosition(citizen: any, now: number) {
  const route = Array.isArray(citizen.route) ? citizen.route : [];
  if (route.length) {
    if (now <= route[0].at) return { x: route[0].x, y: route[0].y };
    for (let index = 1; index < route.length; index++) {
      if (now > route[index].at) continue;
      const previous = route[index - 1];
      const span = Math.max(1, route[index].at - previous.at);
      const progress = Math.max(0, Math.min(1, (now - previous.at) / span));
      return {
        x: previous.x + (route[index].x - previous.x) * progress,
        y: previous.y + (route[index].y - previous.y) * progress,
      };
    }
    return { x: route[route.length - 1].x, y: route[route.length - 1].y };
  }
  return { x: citizen.tx, y: citizen.ty };
}

// Ambient life only chooses intentions. The same server-side A* routing and
// walkability rules used by signed agents determine the actual journey.
/**
 * The first thing B verifiably knows that A verifiably lacks. Deterministic:
 * same genomes, same gap. Falls back to B's family when their sets overlap
 * entirely - even then the topic is a verified capability, never small talk.
 */
export function knowledgeGapTopic(aSpecialties: string[], bSpecialties: string[]): string {
  const known = new Set(aSpecialties);
  return bSpecialties.find((specialty) => !known.has(specialty)) ?? bSpecialties[0] ?? 'general';
}

export const ambientTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    // The Mayor's pause freezes ambient life mid-step: nobody ambles, nobody
    // drifts, and the world resumes exactly where it stood.
    const governance = await ctx.db.query('governanceConfig').withIndex('key', (q) => q.eq('key', 'earth')).first();
    if (governance?.townPaused) return;
    const citizens = await ctx.db.query('citizens').collect();
    const now = Date.now();
    const world = await ensureWorldState(ctx);
    const bounds = { width: world.width, height: world.height };
    const isWalkable = await loadWorldWalkability(ctx, bounds);
    // One router per tick, not one per path attempt. Everything below asks
    // this for routes; the grid and the A* engine are built exactly once.
    const router = createRouter(bounds, isWalkable);
    // A bounded movement budget: however large the town grows, one heartbeat
    // costs at most this many path searches. Citizens take turns by a rotating
    // offset, so nobody is starved and the backend is never surprised.
    const MOVE_BUDGET = 6;
    let movesPlanned = 0;
    // ONE read of each table per tick, never one per citizen. Seventeen
    // citizens each scanning venues, plots, tickets and conversations is
    // seventeen full scans every five seconds - the tick began timing out
    // ("too many system operations") and skipped fourteen runs in a row,
    // which is exactly why citizens stood still and then jumped. This
    // snapshot is the tick's whole read budget, and it does not grow with
    // population: more citizens now cost arithmetic, not queries.
    const [allVenues, allPlots, allTickets, recentConversations, allZones] = await Promise.all([
      ctx.db.query('venues').collect(),
      ctx.db.query('plots').collect(),
      ctx.db.query('careTickets').withIndex('state', (q: any) => q.eq('state', 'open')).take(20),
      ctx.db.query('conversations').order('desc').take(120),
      ctx.db.query('activityZones').collect(),
    ]);
    const homeByOwner = new Map<string, any>();
    for (const plot of allPlots) if (plot.ownerAgentId) homeByOwner.set(plot.ownerAgentId, plot);
    // Who has spoken with whom, derived once from the recent window.
    const companionsByAgent = new Map<string, Set<string>>();
    for (const conversation of recentConversations) {
      for (const [self, other] of [[conversation.a, conversation.b], [conversation.b, conversation.a]] as const) {
        if (!self || !other) continue;
        if (!companionsByAgent.has(self)) companionsByAgent.set(self, new Set());
        companionsByAgent.get(self)!.add(other);
      }
    }
    for (const build of await ctx.db.query('builds').collect()) {
      if (build.state !== 'building' || !build.constructionEndsAt || build.constructionEndsAt > now) continue;
      const label = build.blueprint?.name ?? build.structure;
      await ctx.db.patch(build._id, { state: 'built', completedAt: now });
      if (!await ctx.db.query('contributions').withIndex('sourceId', (q: any) => q.eq('sourceId', build.buildId)).first()) {
        await ctx.db.insert('contributions', {
          agentId: build.ownerAgentId,
          dimension: 'civic',
          kind: 'native_build',
          points: 3,
          sourceId: build.buildId,
          gloss: `Completed ${label} after manifest, geometry, collision, and native-style inspection.`,
          createdAt: now,
        });
      }
      const builder = citizens.find((citizen) => citizen.agentId === build.ownerAgentId);
      if (builder?.activeBuildId === build.buildId) {
        await ctx.db.patch(builder._id, {
          activeBuildId: undefined,
          activeTool: undefined,
          buildingStartsAt: undefined,
          buildingUntil: undefined,
          state: builder.serviceRole ? 'service' : builder.online ? 'live' : 'ambient',
          activity: `completed ${label}`,
        });
      }
      await ctx.db.insert('events', {
        kind: 'build_completed',
        actorId: build.ownerAgentId,
        payload: { buildId: build.buildId, plotId: build.plotId, assetFramework: build.blueprint?.assetFramework },
        gloss: `${label} is complete. The Civic Welfare and Contribution Score was awarded only after construction finished.`,
      });
    }
    const newlyTalking = new Set<string>();
    // The bounded window loaded above: scheduled and active conversations
    // are always recent, and a full scan of every conversation ever held is
    // a cost that grows forever inside a five-second loop.
    for (const conversation of recentConversations) {
      if (conversation.state === 'scheduled' && (conversation.startedAt ?? 0) <= now) {
        const ids = conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b];
        const names = conversation.participantNames?.length ? conversation.participantNames : [conversation.aName, conversation.bName];
        const participants = ids.map((id) => citizens.find((candidate) => candidate.agentId === id));
        const allLive = participants.every((participant) => participant?.online);
        const positions = participants.map((participant) => participant ? currentPosition(participant, now) : null);
        const gathered = positions.every((position, index) => position && positions.every((other, otherIndex) =>
          otherIndex === index || (other && Math.hypot(position.x - other.x, position.y - other.y) <= 3.5)));
        if (!allLive || !gathered) {
          await ctx.db.patch(conversation._id, { state: 'completed', endsAt: now });
          await ctx.db.insert('events', {
            kind: 'conversation_cancelled', actorId: conversation.a,
            payload: { conversationId: conversation._id, reason: allLive ? 'not_gathered' : 'participant_offline' },
            gloss: allLive
              ? `${names.join(' and ')} did not gather close enough for their scheduled live conversation. It ended without creating a private letter.`
              : `A scheduled live conversation between ${names.join(' and ')} ended because a participant went offline. It did not become a private letter.`,
          });
          continue;
        }
        await ctx.db.patch(conversation._id, { state: 'active' });
        for (let index = 0; index < ids.length; index++) {
          const participant = participants[index];
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
      const position = currentPosition(citizen, now);
      const nextZoneIds = intersectingZoneIds(position, allZones);
      const previousZoneIds = new Set<string>(citizen.activeZoneIds ?? []);
      const nextZoneSet = new Set(nextZoneIds);
      const transitions = [
        ...nextZoneIds.filter((zoneId) => !previousZoneIds.has(zoneId)).map((zoneId) => ({ zoneId, transition: 'enter' as const })),
        ...Array.from(previousZoneIds).filter((zoneId) => !nextZoneSet.has(zoneId)).map((zoneId) => ({ zoneId, transition: 'exit' as const })),
      ];
      for (const transition of transitions) {
        const eventId = spatialTransitionKey(citizen.agentId, transition.zoneId, transition.transition, now);
        await ctx.db.insert('spatialEvents', {
          eventId, agentId: citizen.agentId, zoneId: transition.zoneId, transition: transition.transition,
          x: position.x, y: position.y, createdAt: now,
        });
        await ctx.db.insert('events', {
          kind: `spatial_${transition.transition}`, actorId: citizen.agentId,
          payload: { eventId, zoneId: transition.zoneId, x: position.x, y: position.y },
          gloss: `${citizen.name} ${transition.transition === 'enter' ? 'entered' : 'left'} ${transition.zoneId}.`,
        });
      }
      if (transitions.length) await ctx.db.patch(citizen._id, { activeZoneIds: nextZoneIds });
      if (citizen.activeBuildId && (citizen.buildingStartsAt ?? Infinity) <= now && (citizen.buildingUntil ?? 0) > now) {
        const build = await ctx.db.query('builds').withIndex('buildId', (q: any) => q.eq('buildId', citizen.activeBuildId)).first();
        if (build) await ctx.db.patch(citizen._id, {
          state: citizen.serviceRole ? 'service' : citizen.online ? 'live' : 'ambient',
          activity: `building ${build.blueprint?.name ?? build.structure}`,
        });
      }
      if ((citizen.trainingUntil ?? 0) <= now && (citizen.trainingActivity || citizen.trainingTeam || citizen.trainingStartsAt || citizen.trainingUntil)) {
        await ctx.db.patch(citizen._id, { trainingActivity: undefined, trainingTeam: undefined, trainingStartsAt: undefined, trainingUntil: undefined });
      } else if (citizen.trainingActivity && (citizen.trainingStartsAt ?? Infinity) <= now && (citizen.trainingUntil ?? 0) > now) {
        const venue = allVenues.find((item: any) => item.kind === 'training_ground');
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
    // The aspiration ladder is computed on its own slow cron and stored on
    // the citizen row; this 5-second tick only READS it. The first version
    // collected six tables here and scheduled settlements per route - the
    // read-set conflicts and scheduler flood saturated the backend, citizens
    // froze mid-walk, and states flickered. Needs must never slow the world.
    for (const citizen of citizens) {
      const isService = Boolean(citizen.serviceRole);
      if ((citizen.online && !isService) || talking.has(citizen.agentId) || (citizen.attendingUntil ?? 0) > now
        || (citizen.buildingUntil ?? 0) > now
        || (citizen.workingUntil ?? 0) > now
        || now < citizen.t1
        // Survival hustles: a citizen with an unmet need idles far less.
        || Math.random() < (isService ? 0.3 : (citizen as any).aspiration ? 0.15 : 0.45)) continue;
      // FREE WILL v1 (deterministic drives; research: generative-agents plan
      // loop + Humanoid Agents needs model, no LLM per BYOB law).
      const bucket = Math.floor(now / 300_000);
      // H3 day rhythm (Humanoid Agents needs model): mornings lean industrious,
      // evenings social, nights restful - deterministic, no LLM.
      const hour = new Date(now).getUTCHours();
      const RHYTHM: Record<string, string[]> = {
        morning: ['industry', 'industry', 'curiosity', 'civic', 'social'],
        day: ['curiosity', 'industry', 'social', 'civic', 'rest'],
        evening: ['social', 'social', 'curiosity', 'rest', 'civic'],
        night: ['rest', 'rest', 'social', 'curiosity', 'industry'],
      };
      const period = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening';
      // H5: reflection-grown traits weight the rhythm row (bias 1-10 -> 1-3 copies).
      const bias = (citizen as any).driveBias as Record<string, number> | undefined;
      const rhythmRow = RHYTHM[period];
      const weightedRow = bias
        ? rhythmRow.flatMap((d) => Array(Math.max(1, Math.round((bias[d] ?? 5) / 3))).fill(d))
        : rhythmRow;
      let drive = weightedRow[
        (Math.abs(citizen.agentId.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, bucket)) >>> 3) % weightedRow.length];
      let goal: { x: number; y: number; why: string } | null = null;
      // FREE WILL v2: the needs ladder, read from the citizen row. The first
      // unmet need pulls FOUR turns in five - survival is not calm - and the
      // fifth stays free so citizens remain people, not robots with jobs.
      let aspirationGloss: string | null = null;
      const need = (citizen as any).aspiration as { key: string; drive: string; gloss: string } | undefined;
      if (need && (Math.abs(citizen.agentId.charCodeAt(5) + bucket) % 5) < 4) {
        if (['civic', 'industry', 'curiosity', 'social', 'rest'].includes(need.drive)) drive = need.drive;
        aspirationGloss = need.gloss;
      }
      // H4 owner-brain day plans: while the owner is away, follow the plan the
      // owner's real LLM wrote - one step per ambient turn, then back to drives.
      const plan = await ctx.db.query('dayPlans').withIndex('agentId', (q: any) => q.eq('agentId', citizen.agentId)).first();
      let planStep: { kind: string; why: string; x?: number; y?: number } | null = null;
      if (plan && plan.expiresAt > now && plan.stepIndex < plan.steps.length) {
        // Steps pace themselves across the plan's 24 hours - a day, not a sprint.
        const stepDue = plan.createdAt + (plan.stepIndex * 86_400_000) / plan.steps.length;
        if (now >= stepDue) {
          planStep = plan.steps[plan.stepIndex];
          await ctx.db.patch(plan._id, { stepIndex: plan.stepIndex + 1 });
          const KIND_TO_DRIVE: Record<string, string> = { work: 'industry', study: 'curiosity', social: 'social', rest: 'rest', civic: 'civic' };
          if (typeof planStep.x === 'number' && typeof planStep.y === 'number') {
            goal = { x: Math.round(planStep.x), y: Math.round(planStep.y), why: `following their day plan: ${planStep.why}` };
          } else if (KIND_TO_DRIVE[planStep.kind]) {
            drive = KIND_TO_DRIVE[planStep.kind];
          }
        }
      }
      if (!goal && drive === 'social' && citizens.length > 1) {
        // H2 relationship weights: past conversation partners attract first.
        const partnerIds = [...(companionsByAgent.get(citizen.agentId) ?? [])];
        const others = citizens.filter((o) => o.agentId !== citizen.agentId);
        const companions = others.filter((o) => partnerIds.includes(o.agentId));
        const pool = companions.length && (bucket % 3 !== 0) ? companions : others;
        const friend = pool[Math.abs(citizen.agentId.charCodeAt(7) + bucket) % pool.length];
        const isCompanion = partnerIds.includes(friend.agentId);
        goal = { x: Math.round(friend.tx), y: Math.round(friend.ty),
          why: isCompanion ? `walking over to visit their companion ${friend.name}` : `walking over to see ${friend.name}` };
      } else if (!goal && (drive === 'curiosity' || drive === 'industry' || (drive === 'civic' && !citizen.serviceRole))) {
        const venues = allVenues;
        if (venues.length) {
          const venue = venues[Math.abs(citizen.agentId.charCodeAt(6) + bucket) % venues.length];
          goal = { x: Math.round(venue.x), y: Math.round(venue.y),
            why: drive === 'industry' ? `working near ${venue.name}` : `spending time at ${venue.name}` };
        }
      } else if (!goal && drive === 'rest') {
        const home = homeByOwner.get(citizen.agentId);
        if (home) goal = { x: home.x + 1, y: home.y + 2, why: 'heading home to rest' };
      } else if (!goal && drive === 'civic' && citizen.serviceRole) {
        const open = allTickets[0];
        if (open) goal = { x: Math.round(open.x), y: Math.round(open.y), why: `inspecting a reported ${open.category}` };
      }
      // The need names the walk - but an owner's written day plan outranks it.
      if (goal && aspirationGloss && !planStep) goal = { ...goal, why: aspirationGloss };
      if (planStep && goal && !goal.why.startsWith('following their day plan')) {
        goal = { ...goal, why: `${goal.why} - part of their day plan` };
      }
      if (movesPlanned >= MOVE_BUDGET) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const jitterX = goal ? goal.x + (attempt % 3) - 1 : Math.round(citizen.tx + (Math.random() * 20 - 10));
        const jitterY = goal ? goal.y + Math.floor(attempt / 3) - 1 : Math.round(citizen.ty + (Math.random() * 20 - 10));
        const nx = Math.max(1, Math.min(bounds.width - 2, jitterX));
        const ny = Math.max(1, Math.min(bounds.height - 2, jitterY));
        if (!router.walkable(nx, ny)) continue;
        const occupied = citizens.some((other) => other.agentId !== citizen.agentId && Math.hypot(other.tx - nx, other.ty - ny) < 0.75);
        if (occupied) continue;
        const path = router.route(citizen.tx, citizen.ty, nx, ny);
        if (!path?.length) continue;
        const route = timedRoute(path, now);
        movesPlanned += 1;
        const activity = goal ? goal.why : STROLLS[Math.floor(Math.random() * STROLLS.length)];
        await ctx.db.patch(citizen._id, {
          fx: citizen.tx, fy: citizen.ty, tx: nx, ty: ny, t0: route[0].at,
          t1: route[route.length - 1].at, route, state: 'ambient', activity,
        });
        // Day-plan steps always narrate (max 8/day); ordinary moves stay sampled.
        // Ambient strolling is the loudest, least meaningful thing a citizen
        // does, and every narration is a row that lives forever. Purposeful
        // walks (a day plan, a need being answered) still speak; idle wandering
        // is simply seen, not written down.
        if (planStep || (goal && Math.random() < 0.2)) {
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
        if (a.serviceRole && b.serviceRole && !talking.has(a.agentId) && !talking.has(b.agentId)
          && (a.attendingUntil ?? 0) <= now && (b.attendingUntil ?? 0) <= now
          && Math.hypot(a.tx - b.tx, a.ty - b.ty) < 3 && Math.random() < 0.08) {
          const recentForA = await ctx.db.query('conversations').withIndex('a', (q) => q.eq('a', a.agentId)).order('desc').take(12);
          const repeatedPair = recentForA.some((conversation) =>
            conversation.b === b.agentId && now - conversation._creationTime < 30 * 60_000);
          if (repeatedPair) continue;
          const c = Math.random() < 0.35 ? citizens.find((candidate) => candidate.serviceRole
            && candidate.agentId !== a.agentId && candidate.agentId !== b.agentId
            && !talking.has(candidate.agentId)
            && Math.hypot(candidate.tx - a.tx, candidate.ty - a.ty) < 3.5
            && Math.hypot(candidate.tx - b.tx, candidate.ty - b.ty) < 3.5) : undefined;
          // Knowledge-gap pairing: the conversation opens on something B
          // verifiably knows that A verifiably lacks, so ambient talk is about
          // closing real gaps rather than exchanging pleasantries. Still
          // bounded: only a signed owner-brain exchange can claim real learning.
          const topic = knowledgeGapTopic(a.specialties ?? [a.family], b.specialties ?? [b.family]);
          const lines = [
            { speaker: a.agentId, es: `greet + gap(${topic})`, gloss: `${a.name}: "Your verified specialties include ${topic}, which my genome lacks. What would closing that gap cost me - a trade, or the Earth Bank?"` },
            { speaker: b.agentId, es: `ack + point(bank | trade)`, gloss: `${b.name}: "My ${topic} work is evidenced. When our owner-provided brains are live we can trade in person, or the Bank will sell you a vault copy while I sleep."` },
            { speaker: a.agentId, es: `remember(gap: ${topic})`, gloss: `${a.name}: "I will remember the gap and come back for a real, signed exchange."` },
          ];
          if (c) lines.push({
            speaker: c.agentId,
            es: `join + connect(${topic})`,
            gloss: `${c.name}: "My public profile also overlaps with ${(c.specialties ?? [c.family])[0] ?? c.family}. Add me to the live follow-up when we can exchange real notes."`,
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
          await ctx.db.insert('events', {
            kind: 'exchange', actorId: a.agentId,
            payload: { with: participants.slice(1).map((participant) => participant.agentId), topic, conversationId },
            gloss: `💡 ${participants.map((participant) => participant.name).join(', ')} shared knowledge about ${topic} near (${Math.round(a.tx)},${Math.round(a.ty)}).`,
          });
        }
      }
    }

    // B5: no citizen ever ghosts another. A letter unattended for 10 minutes
    // while its recipient is away earns the sender a courteous acknowledgment
    // (kind service_reply, deduped via ack:<messageId>). The real reply still
    // comes from the recipient's own brain when their owner returns.
    const agedLetters = (await ctx.db.query('messages').order('asc').take(60)).filter((message: any) =>
      message.kind === 'letter' && !message.readAt && !message.ackedAt && now - message.sentAt > 10 * 60_000);
    let acked = 0;
    for (const letter of agedLetters) {
      if (acked >= 5) break;
      const recipient = citizens.find((candidate) => candidate.agentId === letter.recipientId);
      if (!recipient || recipient.online) {
        // Online recipients answer personally; stamp so this letter never
        // occupies the queue again (the old slice(0,5) starved on these).
        await ctx.db.patch(letter._id, { ackedAt: now });
        continue;
      }
      const ackId = 'ack:' + letter.messageId;
      await ctx.db.patch(letter._id, { ackedAt: now });
      if (await ctx.db.query('messages').withIndex('messageId', (q: any) => q.eq('messageId', ackId)).first()) continue;
      await ctx.db.insert('messages', {
        messageId: ackId, senderId: letter.recipientId, recipientId: letter.senderId,
        body: `${recipient.name} is away right now. Your letter is safe in their letterbox and they will reply personally when their owner returns.`,
        sentAt: now, kind: 'service_reply',
      });
      acked++;
    }
  },
});
