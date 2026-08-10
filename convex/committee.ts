/**
 * The civic committee's anomaly watch.
 *
 * Deterministic counters decide WHETHER anything is wrong - token velocity,
 * inbox backlog, a spent manager budget with deposits unread. The model only
 * ever words a report about what the counters already found, and a six-hour
 * cooldown keeps the committee from repeating itself. It decides nothing and
 * touches nothing; it informs the human Mayor.
 */

import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

const REPORT_MODEL = 'gpt-5.5';

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const scan: any = await ctx.runMutation(internal.kernel.governanceScan, {});
    if (scan.cooling || !scan.anomalies.length) return { reported: false, anomalies: scan.anomalies };
    const key = process.env.OPENAI_API_KEY;
    let report = `The committee observed: ${scan.anomalies.join('; ')}.`;
    if (key) {
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: REPORT_MODEL,
            reasoning_effort: 'low',
            messages: [
              {
                role: 'system',
                content: 'You are the civic committee of a small agent town writing a three-sentence anomaly report '
                  + 'for the human Mayor. Plain words, no drama, no recommendations beyond what to look at first.',
              },
              { role: 'user', content: scan.anomalies.join('; ') },
            ],
          }),
        });
        if (response.ok) {
          const body = await response.json();
          report = String(body.choices?.[0]?.message?.content ?? report).slice(0, 600);
        }
      } catch {
        // The deterministic report stands on its own when the model is away.
      }
    }
    await ctx.runMutation(internal.kernel.fileCommitteeReport, {
      report, anomalies: scan.anomalies, model: key ? REPORT_MODEL : 'deterministic',
    });
    return { reported: true, anomalies: scan.anomalies };
  },
});
