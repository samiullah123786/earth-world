import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { supplyAudit } from './economy';

const modules = import.meta.glob('./**/*.ts');
const FIELD = { x: 21, y: 35 };      // inside zone:common-field
const WOODLOT = { x: 53, y: 27 };    // inside zone:east-woodlot

let nonce = 0;
const act = (t: ReturnType<typeof convexTest>, who: { agentId: string; token: string }, action: Record<string, unknown>) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: `a-${nonce++}`, action });

async function citizen(t: ReturnType<typeof convexTest>, suffix: string, at = FIELD) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 6,
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  // Stand them on the tile: work is credited where a citizen actually is.
  await t.run(async (ctx) => {
    const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === agentId);
    const now = Date.now();
    await ctx.db.patch(row!._id, { fx: at.x, fy: at.y, tx: at.x, ty: at.y, t0: now, t1: now, route: [{ ...at, at: now }] });
  });
  return { agentId, token: `agent-${suffix}` };
}

async function award(t: ReturnType<typeof convexTest>, agentId: string, points: number, tag: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert('contributions', {
      agentId, dimension: 'civic', kind: 'seeded_for_test', points, sourceId: tag,
      gloss: 'test contribution', createdAt: Date.now(),
    });
  });
}

describe('extracurricular activities', () => {
  it('seeds the community grounds and publishes them', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.seed.init, {});
    const objects = await t.query(api.world.worldObjects, {});
    expect(objects.activityZones).toHaveLength(4);
    expect(objects.activityZones.map((zone: any) => zone.kind).sort()).toEqual(['farm', 'forest', 'orchard', 'quarry']);
  });

  it('earns a tool through contribution rather than handing it out', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'tools');
    expect(await act(t, worker, { type: 'equip', tool: 'watering_can' })).toMatchObject({ tool: 'watering_can' });
    await expect(act(t, worker, { type: 'equip', tool: 'axe' })).rejects.toThrow(/earned at 3 contribution points/);
    // Raw civic points are weighted at 45%, so this clears the axe but not the pickaxe.
    await award(t, worker.agentId, 10, 'test:axe');
    expect(await act(t, worker, { type: 'equip', tool: 'axe' })).toMatchObject({ tool: 'axe' });
    await expect(act(t, worker, { type: 'equip', tool: 'pickaxe' })).rejects.toThrow(/earned at 8 contribution points/);
    await expect(act(t, worker, { type: 'equip', tool: 'spanner' })).rejects.toThrow(/choose a tool/);
  });

  it('needs the right tool and the right ground', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'wrong');
    await expect(act(t, worker, { type: 'plant', ...FIELD })).rejects.toThrow(/needs the watering_can/);
    await act(t, worker, { type: 'equip', tool: 'watering_can' });
    await expect(act(t, worker, { type: 'plant', x: 2, y: 2 })).rejects.toThrow(/not inside a community activity zone/);
    await expect(act(t, worker, { type: 'gather', ...FIELD })).rejects.toThrow(/belongs in a forest/);
  });

  it('walks a distant citizen to the ground and credits nothing yet', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'far', { x: 32, y: 24 });
    await act(t, worker, { type: 'equip', tool: 'watering_can' });
    const routed = await act(t, worker, { type: 'plant', ...FIELD });
    expect(routed).toMatchObject({ routed: true, zone: 'the Common Field' });
    await t.run(async (ctx) => {
      expect(await ctx.db.query('farmPlots').collect()).toHaveLength(0);
    });
  });

  it('grows a crop over time and refuses an early harvest', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const farmer = await citizen(t, 'farmer');
    await act(t, farmer, { type: 'equip', tool: 'watering_can' });
    const planted = await act(t, farmer, { type: 'plant', ...FIELD, crop: 'greens' });
    expect(planted.crop).toBe('greens');
    await expect(act(t, farmer, { type: 'plant', ...FIELD })).rejects.toThrow(/already growing/);
    await expect(act(t, farmer, { type: 'harvest', ...FIELD })).rejects.toThrow(/more minute\(s\)/);

    const fields = (await t.query(api.world.worldObjects, {})).farmPlots;
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ crop: 'greens', stage: 1 });
  });

  it('rewards shared tending when the harvest comes in', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const farmer = await citizen(t, 'grower');
    const helper = await citizen(t, 'helper');
    await act(t, farmer, { type: 'equip', tool: 'watering_can' });
    await act(t, helper, { type: 'equip', tool: 'watering_can' });
    await act(t, farmer, { type: 'plant', ...FIELD });
    await act(t, helper, { type: 'water', ...FIELD });
    await expect(act(t, helper, { type: 'water', ...FIELD })).rejects.toThrow(/already watered/);

    await t.run(async (ctx) => {
      const field = await ctx.db.query('farmPlots').first();
      await ctx.db.patch(field!._id, { readyAt: Date.now() - 1_000 });
    });
    const harvest = await act(t, helper, { type: 'harvest', ...FIELD });
    expect(harvest.helpers).toBe(2);
    await t.run(async (ctx) => {
      const shares = (await ctx.db.query('contributions').collect()).filter((row) => row.kind === 'harvest_share');
      expect(shares.map((row) => row.agentId).sort()).toEqual([farmer.agentId, helper.agentId].sort());
    });
  });

  it('paces gathering instead of letting it be spammed', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const forester = await citizen(t, 'woods', WOODLOT);
    await award(t, forester.agentId, 10, 'test:axe');
    await act(t, forester, { type: 'equip', tool: 'axe' });
    expect(await act(t, forester, { type: 'gather', ...WOODLOT })).toMatchObject({ zone: 'the East Woodlot' });
    await expect(act(t, forester, { type: 'gather', ...WOODLOT })).rejects.toThrow(/resting/);
  });

  it('never mints Earth Tokens from working the land', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const farmer = await citizen(t, 'honest');
    await act(t, farmer, { type: 'equip', tool: 'watering_can' });
    const before = await t.run(async (ctx) => supplyAudit(ctx));
    await act(t, farmer, { type: 'plant', ...FIELD });
    await t.run(async (ctx) => {
      const field = await ctx.db.query('farmPlots').first();
      await ctx.db.patch(field!._id, { readyAt: Date.now() - 1_000 });
    });
    await act(t, farmer, { type: 'harvest', ...FIELD });
    const after = await t.run(async (ctx) => supplyAudit(ctx));
    expect(after.minted).toBe(before.minted);
    expect(after.circulating).toBe(before.circulating);
  });

  it('carries a tool without miming the work forever', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'holstered');
    await act(t, worker, { type: 'equip', tool: 'watering_can' });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      // Equipping is carrying, not doing: no work window opens.
      expect(row!.carriedTool).toBe('watering_can');
      expect(row!.workingUntil ?? 0).toBe(0);
    });

    await act(t, worker, { type: 'plant', ...FIELD });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      expect(row!.activeTool).toBe('watering_can');
      expect(row!.workingUntil!).toBeGreaterThan(Date.now());
    });
  });

  it('keeps a citizen on their errand instead of wandering off', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const worker = await citizen(t, 'errand', { x: 32, y: 24 });
    await act(t, worker, { type: 'equip', tool: 'watering_can' });
    const routed = await act(t, worker, { type: 'plant', ...FIELD });
    expect(routed.routed).toBe(true);

    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      // The claim has to outlast the walk, or an ambient drive reroutes them.
      // Arriving is not the end of the errand: the agent must still ask again,
      // so the hold has to leave room for that call.
      expect(row!.workingUntil!).toBeGreaterThan(Number(routed.arrivesAt) + 30_000);
      // Going offline is exactly when ambient movement takes over.
      await ctx.db.patch(row!._id, { online: false });
    });

    const target = await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      return { tx: row!.tx, ty: row!.ty };
    });
    await t.mutation(internal.act.ambientTick, {});
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === worker.agentId);
      expect({ tx: row!.tx, ty: row!.ty }).toEqual(target);
    });
  });
});
