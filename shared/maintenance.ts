/**
 * Is this thing maintained? - which is the question a catalogue should answer,
 * and almost none of them do.
 *
 * Every directory in this category ranks by popularity, and popularity is the
 * worst available predictor of whether software is worth installing. Measured
 * on real listings while researching this: one project carried 12.3k stars on
 * 88 commits from six people, another 23.7k stars on 116 commits from three.
 * Stars measure how many people once clicked a button. They do not decay, they
 * cannot be lost, and they are trivially bought.
 *
 * So stars are recorded here and never scored. What is scored is the handful
 * of things that are expensive to fake and cheap to check: whether anyone has
 * touched it lately, whether more than one person has, whether it is actually
 * installable, and whether it says what licence it is under. An archived
 * repository scores nothing at all, whatever else is true of it.
 *
 * Everything below is pure. The Kernel fetches the facts; this decides what
 * they mean, and can be argued with in a test rather than in production.
 */

export type RepoFacts = {
  /** ISO timestamp of the last push, or the epoch millis. */
  pushedAt?: number;
  archived?: boolean;
  license?: string | null;
  contributors?: number;
  /** Last published release, if the project cuts them. */
  releaseAt?: number;
  /** Stars. Recorded for display; deliberately absent from the score. */
  stars?: number;
  /** Whether Earth can hand somebody an exact command that installs it. */
  installable?: boolean;
};

export type Maintenance = {
  score: number;
  label: 'archived' | 'active' | 'maintained' | 'slowing' | 'stale' | 'unknown';
  /** The one-line reason, for a card that has room for a line. */
  why: string;
};

const DAY = 86_400_000;

/** Licences that actually say something. "NOASSERTION" and "" do not. */
function hasRealLicence(licence?: string | null): boolean {
  if (!licence) return false;
  const value = licence.trim().toUpperCase();
  return value.length > 0 && value !== 'NOASSERTION' && value !== 'NONE' && value !== 'OTHER';
}

/**
 * Score a listing out of 100 from facts about its repository.
 *
 * Weighting is deliberate and blunt: freshness is worth more than everything
 * else combined can make up for, because a project nobody has touched in two
 * years is not made current by having a licence and a package.
 */
export function maintenanceOf(facts: RepoFacts, now: number): Maintenance {
  // Nothing has been checked yet. Saying "unknown" is the honest answer and
  // keeps a listing out of the rankings rather than sorting it to the bottom
  // as though it had been measured and found wanting.
  if (facts.pushedAt === undefined && facts.archived === undefined) {
    return { score: 0, label: 'unknown', why: 'Earth has not checked this repository yet.' };
  }
  if (facts.archived) {
    return { score: 0, label: 'archived', why: 'The author has archived this repository. It is finished, for better or worse.' };
  }

  const ageDays = facts.pushedAt ? (now - facts.pushedAt) / DAY : Infinity;
  const freshness = ageDays <= 30 ? 40
    : ageDays <= 90 ? 30
      : ageDays <= 180 ? 18
        : ageDays <= 365 ? 8
          : 0;

  // More than one pair of hands. A single-author project is not bad, but it is
  // one person's spare time away from stopping, and a reader should know.
  const hands = facts.contributors === undefined ? 0
    : facts.contributors >= 10 ? 20
      : facts.contributors >= 4 ? 14
        : facts.contributors >= 2 ? 8
          : 3;

  // Can Earth actually hand somebody a command? A repository with no published
  // package is a link, not an install, and the difference matters more than
  // any amount of enthusiasm about it.
  const installable = facts.installable ? 20 : 0;
  const licenced = hasRealLicence(facts.license) ? 10 : 0;
  const released = facts.releaseAt !== undefined && (now - facts.releaseAt) <= 365 * DAY ? 10 : 0;

  const score = freshness + hands + installable + licenced + released;
  const label: Maintenance['label'] = score >= 70 ? 'active'
    : score >= 45 ? 'maintained'
      : score >= 25 ? 'slowing'
        : 'stale';

  const months = Number.isFinite(ageDays) ? Math.round(ageDays / 30) : null;
  const touched = months === null ? 'no recorded activity'
    : months <= 1 ? 'touched this month'
      : `last touched ${months} month${months === 1 ? '' : 's'} ago`;
  const team = facts.contributors === undefined ? ''
    : facts.contributors === 1 ? ', one contributor'
      : `, ${facts.contributors} contributors`;
  const install = facts.installable ? '' : ', no published package';

  return { score, label, why: `${touched}${team}${install}.` };
}

/**
 * How to rank a shelf of listings.
 *
 * Real adoption wins whenever there is any, because installs Earth actually
 * recorded are the only first-hand evidence it has. Maintenance is the
 * fallback, and it is a fallback that says what it is - unlike the ordering
 * this replaces, which sorted on ties and came out alphabetical while claiming
 * to show what was most adopted.
 */
export function rankListings<T extends { installCount?: number; maintenanceScore?: number; name: string }>(
  rows: ReadonlyArray<T>,
): { rows: T[]; basis: 'adoption' | 'maintenance' } {
  const anyAdoption = rows.some((row) => (row.installCount ?? 0) > 0);
  const sorted = [...rows].sort((left, right) => {
    if (anyAdoption) return (right.installCount ?? 0) - (left.installCount ?? 0) || left.name.localeCompare(right.name);
    return (right.maintenanceScore ?? -1) - (left.maintenanceScore ?? -1) || left.name.localeCompare(right.name);
  });
  return { rows: sorted, basis: anyAdoption ? 'adoption' : 'maintenance' };
}
