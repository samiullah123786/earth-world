import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { owner } from '../testHelpers/modularOwner';
import { legacyStarterHome, starterHome, isLegacyStarterHome, creationExtent } from '../shared/creation';
import { balanceOf, assertSupplyInvariant } from './economy';
import { loadWorldWalkability } from './worldGrid';
import { currentPosition } from '../shared/position';

const make = () => convexTest(schema, import.meta.glob('./**/*.ts'));
let nonce = 0;
const act = (t: ReturnType<typeof make>, action: any) => t.mutation(internal.kernel.act, { agentId: 'agent:test-modular', tokenHash: 'test-agent', nonce: `compact-${nonce++}`, action });
const compact = (t: ReturnType<typeof make>, row: any, requestId = 'compact-owner-job-01') => t.mutation(internal.kernel.ownerCreation, { tokenHash: 'test-owner', action: {
  type: 'creation_compact', creationId: row.creationId, expectedRevision: row.revision, requestId,
} });
afterEach(() => vi.useRealTimers());
async function finish(t: ReturnType<typeof make>, creationId: string) {
  const row = await t.run(ctx => ctx.db.query('creations').withIndex('creationId', q => q.eq('creationId', creationId)).first());
  for (let i = 1; i <= 5; i++) {
    vi.setSystemTime(row!.startsAt + i * 8000);
    await t.mutation(internal.kernel.creationTick, {});
  }
  return t.run(ctx => ctx.db.query('creations').withIndex('creationId', q => q.eq('creationId', creationId)).first());
}
async function fixture() {
  vi.useFakeTimers();
  const t = make(), site = await owner(t);
  await t.run(async ctx => {
    for (const person of await ctx.db.query('citizens').collect()) await ctx.db.patch(person._id, { fx: 32, fy: 24, tx: 32, ty: 24, route: [], t0: Date.now(), t1: Date.now() });
  });
  const started: any = await act(t, { type: 'creation_build', plan: legacyStarterHome(site.x, site.y), requestId: 'legacy-home-build-01' });
  const row = await finish(t, started.creationId);
  expect(row!.state).toBe('built');
  return { t, site, row: row! };
}

