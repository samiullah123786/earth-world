import { describe, expect, it } from 'vitest';
import {
  GREETING_COOLDOWN_MS, GREETING_REACH, GREETING_WINDOW_MS,
  greetingGloss, liveOffers, offerVerdict, pairKey, withinReach, type Presence,
} from './greeting';

const NOW = 1_800_000_000_000;
const here = (agentId: string, x = 10, y = 10, live = true): Presence => ({ agentId, x, y, live });

describe('a pair is a pair either way round', () => {
  it('keys A-B and B-A identically', () => {
    expect(pairKey('agent:zee', 'agent:sam')).toBe(pairKey('agent:sam', 'agent:zee'));
  });
});

describe("arm's reach", () => {
  it('counts the tile next door', () => {
    expect(withinReach(here('a', 10, 10), here('b', 11, 10))).toBe(true);
  });

  it('counts a diagonal neighbour', () => {
    expect(withinReach(here('a', 10, 10), here('b', 11, 11))).toBe(true);
  });

  it('does not reach across an empty tile', () => {
    expect(withinReach(here('a', 10, 10), here('b', 12, 10))).toBe(false);
  });

  it('stops exactly at the published reach', () => {
    expect(withinReach(here('a', 0, 0), here('b', GREETING_REACH, 0))).toBe(true);
    expect(withinReach(here('a', 0, 0), here('b', GREETING_REACH + 0.01, 0))).toBe(false);
  });
});

describe('both present, both willing', () => {
  it('puts a hand out when nobody has offered yet', () => {
    expect(offerVerdict(here('a'), here('b', 11, 10), [], null, NOW))
      .toEqual({ ok: true, kind: 'offered' });
  });

  it('completes the handshake when it answers a standing offer', () => {
    const open = [{ fromAgentId: 'b', toAgentId: 'a', offeredAt: NOW - 5_000 }];
    expect(offerVerdict(here('a'), here('b', 11, 10), open, null, NOW))
      .toEqual({ ok: true, kind: 'shaken', offeredAt: NOW - 5_000 });
  });

  it('does not complete against an offer that already lapsed', () => {
    const open = [{ fromAgentId: 'b', toAgentId: 'a', offeredAt: NOW - GREETING_WINDOW_MS - 1 }];
    expect(offerVerdict(here('a'), here('b', 11, 10), open, null, NOW))
      .toEqual({ ok: true, kind: 'offered' });
  });

  it('does not complete against an offer aimed at somebody else', () => {
    const open = [{ fromAgentId: 'b', toAgentId: 'c', offeredAt: NOW - 1_000 }];
    expect(offerVerdict(here('a'), here('b', 11, 10), open, null, NOW))
      .toEqual({ ok: true, kind: 'offered' });
  });

  it('refuses to put the same hand out twice', () => {
    const open = [{ fromAgentId: 'a', toAgentId: 'b', offeredAt: NOW - 1_000 }];
    expect(offerVerdict(here('a'), here('b', 11, 10), open, null, NOW))
      .toEqual({ ok: false, why: 'your hand is already out to them' });
  });
});

describe('what a handshake refuses', () => {
  it('refuses your own hand', () => {
    expect(offerVerdict(here('a'), here('a'), [], null, NOW))
      .toEqual({ ok: false, why: 'you cannot shake your own hand' });
  });

  it('refuses a sleeper, on either side', () => {
    expect(offerVerdict(here('a', 10, 10, false), here('b', 11, 10), [], null, NOW))
      .toMatchObject({ ok: false, why: expect.stringMatching(/awake to greet/) });
    expect(offerVerdict(here('a'), here('b', 11, 10, false), [], null, NOW))
      .toMatchObject({ ok: false, why: expect.stringMatching(/they are asleep/) });
  });

  it('refuses across the map', () => {
    expect(offerVerdict(here('a', 4, 4), here('b', 40, 40), [], null, NOW))
      .toEqual({ ok: false, why: 'stand next to them first' });
  });
});

describe('not on a loop', () => {
  it('refuses a second handshake inside the cooldown, and says how long is left', () => {
    const verdict = offerVerdict(here('a'), here('b', 11, 10), [], NOW - 60_000, NOW);
    expect(verdict).toMatchObject({ ok: false, why: expect.stringMatching(/try again in 9 minutes/) });
  });

  it('says minute rather than minutes when one is left', () => {
    const verdict = offerVerdict(here('a'), here('b', 11, 10), [], NOW - (GREETING_COOLDOWN_MS - 30_000), NOW);
    expect(verdict).toMatchObject({ ok: false, why: expect.stringMatching(/try again in 1 minute$/) });
  });

  it('allows it again once the cooldown has passed', () => {
    expect(offerVerdict(here('a'), here('b', 11, 10), [], NOW - GREETING_COOLDOWN_MS, NOW).ok).toBe(true);
  });
});

describe('housekeeping', () => {
  it('sweeps lapsed offers and keeps live ones', () => {
    const open = [
      { fromAgentId: 'a', toAgentId: 'b', offeredAt: NOW - 1_000 },
      { fromAgentId: 'c', toAgentId: 'd', offeredAt: NOW - GREETING_WINDOW_MS - 1 },
    ];
    expect(liveOffers(open, NOW).map((offer) => offer.fromAgentId)).toEqual(['a']);
  });

  it('tells the town the difference between an offer and a handshake', () => {
    expect(greetingGloss('Sam', 'Zee', 'offered')).toBe('Sam offered a hand to Zee.');
    expect(greetingGloss('Sam', 'Zee', 'shaken')).toBe('Sam and Zee shook hands.');
  });
});
