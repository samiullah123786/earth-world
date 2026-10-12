# Creation and observation design assessment — 12 October 2026

This is a local documentation supplement, initially based on source and updated after release with fresh public HTTPS screenshot evidence. It records an ordinary extension of the incumbent Earthfolk angled 3D world: town overview, citizen following, and creation inspection and operation. It does not redefine the brand or replace the workshop design system.

## Authority and scope

Read sources: `C:/Users/RGB/.claude/DESIGN.md`, `DESIGN.md`, `PRODUCT.md`, `.impeccable/design.json`, and the impeccable `reference/document.md`. Implementation inspection was limited to `src/main.ts`, `src/style.css`, `src/world3d/citizenKit.ts`, and `src/world3d/creationScene.ts`. The release follow-up rechecked the touched main/CSS source and `.artifacts/creation-release-visual-review-2026-10-12.md`, and independently opened the final desktop/tablet/mobile/embed images. References in the initial evidence table describe that earlier source snapshot; subsequent release edits moved line numbers. No fresh impeccable context was generated.

The project's DESIGN.md expressly scopes its interface tokens and Segoe UI hierarchy to the workshop. The live HUD retains authority through its existing stylesheet and components. Shared ART materials apply to both scenes. PRODUCT.md commits to cream plaster, timber, warm windows, gardens, canonical identity, and Kernel authority. No new DESIGN.md generation or sidecar refresh is needed for this extension; DESIGN.md, PRODUCT.md, and `.impeccable/design.json` were preserved.

The document reference's qualitative workshop questions are unnecessary here: the incumbent direction is already specified, and this assignment requests a supplement rather than replacement or refresh of existing design sources.

## Source evidence and adherence

| Surface | Evidence | Assessment |
| --- | --- | --- |
| Live observation controls | `src/main.ts:301–359`; `src/style.css:422–450` | Native buttons extend the existing cream/ink/moss HUD, with its mono typography. Wrapping, 44px minimum heights, pointer-only hover, pressed states, and visible focus rules are present. |
| Creation panel | `src/main.ts:332–348,1615–1678`; `src/style.css:452–461` | A labeled section inside the incumbent right stack uses the existing panel header and border language. A visible label identifies the native select. Persistent nodes and keyed options/actions preserve the interface across fresh state updates. Controls reuse semantic live HUD colors. |
| Creation scene | `src/world3d/creationScene.ts:3,13–18,23–60` | Material roles resolve to shared ART values: plank/curb, stone/shadow, brick/soil, glass/sky, thatch/bark, lantern/sun, door/bark, roof/roof, switch/selection. No independent creation brand palette is introduced. |
| Construction and operation | `src/world3d/creationScene.ts:32–47,65–75`; `src/main.ts:1602–1613,1651–1675` | Geometry displays committed progress and authoritative signals. Doors change physical orientation, lamps change emission and lighting. Four nearby shadow-free PointLights limit active lamp cost. The UI sends requests with expected revisions, rather than assuming successful local state. |
| Interior inspection | `src/main.ts:2449–2465`; `src/world3d/creationScene.ts:77–90` | Roof visibility follows the selected citizen or Explore camera position. This provides a functional view of interiors while retaining other assemblies. |
| Citizen identity | `src/main.ts:1169–1304`; `src/world3d/citizenKit.ts:19,313–326,338–387` | Public avatar colors, hairstyle, head width, eyes, and scholar glasses inform composable bodies; legacy citizens retain the atlas path. Palette roles are imported from `avatarPalette.ts`, rather than defined as literal colors in the touched component. Authority dress, office sash, tier marks, and tools remain distinct from personal wardrobe. |
| State provenance | `src/main.ts:298,1787–1799,2678–2692` | The observer reports the 2.2-second view delay, actual citizen activity, and stale/offline state. Profile coordinates use the displayed route time. No invented citizens or achievement copy was added in the inspected changes. |

