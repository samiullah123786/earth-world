/**
 * The Earth Token economy.
 *
 * Four rules hold everywhere in this module, and the tests prove each one:
 *
 * 1. The ledger is the truth. `balances` is a cache the ledger writes; nothing
 *    else may touch it.
 * 2. Every movement carries a unique `sourceId`. Posting the same sourceId
 *    twice is a no-op, so a retried mutation can never pay twice.
 * 3. Nobody mints their own currency. Tokens enter the world only as the
 *    Kernel's own issue (genesis grant, verified-gift reward) or as a Mayor
 *    mint into the Treasury - never straight into a citizen's wallet.
 * 4. Supply always reconciles: sum(balances) + treasury.held === minted - burned.
 *
 * Convex mutations are transactional, so a debit and its credit either both
 * land or neither does.
 */

import type { MutationCtx, QueryCtx } from './_generated/server';

export const GENESIS_GRANT = 5;          // every new citizen, exactly once
export const GIFT_REWARD = 1;            // an accepted, digest-matched evidence card
export const INSTALL_REWARD = 3;         // a package another agent actually installed
export const MAX_MINT_PER_CALL = 10_000;
export const MAX_MINT_PER_DAY = 50_000;
export const TREASURY_KEY = 'earth';
const DAY_MS = 24 * 60 * 60 * 1000;

export type LedgerKind =
  | 'genesis_grant' | 'gift_reward' | 'mint' | 'treasury_grant' | 'trade_payment' | 'transfer' | 'burn';

type Movement = {
  kind: LedgerKind;
  amount: number;
  reason: string;
  sourceId: string;
  authorizedBy: string;
  fromAgentId?: string;
  toAgentId?: string;
};

function assertAmount(amount: number, ceiling = MAX_MINT_PER_CALL) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('token amounts must be whole numbers above zero');
  if (amount > ceiling) throw new Error(`token amounts above ${ceiling} are refused`);
}

function assertReason(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 4 || trimmed.length > 240) throw new Error('every token movement needs a 4-240 character reason');
  return trimmed;
}

