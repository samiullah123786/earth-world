import { describe, expect, it } from 'vitest';
import {
  PETITION_FLOOR, PETITION_TTL_MS, petitionGloss, petitionThreshold,
  standingPetitions, tallyPetitions, validateReason,
} from './petition';

const NOW = 1_800_000_000_000;
const voice = (agentId: string, ageMs = 0, answeredAt?: number) =>
  ({ agentId, createdAt: NOW - ageMs, answeredAt });

describe('how many voices move a boundary', () => {
  it('never moves on fewer than the floor, however small the town', () => {
    expect(petitionThreshold(0)).toBe(PETITION_FLOOR);
    expect(petitionThreshold(4)).toBe(PETITION_FLOOR);
  });

  it('scales with the town, so a large Earth is not trivially expandable', () => {
    expect(petitionThreshold(40)).toBe(10);
    expect(petitionThreshold(400)).toBe(100);
  });

  it('rounds up, so a quarter of ten is three rather than two and a half', () => {
    expect(petitionThreshold(10)).toBe(3);
    expect(petitionThreshold(13)).toBe(4);
  });
});

describe('a petition is an argument', () => {
  it('refuses a button-press', () => {
    expect(validateReason('more land')).toMatchObject({ ok: false });
    expect(validateReason('')).toMatchObject({ ok: false });
  });

  it('accepts a real sentence and normalises its whitespace', () => {
    expect(validateReason('  The east   district has no free plots left. ')).toEqual({
      ok: true, reason: 'The east district has no free plots left.',
    });
  });

  it('refuses an essay', () => {
    expect(validateReason('x'.repeat(241)))
      .toMatchObject({ ok: false, why: expect.stringMatching(/under 240/) });
  });

  it('refuses control characters, which would forge layout in every feed', () => {
    const forged = `the town is full${String.fromCharCode(7)} and I need room now`;
    expect(validateReason(forged)).toEqual({ ok: false, why: 'a petition is plain text' });
  });
});

describe('which petitions still count', () => {
  it('drops the ones an expansion already answered', () => {
    const rows = [voice('a'), voice('b', 0, NOW - 10), voice('c')];
    expect(standingPetitions(rows, NOW).map((row) => row.agentId)).toEqual(['a', 'c']);
  });

  it('drops the ones that have gone stale', () => {
    const rows = [voice('a'), voice('old', PETITION_TTL_MS + 1)];
    expect(standingPetitions(rows, NOW).map((row) => row.agentId)).toEqual(['a']);
  });

  it('keeps one on the very edge of staleness', () => {
    expect(standingPetitions([voice('edge', PETITION_TTL_MS)], NOW)).toHaveLength(1);
  });

  it('counts one citizen once, however many rows history left behind', () => {
    const rows = [voice('a'), voice('a'), voice('a'), voice('b')];
    expect(standingPetitions(rows, NOW)).toHaveLength(2);
  });
});

describe('the tally', () => {
  it('does not carry on a single voice in a small town', () => {
    expect(tallyPetitions([voice('a')], 6, NOW)).toEqual({ standing: 1, needed: 3, carried: false });
  });

  it('carries when the town has asked loudly enough', () => {
    const rows = ['a', 'b', 'c'].map((id) => voice(id));
    expect(tallyPetitions(rows, 8, NOW)).toEqual({ standing: 3, needed: 3, carried: true });
  });

  it('does not carry on stale voices, however many there are', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => voice(id, PETITION_TTL_MS + 1));
    expect(tallyPetitions(rows, 8, NOW).carried).toBe(false);
  });
});

describe('what the town is told', () => {
  it('says how far short a petition falls, so the ask is actionable', () => {
    expect(petitionGloss('Zee', { standing: 1, needed: 3, carried: false }))
      .toBe('Zee petitioned Atlas for more land. 1 of 3 voices needed; 2 more would call a survey.');
  });

  it('says a survey was called when the petition carries', () => {
    expect(petitionGloss('Zee', { standing: 3, needed: 3, carried: true }))
      .toMatch(/Atlas has been called to survey/);
  });
});
