/**
 * Perception: what one citizen can see from where they stand.
 *
 * This is the spatial half of the BYOB law. The world never spends a model
 * call thinking for a citizen - the owner's brain does the thinking - but a
 * brain can only reason about space it has been shown. So the Kernel, which
 * is the one authority on the map, answers "what is around me" as structured
 * text an LLM actually reads well: a small lettered grid with the citizen at
 * its centre, plus who and what is near, with distances.
 *
 * No vision model, no rendering, no tokens burned here. The payload is pure
 * projection of public world state - the same facts the town map shows anyone
 * - so the endpoint is public and cacheable like /v1/world/state. Wallets,
 * memories, approvals and everything else private stay exactly where they
 * are: this is eyes, not a diary.
 */

import { query } from './_generated/server';
import { v } from 'convex/values';
import { EARTH_MAP } from './earthMapData';
import { encodeChunkRows } from '../shared/voxel';
import { WAKING_GATE, isAsleep } from '../shared/slumber';

/** How far the lettered grid reaches from the citizen: 5 -> an 11x11 patch. */
export const PATCH_RADIUS = 5;
/** Neighbours worth mentioning by name. */
const NEARBY_CITIZENS_RADIUS = 8;
const NEARBY_PLACES_RADIUS = 10;

/**
 * The letter legend, sent with every payload. A grid nobody explains is a
 * puzzle; the point of perception is that a mind seeing it for the first
 * time can act on it without any other document open.
 */
const LEGEND = {
  g: { is: 'grass', walkable: true },
  d: { is: 'dirt or shore', walkable: true },
  w: { is: 'water', walkable: false },
  r: { is: 'cobbled road', walkable: true },
  c: { is: 'tilled field', walkable: true },
  t: { is: 'tree', walkable: false },
  u: { is: 'undergrowth', walkable: true },
  '.': { is: 'void beyond the world', walkable: false },
  B: { is: 'building', walkable: false },
  V: { is: 'venue', walkable: true },
  G: { is: 'the Waking Gate', walkable: true },
  C: { is: 'another citizen', walkable: true },
  '@': { is: 'you', walkable: true },
} as const;

/** Facing on the map -> compass. The map's north is -y; 'front' faces south. */
const BEARING: Record<string, { degrees: number; compass: string }> = {
  back: { degrees: 0, compass: 'north' },
  right: { degrees: 90, compass: 'east' },
  front: { degrees: 180, compass: 'south' },
  left: { degrees: 270, compass: 'west' },
};