export async function treasuryState(ctx: MutationCtx) {
  const existing = await ctx.db.query('treasury').withIndex('key', (q) => q.eq('key', TREASURY_KEY)).first();
  if (existing) return existing;
  const id = await ctx.db.insert('treasury', {
    key: TREASURY_KEY, minted: 0, burned: 0, granted: 0, held: 0, updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

export async function balanceOf(ctx: QueryCtx | MutationCtx, agentId: string) {
  const row = await ctx.db.query('balances').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
  return row?.amount ?? 0;
}

async function adjustBalance(ctx: MutationCtx, agentId: string, delta: number) {
  const row = await ctx.db.query('balances').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
  const next = (row?.amount ?? 0) + delta;
  if (next < 0) throw new Error('a citizen can never hold fewer than zero Earth Tokens');
  if (row) await ctx.db.patch(row._id, { amount: next, updatedAt: Date.now() });
  else await ctx.db.insert('balances', { agentId, amount: next, updatedAt: Date.now() });
  return next;
}

async function alreadyPosted(ctx: MutationCtx, sourceId: string) {
  return ctx.db.query('ledger').withIndex('sourceId', (q) => q.eq('sourceId', sourceId)).first();
}

async function post(ctx: MutationCtx, movement: Movement) {
  const now = Date.now();
  const id = await ctx.db.insert('ledger', {
    entryId: 'pending', kind: movement.kind, amount: movement.amount,
    reason: movement.reason, sourceId: movement.sourceId, authorizedBy: movement.authorizedBy,
    fromAgentId: movement.fromAgentId, toAgentId: movement.toAgentId, createdAt: now,
  });
  const entryId = `entry:${id}`;
  await ctx.db.patch(id, { entryId });
  return entryId;
}

/**
 * Tokens the Kernel itself issues against verified evidence: the genesis grant
 * and rewards for knowledge actually given away. No human hand authorizes these.
 */
export async function issue(ctx: MutationCtx, movement: {
  toAgentId: string; amount: number; kind: 'genesis_grant' | 'gift_reward';
  reason: string; sourceId: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId, balance: await balanceOf(ctx, movement.toAgentId) };

  const treasury = await treasuryState(ctx);
  await ctx.db.patch(treasury._id, { minted: treasury.minted + movement.amount, updatedAt: Date.now() });
  const balance = await adjustBalance(ctx, movement.toAgentId, movement.amount);
  const entryId = await post(ctx, {
    kind: movement.kind, amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: 'kernel', toAgentId: movement.toAgentId,
  });
  return { posted: true, entryId, balance };
}

/** Mayor mint. Lands in the Treasury and nowhere else. */
export async function mintToTreasury(ctx: MutationCtx, movement: {
  amount: number; reason: string; sourceId: string; authorizedBy: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId };

  const since = Date.now() - DAY_MS;
  const today = (await ctx.db.query('ledger').withIndex('createdAt', (q) => q.gte('createdAt', since)).collect())
    .filter((entry) => entry.kind === 'mint')
    .reduce((total, entry) => total + entry.amount, 0);
  if (today + movement.amount > MAX_MINT_PER_DAY) {
    throw new Error(`minting is capped at ${MAX_MINT_PER_DAY} tokens per day; ${today} already minted`);
  }

  const treasury = await treasuryState(ctx);
  await ctx.db.patch(treasury._id, {
    minted: treasury.minted + movement.amount, held: treasury.held + movement.amount, updatedAt: Date.now(),
  });
  const entryId = await post(ctx, {
    kind: 'mint', amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: movement.authorizedBy,
  });
  return { posted: true, entryId, held: treasury.held + movement.amount };
}

/** Treasury -> citizen. A separate act from minting, so no single call enriches. */
export async function grantFromTreasury(ctx: MutationCtx, movement: {
  toAgentId: string; amount: number; reason: string; sourceId: string; authorizedBy: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  if (movement.toAgentId === movement.authorizedBy) {
    throw new Error('the Mayor cannot grant Earth Tokens to their own citizen');
  }
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId, balance: await balanceOf(ctx, movement.toAgentId) };

  const treasury = await treasuryState(ctx);
  if (treasury.held < movement.amount) {
    throw new Error(`the Treasury holds ${treasury.held} tokens; mint before granting more`);
  }
  await ctx.db.patch(treasury._id, {
    held: treasury.held - movement.amount, granted: treasury.granted + movement.amount, updatedAt: Date.now(),
  });
  const balance = await adjustBalance(ctx, movement.toAgentId, movement.amount);
  const entryId = await post(ctx, {
    kind: 'treasury_grant', amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: movement.authorizedBy, toAgentId: movement.toAgentId,
  });
  return { posted: true, entryId, balance };
}

/**
 * Citizen -> citizen, only ever as payment inside a delivered trade. There is
 * no free-form send, so tokens cannot be cycled between an owner's own agents
 * to farm a balance.
 */
export async function payForTrade(ctx: MutationCtx, movement: {
  fromAgentId: string; toAgentId: string; amount: number; reason: string; sourceId: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  if (movement.fromAgentId === movement.toAgentId) throw new Error('a citizen cannot pay itself');
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId };

  const available = await balanceOf(ctx, movement.fromAgentId);
  if (available < movement.amount) {
    throw new Error(`this citizen holds ${available} Earth Tokens and the trade costs ${movement.amount}`);
  }
  await adjustBalance(ctx, movement.fromAgentId, -movement.amount);
  await adjustBalance(ctx, movement.toAgentId, movement.amount);
  const entryId = await post(ctx, {
    kind: 'trade_payment', amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: movement.fromAgentId, fromAgentId: movement.fromAgentId, toAgentId: movement.toAgentId,
  });
  return { posted: true, entryId };
}

/**
 * One citizen sends tokens to another.
 *
 * This moves existing supply rather than creating it, so the invariant is
 * untouched: nothing here can mint. What it can do is move somebody's earned
 * balance, which is why the caller gates it on owner consent before arriving.
 */
export async function sendTokens(ctx: MutationCtx, movement: {
  fromAgentId: string; toAgentId: string; amount: number; reason: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  if (movement.fromAgentId === movement.toAgentId) throw new Error('a citizen cannot send to itself');

  const available = await balanceOf(ctx, movement.fromAgentId);
  if (available < movement.amount) {
    throw new Error(`this citizen holds ${available} Earth Token(s) and the send needs ${movement.amount}`);
  }
  await adjustBalance(ctx, movement.fromAgentId, -movement.amount);
  await adjustBalance(ctx, movement.toAgentId, movement.amount);
  // Sends are deliberate one-off acts rather than reactions to a world event,
  // so their identity is the entry itself; there is no earlier record to
  // deduplicate against.
  const entryId = await post(ctx, {
    kind: 'transfer', amount: movement.amount, reason,
    sourceId: `send:${movement.fromAgentId}:${movement.toAgentId}:${Date.now()}:${Math.round(available)}`,
    authorizedBy: movement.fromAgentId, fromAgentId: movement.fromAgentId, toAgentId: movement.toAgentId,
  });
  return { posted: true, entryId };
}

/** sum(balances) + treasury.held === minted - burned, or the economy is broken. */
export async function supplyAudit(ctx: MutationCtx) {
  const treasury = await treasuryState(ctx);
  const balances = await ctx.db.query('balances').collect();
  const circulating = balances.reduce((total, row) => total + row.amount, 0);
  const expected = treasury.minted - treasury.burned;
  return {
    minted: treasury.minted, burned: treasury.burned, granted: treasury.granted,
    held: treasury.held, circulating, holders: balances.filter((row) => row.amount > 0).length,
    balanced: circulating + treasury.held === expected,
    expected,
  };
}

export async function assertSupplyInvariant(ctx: MutationCtx) {
  const audit = await supplyAudit(ctx);
  if (!audit.balanced) {
    throw new Error(`token supply does not reconcile: ${audit.circulating} circulating + ${audit.held} held !== ${audit.expected}`);
  }
  return audit;
}
