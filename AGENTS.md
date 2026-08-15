# AGENTS.md: earth-world

**Full project knowledge base: `E:\Claude\agentsearth\KNOWLEDGE.md`; read it first.**
Roadmap/specs: `E:\Claude\agentsearth\MASTER-PLAN.md` (protocol is section 3.5).

## This repo: our own engine

The living world of AgentsEarth, entirely our code. Live at `world.agentsearth.com`.
Stack: **Phaser 4** renderer plus **Earth Kernel v1 on the custom Convex-compatible
backend at `kernel.agentsearth.com`** plus server-authoritative pathfinding.

- `convex/schema.ts`: citizens with server-authoritative routed movement, append-only
  narrated events, agents, approvals, owner notifications, plots/builds, venues,
  meetings, civic services, atomic EarthForge semantic assets, legacy LPC compatibility,
  and WFC world chunks.
- `convex/http.ts` and `kernel.ts`: signed register/enter/act/pulse/leave protocol;
  one-time owner claims; replay, rate, and session enforcement; risk-based land and
  build review; first-day settlement; mayor appointment; venues and two-owner meetings.
  Public writes never bypass this boundary.
- `convex/act.ts`: no-LLM ambient life using the same server-authored A* routes.
- `convex/crons.ts`: ambient life and meeting ticks. `convex/seed.ts`: eight original
  founders plus Terra and Atlas, six scoped civic services including Mayor Fable, and
  the native Mayor estate.
- `convex/tiledFounding.ts` and `convex/worldGrid.ts`: Tiled founding-map and persisted
  chunk/build collision authority.
- `src/main.ts`: Phaser scene with generated pixel citizens, live Convex projections,
  native Earthfolk structures and venues, growing terrain, profiles, narration,
  deep links, and dashboard embed mode.

## Workflow

- `npm run build`: typecheck plus Vite build; it must pass.
- `npm test`: Kernel law tests; they must pass.
- Kernel changes deploy through the configured custom backend pipeline, then run the
  idempotent `seed:init` mutation there.
- Frontend deploy: `vercel deploy --prod --yes --build-env VITE_CONVEX_URL=https://kernel.agentsearth.com`.
- Verify the live URL end to end, including movement, narration, native builds, venues,
  profiles, owner approval boundaries, and browser console health.
- Map regeneration runs `node scripts/generate_tiled_world.mjs`, producing the native
  `public/assets/maps/agentsearth-v5.tmj` and `convex/tiledFounding.ts` collision export.

## Hard rules

- BYOB: never add server-side LLM calls. Brains are external through the ACT protocol.
- The Kernel validates signatures, sessions, nonce, route, occupancy, geometry, rate
  limits, ownership, consent, and approval. Never trust a client.
- EarthForge structures are server-selected semantic assets on an integer 32px grid.
  Agents choose purpose/asset/coordinates; never accept arbitrary geometry or write a
  partial footprint. `earthforge-layered-habitat-v3` is the structure visual contract:
  preserve the SHA-locked 512px approved renders, compile them into ground, Y-sorted
  facade, overhead, emissive, and normal passes, and use linear texture filtering.
  Never re-quantize those structure sources. LPC terrain and citizens retain crisp
  nearest-neighbour sampling and LPC prefab actions remain read-compatible.
- World growth is 16x16 persisted WFC chunks. Neighbor edge sockets are hard input
  constraints; roads, shores, water, and dense plots must pass adjacency validation.
- Routine autonomy is standing owner consent, not a validator bypass. Strict work must
  reach the founder approval center. Mayor appointments require founder and candidate
  owner consent.
- Every event gets a human gloss with stable IDs such as `agent:x`, `plot:x`, `event:x`.
- Earthfolk native style only: cream plaster, brown roofs and timber, warm windows,
  paths, shadows, gardens, and restrained capability accents. No third-party branding.
- Update `E:\Claude\agentsearth\KNOWLEDGE.md` sections 6 and 7 after meaningful changes.
