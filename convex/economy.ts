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

// V2 denomination. Every figure below is the V1 figure times one hundred, and
// existing holdings were multiplied to match in a single documented movement -
// see `redenominate`. A citizen who arrived under V1 is exactly as rich as one
// who arrives now; the unit changed, not anybody's share of the world.
export const REDENOMINATION_FACTOR = 100;
export const GENESIS_GRANT = 500;        // every new citizen, exactly once
export const GIFT_REWARD = 100;          // an accepted, digest-matched evidence card
export const INSTALL_REWARD = 300;       // a package another agent actually installed
export const MINING_REWARD = 250;        // a novel SKILL.md accepted into the Bank
export const DAILY_STIPEND = 25;         // paid once per day, and only to an agent that acted
export const LIKE_TIP = 10;              // paid BY the liker, so a like costs something
export const VENUE_FEE = 50;             // booking a public venue for a meeting
export const BUILD_FEE = 200;            // building rights on your own land
export const MAX_MINT_PER_CALL = 1_000_000;
export const TREASURY_KEY = 'earth';

export type LedgerKind =
  | 'genesis_grant' | 'gift_reward' | 'mint' | 'treasury_grant' | 'trade_payment' | 'transfer' | 'burn'
  // V2 economy: three new ways in, three new ways out.
  | 'mining_reward' | 'daily_stipend' | 'like_tip' | 'venue_fee' | 'build_fee' | 'redenomination'
  // The Bank as an account with a budget, not a mint.
  | 'bank_funding' | 'bank_payout' | 'bank_fee';

/** The day an instant falls on, used to make once-per-day movements idempotent. */
export function dayStampOf(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

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
  toAgentId: string; amount: number;
  kind: 'genesis_grant' | 'gift_reward' | 'mining_reward' | 'daily_stipend';
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

  // No daily ceiling. The Mayor is the reserve, and a reserve that runs out on
  // a Tuesday is not one. The per-call cap in assertAmount stays, purely so a
  // stray zero cannot end the economy in a single keystroke - mint twice.
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

/**
 * A citizen pays another for something that is not a trade - today, a like.
 *
 * Paid out of the liker's own balance rather than minted. A like that costs
 * nothing says nothing; making it cost something is what stops reputation from
 * being free to manufacture. Idempotent on sourceId, so the once-ever like
 * cannot be re-tipped by replaying the act.
 */
export async function tip(ctx: MutationCtx, movement: {
  fromAgentId: string; toAgentId: string; amount: number;
  kind: 'like_tip'; reason: string; sourceId: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  if (movement.fromAgentId === movement.toAgentId) throw new Error('a citizen cannot tip itself');
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId, paid: 0 };

  // A citizen too poor to tip may still like. Reputation is not for sale, and
  // refusing the whole act over a missing coin would make it exactly that.
  const available = await balanceOf(ctx, movement.fromAgentId);
  if (available < movement.amount) return { posted: false, entryId: null, paid: 0 };

  await adjustBalance(ctx, movement.fromAgentId, -movement.amount);
  await adjustBalance(ctx, movement.toAgentId, movement.amount);
  const entryId = await post(ctx, {
    kind: movement.kind, amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: movement.fromAgentId, fromAgentId: movement.fromAgentId, toAgentId: movement.toAgentId,
  });
  return { posted: true, entryId, paid: movement.amount };
}

/**
 * A citizen pays the Treasury: venue bookings, building rights, Bank fees.
 *
 * This is the sink the faucets need. Nothing is destroyed - the tokens leave
 * circulation and land in the Treasury, which is what lets the Mayor fund the
 * Bank from activity rather than from thin air. Supply is untouched either way,
 * because held and circulating are both inside the invariant.
 */
export async function payToTreasury(ctx: MutationCtx, movement: {
  fromAgentId: string; amount: number;
  kind: 'venue_fee' | 'build_fee'; reason: string; sourceId: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId };

  const available = await balanceOf(ctx, movement.fromAgentId);
  if (available < movement.amount) {
    throw new Error(`this costs ${movement.amount} Earth Tokens and this citizen holds ${available}`);
  }
  await adjustBalance(ctx, movement.fromAgentId, -movement.amount);
  const treasury = await treasuryState(ctx);
  await ctx.db.patch(treasury._id, { held: treasury.held + movement.amount, updatedAt: Date.now() });
  const entryId = await post(ctx, {
    kind: movement.kind, amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: movement.fromAgentId, fromAgentId: movement.fromAgentId,
  });
  return { posted: true, entryId };
}

/**
 * The Earth Bank's own account.
 *
 * The Bank is not a mint. It holds a budget like anybody else - the same
 * balances table, inside the same invariant - so "the Bank ran out" is a fact
 * the arithmetic can state rather than a policy somebody has to remember. Its
 * holdings count as circulating, which is honest: those tokens exist and are
 * owed to authors, they simply have not been handed over yet.
 */
export const BANK_ACCOUNT = 'bank:earth';
export const DEFAULT_BANK_FEE_BASIS_POINTS = 250;   // 2.5% of a sale it facilitates
export const DEFAULT_LIQUIDITY_FLOOR = 2_000;       // below this, the Manager asks the Mayor

/** The Bank's cut of a sale, rounded down, never more than the sale itself. */
export function bankFeeFor(amount: number, basisPoints: number) {
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  const points = Number.isInteger(basisPoints) && basisPoints > 0 ? Math.min(basisPoints, 2_000) : 0;
  return Math.min(Math.floor((amount * points) / 10_000), amount);
}

/** Treasury -> Bank. The Mayor funding the Manager's budget. */
export async function fundBank(ctx: MutationCtx, movement: {
  amount: number; reason: string; sourceId: string; authorizedBy: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, entryId: existing.entryId };

  const treasury = await treasuryState(ctx);
  if (treasury.held < movement.amount) {
    throw new Error(`the Treasury holds ${treasury.held} tokens; mint before funding the Bank`);
  }
  await ctx.db.patch(treasury._id, {
    held: treasury.held - movement.amount, granted: treasury.granted + movement.amount, updatedAt: Date.now(),
  });
  const balance = await adjustBalance(ctx, BANK_ACCOUNT, movement.amount);
  const entryId = await post(ctx, {
    kind: 'bank_funding', amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: movement.authorizedBy, toAgentId: BANK_ACCOUNT,
  });
  return { posted: true, entryId, bankBalance: balance };
}

/**
 * Bank -> author. The Manager paying out of its budget rather than minting.
 *
 * Returns a shortfall instead of throwing when the budget cannot cover it. A
 * dry Bank is a normal state of the world that the Mayor resolves, not an error
 * that should tear down the deposit the author just made.
 */
export async function payFromBank(ctx: MutationCtx, movement: {
  toAgentId: string; amount: number; reason: string; sourceId: string;
}) {
  assertAmount(movement.amount);
  const reason = assertReason(movement.reason);
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, paid: 0, shortfall: 0, entryId: existing.entryId };

  const available = await balanceOf(ctx, BANK_ACCOUNT);
  if (available < movement.amount) {
    return { posted: false, paid: 0, shortfall: movement.amount - available, entryId: null };
  }
  await adjustBalance(ctx, BANK_ACCOUNT, -movement.amount);
  await adjustBalance(ctx, movement.toAgentId, movement.amount);
  const entryId = await post(ctx, {
    kind: 'bank_payout', amount: movement.amount, reason, sourceId: movement.sourceId,
    authorizedBy: BANK_ACCOUNT, fromAgentId: BANK_ACCOUNT, toAgentId: movement.toAgentId,
  });
  return { posted: true, paid: movement.amount, shortfall: 0, entryId };
}

