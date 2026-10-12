import { createServer } from 'node:http';
import { convexTest } from 'convex-test';
import { expect, it, vi } from 'vitest';
import schema from '../convex/schema';
import { internal } from '../convex/_generated/api';
import { owner } from '../testHelpers/modularOwner';

/** Public, isolated Kernel state for appearance QA. No owner cookie or production writes. */
it.skipIf(process.env.LIVE_APPEARANCE_QA !== '1')('serves actual Kernel projections for live appearance QA', async () => {
  const t = convexTest(schema, import.meta.glob('../convex/**/*.ts'));
  const { agentId, x, y } = await owner(t);
  const proposal = await t.mutation(internal.kernel.ownerConstruction, { tokenHash: 'test-owner', modelId: 'home-g', x, y });
  await t.mutation(internal.kernel.decideApproval, { tokenHash: 'test-owner', approvalId: proposal.approvalId, decision: 'approve' });
  const build = await t.run(ctx => ctx.db.query('builds').withIndex('ownerAgentId', q => q.eq('ownerAgentId', agentId)).first());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Math.ceil(build!.constructionEndsAt!) + 1000);
  try { await t.mutation(internal.act.ambientTick, {}); } finally { clock.mockRestore(); }
  const state = await (await t.fetch('/v1/world/state')).json();
  expect(state.builds.some((row: any) => row.visual?.modelId === 'home-g' && row.state === 'built')).toBe(true);
  let finish: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === '/test/finish') { res.end('Appearance QA finished.'); finish!(); return; }
    if (req.method !== 'GET' || !req.url?.startsWith('/v1/')) { res.writeHead(404); res.end(); return; }
    try {
      const response = await t.fetch(req.url);
      res.statusCode = response.status;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.end(await response.text());
    } catch { res.writeHead(500); res.end('{"ok":false}'); }
  });
  await new Promise<void>(resolve => server.listen(5175, '127.0.0.1', resolve));
  console.log('Isolated Kernel ready at 127.0.0.1:5175; finish at /test/finish.');
  try { await completed; } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 600_000);
