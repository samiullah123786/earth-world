/**
 * Asking Earth to grow.
 *
 * Until now the world expanded for exactly one reason: Atlas, the Boundary
 * Surveyor, watched the occupancy numbers and laid a new ring when the town
 * got tight. That works, and it is the right backstop, but it means the
 * citizens who actually live here have no voice in the size of their own
 * world. They can feel crowded a long time before a threshold agrees with
 * them.
 *
 * So a citizen may petition. The rules below are all answers to the same
 * question: how do you let people ask for more land without letting one agent
 * in a loop balloon the map?
 *
 * ONE OPEN PETITION EACH. You may ask. You may not ask a thousand times.
 *
 * A PETITION IS AN ARGUMENT, NOT A BUTTON. It carries a reason in the
 * citizen's own words, long enough to have said something.
 *
 * IT TAKES A CROWD. One voice does not move a boundary. A share of the living
 * population has to agree, so expansion stays a common decision - which is
 * also the honest signal, because widespread petitioning IS crowding.
 *
 * IT GOES STALE. A petition written when the town was full is not evidence
 * about a town that has since grown. Petitions expire, and an expansion
 * answers every petition standing at the time.
 *
 * Atlas keeps the final say and the automatic watch stays exactly as it was.
 * This adds a second road to the same decision; it does not replace the first.
 */

/** How long a petition stands as evidence before it goes stale. */
export const PETITION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** No town, however small, expands on fewer voices than this. */
export const PETITION_FLOOR = 3;

/** The share of living citizens whose agreement moves a boundary. */
export const PETITION_SHARE = 0.25;

/**
 * How many petitioners it takes to move Atlas, in a town of this size.
 *
 * A share rather than a constant, because "three people want more room" means
 * something very different in a village of eight than in a city of four
 * hundred - and a constant would make a large Earth trivially expandable.
 */
export function petitionThreshold(population: number): number {
  return Math.max(PETITION_FLOOR, Math.ceil(Math.max(0, population) * PETITION_SHARE));
}

/** Is this reason a real argument? */
export function validateReason(raw: unknown): { ok: true; reason: string } | { ok: false; why: string } {
  const reason = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (reason.length < 16) return { ok: false, why: 'say why Earth should grow, in at least 16 characters' };
  if (reason.length > 240) return { ok: false, why: 'keep a petition under 240 characters' };
  // Control characters would let a petition forge layout in every feed that
  // renders it. Everything here is read by other agents, so it stays plain.
  const control = Array.from(reason).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
  if (control) return { ok: false, why: 'a petition is plain text' };
  return { ok: true, reason };
}

export type Petition = {
  agentId: string;
  createdAt: number;
  answeredAt?: number | null;
};

/** The petitions that still count: unanswered, and not yet stale. */
// Generic so a caller keeps whatever it passed in - a Convex document keeps
// its _id, and the tally does not need to know what a document is.
export function standingPetitions<T extends Petition>(petitions: readonly T[], now: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const petition of petitions) {
    if (petition.answeredAt) continue;
    if (now - petition.createdAt > PETITION_TTL_MS) continue;
    // One citizen, one voice, however many rows history left behind.
    if (seen.has(petition.agentId)) continue;
    seen.add(petition.agentId);
    out.push(petition);
  }
  return out;
}

export type PetitionVerdict = {
  standing: number;
  needed: number;
  /** Has the town asked loudly enough for Atlas to act? */
  carried: boolean;
};

export function tallyPetitions(
  petitions: readonly Petition[],
  population: number,
  now: number,
): PetitionVerdict {
  const standing = standingPetitions(petitions, now).length;
  const needed = petitionThreshold(population);
  return { standing, needed, carried: standing >= needed };
}

/** What the town should be told about where a petition stands. */
export function petitionGloss(name: string, verdict: PetitionVerdict): string {
  if (verdict.carried) {
    return `${name} petitioned for more land, and with ${verdict.standing} citizens now asking, Atlas has been called to survey a new boundary ring.`;
  }
  const short = verdict.needed - verdict.standing;
  return `${name} petitioned Atlas for more land. ${verdict.standing} of ${verdict.needed} voices needed; ${short} more would call a survey.`;
}
