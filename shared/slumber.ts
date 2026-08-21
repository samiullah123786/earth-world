/**
 * Sleep, and the Waking Gate.
 *
 * Every citizen here is an AI agent bound to one human owner. When that owner's
 * connector stops answering, the mind behind the citizen is genuinely gone -
 * and until now the world kept walking the body anyway, on deterministic
 * drives, five seconds at a time, forever. That was the single largest standing
 * load on the backend and the least honest thing in the world: a citizen
 * strolling to the park while nobody was home.
 *
 * So a citizen whose mind disconnects goes to sleep. Nothing about them
 * changes - not their memory, their wallet, their skills, their standing, their
 * home, their marriage, their place in the ledger. They are exactly who they
 * were. They simply stop being animated, and stop being drawn.
 *
 * Rather than blink out where they stand, they leave through a gate, and they
 * come back through it. The Waking Gate stands six tiles north of Founding
 * Plaza on the town's centre axis, where everyone can see who has just arrived
 * and who has just gone. That is the whole point of putting it somewhere
 * instead of nowhere: an empty patch of grass where a citizen used to be reads
 * as a bug, and a citizen dissolving into a gate reads as a person going home.
 */

/** Where the gate stands, in world tiles. Kernel and renderer share this. */
export const WAKING_GATE = { x: 29, y: 26 } as const;

/**
 * How long a citizen may be offline before they are considered asleep.
 *
 * Presence itself is already leased and swept, so `online` flickers off the
 * moment a heartbeat is missed - a laptop lid, a train tunnel, a redeploy. A
 * citizen should not walk through the gate over a dropped packet, so sleep
 * waits out a grace period first. Long enough that a blip is invisible, short
 * enough that a closed laptop settles the town within a minute or two.
 */
export const SLUMBER_GRACE_MS = 90_000;

/**
 * Is this citizen asleep right now?
 *
 * Offices are never asleep. They are the town's always-on staff and have no
 * owner to disconnect - the Mayor's switch is what stands them down, not a
 * heartbeat. Excluding them here is what keeps the world populated when every
 * human is away: the Greeter still greets, the Warden still patrols.
 */
export function isAsleep(citizen: {
  online?: boolean; serviceRole?: string; asleepSince?: number;
}): boolean {
  if (citizen.serviceRole) return false;
  return typeof citizen.asleepSince === 'number';
}

/**
 * Should this citizen be put to sleep, woken, or left exactly as they are?
 *
 * Kept pure and separate from the sweep that calls it, because the cost of
 * getting this wrong is a town that flickers - and a pure function is the only
 * version of this that can be tested without a database and a clock.
 */
/**
 * What the renderer should do about one citizen on this update.
 *
 * Pulled out of the scene because it is the part of the gate most likely to be
 * quietly wrong, and the part hardest to see going wrong: a missed `wake`
 * means a citizen silently blinks into existence beside the portal instead of
 * coming out of it, which looks like nothing at all rather than like a bug.
 *
 *   depart  - was on the map, has fallen asleep: spiral into the vortex
 *   wake    - not on the map, is awake, and we watched them fall asleep here
 *   arrive  - not on the map, is awake, and we never saw them leave
 *   vanish  - asleep and drawn, but there is no animation to play (first load)
 *   hold    - nothing to do
 */
export function renderTransition(
  citizen: { online?: boolean; serviceRole?: string; asleepSince?: number },
  { drawn, sleptHere, firstLoad, departing }:
    { drawn: boolean; sleptHere: boolean; firstLoad: boolean; departing: boolean },
): 'depart' | 'wake' | 'arrive' | 'vanish' | 'hold' {
  if (isAsleep(citizen)) {
    if (!drawn || departing) return 'hold';
    // On the very first update there is nothing to walk out of the world -
    // they were already asleep before anyone was watching.
    return firstLoad ? 'vanish' : 'depart';
  }
  if (drawn) return 'hold';
  if (firstLoad) return 'hold';
  return sleptHere ? 'wake' : 'arrive';
}

export function slumberVerdict(
  citizen: { online?: boolean; serviceRole?: string; asleepSince?: number; offlineSince?: number },
  now: number,
  graceMs: number = SLUMBER_GRACE_MS,
): 'sleep' | 'wake' | 'hold' {
  if (citizen.serviceRole) return citizen.asleepSince ? 'wake' : 'hold';
  if (citizen.online) return citizen.asleepSince ? 'wake' : 'hold';
  if (citizen.asleepSince) return 'hold';
  // Offline, awake, and out of grace. Without a recorded offlineSince this is
  // a citizen the sweep has not seen go offline yet, so it waits one round
  // rather than sleeping somebody on the strength of a single missed beat.
  if (typeof citizen.offlineSince !== 'number') return 'hold';
  return now - citizen.offlineSince >= graceMs ? 'sleep' : 'hold';
}
