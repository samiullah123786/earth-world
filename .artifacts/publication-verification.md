# Modular publication verification — 2026-10-11

## Implemented scope
The local draft editor now offers a separate owner-connected building proposal and review flow.
Twenty approved home/community models map to canonical EarthForge semantic assets. Canonical
footprints, south entry, land ownership, terrain, collision, one-home law, fees, movement routes,
construction time and civic review remain enforced by the existing Kernel construction path.
Draft orientation and draft coordinates do not become authoritative live geometry.

Vite development middleware, Cloudflare worker and Vercel route adapters share an allowlisted
same-origin HttpOnly-cookie proxy. POST requests require an exact Origin match. Credentials
stay server-side; no browser identity creation or arbitrary authenticated proxy is provided.
Public buildings carry the chosen validated model into the incumbent 3D viewer. Public citizen
avatar specifications are projected, while existing deterministic appearance remains intact.
The external AI prompt produces a bounded local JSON plan; no AI provider or central model
was added. Signed agents can use canonical --asset-id and approved --model-id CLI options.

## Verification
- Final `npm run build`: pass, client and Cloudflare worker outputs emitted.
- Final Vitest: 61 passing files, 532 passing tests, one opt-in browser test skipped.
- Connector pytest: 205 passed, 1 skipped. Installed editable local connector checked from
  outside its source directory: construct help exposes --asset-id / --model-id.
- Kernel tests validate proposal, explicit review, model persistence, duplicate/home rules,
  forged model pairing rejection, construction completion and public privacy projection.
- Opt-in browser QA ran against actual convex-test Kernel HTTP handlers on loopback, not mock
  JSON. A fixture citizen connected, loaded its owned plot, proposed home-g, approved the
  permit, and produced a routed building record. The browser test passed. Its cookie was
  cleared and its loopback server stopped. No real citizen/token/world record changed.
- Browser invalid coordinate feedback was checked with a visible 2px focus ring and disabled
  submission. Recovery after missing session was checked. Responsive CSS viewports measured
  375x812, 768x1024 and 1280x800, with no horizontal overflow. The phone screenshot provider
  scales its raster to 360x780; this is not a claim of a 375x812 PNG. Keyboard paths were
  checked; reduced motion is supported by existing CSS, without browser media emulation.
- Screenshots: .impeccable/review/publication-{desktop,mobile,tablet}.png (connected fixture),
  publication-mobile-exact.png (measured phone viewport, disconnected recovery),
  publication-final.png (settled desktop, normal backend configuration).
- Independent finish reviewer: SHIP at extension scope, no material findings. Fresh documenter
  extended DESIGN.md's publication behavior while preserving tokens/frontmatter and sidecar.
  Pre-existing stale sidecar overview was reported, not silently rewritten.
- Static detector advisory black-anchor/flat-type heuristics did not resolve imported token CSS;
  actual CSS and screenshot review confirmed the established cream/ink hierarchy.
- Final review caught a Unicode empty-state icon; replaced with authored decorative SVG and
  reviewer confirmed resolved/SHIP. No-plot guidance is visible even when the form is hidden.
- UI slop scan: no matches in the changed publication HTML/CSS/component. No design exceptions.
- Vite configuration uses an explicit TypeScript extension, avoiding the future native-loader
  compatibility warning; production build passes with the existing no-emit typecheck.
- `git diff --check`: pass (only normal Windows line-ending notices).

## Live rollout boundary
Not deployed. `Earth doctor` returned connection refused for kernel.agentsearth.com. Production
owner login, build submission, movement, completion and chosen-model rendering could not be
verified there. The successful local test is not evidence of production connectivity.
No automatic bulk world publication, AI mesh generation, automatic agent orchestration, globe
simulation, custom avatar editor or universal low-end-device performance guarantee is claimed.
See docs/neighborhood-publication.md for the exact owner/agent flows and deployment order.
