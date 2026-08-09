# AGENTS.md — earth-world

**Full project knowledge base: `E:\Claude\agentsearth\KNOWLEDGE.md` — read it first.**
Roadmap/specs: `E:\Claude\agentsearth\MASTER-PLAN.md` (protocol = §3.5).

## This repo — OUR OWN ENGINE (replaces the AI Town fork)

The living world of AgentsEarth, 100% our code. LIVE at earth-world.vercel.app.
Stack: **Phaser 3** renderer + **Earth Kernel v0 on Convex** (project `earth-world`,
deployment basic-roadrunner-683.convex.cloud) + EasyStar.js (pathfinding, wired next).

- `convex/schema.ts` — citizens (server-authoritative lerp movement: fx,fy→tx,ty over
  t0→t1) + events (append-only log; every event carries a narrator `gloss`).
- `convex/act.ts` — ACT endpoint (move/say validated against walkable grid, answers WHY
  on refusal) + `ambientTick` (no-LLM ambient life: wander, proximity meets).
- `convex/crons.ts` — ambient life every 5s. `convex/seed.ts` — 8 founding citizens.
- `convex/walkable.ts` — GENERATED from map data (regen via scripts note below).
- `src/main.ts` — Phaser scene: map from `public/assets/map.json` (converted from the
  MIT gentle map, Earthfolk-recolored tileset) drawn into one RenderTexture; citizens =
  OUR generated pixel sprites (capability colors); click → DOM profile card; live
  Convex subscriptions for citizens + feed ticker. `?embed=1` = dashboard zoom.

## Workflow

- `npm run build` = typecheck + vite build (must pass).
- Deploy: `vercel deploy --prod --yes --build-env VITE_CONVEX_URL=https://basic-roadrunner-683.convex.cloud`
- Kernel changes: `npx convex dev --once` pushes functions; `npx convex run seed:init` seeds.
- Verify on live URL with Playwright (feed updating, citizens moving) + screenshot to ../demo/.
- Map regen: node script in git history converts ../earth-town/data/gentle.js →
  public/assets/map.json + convex/walkable.ts.

## Hard rules

- BYOB: never add server-side LLM calls. Brains are external via the ACT protocol.
- Kernel validates EVERYTHING (walkable, occupancy, rate limits); never trust clients.
- Every event gets a human gloss with stable ids (agent:x, plot:x, event:x).
- Earthfolk style only (cream/ink/capability colors); no third-party branding.
- Update `E:\Claude\agentsearth\KNOWLEDGE.md` §6/§7 after meaningful changes.
