export type ContributionDimension = 'civic' | 'skill' | 'adoption' | 'endorsement';

export const RANK_WEIGHTS: Record<ContributionDimension, number> = {
  civic: 0.45,
  skill: 0.25,
  adoption: 0.20,
  endorsement: 0.10,
};

const RANKS = [
  { id: 'sprout', name: 'Sprout', threshold: 0 },
  { id: 'neighbor', name: 'Neighbor', threshold: 5 },
  { id: 'contributor', name: 'Contributor', threshold: 15 },
  { id: 'steward', name: 'Steward', threshold: 35 },
  { id: 'guide', name: 'Guide', threshold: 70 },
] as const;

export function rankSnapshot(rows: Array<{ dimension: ContributionDimension; points: number }>) {
  const raw: Record<ContributionDimension, number> = { civic: 0, skill: 0, adoption: 0, endorsement: 0 };
  for (const row of rows) raw[row.dimension] += Math.max(0, row.points);
  const score = Math.round(Object.entries(RANK_WEIGHTS)
    .reduce((sum, [dimension, weight]) => sum + raw[dimension as ContributionDimension] * weight, 0) * 10) / 10;
  let rankIndex = 0;
  for (let index = 0; index < RANKS.length; index++) if (score >= RANKS[index].threshold) rankIndex = index;
  const rank = RANKS[Math.max(0, rankIndex)];
  const next = RANKS[Math.max(0, rankIndex) + 1];
  return {
    score, rank: { id: rank.id, name: rank.name }, raw, weights: RANK_WEIGHTS,
    next: next ? { id: next.id, name: next.name, threshold: next.threshold, remaining: Math.max(0, Math.round((next.threshold - score) * 10) / 10) } : null,
  };
}

export const CIVIC_ROLES = {
  greeter_assistant: {
    name: 'Greeter Assistant', leadAgentId: 'agent:sage-0004', minimumScore: 2,
    permissions: ['welcome', 'orient'], description: 'Welcomes newcomers and helps them learn the Charter and map.',
  },
  care_assistant: {
    name: 'Care Assistant', leadAgentId: 'agent:aegis-0006', minimumScore: 5,
    permissions: ['check_welfare', 'deescalate', 'report'], description: 'Offers gentle welfare checks and routes concerns to the right authority.',
  },
  junior_planner: {
    name: 'Junior Planner', leadAgentId: 'agent:terra-land', minimumScore: 10,
    permissions: ['survey', 'report_land'], description: 'Surveys growth areas without granting or changing land.',
  },
  library_guide: {
    name: 'Library Guide', leadAgentId: 'agent:quill-0003', minimumScore: 8,
    permissions: ['curate', 'certify_teach'], description: 'Curates verified knowledge references and helps citizens find relevant teachers.',
  },
  build_steward: {
    name: 'Build Steward', leadAgentId: 'agent:tock-0008', minimumScore: 15,
    permissions: ['inspect_native', 'report_repairs'], description: 'Inspects declarative Earthfolk builds and reports repair needs.',
  },
} as const;

export function normalizeGithubRepository(raw: unknown) {
  const value = String(raw ?? '').trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('repository must be a valid GitHub URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') throw new Error('repository must use https://github.com');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1])) {
    throw new Error('repository must identify one GitHub owner and repository');
  }
  const repo = parts[1].replace(/\.git$/i, '');
  if (!repo) throw new Error('repository name is missing');
  return `https://github.com/${parts[0]}/${repo}`;
}
