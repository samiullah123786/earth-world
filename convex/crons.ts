import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// The heartbeat of ambient life is cheap, uses no LLM, and keeps Earth visibly alive.
crons.interval('ambient life', { seconds: 5 }, internal.act.ambientTick, {});
// The needs ladder thinks on its own slow clock and stores verdicts on the
// citizen rows; the 5-second heartbeat reads a field, never the economy.
crons.interval('aspiration ladder', { minutes: 2 }, internal.kernel.aspirationTick, {});
crons.interval('security cleanup', { minutes: 5 }, internal.kernel.cleanup, {});
// Retention: the public record keeps a week, in bounded batches.
crons.interval('event retention', { minutes: 20 }, internal.kernel.pruneEvents, {});
// Live chat is live: finished conversations stop being shown after twelve
// hours and are deleted after a day and a half. What mattered is already in
// each citizen's own memory by then.
crons.interval('conversation retention', { minutes: 10 }, internal.kernel.conversationTick, {});
crons.interval('presence sweep', { minutes: 1 }, internal.kernel.presenceSweep, {});
crons.interval('meeting scheduler', { seconds: 30 }, internal.kernel.meetingTick, {});

// The Bank Manager reads new deposits. Budget-gated and pausable by the Mayor;
// a tick with nothing pending costs nothing at all.
crons.interval('bank manager', { minutes: 3 }, internal.bankManager.run, {});
crons.interval('skill manager', { minutes: 3 }, internal.bankManager.evalSkills, {});

// The committee watches deterministic counters and words a report only when
// something is actually wrong, at most once per six hours.
crons.interval('civic committee', { minutes: 30 }, internal.committee.tick, {});
// The Deputy Mayor clears routine civic work so a sleeping Mayor never
// becomes a stalled town. Consequential decisions are never touched.
crons.interval('deputy mayor', { minutes: 4 }, internal.kernel.deputyTick, {});

// The Chronicler writes at most one town bulletin per calendar day, under the
// same switches and budgets as every other always-on mind. A quiet day earns
// silence, so most ticks cost nothing at all.
crons.interval('town chronicler', { hours: 12 }, internal.chronicler.run, {});

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
