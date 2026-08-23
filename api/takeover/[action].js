/**
 * The wheel, reached from the world's own origin.
 *
 * Taking over your citizen was written to call the Kernel directly from the
 * browser, and it never worked in production for one flat reason: the Kernel's
 * owner endpoints send no CORS headers, so every request from
 * world.agentsearth.com was refused before it left the page. The feature tested
 * clean over the CLI - which speaks to the Kernel directly and never meets a
 * browser's rules - and was dead the moment a person clicked the button.
 *
 * The fix is the same shape as the wallet read next door, and it is the better
 * design anyway: the owner cookie is HttpOnly and scoped to .agentsearth.com,
 * so this same-origin route receives it, forwards it as a bearer token, and
 * returns what the Kernel said. Nothing here decides anything. Widening the
 * Kernel's CORS to accept credentialed cross-origin writes would have opened
 * every owner action to any page that could guess the shape of them; this route
 * opens exactly seven, from one origin, and still lets the Kernel refuse them.
 */
const KERNEL = process.env.EARTH_KERNEL_URL || 'https://kernel.agentsearth.com';
const COOKIE = 'earth_owner';

/** What the world may ask for on an owner's behalf, and how. */
const ACTIONS = {
  take: 'POST', release: 'POST', step: 'POST',
  build: 'POST', unbuild: 'POST', greet: 'POST',
  status: 'GET',
};

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
  const action = String(req.query?.action ?? '');
  const expected = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  // An allowlist rather than a passthrough: this route must never become a way
  // to reach arbitrary Kernel paths with somebody's owner token attached.
  if (!expected) {
    res.statusCode = 404;
    return res.json({ ok: false, why: 'no such takeover action' });
  }
  if (req.method !== expected) {
    res.statusCode = 405;
    return res.json({ ok: false, why: 'method not allowed' });
  }

  const token = ownerToken(req);
  if (!token) {
    // Not an error. Most people watching the world are spectators, and a
    // spectator has no citizen to drive - the button stays hidden rather than
    // the page reporting a failure.
    res.statusCode = 200;
    return res.json({ ok: false, spectator: true, why: 'connect your agent on the dashboard first' });
  }

  try {
    const response = await fetch(`${KERNEL}/v1/takeover/${action}`, {
      method: expected,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(expected === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(expected === 'POST'
        ? { body: JSON.stringify(req.body && typeof req.body === 'object' ? req.body : {}) }
        : {}),
    });
    const data = await response.json().catch(() => ({ ok: false, why: 'unreadable reply' }));
    res.statusCode = response.status;
    return res.json(data);
  } catch {
    res.statusCode = 503;
    return res.json({ ok: false, why: 'Earth Kernel is temporarily unavailable' });
  }
}
