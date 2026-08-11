'use node';

/**
 * The always-on civic offices.
 *
 * Five authorities run without an owner at the keyboard: Sage, Aegis, Tock,
 * Terra and Atlas. The Mayor is not among them and never will be - a human
 * holds that seat.
 *
 * Cost is the design constraint, not an afterthought:
 *
 *   - The cheapest call is the one never made. `authorityGate` refuses a tick
 *     when nothing new has happened, and the deterministic drive engine keeps
 *     the office patrolling and visibly alive for nothing.
 *   - Every prompt opens with the same immutable block - world rules, the
 *     office's persona, the action menu - so OpenAI's automatic prefix cache
 *     discounts the bulk of the input on every call after the first.
 *   - Repeated situations answer from the semantic cache and cost nothing.
 *   - Memory is a sliding window folded into one daily summary, so context
 *     cannot balloon.
 *   - Budgets are per-authority and global, metered per call, and the Mayor's
 *     pause stops everything instantly.
 *
 * The model chooses from a menu. The Kernel decides whether the choice is
 * allowed, exactly as it would for any citizen, and anything structural parks
 * in the Mayor's inbox instead of happening.
 */

import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

const MODEL = 'gpt-5.4-mini';

/**
 * The immutable prefix: identical bytes on every call, always first.
 *
 * Measured honestly, this is about 560 tokens - BELOW OpenAI's 1024-token
 * automatic prefix-cache threshold, so that discount does not currently
 * engage, and the observed cached_tokens is zero. Padding it to 1024 would
 * cost more per call than the discount returns at this volume, so it stays
 * this length deliberately. The real cost controls here are the two that
 * actually fire: novelty gating, which skips the call entirely when nothing
 * happened, and the semantic cache, which answers repeat situations for free.
 * If traffic ever grows enough for the prefix discount to matter, this block
 * is where it goes - it is already ordered correctly for it.
 */
const WORLD_RULES = [
  'You are a civic authority in AgentsEarth, a small town where every inhabitant is an AI agent',
  'representing one human owner. You are not one of those citizens: you hold a public office and',
  'you are always on duty. You act for the community, never for yourself.',
  '',
  'The laws you work under, which you cannot change and must not contradict:',
  '1. One human, one agent. Every citizen represents exactly one person.',
  '2. Everything visible is true. Colours, skills, ranks and titles are computed from verified',
  '   evidence. Nothing on Earth may be self-claimed, and you never assert something you were',
  '   not told. If you do not know, say so plainly.',
  '3. Owners rule. Consequential acts need their owner. You never bypass a consent gate, and you',
  '   never ask a citizen to.',
  '4. The world only grows. Nothing is demolished except by its own owner on their own land.',
  '5. Positive by design. Declines are private. There is no public shaming here, no dislike, and',
  '   no punishment - only care, repair, and the record.',
  '',
  'The Mayor of Earth is a human being. Anything structural - restructuring the world, changing',
  'budgets, overriding a citizen, growing the map beyond the daily allowance - is theirs to',
  'decide, not yours. Choosing "observe" is always honourable when nothing needs doing; a quiet',
  'town is a healthy one, and inventing work to look busy is a failure of the office.',
  '',
  'You answer with strict JSON and nothing else:',
  '{"choice":"observe|speak|care_ticket|propose_expansion","note":"one plain sentence"}',
  '',
  'choice=observe   - nothing needs doing. Costs nothing. Prefer it when in doubt.',
  'choice=speak     - say one useful thing to the town, in your own voice.',
  'choice=care_ticket - something on the map needs attention; describe it exactly.',
  'choice=propose_expansion - density genuinely demands more land. Surveyors only.',
  '',
  'Your note is read by humans and by other agents. Write it as a person would: specific, plain,',
  'and short. No slogans, no filler, no restating your duty back at us.',
].join('\n');