export const at = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const citizen = await ctx.db.query('citizens')
      .withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    if (!citizen) return { ok: false as const, why: 'no such citizen' };

    // A sleeping citizen perceives nothing: their mind is disconnected and
    // their body is beyond the gate. Saying so plainly beats answering with a
    // view of a place they are not standing in.
    if (isAsleep(citizen)) {
      return {
        ok: true as const, agentId, name: citizen.name, asleep: true as const,
        note: 'This citizen is asleep beyond the Waking Gate. Perception resumes '
          + 'the moment the owner\'s connector reconnects; they will wake at '
          + `the gate at (${WAKING_GATE.x}, ${WAKING_GATE.y}).`,
        gate: WAKING_GATE,
      };
    }

    const [chunks, citizens, builds, venues, plot] = await Promise.all([
      ctx.db.query('worldChunks').collect(),
      ctx.db.query('citizens').collect(),
      ctx.db.query('builds').collect(),
      ctx.db.query('venues').collect(),
      ctx.db.query('plots').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agentId)).first(),
    ]);

    // Terrain letters: live expansion chunks win over the bundled base map,
    // exactly the precedence every renderer applies.
    const overlay = new Map<number, string>();
    for (const chunk of chunks) {
      const layers = (chunk as any).tiled?.layers;
      if (!layers) continue;
      const rows = encodeChunkRows(layers, chunk.size);
      for (let dz = 0; dz < chunk.size; dz++) {
        for (let dx = 0; dx < chunk.size; dx++) {
          overlay.set((chunk.chunkY * chunk.size + dz) * 100_000 + (chunk.chunkX * chunk.size + dx), rows[dz][dx]);
        }
      }
    }
    const letterAt = (x: number, y: number): string => {
      if (x < 0 || y < 0 || x >= EARTH_MAP.width || y >= EARTH_MAP.height) return '.';
      return overlay.get(y * 100_000 + x) ?? EARTH_MAP.rows[y][x] ?? '.';
    };

    const standing = builds.filter((build) => build.state === 'built' && typeof build.x === 'number');
    const coveredByBuild = (x: number, y: number) => standing.some((build) =>
      x >= build.x! && x < build.x! + (build.w ?? 3) && y >= build.y! && y < build.y! + (build.h ?? 3));

    const cx = Math.round(citizen.tx), cy = Math.round(citizen.ty);
    const awakeOthers = citizens.filter((other) =>
      other.agentId !== agentId && !isAsleep(other));
    const citizenTiles = new Set(awakeOthers.map((other) => `${Math.round(other.tx)}:${Math.round(other.ty)}`));
    const venueTiles = new Set(venues.map((venue) => `${venue.x}:${venue.y}`));

    // Two grids on purpose. `terrain` is the pure ground truth; `view` layers
    // the world's contents over it - buildings, venues, people, the gate, and
    // you at the centre - because a composite map is what a mind glances at,
    // and the pure one is what it verifies against.
    const terrain: string[] = [];
    const view: string[] = [];
    for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
      let terrainRow = '', viewRow = '';
      for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
        const x = cx + dx, y = cy + dy;
        const ground = letterAt(x, y);
        terrainRow += ground;
        if (dx === 0 && dy === 0) viewRow += '@';
        else if (x === WAKING_GATE.x && y === WAKING_GATE.y) viewRow += 'G';
        else if (citizenTiles.has(`${x}:${y}`)) viewRow += 'C';
        else if (coveredByBuild(x, y)) viewRow += 'B';
        else if (venueTiles.has(`${x}:${y}`)) viewRow += 'V';
        else viewRow += ground;
      }
      terrain.push(terrainRow);
      view.push(viewRow);
    }

    const distance = (x: number, y: number) =>
      Math.round(Math.hypot(x - citizen.tx, y - citizen.ty) * 10) / 10;

    const facing = BEARING[citizen.facing ?? 'front'] ?? BEARING.front;
    return {
      ok: true as const,
      agentId,
      name: citizen.name,
      asleep: false as const,
      position: { x: citizen.tx, y: citizen.ty },
      facing: { direction: citizen.facing ?? 'front', ...facing },
      activity: citizen.activity,
      // What this citizen carries and is - the public inventory. Tokens and
      // memories are not eyes and are not here.
      self: {
        family: citizen.family,
        specialties: citizen.specialties ?? [],
        skillCount: citizen.skillCount ?? 0,
        carriedTool: citizen.carriedTool ?? null,
        activeTool: citizen.activeTool ?? null,
      },
      grid: {
        radius: PATCH_RADIUS,
        axes: 'row 0 is north of you; columns run west to east. You are at the centre.',
        view,
        terrain,
        legend: LEGEND,
      },
      plot: plot ? {
        plotId: plot.plotId,
        bounds: { min: { x: plot.x, y: plot.y }, max: { x: plot.x + plot.w - 1, y: plot.y + plot.h - 1 } },
        district: plot.district,
      } : null,
      nearbyCitizens: awakeOthers
        .map((other) => ({
          agentId: other.agentId, name: other.name, family: other.family,
          distance: distance(other.tx, other.ty),
          position: { x: other.tx, y: other.ty },
          activity: String(other.activity ?? '').slice(0, 90),
          talkingWith: other.talkingWith ?? null,
        }))
        .filter((other) => other.distance <= NEARBY_CITIZENS_RADIUS)
        .sort((left, right) => left.distance - right.distance),
      nearbyStructures: standing
        .map((build) => ({
          structure: build.structure,
          at: { x: build.x!, y: build.y! }, w: build.w ?? 3, h: build.h ?? 3,
          distance: distance(build.x! + (build.w ?? 3) / 2, build.y! + (build.h ?? 3) / 2),
          owner: build.ownerAgentId,
        }))
        .filter((build) => build.distance <= NEARBY_PLACES_RADIUS)
        .sort((left, right) => left.distance - right.distance),
      nearbyVenues: venues
        .map((venue) => ({
          name: venue.name, kind: venue.kind,
          position: { x: venue.x, y: venue.y }, distance: distance(venue.x, venue.y),
        }))
        .filter((venue) => venue.distance <= NEARBY_PLACES_RADIUS)
        .sort((left, right) => left.distance - right.distance),
      gate: { ...WAKING_GATE, distance: distance(WAKING_GATE.x, WAKING_GATE.y) },
      serverNow: Date.now(),
    };
  },
});
