import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { ensureWorldState } from './planning';
import { loadWorldWalkability } from './worldGrid';
import { placeBlock } from './handbuild';
import { PATCH_RADIUS } from './perception';
import { TILED_GIDS, TILED_MAP_VERSION } from '../shared/tiled-world';

const modules = import.meta.glob('./**/*.ts');
const harness = () => convexTest(schema, modules);
const NOW = 1_800_000_000_000;
afterEach(() => vi.restoreAllMocks());
async function resident(t: ReturnType<typeof harness>, id = 'agent:truth', x = 32, y = 24) {
  return t.run(async (ctx) => {
    await ensureWorldState(ctx);
    return ctx.db.insert('citizens', { agentId: id, name: id, gender: 'male', family: 'engineering', accent: 'design',
      fx: x, fy: y, tx: x, ty: y, t0: NOW, t1: NOW, online: true, state: 'live', activity: 'idle' });
  });
}
async function block(t: ReturnType<typeof harness>, x: number, y: number, kind: string) {
  await t.run((ctx) => ctx.db.insert('placedBlocks', { x, y, level: 1, kind, plotId: 'plot:fixture',
    ownerAgentId: 'agent:truth', paid: 4, placedAt: NOW }));
}

describe('shared spatial truth', () => {
  it('observes current waypoint positions and distances rather than future destinations', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const t = harness();
    const me = await resident(t);
    const other = await resident(t, 'agent:near');
    await t.run(async (ctx) => {
      await ctx.db.patch(me, { fx: 32, fy: 24, tx: 42, ty: 34, t0: NOW - 500, t1: NOW + 1500,
        route: [{ x: 32, y: 24, at: NOW - 500 }, { x: 42, y: 24, at: NOW + 500 }, { x: 42, y: 34, at: NOW + 1500 }] });
      await ctx.db.patch(other, { fx: 39, fy: 24, tx: 50, ty: 24, t0: NOW, t1: NOW + 1000,
        route: [{ x: 39, y: 24, at: NOW }, { x: 50, y: 24, at: NOW + 1000 }] });
    });
    const seen: any = await t.query(api.perception.at, { agentId: 'agent:truth' });
    expect(seen.position).toEqual({ x: 37, y: 24 });
    expect(seen.target).toEqual({ x: 42, y: 34 });
    expect(seen.nearbyCitizens[0]).toMatchObject({ distance: 2, position: { x: 39, y: 24 } });
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS + 2]).toBe('C');
  });

  it('shares hard block collision with perception and server navigation, leaving cosmetics walkable', async () => {
    const t = harness();
    await resident(t);
    await block(t, 33, 24, 'plank');
    await block(t, 34, 24, 'flowers');
    const seen: any = await t.query(api.perception.at, { agentId: 'agent:truth' });
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS + 1]).toBe('B');
    expect(seen.grid.walkable[PATCH_RADIUS][PATCH_RADIUS + 1]).toBe(false);
    expect(seen.grid.view[PATCH_RADIUS][PATCH_RADIUS + 2]).toBe('O');
    expect(seen.grid.walkable[PATCH_RADIUS][PATCH_RADIUS + 2]).toBe(true);
    await t.run(async (ctx) => {
      const walkable = await loadWorldWalkability(ctx, { width: 64, height: 48 });
      expect(walkable(33, 24)).toBe(false);
      expect(walkable(34, 24)).toBe(true);
    });
  });

  it('exposes generated land outside founding bounds and real chunk collision', async () => {
    const t = harness();
    await resident(t, 'agent:truth', 70, 52);
    await t.run(async (ctx) => {
      const world = await ctx.db.query('worldState').first();
      await ctx.db.patch(world!._id, { width: 80, height: 64, generation: 1 });
      const size = 16, ground = Array(256).fill(TILED_GIDS.grass), collision = Array(256).fill(0);
      collision[4 * size + 7] = 1;
      await ctx.db.insert('worldChunks', { chunkId: 'chunk:4:3', chunkX: 4, chunkY: 3, size,
        biome: 'Residential_Suburbs', generation: 1, seed: 1, tiles: Array(256).fill('grass'),
        edges: { north: [], east: [], south: [], west: [] }, createdAt: NOW,
        tiled: { format: 'tiled-v1', version: TILED_MAP_VERSION, width: size, height: size, objects: [],
          layers: { GroundLayer: ground, CollisionLayer: collision, OverheadLayer: Array(256).fill(0) } } });
    });
    const seen: any = await t.query(api.perception.at, { agentId: 'agent:truth' });
    expect(seen.world).toEqual({ width: 80, height: 64 });
    expect(seen.grid.terrain[PATCH_RADIUS][PATCH_RADIUS]).toBe('g');
    expect(seen.grid.walkable[PATCH_RADIUS][PATCH_RADIUS + 1]).toBe(false);
    const terrain = await t.query(api.perception.terrain, {});
    expect(terrain.width).toBe(80);
    expect(terrain.height).toBe(64);
    expect(terrain.rows[52][70]).toBe('g');
  });

  it('checks hand-building reach along the accepted path, never along a shortcut', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const t = harness();
    const id = await resident(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { fx: 20, fy: 20, tx: 36, ty: 20, t0: NOW - 1000, t1: NOW + 1000,
        route: [{ x: 20, y: 20, at: NOW - 1000 }, { x: 20, y: 28, at: NOW }, { x: 36, y: 20, at: NOW + 1000 }] });
    });
    await expect(t.run(async (ctx) => placeBlock(ctx, await ctx.db.get(id),
      { x: 28, y: 20, level: 1, kind: 'plank' }, 'reach-test'))).rejects.toThrow(/walk closer/);
  });
});

