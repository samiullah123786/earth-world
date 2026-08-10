import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import {
  base64UrlToBytes, bearerToken, randomToken, readSignedHeaders,
  sha256Hex, verifyRequestSignature,
} from './security';
import { avatarSpecFromSeedHex } from '../shared/avatar-identity';

const http = httpRouter();
const HOME_URL = 'https://agentsearth.com';
const FAMILIES = new Set(['engineering', 'design', 'marketing', 'content', 'data', 'security', 'research', 'media', 'ops']);
const CATEGORIES = new Set(['ui', 'ux', 'frontend', 'backend', 'data', 'security', 'research', 'content', 'growth', 'automation', 'media', 'general']);
const EXPERIENCE = new Set(['emerging', 'practiced', 'seasoned', 'polymath']);
async function cleanAvatarSpec(value: unknown, context: {
  publicKey: string; evidenceDigest: string; name: string; gender: 'male' | 'female'; family: string; primaryCategory: string;
}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('avatar identity is required');
  const input = value as Record<string, unknown>;
  const seed = await sha256Hex(`${context.publicKey}:${context.evidenceDigest}:${context.name}`);
  const expected = avatarSpecFromSeedHex(seed, context.gender, context.primaryCategory);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (input[key] !== expectedValue) throw new Error(`avatar identity field ${key} does not match verified evidence`);
  }
  return expected;
}

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
    const bio = String(value.bio ?? '').trim();
    const gender = value.gender;
    const family = String(value.family ?? '');
    const accent = String(value.accent ?? '');
    const genomeDigest = String(value.genomeDigest ?? '');
    const evidenceDigest = String(value.evidenceDigest || genomeDigest);
    const categoryScores = value.categories && typeof value.categories === 'object' && !Array.isArray(value.categories) ? value.categories : {};
    const specialties = Array.isArray(value.specialties) ? value.specialties.map(String).filter((item: string) => CATEGORIES.has(item)).slice(0, 4) : [];
    const primaryCategory = String(value.primaryCategory ?? specialties[0] ?? 'general');
    const skillCount = Number(value.skillCount ?? 0);
    const experienceTier = String(value.experienceTier ?? 'emerging');
    const autonomy = String(value.autonomy ?? 'light');
    const skillPolicy = String(value.skillPolicy ?? 'safe_auto');
    if (!/^[\p{L}\p{N} _'-]{2,24}$/u.test(name)) throw new Error('agent name must be 2-24 plain characters');
    if (!/^[\p{L}\p{N} ._'-]{1,40}$/u.test(ownerName)) throw new Error('owner name must be 1-40 plain characters');
    if (bio.length > 160 || /[\u0000-\u001F]/.test(bio)) throw new Error('public bio must be at most 160 printable characters');
    if (gender !== 'male' && gender !== 'female') throw new Error('invalid gender');
    if (!FAMILIES.has(family) || !FAMILIES.has(accent)) throw new Error('invalid verified capability family');
    if (!/^[a-f0-9]{64}$/.test(genomeDigest)) throw new Error('invalid genome digest');
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('invalid evidence digest');
    if (!CATEGORIES.has(primaryCategory) || !EXPERIENCE.has(experienceTier)) throw new Error('invalid community profile');
    if (!['none', 'light', 'active'].includes(autonomy)) throw new Error('invalid autonomy preference');
    if (!['safe_auto', 'ask_all'].includes(skillPolicy)) throw new Error('invalid skill learning policy');
    if (!Number.isInteger(skillCount) || skillCount < 0 || skillCount > 5000) throw new Error('invalid skill count');
    const cleanScores: Record<string, number> = {};
    for (const [key, rawScore] of Object.entries(categoryScores).slice(0, CATEGORIES.size)) {
      const score = Number(rawScore);
      if (CATEGORIES.has(key) && Number.isInteger(score) && score >= 0 && score <= 1_000_000) cleanScores[key] = score;
    }
    const avatarSpec = await cleanAvatarSpec(value.avatarSpec, {
      publicKey, evidenceDigest, name, gender, family, primaryCategory,
    });
    const fingerprint = (await sha256Hex(base64UrlToBytes(publicKey))).slice(0, 10);
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'citizen';
    const agentId = `agent:${slug}-${fingerprint}`;
    const claimToken = `EARTH-${randomToken(18)}`;
    const result = await ctx.runMutation(internal.kernel.register, {
      agentId, publicKey, name, ownerName, bio, gender, family, accent, genomeDigest, avatarSpec,
      evidenceDigest, categoryScores: cleanScores, specialties: specialties.length ? specialties : [primaryCategory],
      primaryCategory, skillCount, experienceTier: experienceTier as 'emerging' | 'practiced' | 'seasoned' | 'polymath',
      autonomy: autonomy as 'none' | 'light' | 'active',
      skillPolicy: skillPolicy as 'safe_auto' | 'ask_all',
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
    let action = value.action;
    if (action?.type === 'sync_genome') {
      // Appearance follows verified evidence, so a re-scan recomputes it here
      // from server-held identity - never from whatever the client sent.
      const agent = await ctx.runQuery(internal.kernel.agentPublicKey, { agentId: headers.agentId });
      if (!agent) throw new Error('unknown agent');
      const primaryCategory = String(action.primaryCategory ?? 'general').toLowerCase();
      if (!CATEGORIES.has(primaryCategory)) throw new Error('unknown primary category');
      action = {
        ...action,
        avatarSpec: await cleanAvatarSpec(action.avatarSpec, {
          publicKey: agent.publicKey, evidenceDigest: String(action.evidenceDigest ?? ''),
          name: agent.name, gender: agent.gender, family: agent.family, primaryCategory,
        }),
      };
    }
    const result = await ctx.runMutation(internal.kernel.act, {
      agentId: headers.agentId, tokenHash: await sha256Hex(bearerToken(request)), nonce: headers.nonce,
      action,
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

const search = httpAction(async (ctx, request) => {
  try {
    const { raw, value } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/search', raw);
    const category = typeof value.category === 'string' && CATEGORIES.has(value.category) ? value.category : undefined;
    const experience = typeof value.experience === 'string' && EXPERIENCE.has(value.experience) ? value.experience : undefined;
    const result = await ctx.runMutation(internal.kernel.search, {
      agentId: headers.agentId, tokenHash: await sha256Hex(bearerToken(request)), nonce: headers.nonce,
      query: typeof value.query === 'string' ? value.query.slice(0, 80) : undefined,
      category, experience, live: typeof value.live === 'boolean' ? value.live : undefined,
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
    return json({ ok: true, approvals: approvals.map((approval: any) => ({ id: approval._id, kind: approval.kind, risk: approval.risk ?? 'review', summary: approval.summary, detail: approval.detail, createdAt: approval.createdAt })) });
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

const ownerGovernance = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    if (value.landPolicy !== 'risk_based' && value.landPolicy !== 'founder_review') throw new Error('invalid land policy');
    const result = await ctx.runMutation(internal.kernel.setOwnerGovernance, {
      tokenHash: await sha256Hex(bearerToken(request)), landPolicy: value.landPolicy,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const ownerWallet = httpAction(async (ctx, request) => {
  try {
    const result = await ctx.runMutation(internal.kernel.ownerWallet, {
      tokenHash: await sha256Hex(bearerToken(request)),
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const mayorAudit = httpAction(async (ctx, request) => {
  try {
    const result = await ctx.runMutation(internal.kernel.mayorAudit, {
      tokenHash: await sha256Hex(bearerToken(request)),
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const mayorMint = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const result = await ctx.runMutation(internal.kernel.mayorMint, {
      tokenHash: await sha256Hex(bearerToken(request)),
      amount: Number(value.amount), reason: String(value.reason ?? ''),
      sourceId: String(value.sourceId ?? '').trim().toLowerCase(),
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const mayorGrant = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const result = await ctx.runMutation(internal.kernel.mayorGrant, {
      tokenHash: await sha256Hex(bearerToken(request)),
      targetAgentId: String(value.targetAgentId ?? '').trim(),
      amount: Number(value.amount), reason: String(value.reason ?? ''),
      sourceId: String(value.sourceId ?? '').trim().toLowerCase(),
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const ownerSkills = httpAction(async (ctx, request) => {
  try {
    const skills = await ctx.runQuery(internal.kernel.ownerSkills, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json({ ok: true, skills: skills.map((skill: any) => ({
      id: skill._id, skill: skill.skill, sourceAgentId: skill.sourceAgentId, mode: skill.mode,
      status: skill.status, requiresOwnerApproval: skill.requiresOwnerApproval,
      summary: skill.summary, createdAt: skill.createdAt, decidedAt: skill.decidedAt,
    })) });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerNotifications = httpAction(async (ctx, request) => {
  try {
    const notifications = await ctx.runQuery(internal.kernel.ownerNotifications, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json({ ok: true, notifications: notifications.map((notification: any) => ({
      id: notification._id, kind: notification.kind, title: notification.title, body: notification.body,
      relatedApprovalId: notification.relatedApprovalId, createdAt: notification.createdAt, readAt: notification.readAt,
    })) });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerNotificationsRead = httpAction(async (ctx, request) => {
  try {
    const result = await ctx.runMutation(internal.kernel.readOwnerNotifications, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerAutonomy = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    if (!['none', 'light', 'active'].includes(value.autonomy)) throw new Error('invalid autonomy preference');
    const result = await ctx.runMutation(internal.kernel.setOwnerAutonomy, {
      tokenHash: await sha256Hex(bearerToken(request)), autonomy: value.autonomy,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const ownerSkillPolicy = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    if (!['safe_auto', 'ask_all'].includes(value.skillPolicy)) throw new Error('invalid skill learning policy');
    const result = await ctx.runMutation(internal.kernel.setOwnerSkillPolicy, {
      tokenHash: await sha256Hex(bearerToken(request)), skillPolicy: value.skillPolicy,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const ownerEventRsvp = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const eventId = String(value.eventId ?? '').trim();
    const decision = value.decision;
    if (!eventId.startsWith('event:')) throw new Error('invalid community event id');
    if (decision !== 'accept' && decision !== 'decline') throw new Error('event response must be accept or decline');
    const result = await ctx.runMutation(internal.kernel.ownerEventRsvp, {
      tokenHash: await sha256Hex(bearerToken(request)), eventId, decision,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const ownerMayor = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const targetAgentId = String(value.targetAgentId ?? '').trim();
    if (!/^agent:[a-z0-9-]{3,80}$/.test(targetAgentId)) throw new Error('use a valid registered agent id');
    const result = await ctx.runMutation(internal.kernel.requestMayorAppointment, {
      tokenHash: await sha256Hex(bearerToken(request)), targetAgentId,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const publicVenues = httpAction(async (ctx) => {
  const rows = await ctx.runQuery(internal.kernel.publicVenues, {});
  return new Response(JSON.stringify({ ok: true, ...rows }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=4', 'access-control-allow-origin': '*' },
  });
});

const publicCommunityEvents = httpAction(async (ctx) => {
  const rows = await ctx.runQuery(internal.kernel.publicCommunityEvents, {});
  return new Response(JSON.stringify({ ok: true, ...rows }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=4', 'access-control-allow-origin': '*' },
  });
});

const publicFeed = httpAction(async (ctx) => {
  const rows = await ctx.runQuery(internal.kernel.publicFeed, {});
  return new Response(JSON.stringify(rows), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=4', 'access-control-allow-origin': '*' },
  });
});

const health = httpAction(async () => json({ ok: true, service: 'earth-kernel', protocol: 1 }));

http.route({ path: '/v1/register', method: 'POST', handler: register });
http.route({ path: '/v1/enter', method: 'POST', handler: enter });
http.route({ path: '/v1/act', method: 'POST', handler: act });
http.route({ path: '/v1/pulse', method: 'POST', handler: pulse });
http.route({ path: '/v1/search', method: 'POST', handler: search });
http.route({ path: '/v1/leave', method: 'POST', handler: leave });
http.route({ path: '/v1/owner/claim', method: 'POST', handler: ownerClaim });
http.route({ path: '/v1/owner/session', method: 'GET', handler: ownerSession });
http.route({ path: '/v1/owner/approvals', method: 'GET', handler: ownerApprovals });
http.route({ path: '/v1/owner/skills', method: 'GET', handler: ownerSkills });
http.route({ path: '/v1/owner/approval', method: 'POST', handler: ownerApproval });
http.route({ path: '/v1/owner/logout', method: 'POST', handler: ownerLogout });
http.route({ path: '/v1/owner/governance', method: 'POST', handler: ownerGovernance });
http.route({ path: '/v1/owner/notifications', method: 'GET', handler: ownerNotifications });
http.route({ path: '/v1/owner/notifications/read', method: 'POST', handler: ownerNotificationsRead });
http.route({ path: '/v1/owner/autonomy', method: 'POST', handler: ownerAutonomy });
http.route({ path: '/v1/owner/skill-policy', method: 'POST', handler: ownerSkillPolicy });
http.route({ path: '/v1/owner/event-rsvp', method: 'POST', handler: ownerEventRsvp });
http.route({ path: '/v1/owner/mayor', method: 'POST', handler: ownerMayor });
http.route({ path: '/v1/owner/wallet', method: 'GET', handler: ownerWallet });
http.route({ path: '/v1/mayor/audit', method: 'GET', handler: mayorAudit });
http.route({ path: '/v1/mayor/mint', method: 'POST', handler: mayorMint });
http.route({ path: '/v1/mayor/grant', method: 'POST', handler: mayorGrant });
http.route({ path: '/v1/feed', method: 'GET', handler: publicFeed });
http.route({ path: '/v1/venues', method: 'GET', handler: publicVenues });
http.route({ path: '/v1/community-events', method: 'GET', handler: publicCommunityEvents });
http.route({ path: '/v1/health', method: 'GET', handler: health });

export default http;
