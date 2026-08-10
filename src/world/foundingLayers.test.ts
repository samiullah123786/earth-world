import { describe, expect, it } from 'vitest';
import foundingMap from '../../public/assets/map.json';
import {
  FOUNDING_GROUND_ACCENT_FRAMES,
  FOUNDING_GROUND_DECORATION_FRAMES,
  FOUNDING_GROUND_FLOWER_FRAMES,
  FOUNDING_GROUND_TUFT_FRAMES,
  foundingDecorationLayer,
} from './foundingLayers';

describe('founding-map legacy layer migration', () => {
  it('keeps the two bank flower patches below every citizen', () => {
    expect(foundingMap.bgtiles[1][32][22]).toBe(279);
    expect(foundingMap.bgtiles[1][26][22]).toBe(280);
    expect(foundingDecorationLayer(279)).toBe('ground');
    expect(foundingDecorationLayer(280)).toBe('ground');
  });

  it('classifies every verified procedural low-detail frame as ground-only', () => {
    const proceduralGroundFrames = [
      ...FOUNDING_GROUND_FLOWER_FRAMES,
      ...FOUNDING_GROUND_TUFT_FRAMES,
      ...FOUNDING_GROUND_ACCENT_FRAMES,
    ];
    expect(new Set(proceduralGroundFrames)).toEqual(new Set(FOUNDING_GROUND_DECORATION_FRAMES));
    for (const frame of proceduralGroundFrames) expect(foundingDecorationLayer(frame)).toBe('ground');
  });

  it('leaves founding roofs, tree canopies, and unknown legacy frames overhead', () => {
    for (const frame of [11, 894, 939, 940, 10_000]) {
      expect(foundingDecorationLayer(frame)).toBe('overhead');
    }
  });
});