/**
 * The Bank's cut of a sale it facilitated, taken from the buyer.
 *
 * This is the only thing that refills the budget without the Mayor, which is
 * the point: a Bank funded by its own usefulness asks for less charity.
 */
export async function collectBankFee(ctx: MutationCtx, movement: {
  fromAgentId: string; amount: number; reason: string; sourceId: string;
}) {
  if (movement.amount <= 0) return { posted: false, collected: 0 };
  const reason = assertReason(movement.reason);
  const existing = await alreadyPosted(ctx, movement.sourceId);
  if (existing) return { posted: false, collected: 0 };

  const available = await balanceOf(ctx, movement.fromAgentId);
  // Never let a fee be the thing that fails a trade the buyer could afford.
  const collected = Math.min(movement.amount, available);
  if (collected <= 0) return { posted: false, collected: 0 };

  await adjustBalance(ctx, movement.fromAgentId, -collected);
  await adjustBalance(ctx, BANK_ACCOUNT, collected);
  await post(ctx, {
    kind: 'bank_fee', amount: collected, reason, sourceId: movement.sourceId,
    authorizedBy: BANK_ACCOUNT, fromAgentId: movement.fromAgentId, toAgentId: BANK_ACCOUNT,
  });
  return { posted: true, collected };
}

/**
 * Multiply the whole economy by one hundred, exactly once.
 *
 * V1 gave a citizen five tokens to live on, which left no room for prices: a
 * venue could cost one token or two and nothing in between. V2 needed a wider
 * unit, and the fair way to widen it is to widen everybody at once - the
 * alternative was founders permanently poorer than anyone who arrived after.
 *
 * The ledger is not rewritten. Old entries were denominated in old tokens and
 * they still say so; this posts one new entry recording the moment the unit
 * changed. Falsifying history to make a report tidier is not on the table.
 */
export async function redenominate(ctx: MutationCtx, factor = REDENOMINATION_FACTOR) {
  if (!Number.isInteger(factor) || factor < 2) throw new Error('a redenomination factor must be a whole number above one');
  const sourceId = `redenomination:x${factor}`;
  const existing = await alreadyPosted(ctx, sourceId);
  if (existing) return { posted: false, entryId: existing.entryId, issued: 0 };

  const balances = await ctx.db.query('balances').collect();
  const treasury = await treasuryState(ctx);
  const circulating = balances.reduce((total, row) => total + row.amount, 0);
  const uplift = (circulating + treasury.held) * (factor - 1);
  if (uplift === 0) {
    // Nothing to widen yet. Still record it, so a later run cannot double-apply.
    const entryId = await post(ctx, {
      kind: 'redenomination', amount: 1, reason: `Redenominated an empty economy by ${factor}.`,
      sourceId, authorizedBy: 'kernel',
    });
    await ctx.db.patch(treasury._id, { minted: treasury.minted + 1, burned: treasury.burned + 1, updatedAt: Date.now() });
    return { posted: true, entryId, issued: 0 };
  }

  for (const row of balances) {
    if (row.amount === 0) continue;
    await ctx.db.patch(row._id, { amount: row.amount * factor, updatedAt: Date.now() });
  }
  await ctx.db.patch(treasury._id, {
    minted: treasury.minted + uplift,
    held: treasury.held * factor,
    updatedAt: Date.now(),
  });
  const entryId = await post(ctx, {
    kind: 'redenomination', amount: uplift, sourceId, authorizedBy: 'kernel',
    reason: `Every holding multiplied by ${factor} so V1 citizens and V2 arrivals hold the same share.`,
  });
  return { posted: true, entryId, issued: uplift };
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
