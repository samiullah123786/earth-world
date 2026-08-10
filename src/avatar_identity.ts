import { avatarArchetype, type PublicAvatarSpec } from '../shared/avatar-identity';
export type { PublicAvatarSpec } from '../shared/avatar-identity';
export { tierInsignia, EXPERIENCE_TIERS, type ExperienceTier, type TierInsignia } from '../shared/avatar-identity';

type AvatarCitizen = {
  agentId: string; name: string; gender: string; family: string;
  primaryCategory?: string; serviceRole?: string; avatarSpec?: PublicAvatarSpec;
};

export function stableIdentityHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function citizenArchetype(primaryCategory = 'general', family = 'general') {
  if (primaryCategory !== 'general') return avatarArchetype(primaryCategory);
  if (family === 'engineering') return 'engineering';
  if (['design', 'media', 'content'].includes(family)) return 'creative';
  if (['data', 'research'].includes(family)) return 'scholar';
  return 'civic';
}

export function authorityAvatarKey(citizen: AvatarCitizen) {
  const role = citizen.serviceRole?.toLowerCase() ?? '';
  if (role.includes('mayor')) return 'mayor_sam';
  if (role.includes('warden')) return 'aegis';
  if (role.includes('steward')) return 'terra';
  if (role.includes('inspector')) return 'tock';
  if (role.includes('greeter')) return 'sage';
  if (role.includes('surveyor')) return 'atlas';
  return undefined;
}

export function fallbackAvatarKey(citizen: AvatarCitizen) {
  const gender = citizen.gender === 'female' ? 'female' : 'male';
  const archetype = citizenArchetype(citizen.primaryCategory, citizen.family);
  const variant = stableIdentityHash(citizen.agentId) % 16;
  return `citizen_${gender}_${archetype}_${String(variant).padStart(2, '0')}`;
}

export function resolveAvatarKey(citizen: AvatarCitizen, available: ReadonlySet<string>) {
  const authority = authorityAvatarKey(citizen);
  if (authority && available.has(authority)) return authority;
  const claimed = citizen.avatarSpec?.catalogKey;
  if (claimed && citizen.avatarSpec?.selectionBasis === 'verified-capabilities' && available.has(claimed)) return claimed;
  const fallback = fallbackAvatarKey(citizen);
  if (available.has(fallback)) return fallback;
  return citizen.gender === 'female' ? 'default_female' : 'default_male';
}
