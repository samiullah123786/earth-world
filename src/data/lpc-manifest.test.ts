import { describe, expect, it } from 'vitest';
import manifest from './lpc_manifest.json';

describe('LPC source-frame integrity', () => {
  it('keeps every component crop completely inside its canonical source sheet', () => {
    for (const [componentId, component] of Object.entries(manifest.components)) {
      const source = manifest.assets[component.sourceAssetId as keyof typeof manifest.assets];
      expect(source, `${componentId} source`).toBeDefined();
      expect(component.frame.x).toBeGreaterThanOrEqual(0);
      expect(component.frame.y).toBeGreaterThanOrEqual(0);
      expect(component.frame.x + component.frame.width, `${componentId} width`).toBeLessThanOrEqual(source.pixelSize.width);
      expect(component.frame.y + component.frame.height, `${componentId} height`).toBeLessThanOrEqual(source.pixelSize.height);
      expect(component.frame.x % manifest.gridSize).toBe(0);
      expect(component.frame.y % manifest.gridSize).toBe(0);
      expect(component.frame.width % manifest.gridSize).toBe(0);
      expect(component.frame.height % manifest.gridSize).toBe(0);
    }
  });

  it('uses complete house-sheet pieces instead of arbitrary or clipped rectangles', () => {
    expect(manifest.components.wood_wall.frame).toEqual({ x: 0, y: 0, width: 96, height: 96 });
    expect(manifest.components.roof_tile.frame).toEqual({ x: 0, y: 96, width: 96, height: 96 });
    expect(manifest.components.wood_door.frame).toEqual({ x: 160, y: 0, width: 32, height: 96 });
    expect(manifest.components.window.frame).toEqual({ x: 224, y: 0, width: 32, height: 64 });
  });
});
