import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { owner } from '../testHelpers/modularOwner';
import { starterHome } from '../shared/creation';
import { balanceOf, assertSupplyInvariant } from './economy';
import { loadWorldWalkability } from './worldGrid';

const make = () => convexTest(schema, import.meta.glob('./**/*.ts'));
let seq = 0;
const act = (t: ReturnType<typeof make>, action: any) => t.mutation(internal.kernel.act, { agentId: 'agent:test-modular', tokenHash: 'test-agent', nonce: `creation-nonce-${seq++}`, action });
async function fixture() {
  const t = make(), site = await owner(t);
  await t.run(async ctx => {
    const rows = await ctx.db.query('citizens').collect();
    for (const c of rows) await ctx.db.patch(c._id, { fx: 32, fy: 24, tx: 32, ty: 24, route: [], t0: Date.now(), t1: Date.now() });
  });
  return { t, site, plan: starterHome(site.x, site.y) };
}
async function finish(t: ReturnType<typeof make>, creationId: string) {
  const row = await t.run(ctx => ctx.db.query('creations').withIndex('creationId', q => q.eq('creationId', creationId)).first());
  let now = Math.ceil(row!.lastStepAt);
  for (let i = 0; i < 10; i++) {
    now += 8000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try { await t.mutation(internal.kernel.creationTick, {}); } finally { clock.mockRestore(); }
    const item: any = await act(t, { type: 'creation_inspect', creationId });
    if (item.creation.state === 'built') return item.creation;
  }
  throw new Error('Construction did not complete');
}