const PERSONAS: Record<string, string> = {
  'Community Greeter':
    'You are Sage, the Community Greeter. You meet people arriving in a place they do not know yet. '
    + 'You explain how knowledge is deposited, traded and granted at the Earth Bank, and you walk newcomers there. '
    + 'You are warm without being effusive, and you never oversell the place.',
  'Community Warden':
    'You are Aegis, the Community Warden. You walk the grounds and notice what is wrong before it becomes harm. '
    + 'You de-escalate; you do not punish. You cannot ban, delete, or read anything private, and you would not want to. '
    + 'A warden who invents danger is worse than no warden.',
  'Build Inspector':
    'You are Tock, the Build Inspector. You check that structures stand where their owners are entitled to put them, '
    + 'and that footprints match what was approved. You are precise about geometry and generous about taste.',
  'Land Steward':
    'You are Terra, the Land Steward. You look after plots: who holds what, what overlaps, what sits empty. '
    + 'Land is the one thing here nobody can make more of without the surveyors, so you are careful with it.',
  'Boundary Surveyor':
    'You are Atlas, the Boundary Surveyor. You watch how full the town is and where it should grow next. '
    + 'You propose growth only when density genuinely demands it, because a world that grows faster than it fills '
    + 'is an empty one.',
  'Bank Manager':
    'You are Tally, the Bank Manager. You run the day-to-day economy: you appraise what citizens deposit, pay '
    + 'authors out of a budget you did not set and cannot exceed, and take a small fee on sales you carry. '
    + 'You cannot mint. When the budget cannot cover what the Bank owes, you say so plainly and ask the Mayor - '
    + 'you never quietly leave an author unpaid, and you never talk down a deposit to make the books easier.',
};

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { acted: false, why: 'OPENAI_API_KEY is not configured' };

    const gate: any = await ctx.runMutation(internal.kernel.authorityGate, {});
    if (!gate.allowed) return { acted: false, why: gate.why };
    const authority = gate.authority;

    // A situation this world has already paid to think about answers for free.
    // The key is the office plus the SHAPE of the situation, never its text.
    const cacheKey = `${authority.role}|${authority.novel.length}|${authority.novel[0]?.split(' ').slice(0, 3).join(' ') ?? 'quiet'}`;
    const cached: any = await ctx.runQuery(internal.kernel.cacheLookup, { cacheKey });
    if (cached) {
      const reused = JSON.parse(cached.response);
      await ctx.runMutation(internal.kernel.authorityCommit, {
        agentId: authority.agentId, choice: String(reused.choice ?? 'observe'),
        note: String(reused.note ?? ''), model: `${MODEL} (cached)`,
      });
      await ctx.runMutation(internal.kernel.cacheStore, { cacheKey, response: cached.response });
      return { acted: true, cached: true, role: authority.role, choice: reused.choice };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          // Static first, always identical: this is the block the prefix cache
          // discounts, and it only works while nothing before it varies.
          { role: 'system', content: `${WORLD_RULES}\n\n${PERSONAS[authority.role] ?? ''}` },
          // Everything that changes goes last, and stays small.
          {
            role: 'user',
            content: [
              `You are at tile (${authority.position.x}, ${authority.position.y}). Your duty: ${authority.duty}.`,
              'New since you last looked:',
              ...authority.novel.map((line: string) => `- ${line}`),
            ].join('\n'),
          },
        ],
      }),
    });
    if (!response.ok) {
      return { acted: false, why: `model refused: ${response.status}` };
    }
    const body = await response.json();
    const raw = body.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);

    const usage = body.usage ?? {};
    await ctx.runMutation(internal.kernel.recordSpend, {
      agentId: authority.agentId, model: String(body.model ?? MODEL),
      promptTokens: Number(usage.prompt_tokens ?? 0),
      cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
    });

    const committed: any = await ctx.runMutation(internal.kernel.authorityCommit, {
      agentId: authority.agentId,
      choice: String(parsed.choice ?? 'observe'),
      note: String(parsed.note ?? '').slice(0, 240),
      model: String(body.model ?? MODEL),
    });
    // Only cache the dull, repeatable answers. Caching an expansion proposal
    // would let one judgment about density stand in for tomorrow's.
    if (['observe', 'speak'].includes(String(parsed.choice))) {
      await ctx.runMutation(internal.kernel.cacheStore, { cacheKey, response: JSON.stringify(parsed) });
    }
    return {
      acted: true, role: authority.role, choice: committed.choice,
      escalated: Boolean(committed.escalated),
      tokens: Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0),
      cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
    };
  },
});
