# Creation UI finish review — 12 October 2026

Reviewer: fresh source-only impeccable finish reviewer. No implementation edits.

## Verdict

**RECAPTURE / BLOCKED VISUAL VERDICT. Do not mark the whole surface SHIP.** Browser access was previously SECURITY BLOCKED; this reviewer did not attempt browser access or a workaround. No fresh screenshots were captured. Existing screenshots do not prove the latest creation rendering, roof reveal, lamps, avatar changes, observation controls, or responsive placement. Shared DESIGN.md §10 remains incomplete.

Source direction is coherent with the incumbent warm Earthfolk angled 3D world: ART materials, authoritative committed parts, labeled native inspection controls, bounded lighting, and a public observer experience. Preserve that direction; no rebrand is warranted. The following defects are verified from source, not from rendered observations. Line references refer to the source examined during this review and may move after fixes.

## Six-fix source recheck

The coordinating agent applied the source fix batch and a final focus recovery repair. This recheck is limited to the six findings below. **6 resolved in source / 0 partial / 0 unresolved.** This is a finding-resolution count, not a rendered health score or shipment approval.

| Original finding | Status | Updated source evidence |
|---|---|---|
| Creation focus loss | Resolved in source | Persistent select, keyed options/part buttons, and stable status remove wholesale replacement. creationAction now captures its actual focused button and, after the final stable render, restores that connected trigger or the picker if the trigger is still disabled. It only restores while the panel remains visible and focus is on body, preserving intentional focus changes elsewhere. `preventScroll` avoids a recovery scroll jump. |
| Embedded hidden panel | Resolved in source | `body.world-panels-open #rightstack { display:flex !important }` wins over the embed hiding rule when explicitly opened. |
| Stale focused controls | Resolved in source | Every fresh world update rerenders the stable creation controls regardless of focused descendants; the animation stale transition also refreshes availability. Updated handlers capture the newest received record. |
| Missing switch state | Resolved in source | Switch text exposes on/off and `aria-pressed` tracks `partIsActive`. Door controls remove switch-specific ARIA. |
| Desktop disclosure mismatch | Resolved in source | Global closed-state CSS now hides rightstack; initialization sets the open class and expanded state together for desktop standalone. All widths use the same explicit-open override. |
| Escape dismissal | Resolved in source | Escape hides creation/profile, clears both disclosure states, closes the stack, and focuses People & activity. |

No remaining source defect among the six scoped findings. Runtime keyboard validation is still required: verify picker selection, busy-action focus loss/recovery, success/error/disabled fallback, deliberate focus navigation during a request, panel dismissal during a request, and subsequent Tab order.

The original findings below are retained as the review record. Their status is superseded by this table; do not treat the six resolved items as outstanding defects. **RECAPTURE / BLOCKED VISUAL remains the whole-surface verdict.**

## Original concrete findings

### [P1] Creation selection and actions discard keyboard focus

Locations: `src/main.ts:1599–1626`, especially `creationPanel.replaceChildren()` and picker onchange.

Selecting another creation destroys the focused select. Starting an action and completing it destroy the action button and the status live region. The user loses the current keyboard position; status delivery is less reliable when a new already-populated live region replaces the old one. Close is the one path that explicitly restores focus.

Fix: keep the picker and status region stable, update children/state in place, or capture a semantic control key and restore focus to its replacement after rendering. Restore an enabled relevant control after an action disables its trigger. Update an existing status node rather than recreating it. Standard: shared DESIGN.md §§6, 8; WCAG 2.4.3. Suggested command: impeccable harden.

### [P1] Embedded Creations opens a panel that CSS permanently hides

Locations: `src/style.css:289–290,438,443`; `src/main.ts:330–344`.

New observation controls stay visible in embed mode, but `body.embed #rightstack { display:none !important }` hides their Creations panel regardless of `world-panels-open` or `creationPanel.hidden=false`. The button announces expanded without exposing any inspectable content. People & activity has the same visibility conflict.

Fix: make the explicitly opened observation panels available in the embed, while preserving the incumbent default collapse policy; alternatively hide unavailable buttons and provide a real supported inspection route. Standard: shared DESIGN.md §§6,8; WCAG 4.1.2. Suggested command: impeccable harden.

### [P2] Focus preservation suppresses authoritative control updates

Locations: `src/main.ts:1633–1646,1822`.

World updates skip `renderCreations()` whenever focus is inside the panel. A user can keep focus on the picker or Locate while an offline state recovers, construction completes, or another actor toggles a door. The visible disabled state, part state, revision, and handler's captured record then remain stale. A request may send an outdated expectedRevision, and controls previously disabled offline can remain disabled while fresh updates arrive. Conversely, the eight-second stale threshold changes the connection banner but does not update creation controls until another render.

