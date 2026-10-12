import { convexTest } from 'convex-test';
import { expect, it, vi } from 'vitest';
import schema from '../convex/schema';
import { internal } from '../convex/_generated/api';
import { owner } from '../testHelpers/modularOwner';

it('continues automatic shelter from an owned empty plot and never duplicates the home', async () => {
  const t = convexTest(schema, import.meta.glob('../convex/**/*.ts'));
  const { agentId } = await owner(t);
  await t.mutation(internal.kernel.aspirationTick, {});
  const citizen = await t.run(ctx => ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', agentId)).first());
  expect(citizen!.aspiration?.key).toBe('shelter');
  const first = await t.mutation(internal.kernel.ambientSettle, { agentId });
  expect(first).toMatchObject({ ok: true, settled: true });
  expect(await t.mutation(internal.kernel.ambientSettle, { agentId })).toMatchObject({ already: true });
  const homes = await t.run(ctx => ctx.db.query('builds').withIndex('ownerAgentId', q => q.eq('ownerAgentId', agentId)).collect());
  expect(homes.filter(b => b.structure === 'home')).toHaveLength(1);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Math.ceil(homes[0].constructionEndsAt!) + 1000);
  try { await t.mutation(internal.act.ambientTick, {}); } finally { clock.mockRestore(); }
  const state = await (await t.fetch('/v1/world/state')).json();
  expect(state.builds.filter((b: any) => b.ownerAgentId === agentId && b.state === 'built')).toHaveLength(1);
  await t.mutation(internal.kernel.aspirationTick, {});
  const settled = await t.run(ctx => ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', agentId)).first());
  expect(settled!.aspiration?.key).not.toBe('shelter');
});

it('prepares one home approval under light consent without starting construction', async () => {
  const t = convexTest(schema, import.meta.glob('../convex/**/*.ts'));
  const { agentId } = await owner(t);
  await t.mutation(internal.kernel.setOwnerAutonomy, { tokenHash: 'test-owner', autonomy: 'light' });
  expect(await t.mutation(internal.kernel.ambientSettle, { agentId })).toMatchObject({ settled: false, state: 'awaiting_owner' });
  await t.mutation(internal.kernel.ambientSettle, { agentId });
  const approvals = await t.query(internal.kernel.ownerApprovals, { tokenHash: 'test-owner' });
  expect(approvals.filter(a => a.kind === 'build')).toHaveLength(1);
  expect(await t.run(ctx => ctx.db.query('builds').withIndex('ownerAgentId', q => q.eq('ownerAgentId', agentId)).collect())).toHaveLength(0);
});

it('never builds a home under none autonomy even with an owned plot', async () => {
  const t = convexTest(schema, import.meta.glob('../convex/**/*.ts'));
  const { agentId } = await owner(t);
  await t.mutation(internal.kernel.setOwnerAutonomy, { tokenHash: 'test-owner', autonomy: 'none' });
  expect(await t.mutation(internal.kernel.ambientSettle, { agentId })).toMatchObject({ settled: false, state: 'plot_ready' });
  expect(await t.run(ctx => ctx.db.query('builds').withIndex('ownerAgentId', q => q.eq('ownerAgentId', agentId)).collect())).toHaveLength(0);
  expect(await t.query(internal.kernel.ownerApprovals, { tokenHash: 'test-owner' })).toHaveLength(0);
});
