import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

let nonce = 0;
const act = (t: ReturnType<typeof convexTest>, who: { agentId: string; token: string }, action: Record<string, unknown>) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: `p-${nonce++}`, action });

async function citizen(t: ReturnType<typeof convexTest>, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 6,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, token: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

/** Give a citizen a plot and a standing structure, the way settling does. */
async function homestead(t: ReturnType<typeof convexTest>, agentId: string, plotId: string, at: { x: number; y: number }) {
  return await t.run(async (ctx) => {
    const plot = (await ctx.db.query('plots').collect()).find((row) => row.plotId === plotId);
    await ctx.db.patch(plot!._id, { ownerAgentId: agentId, claimedAt: Date.now() });
    const now = Date.now();
    const doc = await ctx.db.insert('builds', {
      buildId: 'pending', plotId, ownerAgentId: agentId, structure: 'home', state: 'built',
      createdAt: now, completedAt: now, x: at.x, y: at.y, w: 2, h: 2,
      blueprint: { name: 'First Cottage', kind: 'home', style: 'earthfolk-native-v1' },
    });
    const buildId = `build:${doc}`;
    await ctx.db.patch(doc, { buildId });
    // Stand the citizen beside the structure, not inside it: a building's own
    // collision cells are not somewhere a person can be standing.
    const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === agentId);
    const beside = { x: at.x, y: at.y + 2 };
    await ctx.db.patch(row!._id, { fx: beside.x, fy: beside.y, tx: beside.x, ty: beside.y, t0: now, t1: now });
    return buildId;
  });
}

