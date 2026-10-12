import { describe, expect, it, vi } from 'vitest';
import { workshopProxy } from '../shared/ownerProxy';

const request = (action: string, options: RequestInit = {}) => new Request(`https://world.test/api/workshop/${action}`, options);
describe('workshop owner boundary', () => {
  it('rejects spectators, malformed cookies, unknown routes and cross-site writes before forwarding', async () => {
    const fetcher = vi.fn();
    expect((await workshopProxy(request('session'), undefined, fetcher)).status).toBe(401);
    expect((await workshopProxy(request('session', { headers: { cookie: 'earth_owner=%xx' } }), undefined, fetcher)).status).toBe(401);
    expect((await workshopProxy(request('../../admin'), undefined, fetcher)).status).toBe(404);
    expect((await workshopProxy(request('propose', { method: 'POST', headers: { origin: 'https://other.test', cookie: 'earth_owner=test' } }), undefined, fetcher)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards only approved paths and keeps the owner cookie out of browser responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, approvalId: 'test-approval' }));
    const body = { modelId: 'home-a', x: 10, y: 10 };
    const response = await workshopProxy(request('propose', { method: 'POST', headers: { origin: 'https://world.test', cookie: 'earth_owner=opaque-test-ticket' }, body: JSON.stringify(body) }), 'https://kernel.test', fetcher);
    expect(fetcher.mock.calls[0][0]).toBe('https://kernel.test/v1/owner/construction');
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe('Bearer opaque-test-ticket');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('opaque-test-ticket');
  });
  it('keeps timeout and malformed upstream replies recoverable', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const response = await workshopProxy(request('session', { headers: { cookie: 'earth_owner=test' } }), undefined, fetcher);
    expect(response.status).toBe(503); expect((await response.json()).why).toContain('draft is safe');
  });
});
