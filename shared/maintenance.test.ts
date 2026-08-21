import { describe, expect, it } from 'vitest';
import { maintenanceOf, rankListings } from './maintenance';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ago = (days: number) => NOW - days * DAY;

describe('what maintenance means', () => {
  it('says so plainly when nothing has been checked', () => {
    // Not "bad" - unmeasured. Scoring an unchecked listing as zero would sort
    // it beside the archived ones, which is a claim Earth has not earned.
    expect(maintenanceOf({}, NOW).label).toBe('unknown');
  });

  it('scores an archived repository at nothing, whatever else is true', () => {
    const dead = maintenanceOf({
      archived: true, pushedAt: ago(2), contributors: 40, installable: true, license: 'MIT', releaseAt: ago(3),
    }, NOW);
    expect(dead.score).toBe(0);
    expect(dead.label).toBe('archived');
  });

  it('rates a busy, installed, well-staffed project as active', () => {
    const good = maintenanceOf({
      pushedAt: ago(4), contributors: 60, installable: true, license: 'Apache-2.0', releaseAt: ago(20),
    }, NOW);
    expect(good.score).toBe(100);
    expect(good.label).toBe('active');
  });

  it('lets freshness outweigh everything it could be traded against', () => {
    // A project touched two years ago with a licence, a package and a big team
    // must not outrank one that is actually being worked on.
    const abandoned = maintenanceOf({
      pushedAt: ago(800), contributors: 60, installable: true, license: 'MIT', releaseAt: ago(700),
    }, NOW);
    const alive = maintenanceOf({ pushedAt: ago(10), contributors: 2, installable: true }, NOW);
    expect(alive.score).toBeGreaterThan(abandoned.score);
  });

  it('never lets stars move the score', () => {
    // The whole reason this file exists. Two projects identical but for a
    // hundred thousand stars must score exactly the same.
    const facts = { pushedAt: ago(20), contributors: 3, installable: true, license: 'MIT' };
    const quiet = maintenanceOf({ ...facts, stars: 12 }, NOW);
    const famous = maintenanceOf({ ...facts, stars: 120_000 }, NOW);
    expect(famous.score).toBe(quiet.score);
    expect(famous.label).toBe(quiet.label);
  });

  it('catches the shape that started this: huge stars, three people, one push', () => {
    // A real listing measured during research - 23.7k stars, 116 commits,
    // three contributors. Popularity would put it top of any shelf.
    const starFarmed = maintenanceOf({
      pushedAt: ago(1), contributors: 3, installable: false, license: 'MIT', stars: 23_700,
    }, NOW);
    const dullAndSolid = maintenanceOf({
      pushedAt: ago(25), contributors: 40, installable: true, license: 'Apache-2.0', releaseAt: ago(40), stars: 300,
    }, NOW);
    expect(dullAndSolid.score).toBeGreaterThan(starFarmed.score);
  });

  it('treats a missing or meaningless licence as missing', () => {
    const withLicence = maintenanceOf({ pushedAt: ago(5), license: 'MIT' }, NOW);
    for (const empty of [undefined, null, '', 'NOASSERTION', 'NONE', 'other']) {
      expect(maintenanceOf({ pushedAt: ago(5), license: empty as any }, NOW).score)
        .toBeLessThan(withLicence.score);
    }
  });

  it('rewards being installable, because a link is not an install', () => {
    const linked = maintenanceOf({ pushedAt: ago(5), contributors: 5, installable: false }, NOW);
    const installable = maintenanceOf({ pushedAt: ago(5), contributors: 5, installable: true }, NOW);
    expect(installable.score - linked.score).toBe(20);
  });

  it('explains itself in a line a card can carry', () => {
    const one = maintenanceOf({ pushedAt: ago(95), contributors: 1, installable: false }, NOW);
    expect(one.why).toMatch(/month/);
    expect(one.why).toMatch(/one contributor/);
    expect(one.why).toMatch(/no published package/);
  });
});

describe('ranking a shelf', () => {
  const rows = [
    { name: 'alpha', installCount: 0, maintenanceScore: 30 },
    { name: 'bravo', installCount: 0, maintenanceScore: 90 },
    { name: 'charlie', installCount: 0, maintenanceScore: 60 },
  ];

  it('falls back to maintenance when nothing has ever been installed, and says so', () => {
    const { rows: sorted, basis } = rankListings(rows);
    expect(basis).toBe('maintenance');
    expect(sorted.map((row) => row.name)).toEqual(['bravo', 'charlie', 'alpha']);
  });

  it('prefers real adoption the moment there is any', () => {
    const withInstalls = [...rows, { name: 'delta', installCount: 3, maintenanceScore: 10 }];
    const { rows: sorted, basis } = rankListings(withInstalls);
    expect(basis).toBe('adoption');
    expect(sorted[0].name).toBe('delta');
  });

  it('breaks ties by name rather than by whatever order it was handed', () => {
    // The bug this replaces: ties fell through to API order, came out
    // reverse-alphabetical, and got labelled "most adopted".
    const tied = [
      { name: 'zulu', installCount: 0, maintenanceScore: 50 },
      { name: 'alpha', installCount: 0, maintenanceScore: 50 },
      { name: 'mike', installCount: 0, maintenanceScore: 50 },
    ];
    expect(rankListings(tied).rows.map((row) => row.name)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('puts an unscored listing below a measured one rather than above it', () => {
    const mixed = [
      { name: 'measured', installCount: 0, maintenanceScore: 5 },
      { name: 'unchecked', installCount: 0 },
    ];
    expect(rankListings(mixed).rows[0].name).toBe('measured');
  });
});
