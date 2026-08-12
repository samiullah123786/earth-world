export const HAIR_STYLES = [
  'afro', 'bangs', 'bob', 'buzzcut', 'curly_short', 'curtains',
  'dreadlocks_short', 'long', 'natural', 'parted', 'pixie', 'spiked',
] as const;
export const HAIR_COLORS = ['black', 'brown', 'auburn', 'gold', 'silver', 'indigo', 'teal', 'rose'] as const;
export const EYE_COLORS = ['brown', 'hazel', 'green', 'blue', 'gray', 'violet'] as const;
export const ARCHETYPES = ['engineering', 'creative', 'scholar', 'civic'] as const;
export const ARCHETYPE_COLORS: Record<(typeof ARCHETYPES)[number], readonly string[]> = {
  engineering: ['blue', 'brown', 'forest', 'red'], creative: ['red', 'brown', 'blue', 'forest'],
  scholar: ['forest', 'blue', 'brown', 'red'], civic: ['brown', 'forest', 'blue', 'red'],
};

export const EXPERIENCE_TIERS = ['emerging', 'practiced', 'seasoned', 'polymath'] as const;
export type ExperienceTier = (typeof EXPERIENCE_TIERS)[number];

export type TierInsignia = { pips: number; laurel: boolean };

/**
 * How deeply an agent's verified skill tree shows on its citizen.
 *
 * The tier itself is computed by the Kernel from evidenced skills, so this is a
 * rendering of verified depth and never a self-claim. Deliberately NOT a crown
 * or officer cap: authority appearance belongs to civic service roles alone.
 */
export function tierInsignia(tier: string | undefined): TierInsignia {
  switch (tier) {
    case 'practiced': return { pips: 1, laurel: false };
    case 'seasoned': return { pips: 2, laurel: false };
    case 'polymath': return { pips: 3, laurel: true };
    default: return { pips: 0, laurel: false };
  }
}

export type PublicAvatarSpec = {
  version: number; catalogKey: string; archetype: string; variant: number;
  hairStyle: string; hairColor: string; headShape: string; outfitColor: string;
  eyeColor: string; selectionBasis: string;
};

export function avatarArchetype(category = 'general') {
  if (['frontend', 'backend', 'automation'].includes(category)) return 'engineering';
  if (['ui', 'ux', 'media', 'content'].includes(category)) return 'creative';
  if (['data', 'research'].includes(category)) return 'scholar';
  return 'civic';
}

/**
 * The look a numbered wardrobe variant resolves to, for one gender and
 * archetype. Every field is a pure function of (gender, archetype, variant),
 * which is what makes the pre-baked catalog possible: the 16 variants ARE the
 * wardrobe. selectionBasis records who chose - 'verified-capabilities' when
 * genesis derived it from the identity seed, 'owner-styled' when the owner
 * picked the look themselves. Identity stays in gender and archetype; a
 * wardrobe choice can restyle hair and clothing but never impersonate.
 */
export function avatarSpecForVariant(
  gender: 'male' | 'female', archetype: (typeof ARCHETYPES)[number], variant: number, selectionBasis: string,
): PublicAvatarSpec {
  const archetypeIndex = ARCHETYPES.indexOf(archetype);
  const heads = gender === 'female' ? ['female', 'female_small'] : ['male', 'male_gaunt', 'male_plump', 'male_small'];
  return {
    version: 1, catalogKey: `citizen_${gender}_${archetype}_${String(variant).padStart(2, '0')}`,
    archetype, variant, hairStyle: HAIR_STYLES[variant % HAIR_STYLES.length],
    hairColor: HAIR_COLORS[(variant * 5 + archetypeIndex) % HAIR_COLORS.length],
    headShape: heads[Math.floor(variant / 2) % heads.length],
    outfitColor: ARCHETYPE_COLORS[archetype][(variant * 3 + archetypeIndex) % 4],
    eyeColor: EYE_COLORS[(variant * 7 + archetypeIndex) % EYE_COLORS.length],
    selectionBasis,
  };
}

export function avatarSpecFromSeedHex(seed: string, gender: 'male' | 'female', primaryCategory: string): PublicAvatarSpec {
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('avatar seed must be a SHA-256 hex digest');
  const variant = parseInt(seed.slice(0, 4), 16) % 16;
  return avatarSpecForVariant(gender, avatarArchetype(primaryCategory), variant, 'verified-capabilities');
}
