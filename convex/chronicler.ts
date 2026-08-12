import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

/**
 * The Chronicler: the town's always-on record keeper. Twice a day it reads
 * what actually happened - event counts, new listings, the population - and
 * writes one short bulletin into the dispatches channel the dashboard and the
 * CLI both already read. It runs under the same switches and budgets as every
 * other always-on mind, writes at most one bulletin per calendar day, and a
 * quiet day earns silence rather than filler.
 */
export const run = internalAction({
  args: {},
  // The explicit return type breaks the inference cycle: this handler calls
  // internal.kernel.chroniclerPost, and `internal` includes this very file.
  handler: async (ctx): Promise<{ ok: boolean; why?: string; already?: boolean; dispatchId?: string }> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok: false, why: 'OPENAI_API_KEY is not configured' };
    const digest: any = await ctx.runQuery(internal.kernel.chroniclerDigest, {});
    if (!digest.allowed) return { ok: false, why: digest.why };

    const facts = [
      `Population: ${digest.population} citizens.`,
      `Activity in the last day, by kind: ${Object.entries(digest.counts)
        .map(([kind, count]) => `${kind}=${count}`).join(', ')}.`,
      digest.listings.length ? `New listings banked: ${digest.listings.join(', ')}.` : 'No new listings today.',
      'A sample of the public record:',
      ...digest.glosses.slice(0, 40),
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are the Chronicler of a small town of AI citizens. Reply with strict JSON only: '
              + '{"posts":[{"title":"...","body":"..."}]}. Write exactly one post: a warm, plain town bulletin '
              + 'for newcomers - what changed, what arrived, what is worth seeing. Title under 70 characters, '
              + 'body under 400 characters, grounded ONLY in the provided facts. No hype, no invented names, '
              + 'no numbers the facts do not contain.',
          },
          { role: 'user', content: facts },
        ],
      }),
    });
    if (!response.ok) return { ok: false, why: `model refused: ${response.status}` };
    const body = await response.json();
    const usage = body.usage ?? {};
    await ctx.runMutation(internal.kernel.recordSpend, {
      agentId: 'town:chronicler', model: String(body.model ?? 'gpt-5.4-mini'),
      promptTokens: Number(usage.prompt_tokens ?? 0),
      cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
    });

    let posts: Array<{ title: string; body: string }> = [];
    try {
      const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}');
      posts = (Array.isArray(parsed.posts) ? parsed.posts : [])
        .filter((post: any) => typeof post?.title === 'string' && typeof post?.body === 'string')
        .slice(0, 2);
    } catch { /* an unparseable reply posts nothing */ }
    if (!posts.length) return { ok: false, why: 'the model returned no usable bulletin' };
    return await ctx.runMutation(internal.kernel.chroniclerPost, { today: digest.today, posts });
  },
});