describe('explicit bounded compact home remodeling', () => {
  it('uses smaller defaults without silently changing the historical recipe', () => {
    expect(creationExtent(starterHome(1, 1))).toEqual({ w: 4, h: 4 });
    expect(creationExtent(legacyStarterHome(1, 1))).toEqual({ w: 5, h: 5 });
    expect(isLegacyStarterHome(legacyStarterHome(1, 1))).toBe(true);
    expect(isLegacyStarterHome(starterHome(1, 1))).toBe(false);
  });

  it('reuses paid material, retains identity/parcel/control states and completes through the normal builder', async () => {
    const { t, site, row } = await fixture();
    await act(t, { type: 'creation_use', creationId: row.creationId, partId: 'front-door', event: 'close' });
    await act(t, { type: 'creation_use', creationId: row.creationId, partId: 'entry-lamp', event: 'toggle' });
    const old = await t.run(ctx => ctx.db.query('creations').withIndex('creationId', q => q.eq('creationId', row.creationId)).first());
    const wallet = await t.run(ctx => balanceOf(ctx, site.agentId));
    const ledger = await t.run(ctx => ctx.db.query('ledger').collect());
    await t.run(async ctx => {
      const person = await ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', site.agentId)).first();
      expect(currentPosition(person!, Date.now())).toEqual({ x: old!.plan.x + 2, y: old!.plan.y + 5 });
      const walkable = await loadWorldWalkability(ctx, { width: 64, height: 48 });
      expect(walkable(old!.plan.x + 2, old!.plan.y + 5)).toBe(true);
    });
    const started: any = await compact(t, old);
    expect(started).toMatchObject({ creationId: old!.creationId, state: 'building', progress: 0, paid: old!.paid, reusedMaterials: true });
    expect(started.plan).toEqual(starterHome(old!.plan.x, old!.plan.y, old!.name));
    expect(started.signals).toMatchObject({ 'door-power': false, 'light-power': true });
    expect(await t.run(ctx => balanceOf(ctx, site.agentId))).toBe(wallet);
    expect(await t.run(ctx => ctx.db.query('ledger').collect())).toEqual(ledger);
    const replay: any = await compact(t, old);
    expect(replay).toMatchObject({ creationId: old!.creationId, replayed: true, revision: started.revision });
    const completed = await finish(t, old!.creationId);
    expect(completed).toMatchObject({ state: 'built', plotId: old!.plotId, ownerAgentId: old!.ownerAgentId, name: old!.name, paid: old!.paid });
    await t.run(async ctx => {
      const plot = await ctx.db.query('plots').withIndex('plotId', q => q.eq('plotId', old!.plotId)).first();
      expect(plot).toMatchObject({ w: 6, h: 6, ownerAgentId: site.agentId });
      expect(await ctx.db.query('creations').collect()).toHaveLength(1);
      const walkable = await loadWorldWalkability(ctx, { width: 64, height: 48 });
      expect(walkable(old!.plan.x + 4, old!.plan.y + 1)).toBe(true);
      expect(walkable(old!.plan.x + 2, old!.plan.y + 3)).toBe(false);
      await assertSupplyInvariant(ctx);
    });
    const awareness: any = await t.mutation(internal.kernel.search, { agentId: site.agentId, tokenHash: 'test-agent', nonce: `compact-aware-${nonce++}` });
    expect(awareness.citizens.find((person: any) => person.agentId === site.agentId).home.entrance).toEqual({ x: old!.plan.x + 2, y: old!.plan.y + 4 });
  });

  it('requires explicit owner authority and a fresh revision while ordinary revisions stay append-only', async () => {
    const { t, row } = await fixture();
    await expect(act(t, { type: 'creation_compact', creationId: row.creationId, expectedRevision: row.revision, requestId: 'agent-compact-refused' })).rejects.toThrow(/explicit authenticated owner/);
    await expect(compact(t, { ...row, revision: row.revision - 1 })).rejects.toThrow(/revision changed/);
    await expect(act(t, { type: 'creation_build', creationId: row.creationId, expectedRevision: row.revision, requestId: 'ordinary-shrink-refused', plan: starterHome(row.plan.x, row.plan.y, row.name) })).rejects.toThrow(/preserve existing parts/);
  });

  it('does not remove a customized home or accept arbitrary dimensions', async () => {
    const { t, row } = await fixture();
    await expect(t.mutation(internal.kernel.ownerCreation, { tokenHash: 'test-owner', action: { type: 'creation_compact', creationId: row.creationId, expectedRevision: row.revision, requestId: 'bad-dimensions-01', width: 3 } })).rejects.toThrow(/custom dimensions/);
    await t.run(ctx => ctx.db.patch(row._id, { plan: { ...row.plan, parts: row.plan.parts.map((part: any, i: number) => i === 1 ? { ...part, material: 'brick' } : part) } }));
    await expect(compact(t, row)).rejects.toThrow(/unchanged legacy starter/);
  });

  it('rejects current occupants and future incoming routes before changing a single part', async () => {
    const { t, row } = await fixture();
    const other = await t.run(async ctx => (await ctx.db.query('citizens').collect()).find(person => person.agentId !== row.ownerAgentId)!);
    await t.run(ctx => ctx.db.patch(other._id, { fx: row.plan.x + 1, fy: row.plan.y + 1, tx: row.plan.x + 1, ty: row.plan.y + 1, route: [], t0: Date.now(), t1: Date.now() }));
    await expect(compact(t, row)).rejects.toThrow(/Clear all citizens/);
    await t.run(ctx => ctx.db.patch(other._id, { fx: 32, fy: 24, tx: row.plan.x + 1, ty: row.plan.y + 1, t0: Date.now() + 1000, t1: Date.now() + 2000,
      route: [{ x: 32, y: 24, at: Date.now() + 1000 }, { x: row.plan.x + 1, y: row.plan.y + 1, at: Date.now() + 2000 }] }));
    await expect(compact(t, row)).rejects.toThrow(/active routes/);
    expect(await t.run(ctx => ctx.db.get(row._id))).toEqual(row);
    expect(await t.run(ctx => ctx.db.query('creationRequests').collect())).toHaveLength(1);
  });
});
