# Earth Engine Architecture (V5)

## Tiled grid and rendering invariants

- One world tile is exactly 32 by 32 pixels. Placement and route rendering resolve
  to integer tile origins or centers before entering Phaser.
- `public/assets/maps/agentsearth-v5.tmj` is the only founding-map source. Phaser
  loads it with `make.tilemap()` and native Tiled layers; the deleted `map.json`,
  gentle tileset, matrix renderer, and RenderTextures are not compatibility paths.
- `GroundLayer` contains terrain, roads, water, fields, foundations, and shadows.
- `CollisionLayer` stores collision metadata. Citizens and interactive objects share
  the midground display band and sort by their foot or structure-anchor Y.
- `OverheadLayer` contains only roofs, canopies, upper overhangs, and arches. Grass,
  flowers, and other ground accents cannot occlude citizens.
- Tiled GID `0` becomes Phaser index `-1` during dynamic insertion. Non-zero
  collision GIDs are the shared truth for rendering, EasyStar, and build validation.
- LPC source-sheet crops are registered as real Phaser texture frames. `setCrop` is
  not used because it retains the complete source sheet's display bounds.

## Atomic LPC prefabs

`shared/lpc-prefabs.json` is the canonical catalog. Every new structure, including
the 3x3 native home, is a real LPC prefab. Each prefab defines its complete footprint,
entry, collision cells, and explicit ground/midground/overhead placements. A client
sends a `prefabId`; the Kernel resolves the remaining data from the catalog. Ad-hoc
placement arrays and non-LPC custom structures fail closed.

Before an approval or build row is written, the Kernel atomically checks every cell
for integer and contiguous geometry, bounds, builder ownership, terrain/build
collision, and an accessible prefab entry. Rejected sweeps leave no partial writes.

## WFC expansion and live insertion

Expansion writes deterministic 16 by 16 `worldChunks`, tagged with a district biome
and a persisted `tiled-v1` payload containing `GroundLayer`, `CollisionLayer`, and
`OverheadLayer` GID arrays. Wang sockets make roads, water, shore transitions, and
neighbor borders hard constraints. Dense plots survive only beside roads.

Phaser injects delivered matrices with `putTilesAt()` and updates the EasyStar grid
in the same render turn. A rolling migration adds Tiled payloads to pre-V5 rows
without resetting the world.

## Interactive Tiled object layers

`InteractiveZones` rectangles are parsed into `Phaser.GameObjects.Zone` instances.
The Kernel independently computes intersections against canonical activity-zone
geometry and records `spatialEvents` enter/exit rows. Clients can render and inspect
zones but cannot forge arrival at a future minigame venue.

## Verification

Run:

```powershell
npm test
npm run build
```

The suite covers native layer projection, strict grid math, prefab validation and
atomic rejection, dynamic EasyStar refresh, spatial transitions, deterministic WFC
replay, all biomes, neighbor edge matching, road-adjacent density, and expansion
integration. Browser QA uses `?debug=wfc&lpc-preview=1`; document data attributes
report the map format, native layers, parsed-zone count, inserted-chunk count, and
navigation-grid dimensions.
