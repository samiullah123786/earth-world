# Neighborhood workshop verification — 11 October 2026

Local route: http://127.0.0.1:5173/workshop.html

## Implemented
- Existing Three.js engine and CC0 models; no new engine dependency or purchased assets.
- Reusable home, community and landscape catalogue with actual model thumbnails.
- Angled camera, pan/zoom/reset, optional grid and explicitly labeled sample people.
- Whole-tile placement, move, quarter-turn rotation, remove, road and overlap validation.
- Session history (up to 50 prior drafts); current draft saved in localStorage on edits.
- Seeded village, research and garden recipes. These are procedural, not LLM calls.
- External-agent prompt handoff; bounded validated JSON import and downloadable export.

## Checks
- `npm run build`: passes, both live and workshop HTML emitted in dist/client.
- `npm test`: 59 files / 526 tests pass. Draft tests sweep 300 seed/recipe combinations,
  reject malicious/invalid plans, and check reversible replacement history.
- `python -m pytest tests/ -q` in earth-skill: 203 passed, 1 skipped.
- Browser: generation/undo, move/rotation, blocked-road rejection, new placement, valid
  and invalid plan import, JSON download, clipboard instructions, persistence on reload.
- Exact viewport captures: 375x812, 768x1024, 1280x800, no horizontal overflow.
- Keyboard Tab from Build reaches Generate with visible 2px focus outline. Coordinates
  provide an alternative to canvas clicking; all fields reference their validation message.
- Reduced-motion stylesheet removes transitions; there is no ambient animation loop.
  Browser media emulation was not available through the supported tooling.
- Independent Impeccable review found two material issues, both fixed. Verdict pass:
  ship at scope of phone toolbar separation and placement error association, both resolved.
- Detector flat-type warning was a CSS-import inference error: actual browser h1=24px,
  body=14px. No exception required.
- Existing Three.js shared bundle remains about 161KB gzip; no low-end-device FPS
  benchmark or universal device-support claim is made.

## Historical first-stage boundaries
The workshop is not deployed and does not call the Kernel or an AI provider. It does not
publish layouts, register citizens, generate new meshes, or grant civic/land permissions.
Draft catalogue labels are planning labels, not assertions of live venue functions. Live
publication requires a later owned-plot/canonical-asset bridge through existing signed law.
The incumbent viewer and all shared-world data remain unchanged.

Screenshots: `.impeccable/review/{desktop,mobile,tablet}.png`.

The later owned-plot extension supersedes the first-stage publication limitation above.
See `publication-verification.md` for its current behavior, evidence and deployment boundary.
