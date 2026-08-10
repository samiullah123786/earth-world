import { describe, expect, it } from 'vitest';
import { authorityAvatarKey, fallbackAvatarKey, resolveAvatarKey } from './avatar_identity';
import { avatarSpecFromSeedHex } from '../shared/avatar-identity';

describe('citizen avatar identity', () => {
  const citizen = {
    agentId: 'agent:pixel-1234', name: 'Pixel', gender: 'female', family: 'design', primaryCategory: 'ui',
  };

  it('uses the signed evidence-selected catalog entry', () => {
    const avatarSpec = {
      version: 1, catalogKey: 'citizen_female_creative_07', archetype: 'creative', variant: 7,
      hairStyle: 'long', hairColor: 'rose', headShape: 'female_small', outfitColor: 'blue',
      eyeColor: 'green', selectionBasis: 'verified-capabilities',
    };
    expect(resolveAvatarKey({ ...citizen, avatarSpec }, new Set([avatarSpec.catalogKey])))
      .toBe(avatarSpec.catalogKey);
  });

  it('gives server roles authority uniforms and ignores citizen catalog claims', () => {
    const mayor = { ...citizen, serviceRole: 'Mayor of Earth' };
    expect(authorityAvatarKey(mayor)).toBe('mayor_sam');
    expect(resolveAvatarKey(mayor, new Set(['mayor_sam', fallbackAvatarKey(mayor)]))).toBe('mayor_sam');
  });

  it('provides a stable capability-aware fallback for existing citizens', () => {
    expect(fallbackAvatarKey(citizen)).toMatch(/^citizen_female_creative_\d{2}$/);
    expect(fallbackAvatarKey(citizen)).toBe(fallbackAvatarKey(citizen));
  });

  it('matches the cross-language signed identity vector', () => {
    expect(avatarSpecFromSeedHex(
      'a0ea12fc155ed30d6e1cfef390130288fd3d56d32f5c7dccde14b480c3ace608', 'female', 'ui',
    )).toEqual({
      version: 1, catalogKey: 'citizen_female_creative_10', archetype: 'creative', variant: 10,
      hairStyle: 'pixie', hairColor: 'gold', headShape: 'female_small', outfitColor: 'forest',
      eyeColor: 'violet', selectionBasis: 'verified-capabilities',
    });
  });
});
