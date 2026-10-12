import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { owner } from '../testHelpers/modularOwner';
import { starterHome } from '../shared/creation';
import { tileFactsFor } from './handbuild';
import { balanceOf } from './economy';

const make = () => convexTest(schema, import.meta.glob('./**/*.ts'));
let seq = 0;

describe('loose blocks respect creation reservations', () => {
  for (const state of ['building', 'paused', 'built'] as const) {
    it(`protects the full ${state} envelope and entry before any wall is present`, async () => {
      const t = make(), site = await owner(t);
      const plan = starterHome(site.x, site.y);
      await t.run(async ctx => {
        const now = Date.now();
        await ctx.db.insert('creations', { creationId: `creation:reservation-${state}`, requestId: 'reserved-home',
          ownerAgentId: site.agentId, plotId: 'plot-10-10', name: plan.name, kind: 'home', revision: 1,
          state, progress: state === 'built' ? plan.parts.length : 0, plan, signals: { 'door-power': true }, switches: {},
          paid: 100, consent: 'standing', createdAt: now, updatedAt: now, lastStepAt: now, startsAt: now });
        const citizen = await ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', site.agentId)).first();
        await ctx.db.patch(citizen!._id, { fx: site.x + 2, fy: site.y + 5, tx: site.x + 2, ty: site.y + 5,
          t0: now, t1: now, route: [] });
        const bounds = { width: 64, height: 48 };
        expect((await tileFactsFor(ctx, site.agentId, site.x + 1, site.y + 1, bounds)).facts.structure).toBe(true);
        expect((await tileFactsFor(ctx, site.agentId, site.x + 2, site.y + 4, bounds)).facts.reserved).toBe(true);
        expect((await tileFactsFor(ctx, site.agentId, site.x + 2, site.y + 5, bounds)).facts.reserved).toBe(true);
        expect((await tileFactsFor(ctx, site.agentId, site.x + 4, site.y + 5, bounds)).facts.structure).toBe(false);
        expect((await tileFactsFor(ctx, site.agentId, site.x + 4, site.y + 5, bounds)).facts.reserved).toBe(false);
      });
      const before = await t.run(ctx => balanceOf(ctx, site.agentId));
      for (const tile of [{ x: site.x + 1, y: site.y + 1 }, { x: site.x + 2, y: site.y + 5 }]) {
        await expect(t.mutation(internal.kernel.act, { agentId: site.agentId, tokenHash: 'test-agent',
          nonce: `reservation-${seq++}`, action: { type: 'place_block', ...tile, level: 1, kind: 'plank' } })).rejects.toThrow(/building already stands|doorway has to stay open/);
      }
      expect(await t.run(ctx => ctx.db.query('placedBlocks').collect())).toHaveLength(0);
      expect(await t.run(ctx => balanceOf(ctx, site.agentId))).toBe(before);
    });
  }
});
