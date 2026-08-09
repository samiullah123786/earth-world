import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// The heartbeat of ambient life — cheap, no LLM, keeps Earth visibly alive.
crons.interval('ambient life', { seconds: 5 }, internal.act.ambientTick, {});

export default crons;
