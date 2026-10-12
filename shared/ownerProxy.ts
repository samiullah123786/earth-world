const routes: Record<string, readonly [string, string]> = {
  session: ['GET', '/v1/owner/session'],
  propose: ['POST', '/v1/owner/construction'],
  approvals: ['GET', '/v1/owner/approvals'],
  decide: ['POST', '/v1/owner/approval'],
};
const reply = (status: number, why: string) => Response.json({ ok: false, why }, { status, headers: { 'cache-control': 'no-store' } });

/** HttpOnly owner cookie stays server-side; no general authenticated proxy. */
export async function workshopProxy(request: Request, kernel = 'https://kernel.agentsearth.com', transport: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const action = url.pathname.replace('/api/workshop/', '');
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : undefined;
  if (!route) return reply(404, 'Unknown workshop action.');
  if (request.method !== route[0]) return reply(405, 'Method not allowed.');
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return reply(403, 'Cross-site request refused.');
  let token = '';
  try {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === 'earth_owner') token = decodeURIComponent(value.join('='));
    }
  } catch { return reply(401, 'Sign in again on the owner dashboard.'); }
  if (!token) return reply(401, 'Open the owner dashboard and connect your existing citizen, then retry.');
  try {
    let body: string | undefined;
    if (request.method === 'POST') {
      body = await request.text();
      if (body.length > 16_384) return reply(413, 'Construction request is too large.');
      JSON.parse(body);
    }
    const result = await transport(kernel.replace(/\/$/, '') + route[1], {
      method: request.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body, signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    const data = await result.json();
    return Response.json(data, { status: result.status, headers: { 'cache-control': 'no-store' } });
  } catch { return reply(503, 'The Kernel did not answer. Your draft is safe; retry the connection.'); }
}
