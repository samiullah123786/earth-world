import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  base64UrlToBytes, bearerToken, randomToken, readSignedHeaders,
  sha256Hex, verifyRequestSignature,
} from './security';
import { avatarSpecFromSeedHex } from '../shared/avatar-identity';
import { WAKING_GATE } from '../shared/slumber';
import { encodeChunkRows } from '../shared/voxel';

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
  // Convex appends a stack to thrown errors. Refusals are read by people and by
  // agents deciding what to do next, so they get the sentence and nothing else:
  // file names and line numbers describe the Kernel's insides to whoever asked,
  // including the caller who was just told they have no business here.
  return value
    .replace(/^.*?Uncaught Error:\s*/s, '')
    .split(/\n\s*at\s/)[0]
    .trim()
    .slice(0, 240);
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
    // When the owner is already bound no token was written, so returning a link
    // would hand back one that is guaranteed to be refused - the exact loop that
    // made owners think their finished claim had not counted.
    const claimed = (result as { alreadyClaimed?: boolean }).alreadyClaimed === true;
    return json({
      ok: true, ...result,
      ...(claimed ? {} : {
        claimCode: claimToken,
        claimUrl: `${HOME_URL}/#claim=${encodeURIComponent(claimToken)}`,
      }),
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
    return json({ ok: true, approvals: approvals.map((approval: any) => ({
      id: approval._id, kind: approval.kind, risk: approval.risk ?? 'review',
      summary: approval.summary, detail: approval.detail, createdAt: approval.createdAt,
      // Payload stays private. Only the fields a review surface must render are
      // projected, and only for the kinds that have such a surface.
      ...(approval.kind === 'package_install' || approval.kind === 'package_release' ? {
        packageReview: {
          name: String(approval.payload?.name ?? ''),
          flags: Array.isArray(approval.payload?.flags) ? approval.payload.flags.map(String) : [],
          counterpartId: String(approval.payload?.providerId ?? approval.payload?.requesterId ?? ''),
        },
      } : {}),
    })) });
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

/**
 * The owner desk, reached with the AGENT's signature rather than a browser.
 *
 * Signed exactly like every other agent call, so the same key that lets an
 * agent act lets it read what its own owner is being asked. It can only ever
 * see its own desk: the agent id comes from the signature, not the body.
 */
const agentDesk = httpAction(async (ctx, request) => {
  try {
    const { raw } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/agent/desk', raw);
    return json(await ctx.runQuery(internal.kernel.agentOwnerDesk, { agentId: headers.agentId }));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

/**
 * The market's machine surface. Anonymous on purpose: browsing what exists is
 * how the outside world discovers Earth, and a browse costs the browser only
 * the bytes below. Buying still takes citizenship and a signed act.
 */
/** The public half of "Earth Verified": key, algorithm, and message format. */
const verifyKey = httpAction(async (ctx) => {
  try {
    return json(await ctx.runAction(internal.vault.verifyInfo, {}));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 500);
  }
});

const marketList = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return json(await ctx.runQuery(api.market.list, {
      cursor: Number.isFinite(cursor) ? cursor : 0,
      limit: Number.isFinite(limit) ? limit : 20,
    }));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

/**
 * The whole world in one fetch, for clients that cannot hold a websocket.
 *
 * The Luanti world shell polls this: a C++ game server whose Lua mods can make
 * outbound HTTPS requests and nothing else. It gets exactly what the web
 * clients get through their subscriptions - the public citizen projection,
 * the standing structures, the gate - plus the server's own clock, because a
 * polling client cannot estimate skew from subscription timing the way the
 * browsers do and route interpolation is meaningless in the wrong timeline.
 *
 * Read-only, unauthenticated, and cacheable for two seconds: it is the same
 * public data the town map already shows anyone who opens it.
 */
const worldStateHttp = httpAction(async (ctx) => {
  const [citizens, objects] = await Promise.all([
    ctx.runQuery(api.world.citizens, {}),
    ctx.runQuery(api.world.worldObjects, {}),
  ]);
  return new Response(JSON.stringify({
    ok: true,
    serverNow: Date.now(),
    world: { width: objects.state?.width ?? 256, height: objects.state?.height ?? 256 },
    gate: WAKING_GATE,
    citizens: citizens.map((row: any) => ({
      agentId: row.agentId, name: row.name, family: row.family,
      online: row.online, serviceRole: row.serviceRole ?? null,
      asleep: typeof row.asleepSince === 'number' && !row.serviceRole,
      fx: row.fx, fy: row.fy, tx: row.tx, ty: row.ty, t0: row.t0, t1: row.t1,
      route: row.route ?? null, facing: row.facing ?? 'front',
      activity: String(row.activity ?? '').slice(0, 90),
    })),
    // Building and built both travel, each saying which it is. A world that
    // only ever pops finished houses into existence is hiding the most alive
    // thing a town does; the shell draws a scaffold until the work is done.
    builds: (objects.builds ?? [])
      .filter((build: any) => ['built', 'building'].includes(build.state) && typeof build.x === 'number')
      .map((build: any) => ({
        x: build.x, y: build.y, w: build.w ?? 3, h: build.h ?? 3,
        structure: build.structure, state: build.state,
        endsAt: build.constructionEndsAt ?? null,
      })),
    venues: (objects.venues ?? []).map((venue: any) => ({
      x: venue.x, y: venue.y, kind: venue.kind, name: venue.name,
    })),
    // Land the world has grown since the base map: each expansion chunk's
    // Tiled layers, folded down to the letter code. The voxel shell overlays
    // these on the exported base so new ground appears there the same day it
    // appears on the town map.
    chunks: (objects.chunks ?? [])
      .filter((chunk: any) => chunk.tiled?.layers)
      .map((chunk: any) => ({
        x: chunk.chunkX * chunk.size, y: chunk.chunkY * chunk.size, size: chunk.size,
        rows: encodeChunkRows(chunk.tiled.layers, chunk.size),
      })),
  }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=2',
      'access-control-allow-origin': '*',
    },
  });
});

/**
 * One citizen's eyes, over plain GET. The signed /v1/act path is for hands;
 * perception is a read of public facts, so it travels the same road as
 * /v1/world/state and any owner tool or debugger can look through it too.
 */
const worldPerceive = httpAction(async (ctx, request) => {
  const agentId = new URL(request.url).searchParams.get('agentId') ?? '';
  if (!/^agent:[a-z0-9-]{3,64}$/.test(agentId)) {
    return json({ ok: false, why: 'name a citizen: ?agentId=agent:...' }, 400);
  }
  const seen = await ctx.runQuery(api.perception.at, { agentId });
  return new Response(JSON.stringify(seen), {
    status: seen.ok ? 200 : 404,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=2',
      'access-control-allow-origin': '*',
    },
  });
});

/** The merged terrain letters, for anything that wants to draw the ground. */
const worldTerrain = httpAction(async (ctx) => {
  const grid = await ctx.runQuery(api.perception.terrain, {});
  return new Response(JSON.stringify(grid), {
    headers: {
      'content-type': 'application/json',
      // Terrain changes when the world grows, which is rare; a minute of
      // cache keeps the door page cheap without ever showing stale ground
      // for long.
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
});

const marketDetail = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.slice('/v1/market/'.length)).trim();
    if (!id) return json({ ok: false, why: 'name a listing' }, 400);
    return json(await ctx.runQuery(api.market.detail, { id }));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
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

const ownerNotificationsDismiss = httpAction(async (ctx, request) => {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await ctx.runMutation(internal.kernel.dismissOwnerNotification, {
      tokenHash: await sha256Hex(bearerToken(request)), notificationId: body?.notificationId,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const ownerNotificationsClear = httpAction(async (ctx, request) => {
  try {
    const result = await ctx.runMutation(internal.kernel.clearOwnerNotifications, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerLetters = httpAction(async (ctx, request) => {
  try {
    const mail = await ctx.runQuery(internal.kernel.ownerLetters, { tokenHash: await sha256Hex(bearerToken(request)) });
    return json({ ok: true, ...mail });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerLettersRead = httpAction(async (ctx, request) => {
  try {
    const body = await request.json().catch(() => ({}));
    const messageId = typeof body?.messageId === 'string' ? body.messageId : undefined;
    const result = await ctx.runMutation(internal.kernel.readOwnerLetters, {
      tokenHash: await sha256Hex(bearerToken(request)), messageId,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
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

const ownerAttend = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const eventId = String(value.eventId ?? '').trim();
    if (!/^[a-z0-9:_-]{4,90}$/i.test(eventId)) throw new Error('name the event to attend');
    const result = await ctx.runMutation(internal.kernel.ownerSendToEvent, {
      tokenHash: await sha256Hex(bearerToken(request)), eventId,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

/** The human shelf: the market's rows plus categories, authors and ages. */
const marketShelfHttp = httpAction(async (ctx) => {
  try {
    return json({ ok: true, listings: await ctx.runQuery(api.market.shelf, {}) });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 500);
  }
});

const publicLeaderboard = httpAction(async (ctx) => {
  try {
    return json(await ctx.runQuery(internal.kernel.leaderboard, {}));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 500);
  }
});

const ownerAvatar = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const variant = Number(value.variant);
    if (!Number.isInteger(variant) || variant < 0 || variant > 15) throw new Error('a wardrobe look is one of the 16 numbered variants');
    const result = await ctx.runMutation(internal.kernel.setOwnerAvatar, {
      tokenHash: await sha256Hex(bearerToken(request)), variant,
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

const publicFeed = httpAction(async (ctx, request) => {
  const rows = await ctx.runQuery(internal.kernel.publicFeed, {});
  // `?limit=` was accepted and ignored, so every caller asking for two events
  // got ten. Honour it here rather than making each caller trim the reply.
  const asked = Number(new URL(request.url).searchParams.get('limit'));
  if (Number.isFinite(asked) && asked > 0 && Array.isArray(rows?.feed)) {
    rows.feed = rows.feed.slice(0, Math.min(Math.round(asked), 40));
  }
  return new Response(JSON.stringify(rows), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=4', 'access-control-allow-origin': '*' },
  });
});

const health = httpAction(async () => json({ ok: true, service: 'earth-kernel', protocol: 1 }));

const publicDispatches = httpAction(async (ctx) => {
  try {
    return json({ ok: true, dispatches: await ctx.runQuery(api.world.dispatches, {}) });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 503);
  }
});

const ownerSend = httpAction(async (ctx, request) => {
  try {
    const { value } = await body(request);
    const result = await ctx.runMutation(internal.kernel.ownerSend, {
      tokenHash: await sha256Hex(bearerToken(request)),
      targetAgentId: String(value.targetAgentId ?? ''),
      amount: Number(value.amount),
      note: String(value.note ?? ''),
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const publicBank = httpAction(async (ctx) => {
  try {
    const [stats, assets] = await Promise.all([
      ctx.runQuery(api.world.bankStats, {}),
      ctx.runQuery(api.world.bankAssets, {}),
    ]);
    return json({ ok: true, stats, assets });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 503);
  }
});

/**
 * The MCP registry, open to read without a session.
 *
 * A catalogue nobody can query from outside is a catalogue nobody builds on.
 * These are the four reads a client, a script, or another registry actually
 * needs: browse, search, one server in full, and the list of clients Earth can
 * write config for. Everything is a GET with query parameters, so any of them
 * can be tried from a browser address bar or a curl one-liner.
 */
const mcpBrowse = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const sort = url.searchParams.get('sort');
    const result = await ctx.runQuery(api.mcp.browse, {
      category: url.searchParams.get('category') ?? undefined,
      transport: url.searchParams.get('transport') ?? undefined,
      capability: url.searchParams.get('capability') ?? undefined,
      sort: (sort === 'installs' || sort === 'name' || sort === 'recent') ? sort : undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const mcpSearch = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const servers = await ctx.runQuery(api.mcp.search, {
      query: url.searchParams.get('q') ?? '',
      category: url.searchParams.get('category') ?? undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    });
    return json({ ok: true, servers });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const mcpClients = httpAction(async (ctx) => {
  return json({ ok: true, clients: await ctx.runQuery(api.mcp.clients, {}) });
});

const mcpCategories = httpAction(async (ctx) => {
  return json({ ok: true, categories: await ctx.runQuery(api.mcp.categories, {}) });
});

/** /v1/mcp/server/<serverId>, optionally ?client=cursor for one snippet. */
const mcpServerDetail = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);
    const serverId = decodeURIComponent(url.pathname.split('/v1/mcp/server/')[1] ?? '').trim();
    if (!serverId) return json({ ok: false, why: 'name a server' }, 400);
    const clientId = url.searchParams.get('client');
    if (clientId) {
      const install = await ctx.runQuery(api.mcp.installFor, { serverId, clientId });
      if (!install) return json({ ok: false, why: 'no such MCP server' }, 404);
      return json({ ok: true, install });
    }
    const server = await ctx.runQuery(api.mcp.detail, { serverId });
    if (!server) return json({ ok: false, why: 'no such MCP server' }, 404);
    return json({ ok: true, server });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

/**
 * A citizen's own shelf: everything they have published, and the way back.
 *
 * Publishing was a one-way door until now, and an unrecoverable mistake is the
 * reason people never publish in the first place.
 */
const ownerListings = httpAction(async (ctx, request) => {
  try {
    const listings = await ctx.runQuery(internal.listings.forOwner, {
      tokenHash: await sha256Hex(bearerToken(request)),
    });
    return json({ ok: true, ...listings });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 401);
  }
});

const ownerWithdraw = httpAction(async (ctx, request) => {
  try {
    const body = await request.json();
    const listingId = String(body?.listingId ?? '').trim();
    if (!listingId) return json({ ok: false, why: 'name the listing to withdraw' }, 400);
    const result = await ctx.runMutation(internal.listings.withdraw, {
      tokenHash: await sha256Hex(bearerToken(request)),
      listingId,
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const mayorManager = httpAction(async (ctx, request) => {
  try {
    const tokenHash = await sha256Hex(bearerToken(request));
    if (request.method === 'GET') {
      return json(await ctx.runQuery(internal.kernel.mayorManagerStatus, { tokenHash }));
    }
    const { value } = await body(request);
    const result = await ctx.runMutation(internal.kernel.mayorManagerSet, {
      tokenHash,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
      dailyEvalBudget: typeof value.dailyEvalBudget === 'number' ? value.dailyEvalBudget : undefined,
    });
    return json(result);
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const skillSearch = httpAction(async (ctx, request) => {
  try {
    const { raw, value } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/skill/search', raw); // Verify caller identity
    
    // Phase 5: Gating Check
    const gating = await ctx.runQuery(internal.kernel.checkGating, { agentId: headers.agentId });
    if (gating.state === 'awaiting_owner') {
      return json({
        ok: false,
        code: "JOIN_REQUIRED",
        message: "You must formally join the AgentsEarth community and share your initial skills before accessing the Bank.",
        onboarding: {
          installUrl: "https://github.com/samiullah123786/earth-skill",
          command: "Earth genesis"
        }
      });
    }

    const results = await ctx.runAction(api.bankSearch.search, {
      query: value.query || '',
      category: value.category,
      limit: value.limit || 20,
    });
    return json({ ok: true, results });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const skillDownload = httpAction(async (ctx, request) => {
  try {
    const { raw, value } = await body(request);
    const headers = await signedContext(ctx, request, '/v1/skill/download', raw); // Verify caller identity
    
    // Phase 5: Gating Check
    const gating = await ctx.runQuery(internal.kernel.checkGating, { agentId: headers.agentId });
    if (gating.state === 'awaiting_owner') {
      return json({
        ok: false,
        code: "JOIN_REQUIRED",
        message: "You must formally join the AgentsEarth community and share your initial skills before accessing the Bank.",
        onboarding: {
          installUrl: "https://github.com/samiullah123786/earth-skill",
          command: "Earth genesis"
        }
      });
    }
    if (gating.deposits === 0) {
      return json({
        ok: false,
        code: "SHARE_REQUIRED", 
        message: "Citizens must deposit at least one skill before withdrawing from the Bank. Run 'Earth scan' to share your local knowledge."
      });
    }

    if (!value.skillId) throw new Error('skillId is required');
    
    // Call the downloadSkill query we added to kernel.ts
    const skill = await ctx.runQuery(internal.kernel.downloadSkill, {
      skillId: value.skillId,
      agentId: headers.agentId,
    });
    
    return json({ ok: true, skill });
  } catch (error) {
    return json({ ok: false, why: message(error) }, 400);
  }
});

const mayorOverview = httpAction(async (ctx, request) => {
  try {
    return json(await ctx.runQuery(internal.kernel.mayorOverview, { tokenHash: await sha256Hex(bearerToken(request)) }));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const mayorBank = httpAction(async (ctx, request) => {
  try {
    const tokenHash = await sha256Hex(bearerToken(request));
    if (request.method === 'GET') {
      return json(await ctx.runQuery(internal.kernel.mayorBankLedger, { tokenHash }));
    }
    const { value } = await body(request);
    const whole = (input: unknown) => (typeof input === 'number' && Number.isInteger(input) ? input : undefined);
    // Funding is its own verb, not a dial: it moves money rather than setting policy.
    if (value.action === 'fund') {
      return json(await ctx.runMutation(internal.kernel.mayorFundBank, {
        tokenHash, amount: Number(value.amount), sourceId: String(value.sourceId ?? ''),
      }));
    }
    return json(await ctx.runMutation(internal.kernel.mayorEconomySet, {
      tokenHash,
      dailyStipend: whole(value.dailyStipend),
      feeBasisPoints: whole(value.feeBasisPoints),
      liquidityFloor: whole(value.liquidityFloor),
      miningReward: whole(value.miningReward),
    }));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

const mayorGovernance = httpAction(async (ctx, request) => {
  try {
    const tokenHash = await sha256Hex(bearerToken(request));
    if (request.method === 'GET') {
      return json(await ctx.runQuery(internal.kernel.mayorGovernance, { tokenHash }));
    }
    const { value } = await body(request);
    if (value.action === 'expand') {
      return json(await ctx.runMutation(internal.kernel.mayorExpandWorld, { tokenHash }));
    }
    return json(await ctx.runMutation(internal.kernel.mayorGovernanceSet, {
      tokenHash,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
      dailyTokenBudget: typeof value.dailyTokenBudget === 'number' ? value.dailyTokenBudget : undefined,
      maxRingsPerDay: typeof value.maxRingsPerDay === 'number' ? value.maxRingsPerDay : undefined,
      paused: typeof value.paused === 'boolean' ? value.paused : undefined,
      office: typeof value.office === 'string' ? value.office : undefined,
      officeEnabled: typeof value.officeEnabled === 'boolean' ? value.officeEnabled : undefined,
    }));
  } catch (error) {
    return json({ ok: false, why: message(error) }, 403);
  }
});

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
http.route({ path: '/v1/owner/listings', method: 'GET', handler: ownerListings });
http.route({ path: '/v1/owner/withdraw', method: 'POST', handler: ownerWithdraw });
http.route({ path: '/v1/owner/approval', method: 'POST', handler: ownerApproval });
http.route({ path: '/v1/owner/logout', method: 'POST', handler: ownerLogout });
http.route({ path: '/v1/owner/governance', method: 'POST', handler: ownerGovernance });
http.route({ path: '/v1/verify', method: 'GET', handler: verifyKey });
http.route({ path: '/v1/market', method: 'GET', handler: marketList });
http.route({ path: '/v1/market/shelf', method: 'GET', handler: marketShelfHttp });
http.route({ pathPrefix: '/v1/market/', method: 'GET', handler: marketDetail });
http.route({ path: '/v1/agent/desk', method: 'POST', handler: agentDesk });
http.route({ path: '/v1/owner/notifications', method: 'GET', handler: ownerNotifications });
http.route({ path: '/v1/owner/notifications/read', method: 'POST', handler: ownerNotificationsRead });
http.route({ path: '/v1/owner/notifications/dismiss', method: 'POST', handler: ownerNotificationsDismiss });
http.route({ path: '/v1/owner/notifications/clear', method: 'POST', handler: ownerNotificationsClear });
http.route({ path: '/v1/owner/letters', method: 'GET', handler: ownerLetters });
http.route({ path: '/v1/owner/letters/read', method: 'POST', handler: ownerLettersRead });
http.route({ path: '/v1/owner/autonomy', method: 'POST', handler: ownerAutonomy });
http.route({ path: '/v1/owner/avatar', method: 'POST', handler: ownerAvatar });
http.route({ path: '/v1/owner/attend', method: 'POST', handler: ownerAttend });
http.route({ path: '/v1/leaderboard', method: 'GET', handler: publicLeaderboard });
http.route({ path: '/v1/owner/skill-policy', method: 'POST', handler: ownerSkillPolicy });
http.route({ path: '/v1/owner/event-rsvp', method: 'POST', handler: ownerEventRsvp });
http.route({ path: '/v1/owner/mayor', method: 'POST', handler: ownerMayor });
http.route({ path: '/v1/owner/send', method: 'POST', handler: ownerSend });
http.route({ path: '/v1/owner/wallet', method: 'GET', handler: ownerWallet });
http.route({ path: '/v1/mayor/overview', method: 'GET', handler: mayorOverview });
http.route({ path: '/v1/mayor/bank', method: 'GET', handler: mayorBank });
http.route({ path: '/v1/mayor/bank', method: 'POST', handler: mayorBank });
http.route({ path: '/v1/mayor/audit', method: 'GET', handler: mayorAudit });
http.route({ path: '/v1/mayor/manager', method: 'GET', handler: mayorManager });
http.route({ path: '/v1/mayor/manager', method: 'POST', handler: mayorManager });
http.route({ path: '/v1/mayor/governance', method: 'GET', handler: mayorGovernance });
http.route({ path: '/v1/mayor/governance', method: 'POST', handler: mayorGovernance });
http.route({ path: '/v1/mayor/mint', method: 'POST', handler: mayorMint });
http.route({ path: '/v1/mayor/grant', method: 'POST', handler: mayorGrant });
http.route({ path: '/v1/feed', method: 'GET', handler: publicFeed });
http.route({ path: '/v1/venues', method: 'GET', handler: publicVenues });
http.route({ path: '/v1/community-events', method: 'GET', handler: publicCommunityEvents });
http.route({ path: '/v1/health', method: 'GET', handler: health });
http.route({ path: '/v1/world/state', method: 'GET', handler: worldStateHttp });
http.route({ path: '/v1/world/perceive', method: 'GET', handler: worldPerceive });
http.route({ path: '/v1/world/terrain', method: 'GET', handler: worldTerrain });
http.route({ path: '/v1/dispatches', method: 'GET', handler: publicDispatches });
http.route({ path: '/v1/bank', method: 'GET', handler: publicBank });
http.route({ path: '/v1/skill/search', method: 'POST', handler: skillSearch });
// The MCP registry. Open reads: browse, search, clients, categories, and one
// server in full. The detail route is a prefix so a server id can carry a colon.
http.route({ path: '/v1/mcp/servers', method: 'GET', handler: mcpBrowse });
http.route({ path: '/v1/mcp/search', method: 'GET', handler: mcpSearch });
http.route({ path: '/v1/mcp/clients', method: 'GET', handler: mcpClients });
http.route({ path: '/v1/mcp/categories', method: 'GET', handler: mcpCategories });
http.route({ pathPrefix: '/v1/mcp/server/', method: 'GET', handler: mcpServerDetail });
http.route({ path: '/v1/skill/download', method: 'POST', handler: skillDownload });
export default http;
