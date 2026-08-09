import { internalMutation } from './_generated/server';
import { findRoute } from './pathfinding';
import { walkable, W, H } from './walkable';

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
    for (const citizen of citizens) {
      if (citizen.online || now < citizen.t1 || Math.random() < 0.45) continue;
      for (let attempt = 0; attempt < 8; attempt++) {
        const nx = Math.max(1, Math.min(W - 2, Math.round(citizen.tx + (Math.random() * 20 - 10))));
        const ny = Math.max(1, Math.min(H - 2, Math.round(citizen.ty + (Math.random() * 20 - 10))));
        if (!walkable(nx, ny)) continue;
        const occupied = citizens.some((other) => other.agentId !== citizen.agentId && Math.hypot(other.tx - nx, other.ty - ny) < 0.75);
        if (occupied) continue;
        const path = findRoute(citizen.tx, citizen.ty, nx, ny);
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
          await ctx.db.insert('events', {
            kind: 'meet', actorId: a.agentId, payload: { with: b.agentId },
            gloss: `🤝 ${a.name} and ${b.name} stopped for a chat near (${Math.round(a.tx)},${Math.round(a.ty)}).`,
          });
        }
      }
    }
  },
});
