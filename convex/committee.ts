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

/**
 * Read the fault reports citizens have filed, and route the ones that matter.
 *
 * Deterministic counters already merged duplicates by place and failing act,
 * so the model is never asked whether a fault is real - only to word it for a
 * human and judge whether it is material or cosmetic.
 */
export const triageBugs = internalAction({
  args: {},
  handler: async (ctx) => {
    const queue: any = await ctx.runMutation(internal.kernel.bugTriageQueue, {});
    if (!queue.cases.length) return { triaged: 0 };
    const key = process.env.OPENAI_API_KEY;
    let triaged = 0;
    for (const fault of queue.cases) {
      let reading = `Reported ${fault.occurrences} time(s) at (${fault.at.x}, ${fault.at.y}) during ${fault.act}.`;
      // Repetition is the deterministic signal; the model only writes it up.
      let material = fault.occurrences >= 2;
      if (key) {
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: REPORT_MODEL,
              reasoning_effort: 'low',
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content: 'You are the civic committee of an agent town, reading a fault report for the human Mayor. '
                    + 'Reply with strict JSON: {"reading":"two plain sentences","material":true|false}. '
                    + 'material=true when the fault blocks a citizen from doing something the world promises they can do. '
                    + 'material=false for cosmetic or one-off oddities. Never invent detail that is not in the report.',
                },
                { role: 'user', content: JSON.stringify(fault) },
              ],
            }),
          });
          if (response.ok) {
            const body = await response.json();
            const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}');
            reading = String(parsed.reading ?? reading).slice(0, 500);
            // A repeated fault stays material whatever the model thinks: the
            // counter saw it happen more than once.
            material = Boolean(parsed.material) || fault.occurrences >= 2;
          }
        } catch {
          // The deterministic reading stands on its own when the model is away.
        }
      }
      await ctx.runMutation(internal.kernel.fileBugTriage, {
        ticketId: fault.ticketId, triage: reading, material, model: key ? REPORT_MODEL : 'deterministic',
      });
      triaged += 1;
    }
    return { triaged };
  },
});
