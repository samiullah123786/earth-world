import { describe, expect, it } from 'vitest';
import { componentRenderContract } from './layering';

describe('LPC visual anchoring', () => {
  it('lifts roofs into the facade and bottom-aligns tall props to their footprint', () => {
    expect(componentRenderContract('roof_tile', {
      width: 3, height: 3, solid: true, frame: { height: 128 },
    }).visualOffsetY).toBe(-2);
    expect(componentRenderContract('streetlamp', {
      width: 1, height: 1, solid: true, frame: { height: 64 },
    }).visualOffsetY).toBe(-1);
    expect(componentRenderContract('grass', {
      width: 3, height: 1, solid: false, frame: { height: 32 },
    }).visualOffsetY).toBe(0);
  });
});
