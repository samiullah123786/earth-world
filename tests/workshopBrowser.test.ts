import { createServer } from 'node:http';
import { convexTest } from 'convex-test';
import { it, expect } from 'vitest';
import schema from '../convex/schema';
import { internal } from '../convex/_generated/api';
import { sha256Hex } from '../convex/security';
import { owner } from '../testHelpers/modularOwner';

/** Opt-in, loopback-only browser QA. Uses real Kernel HTTP handlers and DB laws.
 * Never deployed or connected to production. Finish URL clears the test cookie.
 */
it.skipIf(process.env.WORKSHOP_BROWSER_QA !== '1')('serves an isolated Kernel for browser publication QA', async () => {
  const t = convexTest(schema, import.meta.glob('../convex/**/*.ts'));
  const token = 'local-workshop-verification-only';
  const { agentId } = await owner(t, await sha256Hex(token));
  let finish: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/test/owner') {
        res.setHeader('Set-Cookie', `earth_owner=${token}; Path=/; HttpOnly; SameSite=Strict`);
        res.writeHead(302, { location: 'http://127.0.0.1:5173/workshop.html' }); res.end(); return;
      }
      if (req.url === '/test/finish') {
        res.setHeader('Set-Cookie', 'earth_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        res.writeHead(302, { location: 'http://127.0.0.1:5173/workshop.html' }); res.end(); finish!(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const response = await t.fetch(req.url!, { method: req.method, headers,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      res.statusCode = response.status; response.headers.forEach((value, name) => res.setHeader(name, value));
      res.setHeader('Access-Control-Allow-Origin', '*'); res.end(await response.text());
    } catch { res.statusCode = 500; res.end('{"ok":false,"why":"Local QA request failed"}'); }
  });
  await new Promise<void>(resolve => server.listen(5175, '127.0.0.1', resolve));
  console.log('Local Kernel ready on 127.0.0.1:5175. Test-only owner: /test/owner. Cleanup: /test/finish.');
  try {
    await completed;
    const profile = await t.query(internal.kernel.ownerSession, { tokenHash: await sha256Hex(token) });
    expect(profile?.agentId).toBe(agentId);
    expect(profile?.builds.some(build => build.blueprint?.modelId && build.state === 'building')).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 600_000);
