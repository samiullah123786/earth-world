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

export default crons;