describe('owner driving', () => {
  it('takes over mid-route without teleporting, renews without cancelling steps, and refuses rapid overrides', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const t = harness();
    const id = await resident(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('sessions', { tokenHash: 'owner:test', agentId: 'agent:truth', kind: 'owner', createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + 60_000 });
      await ctx.db.patch(id, { fx: 32, fy: 24, tx: 34, ty: 24, t0: NOW - 1000, t1: NOW + 1000,
        route: [{ x: 32, y: 24, at: NOW - 1000 }, { x: 34, y: 24, at: NOW + 1000 }] });
    });
    expect(await t.mutation(internal.takeover.take, { tokenHash: 'owner:test' })).toMatchObject({ x: 33, y: 24 });
    await t.mutation(internal.takeover.step, { tokenHash: 'owner:test', x: 34, y: 24 });
    await t.mutation(internal.takeover.take, { tokenHash: 'owner:test' });
    const body = await t.run((ctx) => ctx.db.get(id));
    expect(body!.t1).toBe(NOW + 320);
    await expect(t.mutation(internal.takeover.step, { tokenHash: 'owner:test', x: 35, y: 24 })).rejects.toThrow(/finish the current step/);
    expect(body!.recentRoutes![0][body!.recentRoutes![0].length - 1]).toEqual({ x: 33, y: 24, at: NOW });
  });
});

describe('day-plan acceptance', () => {
  it('does not consume an unreachable step', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const t = harness();
    const id = await resident(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { online: false });
      await ctx.db.insert('dayPlans', { agentId: 'agent:truth', stepIndex: 0, createdAt: NOW - 1, expiresAt: NOW + 86_400_000,
        steps: [{ kind: 'work', why: 'cross an impassable grove', x: 2, y: 2 }] });
    });
    await t.mutation(internal.act.ambientTick, {});
    const plan = await t.run((ctx) => ctx.db.query('dayPlans').first());
    expect(plan!.stepIndex).toBe(0);
  });

  it('advances only the six accepted movements when the tick budget is exhausted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const t = harness();
    for (let i = 0; i < 8; i++) {
      const agentId = `agent:budget-${i}`;
      const id = await resident(t, agentId, 32, 24);
      await t.run(async (ctx) => {
        await ctx.db.patch(id, { online: false });
        await ctx.db.insert('dayPlans', { agentId, stepIndex: 0, createdAt: NOW - 1, expiresAt: NOW + 86_400_000,
          steps: [{ kind: 'work', why: 'visit open ground', x: 40 + i, y: 21 }] });
      });
    }
    await t.mutation(internal.act.ambientTick, {});
    const plans = await t.run((ctx) => ctx.db.query('dayPlans').collect());
    expect(plans.filter((plan) => plan.stepIndex === 1)).toHaveLength(6);
    expect(plans.filter((plan) => plan.stepIndex === 0)).toHaveLength(2);
  });
});


describe('ambient interaction honesty', () => {
  it('does not start a conversation at destinations while participants are still walking there', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const t = harness();
    const a = await resident(t, 'agent:service-a');
    const b = await resident(t, 'agent:service-b');
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { serviceRole: 'greeter', fx: 10, fy: 24, tx: 32, ty: 24, t0: NOW, t1: NOW + 10000,
        route: [{ x: 10, y: 24, at: NOW }, { x: 32, y: 24, at: NOW + 10000 }] });
      await ctx.db.patch(b, { serviceRole: 'librarian', fx: 50, fy: 24, tx: 33, ty: 24, t0: NOW, t1: NOW + 10000,
        route: [{ x: 50, y: 24, at: NOW }, { x: 33, y: 24, at: NOW + 10000 }] });
    });
    await t.mutation(internal.act.ambientTick, {});
    expect(await t.run((ctx) => ctx.db.query('conversations').collect())).toHaveLength(0);
  });
});
