/**
 * Taking the wheel: when a human steers their own citizen directly.
 *
 * The premise of AgentsEarth is that every citizen is an AI agent bound to
 * one human owner. Takeover is that bond made physical for a while - the
 * owner steps into their agent's body, walks it, works it, and steps out
 * again, after which the agent resumes its own life exactly where the body
 * now stands.
 *
 * Four rules make this safe to exist at all.
 *
 * ONLY YOUR OWN. A takeover is authorised by the owner session that already
 * proves ownership of that citizen. Nobody drives somebody else's agent, ever
 * - that would make every reputation in the world worthless.
 *
 * THE WORLD'S LAWS DO NOT BEND. A driven citizen obeys exactly the rules an
 * autonomous one obeys: walkable ground only, no walking through structures,
 * no reaching outside the world, and every build still goes through the same
 * civic approval. Possession changes who decides the next step, never what
 * steps are legal.
 *
 * IT LAPSES. A held wheel with nobody at it would freeze an agent out of its
 * own life indefinitely, so a takeover expires on its own and must be renewed
 * by someone actually present.
 *
 * IT IS PUBLIC. The world announces it and the citizen is visibly driven.
 * A town where you cannot tell a person from a puppet is a town where nothing
 * you watch means anything.
 */

/** How long one takeover lasts before it lapses without a renewal. */
export const TAKEOVER_LEASE_MS = 45_000;
/** The furthest a driven citizen may step in one command, in tiles. */
export const TAKEOVER_STEP = 1;

export type TakeoverState = {
  drivenBy?: string | null;
  drivenUntil?: number | null;
};

/** Is this citizen being driven by a human right now? */
export function isDriven(citizen: TakeoverState, now: number): boolean {
  return Boolean(citizen.drivenBy) && (citizen.drivenUntil ?? 0) > now;
}

/**
 * May this step be taken?
 *
 * Deliberately strict about distance. A driven citizen moves one tile at a
 * time, so a dropped connection or a held key can never fling a body across
 * the map, and every position the world records is one the citizen could
 * have walked to.
 */
export function stepVerdict(
  from: { x: number; y: number },
  to: { x: number; y: number },
  bounds: { width: number; height: number },
  walkable: (x: number, y: number) => boolean,
): { ok: true } | { ok: false; why: string } {
  if (!Number.isInteger(to.x) || !Number.isInteger(to.y)) {
    return { ok: false, why: 'a step lands on a whole tile' };
  }
  if (to.x < 0 || to.y < 0 || to.x >= bounds.width || to.y >= bounds.height) {
    return { ok: false, why: 'that is beyond the edge of the world' };
  }
  const reach = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (reach === 0) return { ok: false, why: 'you are already standing there' };
  if (reach > TAKEOVER_STEP) {
    return { ok: false, why: 'a driven citizen walks one tile at a time' };
  }
  if (!walkable(to.x, to.y)) {
    return { ok: false, why: 'something solid is in the way' };
  }
  return { ok: true };
}

/**
 * What the world should say about a citizen while a human is driving them.
 *
 * Written for the feed and the nameplate, because the whole point is that
 * possession is never hidden.
 *
 * It does NOT name anybody. It was originally written to name the owner and
 * then called with the citizen's own name, so a driven Zee read "being walked
 * in person by Zee" - which is nonsense twice over. The owner's real name is
 * private and the citizen's name is already on the nameplate; what a watcher
 * needs to know is simply that the body is being steered by hand.
 */
export function drivenActivity(): string {
  return 'being walked in person by their owner';
}
