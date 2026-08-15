import { describe, expect, it } from 'vitest';
import { EARTHFORGE_ASSETS } from '../../shared/earthforge';
import { citizenDepth, isCitizenInFront } from './layering';
import { tileCenter } from './grid';
import { earthForgeRenderPlan } from './earthforge-render';

describe('EarthForge layered rendering contract', () => {
  it('places every approved pass at one shared integer anchor without changing its aspect ratio', () => {
    const plan = earthForgeRenderPlan('home_courtyard', EARTHFORGE_ASSETS.home_courtyard, 10, 20);
    expect(plan.map((pass) => pass.pass)).toEqual(['ground', 'midground', 'overhead', 'emissive']);
    expect(plan.map((pass) => pass.layer)).toEqual(['ground', 'midground', 'overhead', 'overhead']);
    expect(plan.every((pass) => Number.isInteger(pass.x) && Number.isInteger(pass.y))).toBe(true);
    expect(new Set(plan.map((pass) => `${pass.x},${pass.y},${pass.displaySize}`)).size).toBe(1);
  });

  it('keeps entry-row citizens in front while north-side citizens pass behind the facade', () => {
    const asset = EARTHFORGE_ASSETS.home_courtyard;
    const facade = earthForgeRenderPlan('home_courtyard', asset, 10, 20)
      .find((pass) => pass.pass === 'midground')!;
    expect(isCitizenInFront(citizenDepth(tileCenter(20 + asset.entry[1])), facade.depth)).toBe(true);
    expect(isCitizenInFront(citizenDepth(tileCenter(20 + asset.entry[1] - 1)), facade.depth)).toBe(false);
  });

  it('never lets low ground detail enter a Y-sorted or overhead pass', () => {
    for (const [assetId, asset] of Object.entries(EARTHFORGE_ASSETS)) {
      const plan = earthForgeRenderPlan(assetId, asset, 0, 3);
      expect(plan.find((pass) => pass.pass === 'ground')?.layer).toBe('ground');
      expect(plan.find((pass) => pass.pass === 'midground')?.layer).toBe('midground');
      expect(plan.find((pass) => pass.pass === 'overhead')?.layer).toBe('overhead');
    }
  });

  it('fits a compact migrated home to its whole three-tile site without visual drift', () => {
    const plan = earthForgeRenderPlan('home_timber', EARTHFORGE_ASSETS.home_timber, 18, 30, 3, 3, 3);
    expect(plan[0]).toMatchObject({ x: 624, y: 1056, displaySize: 96 });
    expect(new Set(plan.map((pass) => `${pass.x}:${pass.y}:${pass.displaySize}`))).toHaveLength(1);
  });
});
