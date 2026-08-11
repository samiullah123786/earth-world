/**
 * The world's own wallet read.
 *
 * The full-screen map used to show a dash where a balance should be. The
 * balance was only ever handed in by postMessage from the dashboard that
 * embeds the map, so a map opened directly had nobody to hand it one.
 *
 * It could not simply call the dashboard's endpoint either: the owner cookie
 * is HttpOnly and, until now, host-only. Widening it to .agentsearth.com means
 * this host receives it too, and this route is what turns it into a number.
 *
 * It carries no authority of its own. It reads a cookie it cannot decode,
 * forwards it, and returns what the Kernel said. The Kernel is still the only
 * thing that decides whether a session may see a balance.
 */
// This package is ESM ("type": "module"), so the handler is an export, not a
// module.exports - the CommonJS form deploys fine and then fails at invocation.
const KERNEL = process.env.EARTH_KERNEL_URL || 'https://kernel.agentsearth.com';
const COOKIE = 'earth_owner';

function ownerToken(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.json({ ok: false, why: 'method not allowed' });
  }
  const token = ownerToken(req);
  if (!token) {
    // Not an error. Most people watching the world are spectators, and a
    // spectator has no wallet to show - the HUD says so rather than breaking.
    res.statusCode = 200;
    return res.json({ ok: false, spectator: true });
  }
  try {
    const response = await fetch(`${KERNEL}/v1/owner/wallet`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({ ok: false }));
    res.statusCode = response.status;
    return res.json(data);
  } catch (error) {
    res.statusCode = 503;
    return res.json({ ok: false, why: 'Earth Kernel is temporarily unavailable' });
  }
};
