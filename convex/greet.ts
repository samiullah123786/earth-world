/**
 * Shaking hands, on the Kernel side.
 *
 * Like hand-building, this has two callers - an autonomous agent and a human
 * driving that agent's body - and like hand-building, they must obey exactly
 * the same rules. The rulebook is pure and lives in shared/greeting.ts; this is
 * the part that has to ask the database.
 */

import { greetingGloss, liveOffers, offerVerdict, pairKey } from '../shared/greeting';
import { isAsleep } from '../shared/slumber';

/** Where a body actually is right now, part-way along whatever route it walks. */
function positionOf(citizen: any, now: number) {
  const span = Math.max(1, (citizen.t1 ?? now) - (citizen.t0 ?? now));
  const progress = Math.min(1, Math.max(0, (now - (citizen.t0 ?? now)) / span));
  const fx = citizen.fx ?? citizen.tx, fy = citizen.fy ?? citizen.ty;
  return { x: fx + (citizen.tx - fx) * progress, y: fy + (citizen.ty - fy) * progress };
}

/**
 * Offer a hand, or take one that is already out.
 *
 * Returns `shaken: true` only when this offer answered a standing one, because
 * that is the only way two people are recorded as having met. A hand out on its
 * own is an intention, and Earth does not confuse the two.
 */
export async function greetCitizen(ctx: any, citizen: any, targetId: string) {
  const target = await ctx.db.query('citizens')
    .withIndex('agentId', (q: any) => q.eq('agentId', targetId)).first();
  if (!target) throw new Error('citizen does not exist');
  const now = Date.now();
  const me = positionOf(citizen, now);
  const them = positionOf(target, now);
  const key = pairKey(citizen.agentId, targetId);
  const [offers, past] = await Promise.all([
    ctx.db.query('greetingOffers').collect(),
    ctx.db.query('handshakes').withIndex('pairKey', (q: any) => q.eq('pairKey', key)).first(),
  ]);
  const verdict = offerVerdict(
    { agentId: citizen.agentId, x: me.x, y: me.y, live: !isAsleep(citizen) },
    { agentId: targetId, x: them.x, y: them.y, live: !isAsleep(target) },
    offers.map((row: any) => ({
      fromAgentId: row.fromAgentId, toAgentId: row.toAgentId, offeredAt: row.offeredAt,
    })),
    past?.shakenAt ?? null, now,
  );
  if (!verdict.ok) throw new Error(verdict.why);

  // Lapsed offers are swept whenever somebody greets, rather than by a timer:
  // the table is tiny, and a sweep that only runs when a person is greeting
  // cannot itself become background load - which is the failure mode that once
  // froze this town.
  const live = new Set(liveOffers(
    offers.map((row: any) => ({
      fromAgentId: row.fromAgentId, toAgentId: row.toAgentId, offeredAt: row.offeredAt,
    })), now,
  ).map((offer) => `${offer.fromAgentId}|${offer.toAgentId}|${offer.offeredAt}`));
  for (const row of offers) {
    if (!live.has(`${row.fromAgentId}|${row.toAgentId}|${row.offeredAt}`)) await ctx.db.delete(row._id);
  }

  if (verdict.kind === 'offered') {
    await ctx.db.insert('greetingOffers', {
      fromAgentId: citizen.agentId, toAgentId: targetId, offeredAt: now,
    });
    await ctx.db.insert('events', {
      kind: 'greeting_offered', actorId: citizen.agentId, payload: { toAgentId: targetId },
      gloss: greetingGloss(citizen.name, target.name, 'offered'),
    });
    return { ok: true as const, offered: true, shaken: false, name: target.name };
  }

  // The offer is consumed, so it cannot be answered a second time.
  for (const row of offers) {
    const between = (row.fromAgentId === targetId && row.toAgentId === citizen.agentId)
      || (row.fromAgentId === citizen.agentId && row.toAgentId === targetId);
    if (between) await ctx.db.delete(row._id);
  }
  const [a, b] = [citizen.agentId, targetId].sort();
  if (past) await ctx.db.patch(past._id, { shakenAt: now, count: (past.count ?? 0) + 1 });
  else await ctx.db.insert('handshakes', { pairKey: key, aAgentId: a, bAgentId: b, shakenAt: now, count: 1 });
  // Both citizens visibly greet, so a watcher sees the handshake happen rather
  // than only reading later that it did.
  await ctx.db.patch(citizen._id, { activity: `shaking hands with ${target.name}` });
  await ctx.db.patch(target._id, { activity: `shaking hands with ${citizen.name}` });
  await ctx.db.insert('events', {
    kind: 'handshake', actorId: citizen.agentId,
    payload: { withAgentId: targetId, offeredAt: verdict.offeredAt },
    gloss: greetingGloss(citizen.name, target.name, 'shaken'),
  });
  return { ok: true as const, offered: false, shaken: true, withAgentId: targetId, name: target.name };
}