The direction is coherent at source level: the neighborhood remains the primary object, scene materials remain warm Earthfolk materials, and controls use the live interface rather than importing workshop styling. The fresh release images additionally support the scoped layout/empty-state findings below; they do not prove the full creation flow.

## New controls and behavior

- **Overview:** stops following, clears citizen selection, hides actor status and profile, and frames the town from the existing angled camera.
- **Follow citizen / Stop following:** unavailable until a citizen is selected; exposes `aria-pressed`. Following tracks the displayed citizen position. Starting an Orbit interaction stops following.
- **People & activity:** exposes `aria-expanded` and `aria-controls` for the right stack. Mobile and embedded views start closed; desktop starts open. CSS disclosure follows the same body state at all viewport sizes, including an explicit open override for embedded mode. Closing this group also closes Creations.
- **Creations:** opens or closes the creation section and opens the right stack. Opening scrolls the panel into view and focuses its Close button without an extra focus scroll (`src/main.ts:349–351`). Clicking a creation in the scene selects it and opens the same inspector, while the native picker provides a keyboard alternative.
- **Inspect a creation:** lists received names and states; the detail reports state, committed part progress, and revision. Locate creation focuses its world position.
- **Open / Close door; switch on/off:** visible native buttons request an authoritative operation. Switches state their current value and expose `aria-pressed`. They are disabled for a different owner, unavailable state, busy requests, or incomplete construction.
- **Pause / Resume construction:** requests the corresponding authoritative command; disabled for a different owner, stale state, busy requests, or completed construction.
- **Close world creations:** hides the section and explicitly returns focus to Creations. Escape closes Creations, the right stack, and citizen profile, resets expanded attributes, and returns focus to People & activity.

The connection message uses `role="status"`. The creation response uses a persistent status region, with sending, success, and failure text. Viewing-only and stale-state explanations appear beside operations. The empty state explains that agents can submit a validated plan on owned land. UI ownership gating uses the viewer hint; the copy accurately states that Earth checks authority, distance, and revision. Fresh state updates refresh panel state even while a control has focus; retained nodes receive current revision handlers. An explicit stale-transition check refreshes disabled controls when state ages beyond eight seconds.

## State and accessibility coverage observed in source

Native semantics, visible select labeling, expanded/pressed attributes, disabled attributes, pointer-only hover, active feedback, and 2px focus outlines are present for the new observation and creation controls. The close target is at least 44px square, with an explicit cream focus ring that overrides the incumbent outline reset (`src/style.css:474–475`). The content area scrolls at 40dvh, wraps ordinary text, and uses 12px labels consistent with the incumbent dense live HUD. Hidden empty-state picker descendants remain hidden; the outer stack scrolls and its children do not shrink. Named layout tokens reserve desktop, mobile, and short embedded bands; embedded observation controls sit above Explore (`src/style.css:424,440,455–464`).

Loading and success/error text are implemented for creation requests without changing action labels. Permission and offline explanations exist. Source supports reduced-motion preferences for Orbit damping, citizen idle breathing, arrival/departure effects, clouds, wildlife, and water. Creation doors and roof changes are immediate state changes, without added decorative animation. Actual citizen movement continues to represent world state.

## Release evidence follow-up

The coordinator reports Kernel commit `7fa0ac4` successfully deployed through HTTPS to Vidify, viewer `8675e44` promoted at `world.agentsearth.com`, and dashboard `b2c70de` already live. UI follow-up commits `53ae7f1`, `da0520a`, `4c60fad`, and `a408f9c` address stack scrolling, opening focus, Close focus visibility, embedded separation, and named layout tokens. The viewer API adapter ESM change is outside this design assessment. This documentation task did not deploy or independently certify deployment status.

Independently viewed final captures:

