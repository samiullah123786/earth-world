---
name: AgentsEarth Neighborhood Workshop
description: An inspectable neighborhood assembled from reusable 3D blocks.
colors:
  background: "#eeeae1"
  surface: "#faf8f2"
  surface-raised: "#fffdf7"
  foreground: "#28362d"
  muted-foreground: "#576255"
  muted: "#e6e9dd"
  border: "#7d8879"
  primary: "#355c3d"
  primary-hover: "#284a30"
  primary-foreground: "#ffffff"
  ring: "#38633e"
  destructive: "#9b352c"
  input: "#fffdf7"
  art-background: "#e6e9dd"
  art-grass: "#a2b17b"
  art-soil: "#b9a587"
  art-road: "#d8d1b7"
  art-curb: "#eee7d4"
  art-grid: "#637451"
  art-sun: "#fff0d2"
  art-sky: "#fffdf2"
  art-shadow: "#768b81"
  art-selection: "#355c3d"
  art-invalid: "#9b352c"
  art-ghost: "#5c854c"
  art-leaf: "#77935c"
  art-bark: "#8f7052"
  art-roof: "#a86e4e"
typography:
  headline:
    fontFamily: "'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
  section:
    fontFamily: "'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "8px"
spacing:
  touch-target: "44px"
  compact-panel-height: "64px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
  "20": "80px"
  "32": "128px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.primary-foreground}"
  button-secondary:
    backgroundColor: "{colors.input}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px"
    typography: "{typography.body}"
  panel-navigation:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    padding: "8px 16px"
  catalogue-block:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "4px"
  preview-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    typography: "{typography.label}"
  scene-toolbar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px"
---

# Design System: AgentsEarth Neighborhood Workshop

## Overview

**Creative North Star: "A neighborhood made from inspectable, reusable blocks"**

This system records the neighborhood workshop at `/workshop.html` and `src/workshop/`, plus the shared 3D neighborhood appearance approved for live Earth on 11 October 2026. Scene art is shared through `src/world3d/neighborhood.ts`; the workshop interface tokens, typography, and component examples apply to the workshop only. The incumbent live HUD retains the authority of its existing `src/style.css` and components.

Earthfolk materials give both neighborhoods their identity: cream buildings, timber, warm roofs, sage terrain, paths, and gardens. The workshop interface supports that world with quiet cream surfaces, dark green controls, compact native fields, and a generous angled 3D work surface. Segoe UI is the approved Operate workhorse face for this editor. Live Earth opens from a higher angled perspective, with softer ambient light and the shared sage background in overhead mode; its Orbit and Explore controls remain available.

The workshop world is a local planning document. Labels keep the draft distinct from live Earth, and sample people are explicitly presented as samples. An owner can connect an existing citizen to request and review construction on their owned plot. The Kernel retains identity, permissions, and publication authority; the workshop's external-agent instructions do not invoke a central LLM or grant live authority. Shared appearance changes clone model materials while retaining source geometry, canonical footprints, and citizen identities.

**Key Characteristics:**
- A model-led neighborhood rather than decorative imagery.
- Cream interface surfaces and restrained dark green actions.
- Native controls, readable labels, and visible selection.
- A fixed angled workshop camera; a higher angled live default with Orbit and Explore retained.
- Explicit local-draft and sample-data language.

## Colors

The palette pairs warm neutral workshop interface surfaces with shared sage terrain and timber-roof materials. Interface values above are extracted from `src/workshop/tokens.css`; `art-*` values preserve the hexadecimal colors of `src/world3d/neighborhood.ts` as CSS strings. `src/workshop/palette.ts` reexports that ART palette. Live terrain uses the shared grass, leaf, and roof colors through `src/world3d/palette.ts`, while its remaining terrain materials retain their existing derived palette. The sidecar's eight-step OKLCH ramps are synthesized preview metadata, not additional shipping tokens.

### Primary
- **Dark garden green:** `primary` identifies primary actions, links, and selected panel navigation; `primary-hover` gives hover and press feedback. `primary-foreground` supplies primary-action text; `ring` supplies keyboard focus.
- **Placement green:** `art-selection` marks selected footprints, while `art-ghost` tints a valid translucent placement preview.

### Secondary
- **Earthfolk materials:** `art-grass`, `art-soil`, `art-road`, and `art-curb` define the neighborhood ground, plinth, roads, and connecting paths. `art-leaf`, `art-bark`, and `art-roof` recolor existing model materials.
- **Scene lighting:** `art-sun`, `art-sky`, and `art-shadow` are renderer lighting colors, not interface accents. `art-grid` supplies the optional tile grid.

