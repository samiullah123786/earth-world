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
// Twice a minute, not once. The sweep is one collect and a handful of patches,
// and it is what turns a quiet connector into a citizen walking through the
// gate - halving its period halves the wait for the only visible thing here.
crons.interval('presence sweep', { seconds: 30 }, internal.kernel.presenceSweep, {});
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
// An approval outlives the case it is about, and a queue full of items that
// cannot be decided is worse than an empty one. Anything pointing at a closed
// case is withdrawn on its own.
crons.interval('approval reconciliation', { minutes: 30 }, internal.kernel.reconcileApprovals, {});

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

// The catalogue restocks itself from the official MCP registry, where every
// record carries a real published package or a real remote URL - so what lands
// on the shelf is something Earth can hand somebody an exact command for,
// rather than a repository they would have to clone and run.
crons.interval('mcp registry sync', { hours: 24 }, internal.registrySync.syncOfficialRegistry, {});
// And the evidence behind those listings is refreshed a dozen at a time. Two
// GitHub calls per repository against an unauthenticated ceiling of sixty an
// hour: slow on purpose, free, and it never needs a key to work at all.
crons.interval('listing maintenance', { hours: 1 }, internal.registrySync.refreshMaintenance, {});

export default crons;