Fix: update current facts, availability and control state without replacing focused nodes. Resolve the current record at activation and recheck freshness immediately before posting. Standard: shared DESIGN.md §6. Suggested command: impeccable harden.

### [P2] Switch controls expose an action but no current state

Location: `src/main.ts:1638–1642`.

Door text reflects open/closed state through its next action. Switches always read `Toggle <part id>` and have no `aria-pressed`, even though `partIsActive` is calculated. Keyboard and screen reader users cannot tell whether the authoritative light/signal is on. This matters especially when the scene is distant or its roof conceals the lamp.

Fix: expose on/off text and native button `aria-pressed` tied to the committed signal; retain meaningful part identity. Standard: shared DESIGN.md §§6,8; WCAG 4.1.2. Suggested command: impeccable clarify.

### [P2] Desktop People & activity disclosure state contradicts visibility

Locations: `src/main.ts:312–315`; `src/style.css:123–134,440–443`.

The button initializes `aria-expanded=false` and only toggles a body class, but desktop `#rightstack` always displays flex. Its collapse state controls layout only inside the mobile breakpoint. Desktop users are offered a disclosure that neither hides its content nor truthfully reports its initial visibility.

Fix: derive disclosure state from the applicable layout and make the same control truthfully open/close its target at each supported viewport; initialize and synchronize state on breakpoint changes. Standard: shared DESIGN.md §8; WCAG 4.1.2. Suggested command: impeccable harden.

### [P2] Escape hides focused mobile panels without focus recovery

Location: `src/main.ts:318–322`.

Escape removes `world-panels-open`, hiding the mobile rightstack, but does not restore focus from its now-hidden control. It also does not hide creationPanel or reset the Creations button's expanded state. The next tab order and announced state do not reliably match what was dismissed.

Fix: close the active disclosure consistently and return focus to its opener when focus was inside the dismissed content. Do not trap focus: these are nonmodal panels. Standard: shared DESIGN.md §8; WCAG 2.4.3 / 4.1.2. Suggested command: impeccable harden.

## Positive source evidence

- Creations are listed using a visible label and native select, providing a keyboard alternative to scene picking.
- Scene geometry derives from committed plan/progress/signals, rather than fabricated public appearance.
- Built-state and ownership gating, request timeout, busy disabling, explicit public-view permission copy, and error feedback exist.
- New observation/action controls reserve 44px minimum height; new controls provide hover, pressed, disabled, and focus-visible treatments.
- Roof visibility is scoped by creation identity. The nearby point-light pool is capped at four and has no shadows.
- Creation materials derive from shared ART roles. The established live HUD remains authoritative under project DESIGN.md's Material Scope Rule.

## Scope and QA limitations

Read: project DESIGN.md / PRODUCT.md, shared `C:/Users/RGB/.claude/DESIGN.md`, impeccable skill / craft-floor / audit guidance, and Earth skill. Impeccable context was already run once in this session by the coordinating agent; it was not rerun. Reviewed main.ts, style.css, citizenKit.ts, rig.ts, and untracked creationScene.ts source, including the later lamp pool addition. `.artifacts/review-system-detector.json` contains `[]` and is only an earlier source-review baseline; it is not fresh visual or interaction evidence.

No rendered contrast measurements, screenshots, live keyboard pass, pointer pass, overflow inspection, viewport state pass, lamp readability judgment, avatar likeness judgment, or camera/roof reveal visual judgment were performed. No new build or tests were run by this reviewer. Parent-reported build and 569 passing tests predate the latest lamp changes and do not replace visual QA. Numerical visual/a11y health scores are withheld because the required rendered evidence is absent.

Required recapture after fixes, once authorized browser access is restored: 375×812, 768×1024, 1280×800; standalone and embed; overview/follow; open/closed panels; selected creation; building/paused/built; owner/view-only; sending/success/rejected/offline/recovered; door open/closed and light on/off; selected citizen inside/outside; reduced motion. Tab through these states and verify focus restoration, truthful disclosure/pressed state, no overlap/clipping, touch targets, readable controls, and actual door/light appearance.

The retained HUD's hard offset shadows and monospace presentation follow explicit project authority. No new design-rule exception was introduced by this review. §10 is reported as blocked, not waived.

## Follow-up order

1. Impeccable harden: focus, embed visibility, live state synchronization, and disclosure truthfulness.
2. Impeccable clarify: authoritative switch state.
3. Impeccable polish: bounded fresh capture/keyboard verification after the security block is legitimately resolved.