### Neutral
- **Warm paper:** `background` grounds the page and loading layer; `surface` carries header, tool rail, toolbar, and status bar. `surface-raised` carries catalogue blocks; `input` carries native controls.
- **Sage paper:** `muted` carries hover and pressed states; `art-background` grounds the 3D scene.
- **Ink and structure:** `foreground` supplies main text, `muted-foreground` supplies secondary copy, and `border` supplies component boundaries and dividers.
- **Clay error:** `destructive` supplies validation messages; `art-invalid` tints an invalid placement preview. Errors also state the reason in text.

**The Material Scope Rule.** Shared ART colors and material treatment apply to workshop and live neighborhood scenes; workshop controls retain their dark green palette, and live HUD styling retains its existing authority.

## Typography

**Display and body font:** Segoe UI with sans-serif fallback. This deliberate shared face keeps the workshop practical and readable. The declared Consolas stack is unused in the current surface and is not a documented typography role.

The hierarchy uses five sizes. Headline type introduces the active panel; title type labels the neighborhood; section type groups placement and inspection controls; body type supports instructions and fields; label type carries metadata, validation, and compact camera controls. The wordmark uses title size with a heavier weight (700). Panel headings use weight (600), while selected navigation uses (700).

Headlines are balanced and body copy wraps naturally. Catalogue captions use label size with a tighter line height (1.3); secondary information also changes color so size alone does not carry hierarchy. There is no separate decorative display font.

## Layout

The mobile layout places the complete neighborhood above the tool rail. The header wraps, actions form their own row, and panel navigation remains sticky within the rail. The scene has a minimum height (480px) and height (60vh); scene heading, canvas, toolbar, and footer occupy separate reserved bands. The catalogue stays a three-column grid with compact captioned objects.

At (768px), the workshop fills the viewport using `100dvh`, with header, a horizontal workspace, and status footer. The independently scrolling rail is (288px) wide. At (1100px), it becomes (304px); the draft label moves inline, and canvas/toolbar offsets tighten for the wide layout. The scene takes the remaining space. These are workshop composition values, not a general live-world layout prescription.

Spacing follows the recorded four-pixel scale. Tool panels use (20px) padding; catalogue and coordinate groups use (8px) gaps. Buttons and native fields have a minimum height (44px). Scene controls wrap on narrower screens without sharing the footer band. The camera fits the whole neighborhood to the available canvas; it preserves its fixed angle and does not rotate interactively.

Live Earth fills the viewport behind its existing HUD. At widths up to (768px), Live chat and Community directory start collapsed so the neighborhood remains visible. Their touched expand/collapse controls use `--touch-target` for height and minimum width; Grab uses the same minimum height. The collapsed directory reserves `--compact-panel-height`. These live accessibility dimensions map to the matching frontmatter spacing tokens without applying workshop layout or typography to the HUD.

## Elevation & Depth

Most interface groups are flat and separated by borders or spacing. The floating camera/history toolbar uses the single `shadow-raised` token (`0 4px 16px rgb(40 54 45 / 12%)`). Selected navigation uses an inset underline rather than a floating shadow. Actual 3D light, geometry, and cast shadows communicate the neighborhood's depth.

**The Quiet Controls Rule.** Reserve raised interface depth for the scene toolbar; use borders, spacing, and selected-state marks for ordinary controls and groups.

## Shapes

Controls and catalogue blocks use the small radius; the scene toolbar uses the medium radius. Navigation and draft-object rows have square edges. Thin boundaries define cream surfaces without surrounding every group with a card. Catalogue images occupy a consistent height (72px), followed by wrapping captions; they are generated from the actual model geometry.

## Components

### Buttons

Primary buttons use dark green, white text, and weight (600). Secondary buttons use the input surface and a border. Standard padding is (8px 12px), with minimum height (44px). Hover is pointer-only; primary hover and press use the deeper green, while secondary hover and press use the muted surface. Disabled controls reduce opacity to (.5) and use native `disabled` semantics. Keyboard focus is a (2px) ring offset by (2px).

### Inputs / Fields

Native inputs, selects, and textareas use the input surface, small radius, thin border, and (8px) padding. Visible labels identify every field. Placement coordinates and facing share a local validation message through `aria-describedby`; seed and import fields have their own linked errors and invalid states. File import reports rejection inline and preserves the current draft. Textareas can resize vertically.

### Navigation

Three native pressed-state buttons switch Build, Generate, and Agent plans. The selected button combines darker green, weight (700), and an inset bottom line. Navigation is sticky in the tool rail, with a cream surface and divider. Hidden panels leave the interaction sequence when inactive.

### Catalogue blocks

Each reusable block is a discrete selectable button: actual runtime model thumbnail above its real catalogue label. Selection combines a (2px) green outline, muted surface, and `aria-pressed`. Before a thumbnail resolves, the same-height neutral slot preserves layout; a failed thumbnail reports “Preview unavailable.” The catalogue's content is sourced from approved local model definitions, not arbitrary imported geometry.