| Artifact | Viewport | Observed scope |
| --- | --- | --- |
| `.artifacts/creation-release-mobile.jpg` | 375×812 | Open empty Creations panel; complete heading/copy/Close; separate View and bottom controls. |
| `.artifacts/creation-release-tablet.jpg` | 768×1024 | Open empty panel and activity stack; readable wrapping; prominent neighborhood and separated controls. |
| `.artifacts/creation-release-desktop.jpg` | 1280×800 | Following Aegis with profile and empty Creations panel; no visible control collision in the touched layout. |
| `.artifacts/creation-release-embed.jpg` | 375×520 | Empty Creations panel fully visible in the scrolling stack; observation strip and Explore separated. Earlier activity content is partially clipped at the intentional scrolled position. |

`.artifacts/creation-release-live.jpg` also exists as coordinator evidence; it was not independently opened by this documentation task. The fresh visual review records a **scoped PASS for captured public observation layout and the empty Creations state**. This document's image inspection agrees within that scope. The angled neighborhood and actual citizen context remain product-specific; the scene is visually central, and hiding an empty picker/label improves the empty composition. No touched-region horizontal overflow or overlap is apparent in these images. DOM scroll-width measurements, console checks, and live keyboard checks are coordinator-reported, not independently performed here.

## Known gaps and limits

1. **The earlier SECURITYBLOCKED limitation applies to local browser access only.** Public HTTPS capture access subsequently became available. The required standalone screenshot sizes and an additional short embedded size now have fresh evidence for the captured empty/public observation states. Complete creation-home §10 QA remains outstanding: populated geometry/progress, doors, lights, roofs, owner operations, request success/rejection, offline recovery, many-item scroll, computed contrast, and runtime reduced-motion behavior are not certified. Do not expand the scoped screenshot pass into a whole-flow pass.
2. **Populated focus continuity needs live verification.** Persistent controls replace the earlier wholesale DOM rebuild. Source also retains a request trigger and returns focus to it or the picker when disabling loses focus to the body (`src/main.ts:1608,1620–1622`). The coordinator reports opening focus on Close, Tab to Overview, and Escape focus return with disclosure reset. Those keyboard checks were not independently performed by this documenter. Selected-record/part removal, populated picker paths, and action-request recovery remain unverified in a browser.
3. **Stale feedback needs runtime verification.** Source now refreshes panel disabled states on fresh updates and stale transitions. The authoritative endpoint remains the final validator. Timing, reconnection, and response behavior were not exercised by this documentation task.
4. **Control states need a live interaction pass.** Switch buttons now have on/off text and pressed-state semantics. Some disabled cases rely on nearby permission/stale text and displayed creation state. The persistent status region improves announcement intent, but screen-reader announcements are unverified. Full state coverage is not established by source inspection alone.
5. **Canonical palette extraction resolves the earlier local-literal concern.** The inspected `citizenKit.ts` imports AVATAR_HAIR/CLOTH/EYES from `avatarPalette.ts`. This removes the previously documented component-local palette exception. The token module itself was outside the four-file inspection scope; no new exception is asserted for the observed change.
6. **Existing drift remains outside scope.** The live HUD already has strong offset shadows, existing raw color literals, and an existing purple family fallback. Those were observed only to distinguish incumbent authority from new changes; this documentation does not authorize or implement their repair. The release layout reservations now use named tokens. The workshop spacing scale is not imposed on the separately authoritative live HUD.
7. **No runtime or backend verification was performed by this documentation task.** Request acceptance, authorization, lamp visibility, collisions, and route continuity require the implementation owner's tests. Source references to shared types/helpers were not treated as an audit of their internals.

## Preservation and delivery statement

Only this supplementary artifact was written. Incumbent normative design and product files, sidecar metadata, and implementation files were not changed by the documentation task.

No new design exception is claimed necessary for the inspected repaired implementation. Existing unrelated drift was preserved outside scope.

QA statement to report: fresh public HTTPS captures support a scoped observation/empty-panel layout pass at desktop, tablet, mobile, and short embedded sizes; complete creation-home state coverage and reduced-motion runtime QA remain pending. Local SECURITYBLOCKED history no longer means fresh public screenshot evidence is unavailable.
