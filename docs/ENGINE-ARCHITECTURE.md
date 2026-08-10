# Earth Engine Architecture

## Grid and rendering invariants

- One world tile is exactly 32 by 32 pixels. World placement and route rendering use
  integer tile origins or integer tile centers; fractional final coordinates are
  rejected or rounded before entering Phaser.
- `groundLayer` contains terrain, roads, water, foundations, fields, and shadows.
- `objectLayer` contains collision objects and citizens. Every sortable object uses
  its foot/structure anchor as depth, so smaller screen Y renders behind larger Y.
- `overheadLayer` contains roofs, canopies, upper overhangs, and arches. It always
  renders over citizens and never contributes a giant flattened collision rectangle.
- LPC source-sheet crops are registered as real Phaser texture frames. `setCrop` is
  not used because it retains the complete source sheet's display bounds.

## Atomic LPC prefabs

`shared/lpc-prefabs.json` is the canonical catalog. Each versioned prefab defines its
whole footprint, entry, collision cells, and explicit ground/midground/overhead
placements. The client sends a `prefabId`; the Kernel resolves all other fields from
the catalog.

Before any approval or build record is written, the Kernel sweeps every footprint
cell for:

1. integer and contiguous coordinates;
2. bounds and ownership by the builder;
3. existing builds and founding-map collision;
4. persisted WFC terrain collision; and
5. an unblocked prefab entry.

Convex mutations are transactional, and tests assert that a rejected sweep leaves
both build and approval counts unchanged.

## WFC expansion

Expansion writes uniform 16 by 16 `worldChunks`, each tagged with a district biome.
The generator is deterministic for a seed and uses Wang sockets (`grass`, `road`,
`water`) as hard constraints. Existing neighbor edges become the boundary domain for
the new chunk. The solver backtracks on contradictions and fails closed rather than
falling back to random noise.

Additional rules enforce road continuity, shore tiles between water and land, and
dense plots only beside roads. Chunks, road-adjacent plots, and world dimensions are
committed by one backend transaction. Pathfinding reads the same persisted chunk and
prefab collision state as placement validation.

## Verification

Run:

```powershell
npm test
npm run build
```

The suite covers grid math, layer/depth ordering, prefab catalog validation, legacy
catalog compatibility, atomic rejection, pathfinding, deterministic WFC replay,
all biomes, neighbor edge matching, road-adjacent density, and expansion integration.
For browser QA, use `?debug=layers,grid,occlusion,wfc&lpc-preview=1`; this adds a local
three-layer prefab/occlusion fixture and a deterministic WFC preview without writing
to the backend.