### Scene toolbar and preview label

The toolbar groups Undo/Redo, camera actions, Tile grid, and Sample people. Toggles use native `aria-pressed`; disabled history controls remain visible. The compact preview label explicitly states that this is not live Earth. The stage provides labeled tile fields and an all-blocks list as keyboard alternatives to pointer selection.

### Feedback and persistence

Loading covers the stage with preparation text; model failure offers a reload action while the draft remains available. Status messages confirm edits without interrupting the workspace. Clipboard failure exposes selectable instructions; storage failure tells the owner to export JSON. Valid edits, generation, import, undo, and redo autosave the current draft under `agentsearth:neighborhood-draft:v1`; Save draft also writes it explicitly. Storage is local to the browser/device. Undo/redo is session-only, with up to (50) committed predecessor plans; reload restores the draft, not the history.

Interface hover transitions use `duration-fast` (120ms), ease-out. Reduced motion removes transitions. Scene interaction renders on change rather than using decorative idle animation.

### Shared neighborhood appearance and live view

Homes and civic models reuse the shared material clone helper, which recolors green roof regions to warm clay while preserving texture shading. Trees use sage leaves and timber bark. Geometry, loaded source materials, and canonical build footprints remain intact. Live overhead mode uses the shared background and fog colors; Explore retains its sky dome and time-dependent fog. The live camera uses a narrower field of view (38 degrees) and a higher angled focus position, while preserving orbit, pan, zoom, citizen focus, and Explore navigation.

Live lighting retains its day cycle with a minimum hemisphere intensity (1.65), using shared sky and shadow colors. Reduced motion disables Orbit damping, decorative cloud and wildlife updates, and animated water time, and removes CSS transitions and animations. Citizen movement continues to represent actual live state. The workshop's on-change rendering and fixed camera remain specific to its editing surface.

### Owned-plot publication

Publication extends the tool rail below the active editing panel, separated by the existing thin divider. It uses the same cream surface, native controls, field labels, compact validation text, and secondary button treatment. The neighborhood canvas remains the visual center; the draft and preview labels remain visible when a citizen is connected.

Check connection reports session progress and failure in place, then becomes available for recovery. The connected state names the existing citizen and owned plot. The form offers draft homes and community models, with absolute Earth tile fields and a textual canonical footprint preview. The preview states the south-facing entrance and retained model identity; draft rotation and neighborhood coordinates do not govern live construction. Landscape blocks remain local. Incomplete or out-of-plot coordinates disable Request build review, with linked field errors and native invalid semantics after validation.

The permit explanation appears before Request build review and states the (200 Earth Token) charge, including declined permits, with no real-money charge. Pending reviews use the existing inspector divider and paired Approve build / Decline build buttons. Busy requests disable their actions. Decision feedback distinguishes a declined permit, owner approval awaiting civic review, and construction available to inspect on live Earth. A successful decision returns focus to Check connection after refreshing the review list; explicit status text confirms what changed while preserving the local draft. The live construction link appears after owner approval, including when civic review remains pending.

## Do's and Don'ts

### Do:
- **Do** keep model identity, canonical footprints, and actual neighborhood geometry central to both scenes.
- **Do** use workshop CSS tokens for workshop controls and shared ART tokens for approved neighborhood scene materials.
- **Do** keep selected and invalid states legible through both text or semantics and color.
- **Do** label local drafts, sample people, and external-agent instructions accurately.
- **Do** keep keyboard fields and the draft-object list available alongside canvas interaction.
- **Do** preserve source provenance: Kenney CC0 licenses are recorded in `assets/kenney/LICENSE.md` and `public/models/NOTICE.md`; thumbnails are runtime renders of those existing assets.

### Don't:
- **Don't** apply workshop HUD colors, typography, or component styling to live Earth without a separate approved interface change; the approved integration covers shared 3D appearance and touched accessibility controls.
- **Don't** imply local saving, plan import, or procedural generation publishes to shared Earth or grants Kernel permissions.
- **Don't** present sample people as live citizens or invoke a central LLM through workshop copy.
- **Don't** add a dark theme or shipping raster identity to a surface that currently has neither.
- **Don't** promise undo history survives reload; only the current draft is persisted.


## Citizen and compact-building proportions (11 October 2026)

The live glTF citizen atlas wraps source UVs before applying the selected skin cell, and uses flipY=false to match GLTFLoader. Faces and bilateral body textures stay in one skin cell. Shared WORLD_SCALE records a 1.2-tile citizen, 2-tile minimum home height, and 3-tile minimum civic height. The live renderer raises only vertical scale on compact legacy structures; X/Z footprints and Kernel navigation remain unchanged. Normal habitat-sized homes keep their natural uniform scale. Workshop drafts retain their original uniform fit.
