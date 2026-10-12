import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { owner } from '../testHelpers/modularOwner';
import { modularAsset, MODULAR_MODELS } from '../shared/modular';
const modules = import.meta.glob('./**/*.ts');


describe('modular construction', () => {
  it('maps every presentation choice to a real canonical asset and local model', () => {
    for (const id of Object.keys(MODULAR_MODELS)) expect(modularAsset(id).model.url).toMatch(/^\/models\//);
    expect(() => modularAsset('https://arbitrary/model.glb')).toThrow();
  });
  it('records owner review, preserves chosen appearance after approval, and blocks duplicate permits and homes', async () => {
    const t = convexTest(schema, modules); const { agentId, x, y } = await owner(t);
    const proposal = await t.mutation(internal.kernel.ownerConstruction, { tokenHash: 'test-owner', modelId: 'home-a', x, y });
    expect(proposal.awaitingOwner).toBe(true);
    await expect(t.mutation(internal.kernel.ownerConstruction, { tokenHash: 'test-owner', modelId: 'home-a', x, y })).rejects.toThrow(/pending civic review/);
    await t.mutation(internal.kernel.decideApproval, { tokenHash: 'test-owner', approvalId: proposal.approvalId, decision: 'approve' });
    const builds = await t.run(ctx => ctx.db.query('builds').withIndex('ownerAgentId', q => q.eq('ownerAgentId', agentId)).collect());
    expect(builds[0]).toMatchObject({ x, y, w: 5, h: 5, state: 'building', blueprint: { modelId: 'home-a', earthForge: { assetId: 'home_courtyard' } } });
    await expect(t.mutation(internal.kernel.ownerConstruction, { tokenHash: 'test-owner', modelId: 'home-b', x, y })).rejects.toThrow(/home already/);
    const time = vi.spyOn(Date, 'now').mockReturnValue(Math.ceil(builds[0].constructionEndsAt!) + 1000);
    try { await t.mutation(internal.act.ambientTick, {}); } finally { time.mockRestore(); }
    const publicWorld = await (await t.fetch('/v1/world/state')).json();
    expect(publicWorld.builds.find((build: any) => build.ownerAgentId === agentId)).toMatchObject({
      state: 'built', plotId: 'plot-10-10', visual: { modelId: 'home-a', assetId: 'home_courtyard' },
    });
    expect(JSON.stringify(publicWorld)).not.toContain('Private Owner');
  });
  it('rejects wrong sessions, unsafe geometry and forged signed-agent model/asset combinations', async () => {
    const t = convexTest(schema, modules); const { agentId, x, y } = await owner(t);
    await expect(t.mutation(internal.kernel.ownerConstruction, { tokenHash: 'test-agent', modelId: 'home-a', x, y })).rejects.toThrow(/session/);
    await expect(t.mutation(internal.kernel.ownerConstruction, { tokenHash: 'test-owner', modelId: 'home-a', x: x + 5, y: y + 5 })).rejects.toThrow(/plot|land/);
    await expect(t.mutation(internal.kernel.act, { agentId, tokenHash: 'test-agent', nonce: 'forged-model', action: { type: 'construct_structure', structureType: 'home', assetId: 'home_courtyard', modelId: 'civic-a', coordinates: { x, y } } })).rejects.toThrow(/model must match/);
  });
});
