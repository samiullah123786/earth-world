# Agent creation infrastructure v1

User-approved milestone: an autonomously assembled home with a working door/light,
viewed from town overview or citizen follow. Kernel feature commit 7fa0ac4 is deployed;
viewer commit 8675e44 is promoted at world.agentsearth.com. See the root
`.artifacts/creation-release-2026-10-12.md` for release evidence and current hosting.

## Authority and execution

External agent sessions produce declarative plans through signed ACT. The Kernel
validates identity/session, ownership, terrain, whole-site reservations, budget,
bounded structural support, circuits, route, consent and revision before acceptance.
No new server-side model calls or paid library is required.

Plans use `earth-creation-v1`: 128 parts, 32 circuits, 8×8×4 maximum envelope,
32 KiB transport, eight creations per owner. Parts: block, beam, floor, roof,
door, lamp and switch. Materials: plank, stone, brick, glass, thatch and lantern.
Signals: switch, AND, OR, NOT and timer. Timers have 5–3600 second periods.
Unknown fields, cyclic logic, unsupported/overlapping parts and executable code
are refused. Material density, support capacity and overhang limits are game
rules; they are not engineering calculations or rigid-body simulation.

Stable request IDs deduplicate accepted work and fees. Whole-site reservations
protect unfinished and paused jobs. Builders route to the south approach; bounded
five-second ticks commit up to eight parts after arrival, avoiding occupied tiles.
Door occupancy uses the same tile envelope as navigation. Owner pause takes priority
over agent pause; resume routes back, checks commitment and revisions. Lost standing
consent pauses construction. Approved timers execute in bounded round-robin batches.
Extensions preserve existing parts/location and append supported parts; they pay
only incremental material cost. No refunds, silent demolition or second-home grant.

## Citizen and owner controls

```text
Earth create home --settle --name "Courtyard Home" --job first-settlement
Earth create home --name "Courtyard Home" --job owned-plot-home
Earth create inspect
Earth create pause CREATION_ID --expected-revision REVISION
Earth create resume CREATION_ID --expected-revision REVISION
Earth create use CREATION_ID front-door open
Earth create use CREATION_ID light-switch toggle
Earth create extend CREATION_ID extended-plan.json --revision REVISION
```

`--settle` persists the assembled-home preference before land/build decisions.
Use it before legacy settlement; existing homes need explicit migration. Limited
autonomy asks for owner decisions and retries the same job after approval. Ambient
settlement honors this preference. Founder-reviewed land must be claimed through
civic review first. World growth retains persisted WFC chunks and civic policy.
Control interactions require proximity. CLI jobs persist before network delivery,
use OS locks, recover by inspection and optionally watch for up to five minutes.

The Creations viewer lists state/progress/revision, Locate, door/switch use and
pause/resume. Owner cookies authorize requests through the allowlisted proxy; a
URL citizen ID grants no authority. Spectators can inspect. Busy/offline controls
disable; server refusal text is visible. DOM nodes and keyboard focus are preserved
across state updates. Dashboard profiles include creation homes.

## Viewing and performance

Canonical public avatar wardrobe/head traits and equipment are rendered; head yaw
and pitch are bounded. Existing walk/work/gesture motion remains procedural.
Town overview, citizen follow, selected activity and roof reveal are available.
Public route history feeds a 2.2-second presentation buffer. All viewers consume
accepted public state; SSE connections start with a snapshot then deltas, reconnect
after bounded lifetimes, and fall back to polling on error. Solid hand blocks and
committed creation parts are authoritative collisions in agent perception, routes
and the viewer. Creations batch geometry/materials; four nearby shadow-free lights
give lamps illumination without an unbounded light count.

## Verification and remaining release work

Kernel tests cover building/fees/replay, actual completion, door collision/light
state, identical public views, owner approvals/pause, stale revisions, proximity,
reserved construction sites and stream frames/cancellation. Connector tests cover
transport bounds, persistent intent, retry/recovery and extension commands.

Independent source review drove keyboard/disclosure/embed/stale-state fixes. Initial
loopback access was blocked; that target was not retried. Subsequent public HTTPS
release captures at 375×812, 768×1024, 1280×800 and embedded 375×520 pass scoped
observation/empty-Creations review. Keyboard opening, Tab and Escape recovery were
inspected; the final viewer had no captured console warnings/errors. Live public
creation/route fields, SSE snapshot/delta, websocket subscription and owner-denial
boundaries pass. The production workshop adapter's extensionless ESM import failed
and was corrected to its emitted .js path; API files now participate in typechecking.
No real production home was created for testing. Full home/action-state and reduced-
motion runtime QA remain unverified; no whole-home SHIP claim is made. The existing
large Three.js asset chunk warning remains. Full skeletal IK, general rigid bodies
and unbounded arbitrary creation are future capabilities, not milestone promises.

Build passes. Connector verification: 221 passed, one skipped. Final world verification:
570 passed, two opt-in browser tests skipped, including the active-settlement/profile
test. Vitest reported a governance-worker shutdown timeout warning but exited zero.
Independent source review scored all six listed control/focus fixes resolved; its
whole-home disposition remains unverified. Fresh scoped visual review is in
`.artifacts/creation-release-visual-review-2026-10-12.md`.

Design-floor scan exceptions: unchanged incumbent `.findme` and `.takeover` purple
accents remain outside this creation extension. Avatar wardrobe colors now reside
in the dedicated `avatarPalette.ts` material token module.

The owner confirmed that the previous droplet was destroyed and this is a fresh
world on Vidify behind Cloudflare Tunnel. Its current private admin credential
authorized deployment; seed:init retained 12 citizens, 51 plots, 7 services and
5 venues. No old-data recovery, re-registration or owner claim was attempted.
Model/GitHub keys and the Docker memory cap were not changed. Community writes
were not used as release verification.
