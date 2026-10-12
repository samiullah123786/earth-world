import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { owner } from '../testHelpers/modularOwner';
import { planExpansion } from './planning';
import { creationExtent } from '../shared/creation';
import { loadWorldWalkability } from './worldGrid';
import { findRoute } from './pathfinding';

const make = () => convexTest(schema, import.meta.glob('./**/*.ts'));
let nonce = 0;
const act = (t: ReturnType<typeof make>, action: any) => t.mutation(internal.kernel.act, {
  agentId: 'agent:test-modular', tokenHash: 'test-agent', nonce: `land-recovery-${nonce++}`, action,
});
afterEach(() => vi.useRealTimers());

describe('land growth survives bounded transactions and settlement waits honestly', () => {
  it('refuses a larger parcel when live obstacles block its new land beyond the founding map', async () => {
    vi.useFakeTimers();
    const t = make();
    await owner(t);
    await t.run(async ctx => {
      const world = await ctx.db.query('worldState').first();
      await ctx.db.patch(world!._id, { width: 96, height: 64 });
      const plot = await ctx.db.query('plots').withIndex('ownerAgentId', q => q.eq('ownerAgentId', 'agent:test-modular')).first();
      await ctx.db.patch(plot!._id, { x: 68, y: 18, w: 6, h: 6 });
      // A 7x6 expansion must add either the west or east column. Neither
      // column may be allotted through a standing obstacle just because the
      // coordinate is beyond the legacy map export.
      for (const x of [67, 74]) for (let y = 18; y < 24; y++) await ctx.db.insert('placedBlocks', {
        x, y, level: 0, kind: 'stone', plotId: plot!.plotId, ownerAgentId: 'agent:test-modular', paid: 1, placedAt: Date.now(),
      });
    });
    await expect(act(t, { type: 'expand_plot', width: 7, height: 6 })).rejects.toThrow(/no safe non-overlapping expansion/);
    const plot = await t.run(ctx => ctx.db.query('plots').withIndex('ownerAgentId', q => q.eq('ownerAgentId', 'agent:test-modular')).first());
    expect(plot).toMatchObject({ x: 68, y: 18, w: 6, h: 6 });
  });

  it('keeps reserve expansion opt-in and plans rather than generating inside a mutation', async () => {
    vi.useFakeTimers();
    const t = make();
    await t.mutation(internal.seed.init, {});
    const idle: any = await t.mutation(internal.kernel.expandWorldDeferred, { reason: 'capacity only' });
    expect(idle.scheduled).toBe(false);
    const planned: any = await t.mutation(internal.kernel.expandWorldDeferred, { reason: 'home reserve', maintainHabitatReserve: true });
    expect(planned.scheduled).toBe(true);
    const state: any = await t.query(api.world.worldObjects, {});
    expect(state.state).toMatchObject({ width: 64, height: 48, generation: 0 });
    expect(state.chunks).toHaveLength(0);
    expect(await t.query(internal.kernel.expansionWork, {})).toMatchObject({ pending: true, generation: 1 });
  });

  it('reschedules an interrupted persisted ring without replacing its generation', async () => {
    vi.useFakeTimers();
    const t = make();
    await t.mutation(internal.seed.init, {});
    await t.run(ctx => planExpansion(ctx, 'interrupted initial survey', true));
    const scheduledBefore = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
    const resumed: any = await t.mutation(internal.kernel.runWorldExpansion, { reason: 'retry survey' });
    expect(resumed.alreadyRunning).toBe(true);
    const scheduledAfter = await t.run(ctx => ctx.db.system.query('_scheduled_functions').collect());
    expect(scheduledAfter.length).toBe(scheduledBefore.length + 1);
    await t.action(internal.expansion.layRing, {});
    const state: any = await t.query(api.world.worldObjects, {});
    expect(state.state).toMatchObject({ generation: 1, width: 80, height: 64 });
    expect(await t.query(internal.kernel.expansionWork, {})).toMatchObject({ pending: false });
  }, 60000);

  it('persists an assembled home request while land is missing, then settles and discovers its real entry', async () => {
    vi.useFakeTimers();
    const t = make();
    await owner(t);
    await t.run(async ctx => {
      const plots = await ctx.db.query('plots').collect();
      for (const plot of plots) if (plot.ownerAgentId === 'agent:test-modular') {
        await ctx.db.patch(plot._id, { ownerAgentId: undefined, w: 3, h: 3 });
      }
    });
    const request = { type: 'creation_home', requestId: 'await-new-land-home', name: 'Survey Courtyard Home' };
    const waiting: any = await act(t, request);
    expect(waiting).toMatchObject({ ok: true, state: 'awaiting_land', expansion: { scheduled: true, generation: 1 } });
    expect(await t.run(ctx => ctx.db.query('creations').collect())).toHaveLength(0);
    const agent = await t.run(ctx => ctx.db.query('agents').withIndex('agentId', q => q.eq('agentId', 'agent:test-modular')).first());
    expect(agent).toMatchObject({ homeStyle: 'assembly', homeRequestId: request.requestId, homeName: request.name });
    const repeat: any = await act(t, request);
    expect(repeat.state).toBe('awaiting_land');
    await t.action(internal.expansion.layRing, {});
    // Drive the exact bounded followup scheduled by expansionCommit. No new
    // owner or agent build request is needed to preserve the assembly intent.
    const followup: any = await t.mutation(internal.kernel.ambientSettle, { agentId: 'agent:test-modular' });
    expect(followup).toMatchObject({ ok: true, state: 'building' });
    const started: any = await act(t, request);
    expect(started.state).toBe('building');
    const completedAt = await t.run(async ctx => {
      const row = await ctx.db.query('creations').withIndex('creationId', q => q.eq('creationId', started.creationId)).first();
      return row!.startsAt + 30000;
    });
    vi.setSystemTime(completedAt);
    for (let i = 0; i < 5; i++) { vi.setSystemTime(completedAt + (i + 1) * 8000); await t.mutation(internal.kernel.creationTick, {}); }
    const inspection: any = await act(t, { type: 'creation_inspect', creationId: started.creationId });
    expect(inspection.creation.state).toBe('built');
    const awareness: any = await t.mutation(internal.kernel.search, { agentId: 'agent:test-modular', tokenHash: 'test-agent', nonce: `aware-${nonce++}` });
    const self = awareness.citizens.find((c: any) => c.agentId === 'agent:test-modular');
    const extent = creationExtent(inspection.creation.plan);
    const entry = { x: inspection.creation.plan.x + Math.floor(extent.w / 2), y: inspection.creation.plan.y + extent.h };
    expect(self.home).toMatchObject({ creationId: started.creationId, state: 'built', entrance: entry });
    expect(self.home.components).toEqual(expect.arrayContaining([{ partId: 'front-door', behavior: 'door', active: true }, { partId: 'entry-lamp', behavior: 'light', active: false }]));
    await t.run(async ctx => {
      const world = await ctx.db.query('worldState').withIndex('key', q => q.eq('key', 'earth')).first();
      const walkable = await loadWorldWalkability(ctx, world!);
      expect(walkable(entry.x, entry.y)).toBe(true);
      const path = findRoute(32, 24, entry.x, entry.y, world!, walkable);
      expect(path?.[path.length - 1]).toEqual(entry);
    });
    const same: any = await act(t, request);
    expect(same.creationId).toBe(started.creationId);
    expect(await t.run(ctx => ctx.db.query('creations').collect())).toHaveLength(1);
  }, 60000);
});