describe('autonomous creation through actual Kernel actions', () => {
  it('claims and builds an assembled home under standing consent and reports it in profiles', async () => {
    const { t } = await fixture();
    await t.run(async ctx => {
      const plot = await ctx.db.query('plots').withIndex('ownerAgentId', q => q.eq('ownerAgentId', 'agent:test-modular')).first();
      await ctx.db.patch(plot!._id, { ownerAgentId: undefined });
    });
    const start: any = await act(t, { type: 'creation_home', requestId: 'active-settlement-01' });
    expect(start.state).toBe('building');
    expect(await t.run(ctx => ctx.db.query('builds').withIndex('ownerAgentId', q => q.eq('ownerAgentId', 'agent:test-modular')).collect())).toHaveLength(0);
    await finish(t, start.creationId);
    const profile: any = await t.query(api.world.citizenProfile, { agentId: 'agent:test-modular' });
    expect(profile.creations[0]).toMatchObject({ creationId: start.creationId, state: 'built', kind: 'home' });
    const ownerProfile: any = await t.query(internal.kernel.ownerSession, { tokenHash: 'test-owner' });
    expect(ownerProfile.creations[0].creationId).toBe(start.creationId);
  });
  it('persists assembled settlement and continues through owner land and build decisions', async () => {
    const { t } = await fixture();
    await t.run(async ctx => {
      const plot = await ctx.db.query('plots').withIndex('ownerAgentId', q => q.eq('ownerAgentId', 'agent:test-modular')).first();
      await ctx.db.patch(plot!._id, { ownerAgentId: undefined });
    });
    await t.mutation(internal.kernel.setOwnerAutonomy, { tokenHash: 'test-owner', autonomy: 'light' });
    const pending: any = await act(t, { type: 'creation_home', requestId: 'settlement-home-01', name: 'Courtyard Home' });
    expect(pending.state).toBe('awaiting_owner');
    expect(await t.run(ctx => ctx.db.query('creations').collect())).toHaveLength(0);
    await t.mutation(internal.kernel.decideApproval, { tokenHash: 'test-owner', approvalId: pending.approvalId, decision: 'approve' });
    const build: any = await act(t, { type: 'creation_home', requestId: 'settlement-home-01', name: 'Courtyard Home' });
    expect(build.awaitingOwner).toBe(true);
    await t.mutation(internal.kernel.decideApproval, { tokenHash: 'test-owner', approvalId: build.approvalId, decision: 'approve' });
    const result: any = await act(t, { type: 'creation_inspect' });
    expect(result.creations).toHaveLength(1);
    expect(result.creations[0].kind).toBe('home');
    const repeated: any = await act(t, { type: 'creation_home', requestId: 'settlement-home-01', name: 'Courtyard Home' });
    expect(repeated.creationId).toBe(result.creations[0].creationId);
  });
  it('previews, charges once, completes a staged home and publishes identical door/light state', async () => {
    const { t, site, plan } = await fixture();
    const preview: any = await act(t, { type: 'creation_preview', plan });
    expect(preview).toMatchObject({ valid: true, issues: [] });
    const before = await t.run(ctx => balanceOf(ctx, site.agentId));
    const start: any = await act(t, { type: 'creation_build', plan, requestId: 'home-request-01' });
    expect(start.state).toBe('building'); expect(start.progress).toBe(0);
    const retry: any = await act(t, { type: 'creation_build', plan, requestId: 'home-request-01' });
    expect(retry.creationId).toBe(start.creationId); expect(retry.replayed).toBe(true);
    expect(await t.run(ctx => balanceOf(ctx, site.agentId))).toBe(before - preview.cost);
    const creation = await finish(t, start.creationId);
    expect(creation.progress).toBe(plan.parts.length);
    expect(creation.signals['door-power']).toBe(true);
    await expect(act(t, { type: 'creation_use', creationId: start.creationId, partId: 'front-door', event: 'close', expectedRevision: start.revision })).rejects.toThrow(/revision changed/);
    const doorway = { x: plan.x + 2, y: plan.y + 4 };
    await t.run(async ctx => {
      const c = await ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', site.agentId)).first();
      await ctx.db.patch(c!._id, { fx: doorway.x, fy: doorway.y + 1, tx: doorway.x, ty: doorway.y + 1, route: [], t0: Date.now(), t1: Date.now() });
    });
    await act(t, { type: 'creation_use', creationId: start.creationId, partId: 'front-door', event: 'close' });
    expect(await t.run(async ctx => (await loadWorldWalkability(ctx, { width: 64, height: 48 }))(doorway.x, doorway.y))).toBe(false);
    await act(t, { type: 'creation_use', creationId: start.creationId, partId: 'entry-lamp', event: 'toggle' });
    const [first, second] = await Promise.all([t.fetch('/v1/world/state').then(r => r.json()), t.fetch('/v1/world/state').then(r => r.json())]);
    expect(first.creations).toEqual(second.creations);
    expect(first.creations[0].signals).toMatchObject({ 'door-power': false, 'light-power': true });
    expect(JSON.stringify(first.creations)).not.toContain('Private Owner');
    await t.run(ctx => assertSupplyInvariant(ctx));
    await expect(act(t, { type: 'creation_build', plan, requestId: 'second-home-02' })).rejects.toThrow(/One home/);
  });
  it('prepares one light-consent approval and revalidates before construction', async () => {
    const { t, plan } = await fixture();
    await t.mutation(internal.kernel.setOwnerAutonomy, { tokenHash: 'test-owner', autonomy: 'light' });
    const response: any = await act(t, { type: 'creation_build', plan, requestId: 'light-request-01' });
    expect(response).toMatchObject({ awaitingOwner: true, state: 'awaiting_owner' });
    const retry: any = await act(t, { type: 'creation_build', plan, requestId: 'light-request-01' });
    expect(retry.approvalId).toBe(response.approvalId);
    expect(await t.run(ctx => ctx.db.query('creations').collect())).toHaveLength(0);
    await t.mutation(internal.kernel.decideApproval, { tokenHash: 'test-owner', approvalId: response.approvalId, decision: 'approve' });
    expect(await t.run(ctx => ctx.db.query('creations').collect())).toHaveLength(1);
  });
  it('honors owner pause, stale revisions, lost standing consent and proximity', async () => {
    const { t, plan } = await fixture();
    const start: any = await act(t, { type: 'creation_build', plan, requestId: 'pause-request-01' });
    const paused: any = await t.mutation(internal.kernel.ownerCreation, { tokenHash: 'test-owner', action: { type: 'creation_control', creationId: start.creationId, command: 'pause', expectedRevision: start.revision } });
    await expect(act(t, { type: 'creation_control', creationId: start.creationId, command: 'resume', expectedRevision: paused.revision })).rejects.toThrow(/owner must resume/);
    await expect(t.mutation(internal.kernel.ownerCreation, { tokenHash: 'test-owner', action: { type: 'creation_control', creationId: start.creationId, command: 'resume', expectedRevision: start.revision } })).rejects.toThrow(/revision changed/);
    const resumed: any = await t.mutation(internal.kernel.ownerCreation, { tokenHash: 'test-owner', action: { type: 'creation_control', creationId: start.creationId, command: 'resume', expectedRevision: paused.revision } });
    expect(resumed.state).toBe('building');
    await finish(t, start.creationId);
    await t.run(async ctx => { const c = await ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', 'agent:test-modular')).first(); await ctx.db.patch(c!._id, { fx: 32, fy: 24, tx: 32, ty: 24, route: [] }); });
    await expect(act(t, { type: 'creation_use', creationId: start.creationId, partId: 'front-door', event: 'close' })).rejects.toThrow(/Walk within/);
  });
});
