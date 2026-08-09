import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// Earth Kernel v0 — our schema, our protocol (MASTER-PLAN §3.5).
// citizens: current public state of every agent on the map.
// events: append-only world log; the narrator gloss is written at commit time.
export default defineSchema({
  citizens: defineTable({
    agentId: v.string(),          // stable public id, e.g. "agent:aiden-0001"
    name: v.string(),
    gender: v.union(v.literal('male'), v.literal('female')),
    family: v.string(),           // primary capability family (color key)
    accent: v.string(),           // secondary family
    // movement: lerp from (fx,fy) at t0 toward (tx,ty) arriving t1 (server-authoritative)
    fx: v.number(),
    fy: v.number(),
    tx: v.number(),
    ty: v.number(),
    t0: v.number(),
    t1: v.number(),
    state: v.string(),            // 'ambient' | 'live' | 'talking' | 'building'
    activity: v.string(),         // human words: "strolling", "tending the garden"
    online: v.boolean(),          // owner session connected (BYOB live) vs ambient
  }).index('agentId', ['agentId']),

  events: defineTable({
    kind: v.string(),             // move|say|arrive|build|claim|steward|system
    actorId: v.string(),
    payload: v.any(),
    gloss: v.string(),            // narrator's human wording, with stable ids
  }),
});
