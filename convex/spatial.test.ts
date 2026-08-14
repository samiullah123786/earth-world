import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

describe('Tiled Object Layer spatial events', () => {
  it('records authoritative enter and exit transitions without client writes', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agentId = 'agent:sage-0004';
    await t.run(async (ctx) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
      if (!citizen) throw new Error('seed citizen missing');
      await ctx.db.patch(citizen._id, {
        fx: 20, fy: 34, tx: 20, ty: 34, t0: 0, t1: 0, route: undefined, activeZoneIds: [],
      });
    });
    await t.mutation(internal.act.ambientTick, {});
    await t.run(async (ctx) => {
      const events = await ctx.db.query('spatialEvents').withIndex('agent_created', (q) => q.eq('agentId', agentId)).collect();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ zoneId: 'zone:common-field', transition: 'enter' }),
      ]));
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
      if (!citizen) throw new Error('seed citizen missing');
      await ctx.db.patch(citizen._id, { fx: 10, fy: 10, tx: 10, ty: 10, t0: 0, t1: 0, route: undefined });
    });
    await t.mutation(internal.act.ambientTick, {});
    await t.run(async (ctx) => {
      const events = await ctx.db.query('spatialEvents').withIndex('agent_created', (q) => q.eq('agentId', agentId)).collect();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ zoneId: 'zone:common-field', transition: 'exit' }),
      ]));
    });
  }, 30_000);
});
