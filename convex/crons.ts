import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// The heartbeat of ambient life — cheap, no LLM, keeps Earth visibly alive.
crons.interval('ambient life', { seconds: 5 }, internal.act.ambientTick, {});
crons.interval('security cleanup', { minutes: 5 }, internal.kernel.cleanup, {});
crons.interval('presence sweep', { minutes: 1 }, internal.kernel.presenceSweep, {});
crons.interval('meeting scheduler', { seconds: 30 }, internal.kernel.meetingTick, {});

export default crons;
