import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { owner } from '../testHelpers/modularOwner';
import { parseCreation, starterHome, creationCollision } from '../shared/creation';
import { useCreation } from './creation';

const make = () => convexTest(schema, import.meta.glob('./**/*.ts'));
let sequence = 0;
const act = (t: ReturnType<typeof make>, action: any) => t.mutation(internal.kernel.act, { agentId: 'agent:test-modular', tokenHash: 'test-agent', nonce: `review-nonce-${sequence++}`, action });

describe('creation safety review regressions', () => {
  it('makes an owner pause authoritative even when the agent already paused', async () => {
    const t = make(), site = await owner(t);
    const start: any = await act(t, { type: 'creation_build', plan: starterHome(site.x, site.y), requestId: 'review-pause-01' });
    const agentPause: any = await act(t, { type: 'creation_control', creationId: start.creationId, command: 'pause', expectedRevision: start.revision });
    const ownerPause: any = await t.mutation(internal.kernel.ownerCreation, { tokenHash: 'test-owner', action: { type: 'creation_control', creationId: start.creationId, command: 'pause', expectedRevision: agentPause.revision } });
    await expect(act(t, { type: 'creation_control', creationId: start.creationId, command: 'resume', expectedRevision: ownerPause.revision })).rejects.toThrow(/owner must resume/i);
  });

  it('refuses to close a fractional doorway over any tile it blocks', async () => {
    const t = make(), site = await owner(t);
    const plan = parseCreation({ version: 'earth-creation-v1', kind: 'object', name: 'Fractional Door', x: site.x, y: site.y,
      parts: [
        { id: 'foundation', shape: 'floor', material: 'stone', x: 0, y: 0, z: 0, w: 2, h: .25, d: 2 },
        { id: 'door', shape: 'door', material: 'plank', x: .25, y: .25, z: .25, w: 1, h: 2, d: 1 },
      ], circuits: [{ id: 'power', type: 'switch', inputs: [] }], bindings: [{ partId: 'door', signalId: 'power', behavior: 'door' }],
    });
    expect(creationCollision({ plan, progress: 2, signals: { power: false } })).toContainEqual({ x: site.x, y: site.y });
    await t.run(async ctx => {
      const now = Date.now();
      await ctx.db.insert('creations', { creationId: 'review-door', ownerAgentId: site.agentId, plotId: 'plot-10-10', requestId: 'review-door-01', name: plan.name, kind: plan.kind, plan, revision: 1, state: 'built', progress: 2, signals: { power: true }, switches: { power: true }, paid: 1, consent: 'standing', createdAt: now, updatedAt: now, startsAt: now, lastStepAt: now });
      const citizen = await ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', site.agentId)).first();
      await ctx.db.patch(citizen!._id, { fx: site.x, fy: site.y, tx: site.x, ty: site.y, route: [], t0: now, t1: now });
    });
    await expect(t.run(async ctx => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', q => q.eq('agentId', site.agentId)).first();
      return useCreation(ctx, citizen, { creationId: 'review-door', partId: 'door', event: 'close' });
    })).rejects.toThrow(/occupied/i);
  });
});
