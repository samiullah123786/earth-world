import { describe, expect, it, vi } from 'vitest';
import { AgentBuildService } from './AgentBuildService';

describe('AgentBuildService', () => {
  it('normalizes an allowlisted construction into the signed Kernel action', async () => {
    const submit = vi.fn(async (action) => ({ ok: true, action }));
    const service = new AgentBuildService(submit);
    const result = await service.executeWorldAction({
      action: 'construct_structure',
      structureType: 'community_garden',
      coordinates: { x: 140, y: 85 },
      prefabId: 'community_garden',
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

  it('rejects unknown and mismatched prefab types before signing', async () => {
    const submit = vi.fn();
    const service = new AgentBuildService(submit);
    await expect(service.executeWorldAction({
      action: 'construct_structure', structureType: 'community_garden', coordinates: { x: 1, y: 1 },
      prefabId: 'not_in_manifest',
    })).rejects.toThrow(/unknown LPC prefab/i);
    await expect(service.executeWorldAction({
      action: 'construct_structure', structureType: 'community_garden', coordinates: { x: 1, y: 1 },
      prefabId: 'store_wooden',
    })).rejects.toThrow(/does not match/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits semantic architecture without exposing tile placements', async () => {
    const submit = vi.fn(async (action) => ({ ok: true, action }));
    const service = new AgentBuildService(submit);
    await service.executeWorldAction({
      action: 'construct_structure', structureType: 'bank', coordinates: { x: 30, y: 17 },
      assetId: 'bank_rotunda',
    });
    expect(submit).toHaveBeenCalledWith({
      type: 'construct_structure', structureType: 'bank', coordinates: { x: 30, y: 17 },
      assetId: 'bank_rotunda',
    });
    expect(submit.mock.calls[0][0]).not.toHaveProperty('blueprint');
    expect(submit.mock.calls[0][0]).not.toHaveProperty('placements');
  });
});
