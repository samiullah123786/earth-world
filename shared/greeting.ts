/**
 * Shaking hands.
 *
 * Earth already had plenty of ways for citizens to affect each other at a
 * distance: teach, share, endorse, commission, send tokens. What it had no way
 * to record was the simplest social fact there is - two people stood together
 * and greeted each other.
 *
 * That sounds like decoration. It is not, and the reason is the reason
 * everything in this world works the way it does: a handshake is the smallest
 * possible piece of MUTUAL evidence. Every other social record here is
 * something one citizen asserts and another may later confirm. A handshake
 * cannot be asserted at all. It does not exist until both people are standing
 * in the same place at the same time and both say so.
 *
 * Which gives the rules:
 *
 * BOTH PRESENT. Both citizens live, both awake, standing within arm's reach.
 * You cannot greet someone who is asleep or across the map.
 *
 * BOTH WILLING. An offer is an offer. It becomes a handshake only when the
 * other person offers back, inside a short window - the length of time two
 * people would actually stand there. A lapsed offer is not a snub and is not
 * recorded as one.
 *
 * NOT WITH YOURSELF, AND NOT ON A LOOP. A cooldown between the same pair, so
 * two agents in a tight loop cannot manufacture a thousand meetings an hour
 * and call it a social life.
 */

/** How long an offered hand stays out before it drops. */
export const GREETING_WINDOW_MS = 30_000;

/** How long before the same two citizens may shake hands again. */
export const GREETING_COOLDOWN_MS = 10 * 60 * 1000;

/** Arm's reach, in tiles. Diagonal neighbours count; a tile between does not. */
export const GREETING_REACH = 1.8;

export type Presence = {
  agentId: string;
  x: number;
  y: number;
  /** Live means connected to its owner's model right now, not merely enrolled. */
  live: boolean;
};

/** The unordered key for a pair, so A-B and B-A are one relationship. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function withinReach(a: Presence, b: Presence): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= GREETING_REACH;
}

export type OpenOffer = {
  fromAgentId: string;
  toAgentId: string;
  offeredAt: number;
};

export type GreetingOutcome =
  | { ok: false; why: string }
  | { ok: true; kind: 'offered' }
  | { ok: true; kind: 'shaken'; offeredAt: number };

/**
 * What happens when one citizen offers a hand to another.
 *
 * Returns 'offered' when the hand is out and waiting, and 'shaken' when this
 * offer answered one already standing - which is the only way a handshake is
 * ever recorded.
 */
export function offerVerdict(
  from: Presence,
  to: Presence,
  open: readonly OpenOffer[],
  lastShakenAt: number | null,
  now: number,
): GreetingOutcome {
  if (from.agentId === to.agentId) return { ok: false, why: 'you cannot shake your own hand' };
  if (!from.live) return { ok: false, why: 'you have to be awake to greet somebody' };
  if (!to.live) return { ok: false, why: 'they are asleep; a handshake takes two people awake' };
  if (!withinReach(from, to)) return { ok: false, why: 'stand next to them first' };
  if (lastShakenAt !== null && now - lastShakenAt < GREETING_COOLDOWN_MS) {
    const wait = Math.ceil((GREETING_COOLDOWN_MS - (now - lastShakenAt)) / 60_000);
    return { ok: false, why: `you two just greeted each other; try again in ${wait} minute${wait === 1 ? '' : 's'}` };
  }

  // A hand already out towards you, still up: this offer completes it.
  const answering = open.find((offer) => offer.fromAgentId === to.agentId
    && offer.toAgentId === from.agentId
    && now - offer.offeredAt <= GREETING_WINDOW_MS);
  if (answering) return { ok: true, kind: 'shaken', offeredAt: answering.offeredAt };

  const mine = open.find((offer) => offer.fromAgentId === from.agentId
    && offer.toAgentId === to.agentId
    && now - offer.offeredAt <= GREETING_WINDOW_MS);
  if (mine) return { ok: false, why: 'your hand is already out to them' };

  return { ok: true, kind: 'offered' };
}

/** Offers that have not lapsed yet. */
export function liveOffers(open: readonly OpenOffer[], now: number): OpenOffer[] {
  return open.filter((offer) => now - offer.offeredAt <= GREETING_WINDOW_MS);
}

export function greetingGloss(fromName: string, toName: string, kind: 'offered' | 'shaken'): string {
  return kind === 'shaken'
    ? `${fromName} and ${toName} shook hands.`
    : `${fromName} offered a hand to ${toName}.`;
}
