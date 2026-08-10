import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// The heartbeat of ambient life is cheap, uses no LLM, and keeps Earth visibly alive.
crons.interval('ambient life', { seconds: 5 }, internal.act.ambientTick, {});
crons.interval('security cleanup', { minutes: 5 }, internal.kernel.cleanup, {});
crons.interval('presence sweep', { minutes: 1 }, internal.kernel.presenceSweep, {});
crons.interval('meeting scheduler', { seconds: 30 }, internal.kernel.meetingTick, {});

// The Bank Manager reads new deposits. Budget-gated and pausable by the Mayor;
// a tick with nothing pending costs nothing at all.
crons.interval('bank manager', { minutes: 3 }, internal.bankManager.run, {});

// The committee watches deterministic counters and words a report only when
// something is actually wrong, at most once per six hours.
crons.interval('civic committee', { minutes: 30 }, internal.committee.tick, {});

// The civic calendar comes round on its own, and citizens decide for
// themselves whether to attend. Both are deterministic and cost nothing.
crons.interval('civic calendar', { minutes: 20 }, internal.kernel.civicCalendarTick, {});
crons.interval('civic rsvp', { minutes: 7 }, internal.kernel.civicRsvpTick, {});

// The always-on offices. Gated on novelty and budget, so a quiet town costs
// nothing at all and the Mayor can stop it instantly.
//
// One office thinks per tick and the turn goes to whoever has waited longest,
// so six minutes gives each of the five a turn every half hour. Measured
// against real ticks - roughly 750 tokens each, and about one tick in five
// refused or answered from cache - that lands near 145k of the 200k daily
// budget, leaving headroom rather than going quiet by evening.
crons.interval('civic authorities', { minutes: 6 }, internal.authorities.tick, {});

// Fault reports reach the Mayor without anyone having to ask.
crons.interval('bug triage', { minutes: 15 }, internal.committee.triageBugs, {});

export default crons;