describe('property ownership and rebuilding', () => {
  it('lets an owner take down their own structure, and clears the map', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const owner = await citizen(t, 'homeowner');
    const buildId = await homestead(t, owner.agentId, 'plot-22-30', { x: 22, y: 30 });

    const before = await t.query(api.world.worldObjects, {});
    expect(before.builds.some((row: any) => row.buildId === buildId)).toBe(true);

    const razed = await act(t, owner, { type: 'demolish_structure', buildId });
    expect(razed.plotId).toBe('plot-22-30');
    expect(razed.endsAt).toBeGreaterThan(razed.startsAt);

    // Gone from the map the moment it is razed...
    const after = await t.query(api.world.worldObjects, {});
    expect(after.builds.some((row: any) => row.buildId === buildId)).toBe(false);
    await t.run(async (ctx) => {
      // ...but the row survives, carrying who built it and who took it down.
      const row = (await ctx.db.query('builds').collect()).find((one) => one.buildId === buildId);
      expect(row?.state).toBe('razed');
      expect(row?.razedBy).toBe(owner.agentId);
      expect(row?.ownerAgentId).toBe(owner.agentId);
      const events = await ctx.db.query('events').collect();
      expect(events.some((event) => event.kind === 'build_razed')).toBe(true);
      // The citizen walks there and swings a hammer rather than editing a table.
      const citizenRow = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === owner.agentId);
      expect(citizenRow?.activeTool).toBe('hammer');
      expect(citizenRow?.activeBuildId).toBe(buildId);
    });
  });

  it("refuses to touch another citizen's home", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const owner = await citizen(t, 'settled');
    const stranger = await citizen(t, 'stranger');
    const buildId = await homestead(t, owner.agentId, 'plot-22-30', { x: 22, y: 30 });
    await expect(act(t, stranger, { type: 'demolish_structure', buildId }))
      .rejects.toThrow(/only demolish structures it built/);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('builds').collect()).find((one) => one.buildId === buildId);
      expect(row?.state).toBe('built');
    });
  });

  it('refuses to demolish on land the builder no longer owns', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const mover = await citizen(t, 'mover');
    const buildId = await homestead(t, mover.agentId, 'plot-22-30', { x: 22, y: 30 });
    // They moved: the structure stays standing, but the ground is not theirs.
    await t.run(async (ctx) => {
      const plot = (await ctx.db.query('plots').collect()).find((row) => row.plotId === 'plot-22-30');
      await ctx.db.patch(plot!._id, { ownerAgentId: 'agent:someone-else' });
    });
    await expect(act(t, mover, { type: 'demolish_structure', buildId }))
      .rejects.toThrow(/only demolish on land it owns/);
  });

  it('never demolishes civic ground, even for its own builder', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const opportunist = await citizen(t, 'opportunist');
    // Hand the Bank's own structure to a citizen: ownership alone must not be
    // enough, because the ground beneath it is civic.
    const bankBuildId = await t.run(async (ctx) => {
      const build = (await ctx.db.query('builds').collect()).find((row) => row.buildId === 'build:earth-bank');
      await ctx.db.patch(build!._id, { ownerAgentId: opportunist.agentId });
      const plot = (await ctx.db.query('plots').collect()).find((row) => row.plotId === 'plot:earth-bank');
      await ctx.db.patch(plot!._id, { ownerAgentId: opportunist.agentId });
      return build!.buildId;
    });
    await expect(act(t, opportunist, { type: 'demolish_structure', buildId: bankBuildId }))
      .rejects.toThrow(/civic ground is never demolished/);
  });

  it('is idempotent: taking down what is already down changes nothing', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const owner = await citizen(t, 'twice');
    const buildId = await homestead(t, owner.agentId, 'plot-22-30', { x: 22, y: 30 });
    await act(t, owner, { type: 'demolish_structure', buildId });
    const again = await act(t, owner, { type: 'demolish_structure', buildId });
    expect(again.alreadyRazed).toBe(true);
    await t.run(async (ctx) => {
      const razedEvents = (await ctx.db.query('events').collect()).filter((event) => event.kind === 'build_razed');
      expect(razedEvents).toHaveLength(1);
    });
  });

  it('lets the owner rebuild on the cleared ground', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const owner = await citizen(t, 'rebuilder');
    const buildId = await homestead(t, owner.agentId, 'plot-22-30', { x: 22, y: 30 });

    // A standing home blocks a second one, as it always has.
    await expect(act(t, owner, { type: 'build', structure: 'home' }))
      .rejects.toThrow(/already stands/);

    await act(t, owner, { type: 'demolish_structure', buildId });
    // Once razed it blocks nothing: this is the whole point of demolition, and
    // it failed live because three separate queries still counted razed rows.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('citizens').collect()).find((one) => one.agentId === owner.agentId);
      await ctx.db.patch(row!._id, { activeBuildId: undefined, buildingUntil: 0 });
    });
    const rebuilt = await act(t, owner, { type: 'build', structure: 'home' });
    expect(rebuilt.ok).toBe(true);
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query('builds').collect()).filter((one) => one.plotId === 'plot-22-30');
      expect(rows.filter((one) => one.state === 'razed')).toHaveLength(1);
      expect(rows.filter((one) => one.state !== 'razed').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('frees the ground it stood on: a razed structure blocks no path and no rebuild', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const owner = await citizen(t, 'collision');
    const buildId = await homestead(t, owner.agentId, 'plot-22-30', { x: 22, y: 30 });
    // Give the structure real collision cells, the way a prefab does.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('builds').collect()).find((one) => one.buildId === buildId);
      await ctx.db.patch(row!._id, {
        blueprint: { ...row!.blueprint, collision: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
      });
    });

    const blockedWhileStanding = await t.run(async (ctx) => {
      const { loadWorldWalkability } = await import('./worldGrid');
      const world = (await ctx.db.query('worldState').collect())[0];
      const walkable = await loadWorldWalkability(ctx, { width: world.width, height: world.height });
      return !walkable(22, 30);
    });
    expect(blockedWhileStanding).toBe(true);

    await act(t, owner, { type: 'demolish_structure', buildId });

    // Once razed the ground is free again. Without this, a demolished building
    // blocks its own replacement forever - the collision sweep predates razing
    // and only skipped 'planned'.
    const stillBlocked = await t.run(async (ctx) => {
      const { loadWorldWalkability } = await import('./worldGrid');
      const world = (await ctx.db.query('worldState').collect())[0];
      const walkable = await loadWorldWalkability(ctx, { width: world.width, height: world.height });
      return !walkable(22, 30);
    });
    expect(stillBlocked).toBe(false);
  });
});
