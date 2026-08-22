/**
 * Perception, end to end against a real Kernel.
 *
 * This payload is what owner-side minds will reason about before they move or
 * build, so a wrong grid is worse than no grid: an LLM told there is grass
 * where there is water will walk its citizen into the river with total
 * confidence. These tests pin the centre, the overlay precedence, the
 * composite markers, and the honesty of sleep.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { PATCH_RADIUS } from './perception';
import { WAKING_GATE } from '../shared/slumber';
import { TILED_GIDS } from '../shared/tiled-world';

const modules = import.meta.glob('./**/*.ts');

let seq = 0;
async function resident(t: ReturnType<typeof convexTest>, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'light',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}-${seq++}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId };
}

const standAt = (t: ReturnType<typeof convexTest>, agentId: string, x: number, y: number) =>
  t.run(async (ctx: any) => {
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
    await ctx.db.patch(citizen._id, { tx: x, ty: y, fx: x, fy: y, route: undefined });
  });

describe('the grid', () => {
  it('puts the citizen at the exact centre, every time', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'centre');
    await standAt(t, agentId, 40, 30);
    const seen: any = await t.query(api.perception.at, { agentId });
    expect(seen.ok).toBe(true);
    expect(seen.grid.view).toHaveLength(PATCH_RADIUS * 2 + 1);
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS]).toBe('@');
    // The pure terrain never carries the composite markers.
    expect(seen.grid.terrain.join('')).not.toMatch(/[@BCVG]/);
  });

  it('shows the void beyond the world edge as void, not as grass', async () => {
    // A mind at the frontier must know where the world stops. Painting the
    // edge green would invite a plan that walks straight off the map.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'edge');
    await standAt(t, agentId, 0, 0);
    const seen: any = await t.query(api.perception.at, { agentId });
    // Everything north and west of (0,0) is outside the map.
    expect(seen.grid.terrain[0].slice(0, PATCH_RADIUS)).toBe('.'.repeat(PATCH_RADIUS));
  });

  it('lets a live expansion chunk overrule the bundled base map', async () => {
    // The base export is a snapshot; the world keeps growing after it. If the
    // overlay ever loses precedence, perception describes last month's land.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'overlay');
    await standAt(t, agentId, 8, 8);
    const size = 16;
    const water = new Array(size * size).fill(TILED_GIDS.water);
    await t.run(async (ctx: any) => {
      await ctx.db.insert('worldChunks', {
        chunkId: 'chunk:0:0', chunkX: 0, chunkY: 0, size, biome: 'Town_Center',
        generation: 1, seed: 1, tiles: new Array(size * size).fill('water'),
        edges: { north: [], east: [], south: [], west: [] },
        createdAt: Date.now(),
        tiled: {
          format: 'tiled-v1', version: 1, width: size, height: size, objects: [],
          layers: {
            GroundLayer: water,
            CollisionLayer: new Array(size * size).fill(0),
            OverheadLayer: new Array(size * size).fill(0),
          },
        },
      });
    });
    const seen: any = await t.query(api.perception.at, { agentId });
    expect(seen.grid.terrain[PATCH_RADIUS][PATCH_RADIUS]).toBe('w');
    expect(seen.grid.legend.w.walkable).toBe(false);
  });
});

describe('what stands and who is near', () => {
  it('marks another citizen on the view and lists them with a distance', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'looker');
    const { agentId: other } = await resident(t, 'neighbour');
    await standAt(t, agentId, 40, 30);
    await standAt(t, other, 42, 30);
    const seen: any = await t.query(api.perception.at, { agentId });
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS + 2]).toBe('C');
    const listed = seen.nearbyCitizens.find((entry: any) => entry.agentId === other);
    expect(listed.distance).toBe(2);
    expect(listed.name).toBe('Test neighbour');
  });

  it('does not show a sleeping citizen as standing in a field', async () => {
    // Sleep means the mind is gone and the body is beyond the gate. A 'C' on
    // the grid for a sleeper would be the one lie perception could tell.
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'watcher');
    const { agentId: sleeper } = await resident(t, 'dozer');
    await standAt(t, agentId, 40, 30);
    await standAt(t, sleeper, 41, 30);
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', sleeper)).first();
      await ctx.db.patch(citizen._id, { online: false, asleepSince: Date.now() });
    });
    const seen: any = await t.query(api.perception.at, { agentId });
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS + 1]).not.toBe('C');
    expect(seen.nearbyCitizens.some((entry: any) => entry.agentId === sleeper)).toBe(false);
  });

  it('marks a standing building as B on the view', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'builderwatch');
    await standAt(t, agentId, 60, 60);
    await t.run(async (ctx: any) => {
      await ctx.db.insert('builds', {
        buildId: 'build:test', plotId: 'plot:test', ownerAgentId: 'agent:someone',
        structure: 'home', state: 'built', createdAt: Date.now(),
        x: 62, y: 60, w: 3, h: 3,
      });
    });
    const seen: any = await t.query(api.perception.at, { agentId });
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS + 2]).toBe('B');
    expect(seen.nearbyStructures[0].structure).toBe('home');
  });
});

describe('honesty', () => {
  it('a sleeping citizen perceives nothing but where they will wake', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'shut');
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      await ctx.db.patch(citizen._id, { online: false, asleepSince: Date.now() });
    });
    const seen: any = await t.query(api.perception.at, { agentId });
    expect(seen.asleep).toBe(true);
    expect(seen.grid).toBeUndefined();
    expect(seen.gate).toEqual(WAKING_GATE);
  });

  it('answers a stranger honestly rather than inventing a citizen', async () => {
    const t = convexTest(schema, modules);
    const seen: any = await t.query(api.perception.at, { agentId: 'agent:never-was' });
    expect(seen.ok).toBe(false);
  });

  it('reads facing as a compass bearing the way the map is actually drawn', async () => {
    const t = convexTest(schema, modules);
    const { agentId } = await resident(t, 'compass');
    await t.run(async (ctx: any) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
      await ctx.db.patch(citizen._id, { facing: 'back' });
    });
    const seen: any = await t.query(api.perception.at, { agentId });
    // 'back' sprites face away from the viewer, which on this map is north.
    expect(seen.facing).toEqual({ direction: 'back', degrees: 0, compass: 'north' });
  });
});
