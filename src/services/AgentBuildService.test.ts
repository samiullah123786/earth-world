import { describe, expect, it, vi } from 'vitest';
import { AgentBuildService, LPC_BUILD_TEMPLATES } from './AgentBuildService';

describe('AgentBuildService', () => {
  it('normalizes an allowlisted construction into the signed Kernel action', async () => {
    const submit = vi.fn(async (action) => ({ ok: true, action }));
    const service = new AgentBuildService(submit);
    const result = await service.executeWorldAction({
      action: 'construct_structure',
      structureType: 'community_garden',
      coordinates: { x: 140, y: 85 },
      blueprint: LPC_BUILD_TEMPLATES.community_garden,
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'construct_structure',
      structureType: 'community_garden',
      coordinates: { x: 140, y: 85 },
      prefabId: 'community_garden',
    }));
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects ad-hoc placement lists and mismatched prefab types before signing', async () => {
    const submit = vi.fn();
    const service = new AgentBuildService(submit);
    await expect(service.executeWorldAction({
      action: 'construct_structure', structureType: 'community_garden', coordinates: { x: 1, y: 1 },
      blueprint: [{ tile: 'not_in_manifest', xOffset: 0, yOffset: 0 }],
    })).rejects.toThrow(/registered atomic LPC prefab/i);
    await expect(service.executeWorldAction({
      action: 'construct_structure', structureType: 'community_garden', coordinates: { x: 1, y: 1 },
      prefabId: 'store_wooden',
    })).rejects.toThrow(/does not match/i);
    expect(submit).not.toHaveBeenCalled();
  });
});
