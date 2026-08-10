import type { WorldRenderLayer } from './layering';

// The founding map predates the three-layer renderer and stores roofs,
// canopies, flowers, and grass tufts together in bgtiles[1]. These verified
// low-profile frames are painted into the ground texture so they can never
// occlude a citizen. Everything else in that legacy plane remains overhead.
export const FOUNDING_GROUND_FLOWER_FRAMES = [278, 279, 280, 934, 935, 936, 937] as const;
export const FOUNDING_GROUND_TUFT_FRAMES = [889, 890, 891] as const;
export const FOUNDING_GROUND_ACCENT_FRAMES = [896, 938] as const;

export const FOUNDING_GROUND_DECORATION_FRAMES = [
  ...FOUNDING_GROUND_FLOWER_FRAMES,
  ...FOUNDING_GROUND_TUFT_FRAMES,
  ...FOUNDING_GROUND_ACCENT_FRAMES,
] as const;

const groundDecorationFrames = new Set<number>(FOUNDING_GROUND_DECORATION_FRAMES);

export function foundingDecorationLayer(frame: number): Extract<WorldRenderLayer, 'ground' | 'overhead'> {
  return groundDecorationFrames.has(frame) ? 'ground' : 'overhead';
}
