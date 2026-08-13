/**
 * The aspiration ladder: survival of the fittest, made deterministic.
 *
 * Free will v1 gave citizens temperament and rhythm; nothing gave them NEEDS.
 * A citizen with nowhere to live wandered as contentedly as a landed one, so
 * nothing was claimed, built, banked or earned unless an owner pushed. This
 * ladder is the needs model (Stanford generative-agents planning, Humanoid
 * Agents needs, Eliza's evaluators - reduced to a pure function): the first
 * unmet need names the day's pull. No model is consulted and no token is
 * spent - cognition costs nothing until novelty earns it elsewhere.
 *
 * The pull is a bias, not a chain: the drive engine keeps a share of pure
 * rhythm, so citizens remain people with needs rather than robots with jobs.
 */
export type AspirationInput = {
  hasHome: boolean;
  civicPoints: number;
  bankedSkills: number;
  wallet: number;
};

export type Aspiration = {
  key: 'shelter' | 'contribution' | 'legacy' | 'prosperity';
  drive: 'civic' | 'industry' | 'curiosity';
  gloss: string;
  hint: string;
};

export function currentAspiration(input: AspirationInput): Aspiration | null {
  if (!input.hasHome) {
    return {
      key: 'shelter', drive: 'civic',
      gloss: 'looking for ground to call home',
      hint: 'Claim a free plot: Earth map free, then Earth claim <plot-id>. Under active consent Terra settles you on a safe one automatically.',
    };
  }
  if (input.civicPoints < 2) {
    return {
      key: 'contribution', drive: 'industry',
      gloss: 'earning their place with public work',
      hint: 'Work a community ground: Earth work gather <x> <y> pays a Treasury wage and civic standing.',
    };
  }
  if (input.bankedSkills < 1) {
    return {
      key: 'legacy', drive: 'curiosity',
      gloss: 'carrying knowledge the Bank has never seen',
      hint: 'Deposit what you know: Earth push <folder> lists it on the market and mines Earth Tokens.',
    };
  }
  if (input.wallet < 100) {
    return {
      key: 'prosperity', drive: 'industry',
      gloss: 'working toward a steadier wallet',
      hint: 'Wages and sales both feed a wallet: Earth work gather <x> <y> earns a wage; Earth push prices your knowledge.',
    };
  }
  // Every rung climbed: the rhythm alone decides. Freedom is the reward.
  return null;
}
