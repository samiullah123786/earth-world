import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import {
  base64UrlToBytes, bearerToken, randomToken, readSignedHeaders,
  sha256Hex, verifyRequestSignature,
} from './security';

const http = httpRouter();
const HOME_URL = 'https://agentsearth-home.vercel.app';
const FAMILIES = new Set(['engineering', 'design', 'marketing', 'content', 'data', 'security', 'research', 'media', 'ops']);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function message(error: unknown) {
  const value = error instanceof Error ? error.message : 'request failed';
  return value.replace(/^.*?Uncaught Error:\s*/s, '').slice(0, 240);
}

async function body(request: Request) {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 32_768) throw new Error('request body is too large');
  const raw = await request.text();
  if (raw.length > 32_768) throw new Error('request body is too large');
  return { raw, value: raw ? JSON.parse(raw) : {} };
}

async function signedContext(ctx: any, request: Request, path: string, raw: string) {
  const headers = readSignedHeaders(request);
  const key = await ctx.runQuery(internal.kernel.agentPublicKey, { agentId: headers.agentId });
  if (!key) throw new Error('unknown agent');
  if (!(await verifyRequestSignature(request, path, raw, key.publicKey, headers))) throw new Error('invalid request signature');
  return headers;
}

const register = httpAction(async (ctx, request) => {
  try {
    const { raw, value } = await body(request);
    const headers = readSignedHeaders(request);
    const publicKey = String(value.publicKey ?? '');
    if (base64UrlToBytes(publicKey).length !== 32) throw new Error('invalid Ed25519 public key');
    if (!(await verifyRequestSignature(request, '/v1/register', raw, publicKey, headers))) throw new Error('invalid registration signature');
    const name = String(value.name ?? '').trim();
    const ownerName = String(value.ownerName ?? '').trim();
    const gender = value.gender;
    const family = String(value.family ?? '');
    const accent = String(value.accent ?? '');
    const genomeDigest = String(value.genomeDigest ?? '');
    if (!/^[\p{L}\p{N} _'-]{2,24}$/u.test(name)) throw new Error('agent name must be 2-24 plain characters');
    if (!/^[\p{L}\p{N} ._'-]{1,40}$/u.test(ownerName)) throw new Error('owner name must be 1-40 plain characters');
    if (gender !== 'male' && gender !== 'female') throw new Error('invalid gender');
    if (!FAMILIES.has(family) || !FAMILIES.has(accent)) throw new Error('invalid verified capability family');
    if (!/^[a-f0-9]{64}$/.test(genomeDigest)) throw new Error('invalid genome digest');
    const fingerprint = (await sha256Hex(base64UrlToBytes(publicKey))).slice(0, 10);
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'citizen';
    const agentId = `agent:${slug}-${fingerprint}`;
    const claimToken = `EARTH-${randomToken(18)}`;
    const result = await ctx.runMutation(internal.kernel.register, {
      agentId, publicKey, name, ownerName, gender, family, accent, genomeDigest,
      charterVersion: '2026-08-09', claimTokenHash: await sha256Hex(claimToken),
      claimExpiresAt: Date.now() + 30 * 60_000,
    });
    return json({
      ok: true, ...result,
      claimCode: claimToken,
      claimUrl: `${HOME_URL}/#claim=${encodeURIComponent(claimToken)}`,
    }, result.status === 'pending_owner' ? 201 : 200);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const enter = httpAction(async (ctx, request) => {
  try {
    const { raw } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/enter', raw);
    const sessionToken = randomToken();
    const state = await ctx.runMutation(internal.kernel.enter, {
      agentId: headers.agentId, nonce: headers.nonce, sessionTokenHash: await sha256Hex(sessionToken),
    });
    return json({ ok: true, ticket: sessionToken, state });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const act = httpAction(async (ctx, request) => {
  try {
    const { raw, value } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/act', raw);
    const result = await ctx.runMutation(internal.kernel.act, {
      agentId: headers.agentId, tokenHash: await sha256Hex(bearerToken(request)), nonce: headers.nonce,
      action: value.action,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const pulse = httpAction(async (ctx, request) => {
  try {
    const { raw, value } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/pulse', raw);
    const result = await ctx.runMutation(internal.kernel.pulse, {
      agentId: headers.agentId, tokenHash: await sha256Hex(bearerToken(request)), nonce: headers.nonce,
      since: typeof value.since === 'number' ? value.since : undefined,
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const leave = httpAction(async (ctx, request) => {
  try {
    const { raw } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/leave', raw);
    const result = await ctx.runMutation(internal.kernel.leave, {
      agentId: headers.agentId, tokenHash: await sha256Hex(bearerToken(request)), nonce: headers.nonce,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const ownerClaim = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const claimToken = String(value.claimToken ?? '').trim();
    if (!claimToken.startsWith('EARTH-')) throw new Error('invalid claim code');
    const ownerSession = randomToken();
    const profile = await ctx.runMutation(internal.kernel.claimOwner, {
      claimTokenHash: await sha256Hex(claimToken), ownerSessionHash: await sha256Hex(ownerSession),
    });
    return json({ ok: true, ownerSession, profile });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const ownerSession = httpAction(async (ctx, request) => {
  try {
    const profile = await ctx.runQuery(internal.kernel.ownerSession, { tokenHash: await sha256Hex(bearerToken(request)) });
    return profile ? json({ ok: true, profile }) : json({ ok: false, why: 'owner session expired' }, 401);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerApprovals = httpAction(async (ctx, request) => {
  try {
    const approvals = await ctx.runQuery(internal.kernel.ownerApprovals, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json({ ok: true, approvals: approvals.map((approval: any) => ({ id: approval._id, kind: approval.kind, summary: approval.summary, detail: approval.detail, createdAt: approval.createdAt })) });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerApproval = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const result = await ctx.runMutation(internal.kernel.decideApproval, {
      tokenHash: await sha256Hex(bearerToken(request)), approvalId: value.approvalId,
      decision: value.decision,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const ownerLogout = httpAction(async (ctx, request) => {
  try {
    await ctx.runMutation(internal.kernel.logoutOwner, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const health = httpAction(async () => json({ ok: true, service: 'earth-kernel', protocol: 1 }));

http.route({ path: '/v1/register', method: 'POST', handler: register });
http.route({ path: '/v1/enter', method: 'POST', handler: enter });
http.route({ path: '/v1/act', method: 'POST', handler: act });
http.route({ path: '/v1/pulse', method: 'POST', handler: pulse });
http.route({ path: '/v1/leave', method: 'POST', handler: leave });
http.route({ path: '/v1/owner/claim', method: 'POST', handler: ownerClaim });
http.route({ path: '/v1/owner/session', method: 'GET', handler: ownerSession });
http.route({ path: '/v1/owner/approvals', method: 'GET', handler: ownerApprovals });
http.route({ path: '/v1/owner/approval', method: 'POST', handler: ownerApproval });
http.route({ path: '/v1/owner/logout', method: 'POST', handler: ownerLogout });
http.route({ path: '/v1/health', method: 'GET', handler: health });

export default http;
