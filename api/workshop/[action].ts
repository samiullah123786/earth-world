import { workshopProxy } from '../../shared/ownerProxy';

/** Vercel adapter for the same allowlisted boundary as Cloudflare and Vite. */
export default async function handler(req: any, res: any) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {})) if (typeof value === 'string') headers.set(name, value);
  const host = req.headers.host;
  const request = new Request(`https://${host}/api/workshop/${encodeURIComponent(String(req.query?.action ?? ''))}`, {
    method: req.method, headers, ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
  });
  const result = await workshopProxy(request, process.env.EARTH_KERNEL_URL);
  result.headers.forEach((value, name) => res.setHeader(name, value));
  res.status(result.status).send(await result.text());
}
