# Creation release visual review — 12 October 2026

## Scoped verdict

**PASS for the captured standalone and embedded observation/Creations layout and empty state. No visual release blocker found in this scope.** This is not approval of the complete creation-home flow or a completed whole-surface DESIGN.md §10 gate.

Direction: preserve the existing warm, compact Earth HUD around the angled model-led neighborhood, with native observation controls and a plainly labeled authoritative Creations panel. No rebrand is needed.

Reviewed frontend commits `53ae7f1`, `da0520a`, `4c60fad`, and the follow-up embed/layout token fix `a408f9c`. This reviewer read shared DESIGN.md, project DESIGN.md and PRODUCT.md, impeccable craft-floor, Earth skill, and the earlier creation UI finish report. Impeccable context was not rerun. No implementation edits, browser access, SSH, deployment, or community action were performed by this reviewer.

## Fresh visual evidence

Independently opened and examined these final captures after the coordinating agent confirmed replacement and frontend version `4c60fad`:

| File | Viewport | Captured state | Finding |
| --- | --- | --- | --- |
| `creation-release-mobile.jpg` | 375×812 | Public observation; Creations open and empty | Creations heading, close control and full empty copy are visible. Panel stays above View and bottom observation controls. No visible horizontal overflow or control overlap. Narrow copy wraps naturally; no empty picker label remains. |
| `creation-release-tablet.jpg` | 768×1024 | Public observation; Creations open and empty | Stack and empty panel are clear of View and observation controls. Scene remains prominent. Empty copy is readable and complete; no empty select/label is shown. |
| `creation-release-desktop.jpg` | 1280×800 | Following Aegis with profile; Creations open and empty | Profile/activity/Creations stack is visible without collision with left observation controls. Following has clear text feedback. Empty copy and close control are visible. |

The coordinating agent separately verified actual viewport dimensions, matching document scrollWidth, and final desktop console errors/warnings `[]`. Those are reported runtime checks, not measurements made by this reviewer.

The product-specific neighborhood/citizen view passes the scoped swap test; the scene remains the focal point in the squint test. Hiding the unpopulated picker and label improves the delete test. Empty-state text describes the actual plan workflow without fabricated creations; scene provenance follows project-owned assets and state. Screenshot legibility is satisfactory, but no rendered contrast measurement was performed.

## Source and keyboard checks

- `src/style.css:455–460`: hidden creation descendants stay hidden; the rightstack scrolls vertically; its children do not shrink. Desktop and mobile reserved bands keep the captured stack away from fixed observation controls.
- `src/main.ts:350–351`: opening Creations scrolls the panel into view and focuses its native Close button without an extra focus scroll.
- `src/style.css:469–470`: creation Close has a 44px target and explicit 2px cream focus-visible outline with 2px offset, correcting the incumbent later outline reset. Observation and creation-content buttons retain their focus treatments.
- Stable picker, keyed controls and status region remain in source. Disclosure and switch states use native button/select semantics and ARIA; no new issue found in the previously repaired six source findings.

The coordinating agent reports runtime verification of opening focus on Close, Tab from Close to Overview, and Escape dismissal returning focus to People & activity with both disclosure states false. This reviewer did not perform a live keyboard pass. Action-request focus recovery and populated-picker keyboard paths remain source-reviewed only.

## Limits and remaining QA

No real production creation home was created for these captures. These images do not certify construction progress, roof reveal, selected-home geometry, doors, lights, owner operating permissions, sending/success/rejection states, or offline/recovered controls. They also do not prove the full scroll range under many populated items or expanded activity panels.

Reduced motion was not emulated because the available browser tooling lacked that capability. Source reduced-motion support remains present, but runtime preference behavior is unverified. No complete pointer/state matrix, computed contrast check, dark-theme pass, or whole-page accessibility certification was performed. No new tests/build were run by this reviewer; coordinating-agent build/test evidence is separate.

The prior report's lack-of-fresh-screenshot limitation is resolved for these three captured layout/empty states only. Whole creation-home §10 QA remains incomplete; do not convert this scoped pass into a full home-flow SHIP claim.

The previously reported §3 token exception is resolved in `a408f9c`: desktop/mobile stack reservations now use named layout tokens. The incumbent HUD's hard shadows and monospace presentation retain explicit project authority under its Material Scope Rule.

## Embedded follow-up — verified after fix

An embedded dashboard observation/mode overlap was discovered after the standalone captures. Commit a408f9c raises embedded observation controls to 64px plus the safe-area inset using existing named dimensions. For mobile embedded viewports no taller than 640px, the stack begins at its named 164px offset and reserves 312px below its maximum height; a 520px viewport therefore allows a 208px scrolling stack above the observation band. Nonshrinking children and opening scroll/focus remain intact. Existing embed policy keeps View settings hidden. After the coordinating agent confirmed final deployment `a408f9c`, this reviewer independently opened `creation-release-embed.jpg` at 375×520. The full World creations header, native Close control and empty copy are visible within the independently scrolling stack. The observation strip and Explore control are separated and fully visible. A partly clipped earlier activity panel at the top is the expected scroll position produced by revealing Creations; the target Creations panel is complete. No horizontal overflow or overlap is visible in the touched region. Coordinating-agent DOM measurements separately confirm scrollWidth 375, stack 164–372, observation strip 388–456, and Explore 464–508. The embedded overlap is resolved in this captured state. The three earlier standalone captures show unchanged equivalent layout; a408f9c changed reserve token references and embedded positioning. Populated creation/action states and reduced-motion runtime verification remain pending as described above.


