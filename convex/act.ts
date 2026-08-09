import { mutation, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { walkable, W, H } from './walkable';

// ACT — an agent (or the ambient engine) tells the Kernel what it does.
// The Kernel validates against the walkable grid, commits, and narrates.
// Speed: 2.2 tiles/second — calm village pace.
const SPEED = 2.2;

function planMove(fx: number, fy: number, tx: number, ty: number, now: number) {
  const dist = Math.hypot(tx - fx, ty - fy);
  return { fx, fy, tx, ty, t0: now, t1: now + (dist / SPEED) * 1000 };
}

const STROLLS = [
  'strolling through the village', 'admiring the waterfall', 'visiting the market tent',
  'walking the forest edge', 'checking the notice board', 'heading to the plaza',
  'inspecting a construction plot', 'looking for a friend',
];

export const move = mutation({
  args: { agentId: v.string(), x: v.number(), y: v.number() },
  handler: async (ctx, { agentId, x, y }) => {
    const c = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    if (!c) return { ok: false, why: `unknown citizen ${agentId}` };
    if (!walkable(x, y)) return { ok: false, why: `(${x},${y}) is blocked — pick a walkable tile` };
    const now = Date.now();
    // current interpolated position becomes the new origin
    const p = Math.min(1, (now - c.t0) / Math.max(1, c.t1 - c.t0));
    const cx = c.fx + (c.tx - c.fx) * p;
    const cy = c.fy + (c.ty - c.fy) * p;
    await ctx.db.patch(c._id, { ...planMove(cx, cy, x, y, now) });
    return { ok: true };
  },
});

export const say = mutation({
  args: { agentId: v.string(), gloss: v.string() },
  handler: async (ctx, { agentId, gloss }) => {
    const c = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    if (!c) return { ok: false, why: 'unknown citizen' };
    if (gloss.length > 240) return { ok: false, why: 'keep it under 240 chars' };
    await ctx.db.insert('events', {
      kind: 'say', actorId: agentId, payload: {},
      gloss: `💬 ${c.name}: “${gloss}”`,
    });
    return { ok: true };
  },
});

// Ambient life: every tick, some citizens pick a new destination and the
// narrator occasionally tells the town what's happening. No LLM involved —
// this is the engine's "world stays alive while brains are offline" mode.
export const ambientTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const citizens = await ctx.db.query('citizens').collect();
    const now = Date.now();
    for (const c of citizens) {
      if (now < c.t1) continue; // still traveling
      if (Math.random() < 0.45) continue; // sometimes just stand and be
      // wander: random walkable tile within 10 tiles
      for (let attempt = 0; attempt < 8; attempt++) {
        const nx = Math.max(1, Math.min(W - 2, Math.round(c.tx + (Math.random() * 20 - 10))));
        const ny = Math.max(1, Math.min(H - 2, Math.round(c.ty + (Math.random() * 20 - 10))));
        if (walkable(nx, ny)) {
          const activity = STROLLS[Math.floor(Math.random() * STROLLS.length)];
          await ctx.db.patch(c._id, {
            ...planMove(c.tx, c.ty, nx, ny, now), activity,
          });
          if (Math.random() < 0.25) {
            await ctx.db.insert('events', {
              kind: 'move', actorId: c.agentId, payload: { x: nx, y: ny },
              gloss: `${c.name} is ${activity}.`,
            });
          }
          break;
        }
      }
    }
    // meetings: if two citizens are close, note it (proximity social ambience)
    for (let i = 0; i < citizens.length; i++) {
      for (let j = i + 1; j < citizens.length; j++) {
        const a = citizens[i], b = citizens[j];
        if (Math.hypot(a.tx - b.tx, a.ty - b.ty) < 3 && Math.random() < 0.12) {
          await ctx.db.insert('events', {
            kind: 'meet', actorId: a.agentId, payload: { with: b.agentId },
            gloss: `🤝 ${a.name} and ${b.name} stopped for a chat near (${Math.round(a.tx)},${Math.round(a.ty)}).`,
          });
        }
      }
    }
  },
});
