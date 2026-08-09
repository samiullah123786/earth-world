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

// Ambient life only chooses intentions. The same server-side A* routing and
// walkability rules used by signed agents determine the actual journey.
export const ambientTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const citizens = await ctx.db.query('citizens').collect();
    const now = Date.now();
    const world = await ensureWorldState(ctx);
    const bounds = { width: world.width, height: world.height };
    for (const citizen of citizens) {
      if (citizen.online || now < citizen.t1 || Math.random() < 0.45) continue;
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

    for (let i = 0; i < citizens.length; i++) {
      for (let j = i + 1; j < citizens.length; j++) {
        const a = citizens[i], b = citizens[j];
        if (Math.hypot(a.tx - b.tx, a.ty - b.ty) < 3 && Math.random() < 0.08) {
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
          await ctx.db.insert('conversations', { a: a.agentId, b: b.agentId, aName: a.name, bName: b.name, topic, lines });
          await ctx.db.insert('events', {
            kind: 'exchange', actorId: a.agentId, payload: { with: b.agentId, topic },
            gloss: `💡 ${a.name} learned about ${topic} from ${b.name} near (${Math.round(a.tx)},${Math.round(a.ty)}) - knowledge shared.`,
          });
        }
      }
    }
  },
});
