import { CREATION_LIMITS, CREATION_VERSION, creationCollision, creationCost, creationExtent, evaluateSignals, parseCreation, partIsActive, starterHome, type CreationPlan } from '../shared/creation';
import { currentPosition, appendRouteHistory } from '../shared/position';
import { balanceOf, payToTreasury } from './economy';
import { ensureWorldState } from './planning';
import { loadTerrainLetters, loadWorldWalkability } from './worldGrid';
import { findRoute } from './pathfinding';
import { sha256Hex } from './security';

const byId = (ctx: any, creationId: string) => ctx.db.query('creations').withIndex('creationId', (q: any) => q.eq('creationId', creationId)).first();
export function publicCreation(row: any) {
  return { creationId: row.creationId, ownerAgentId: row.ownerAgentId, requestId: row.requestId, name: row.name, kind: row.kind, revision: row.revision, state: row.state, progress: row.progress, totalParts: row.plan.parts.length, plan: row.plan, signals: row.signals, switches: row.switches, paid: row.paid, pauseReason: row.pauseReason ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt, completedAt: row.completedAt ?? null };
}
export async function inspectCreations(ctx: any, agentId: string, creationId?: string) {
  if (creationId) { const row = await byId(ctx, creationId); if (!row) throw new Error('Creation was not found.'); return { ok: true, creation: publicCreation(row) }; }
  const rows = await ctx.db.query('creations').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', agentId)).collect();
  return { ok: true, creations: rows.map(publicCreation) };
}
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const requestIdOf = (value: unknown) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw new Error('Use a stable requestId of 8–80 letters, digits, underscores or hyphens.'); return value; };
const prefixPreserved = (old: CreationPlan, next: CreationPlan) => old.parts.every((part, index) => ['id', 'shape', 'material', 'x', 'y', 'z', 'w', 'h', 'd'].every(key => (part as any)[key] === (next.parts[index] as any)?.[key]));

/** Whole-site checks are repeated at approval and before committing; preview grants no authority. */
export async function validateCreation(ctx: any, agent: any, input: unknown, creationId?: string, expectedRevision?: number, allowUnchanged = false) {
  const plan = parseCreation(input), extent = creationExtent(plan);
  if (agent.ownerName?.length >= 3 && plan.name.toLowerCase().includes(agent.ownerName.toLowerCase())) throw new Error('Keep the private owner name out of public creations.');
  const world = await ensureWorldState(ctx);
  const [plots, builds, creations, blocks, venues, letterAt] = await Promise.all([
    ctx.db.query('plots').collect(), ctx.db.query('builds').collect(), ctx.db.query('creations').collect(), ctx.db.query('placedBlocks').collect(), ctx.db.query('venues').collect(), loadTerrainLetters(ctx, world),
  ]);
  const plot = plots.find((p: any) => p.ownerAgentId === agent.agentId && plan.x >= p.x && plan.y >= p.y && plan.x + extent.w <= p.x + p.w && plan.y + extent.h <= p.y + p.h);
  if (!plot) throw new Error('The entire creation must fit inside your owned plot. Claim land or request a larger plot first.');
  const previous = creationId ? creations.find((r: any) => r.creationId === creationId) : null;
  if (creationId && (!previous || previous.ownerAgentId !== agent.agentId)) throw new Error('Only the owner may revise a creation.');
  if (previous && previous.revision !== expectedRevision) throw new Error('Creation revision changed. Inspect it before revising.');
  if (previous && (!prefixPreserved(previous.plan, plan) || plan.x !== previous.plan.x || plan.y !== previous.plan.y || plan.kind !== previous.kind)) throw new Error('Revisions preserve existing parts and location; extend by appending supported parts.');
  if (previous && !allowUnchanged && plan.parts.length <= previous.plan.parts.length) throw new Error('Append at least one supported part to extend a creation.');
  if (!previous && creations.filter((r: any) => r.ownerAgentId === agent.agentId).length >= CREATION_LIMITS.creationsPerOwner) throw new Error('This plot already has eight creations. Extend an existing creation.');
  if (plan.kind === 'home' && (builds.some((b: any) => b.ownerAgentId === agent.agentId && b.state !== 'razed' && (b.structure === 'home' || b.blueprint?.kind === 'home')) || creations.some((r: any) => r.ownerAgentId === agent.agentId && r.kind === 'home' && r.creationId !== creationId))) throw new Error('One home per citizen. Extend your existing home instead of creating another.');
  const rect = { x: plan.x, y: plan.y, ...extent };
  if (builds.some((b: any) => b.state !== 'razed' && typeof b.x === 'number' && overlap(rect, { x: b.x, y: b.y, w: b.w ?? 1, h: b.h ?? 1 }))) throw new Error('An existing structure occupies this site.');
  if (creations.some((r: any) => r.creationId !== creationId && overlap(rect, { x: r.plan.x, y: r.plan.y, ...creationExtent(r.plan) }))) throw new Error('Another creation occupies this site.');
  if (blocks.some((b: any) => b.x >= rect.x && b.x < rect.x + rect.w && b.y >= rect.y && b.y < rect.y + rect.h)) throw new Error('Hand-built blocks occupy this site.');
  if (venues.some((v: any) => overlap(rect, { x: v.x, y: v.y, w: v.w ?? 1, h: v.h ?? 1 }))) throw new Error('A public venue must stay clear.');
  for (let x = rect.x; x < rect.x + rect.w; x++) for (let y = rect.y; y < rect.y + rect.h; y++) if (!['g', 'd', 'c', 'u'].includes(letterAt(x, y))) throw new Error(`Terrain at (${x}, ${y}) is protected, a road, water or blocked.`);
  const walkable = await loadWorldWalkability(ctx, world);
  // Keep a usable approach tile outside the assembled walls. It may be on the plot's yard.
  const approach = { x: plan.x + Math.floor(extent.w / 2), y: plan.y + extent.h };
  if (!walkable(approach.x, approach.y)) throw new Error('Leave a walkable south approach outside the creation.');
  const cost = creationCost(plan) - (previous ? creationCost(previous.plan) : 0);
  if (cost < 0) throw new Error('Creation extensions do not refund materials.');
  const balance = await balanceOf(ctx, agent.agentId);
  if (balance < cost) throw new Error(`Materials cost ${cost} Earth Tokens; your wallet holds ${balance}.`);
  return { plan, plot, cost, balance, previous, approach, world };
}

/** Kernel-owned recipe is editable data, not a fake AI inference or a second home grant. */
export async function creationRecipe(ctx: any, agent: any, action: any) {
  if (action.recipe !== 'starter-home') throw new Error('The available recipe is starter-home.');
  const plot = await ctx.db.query('plots').withIndex('ownerAgentId', (q: any) => q.eq('ownerAgentId', agent.agentId)).first();
  if (!plot) throw new Error('Claim an owned home plot first.');
  const x = action.x ?? plot.x, y = action.y ?? plot.y;
  const plan = starterHome(x, y, action.name ?? 'Timber Courtyard Home');
  const checked = await validateCreation(ctx, agent, plan);
  return { ok: true, plan: checked.plan, cost: checked.cost, catalog: CREATION_VERSION, limits: CREATION_LIMITS };
}

export async function requestCreation(ctx: any, agent: any, citizen: any, action: any, approve: (payload: any) => Promise<any>, explicit = false): Promise<any> {
  const requestId = requestIdOf(action.requestId), plan = parseCreation(action.plan);
  const digest = await sha256Hex(JSON.stringify({ plan, creationId: action.creationId ?? null, expectedRevision: action.expectedRevision ?? null }));
  let request = await ctx.db.query('creationRequests').withIndex('owner_request', (q: any) => q.eq('ownerAgentId', agent.agentId).eq('requestId', requestId)).first();
  if (request && request.digest !== digest) throw new Error('This requestId already identifies a different plan.');
  if (request?.creationId) { const row = await byId(ctx, request.creationId); return { ok: true, ...publicCreation(row), replayed: true }; }
  if (request?.approvalId && !explicit) {
    const approval = await ctx.db.get(request.approvalId);
    return { ok: true, state: approval?.state === 'pending' ? 'awaiting_owner' : approval?.state ?? 'unavailable', awaitingOwner: approval?.state === 'pending', approvalId: request.approvalId, requestId };
  }
  const checked = await validateCreation(ctx, agent, plan, action.creationId, action.expectedRevision);
  const requiresFounder = checked.world.landPolicy === 'founder_review';
  if (!explicit && (agent.autonomy !== 'active' || requiresFounder)) {
    const stage = agent.autonomy === 'active' && requiresFounder ? 'founder' : 'owner';
    const approvalFor = stage === 'founder' ? checked.world.founderAgentId ?? checked.world.mayorAgentId : agent.agentId;
    if (!approvalFor) throw new Error('Required civic review is unavailable.');
    const approvalId = await approve({ ...action, plan, requestId, requesterId: agent.agentId, stage, approvalFor });
    await ctx.db.insert('creationRequests', { ownerAgentId: agent.agentId, requestId, digest, approvalId });
    return { ok: true, state: 'awaiting_owner', awaitingOwner: true, approvalId, requestId, cost: checked.cost };
  }
  if (citizen.drivenUntil > Date.now()) throw new Error('Release owner control before starting an autonomous build.');
  if (citizen.activeBuildId && citizen.buildingUntil > Date.now()) throw new Error('Finish or pause the current build first.');
  if (checked.previous?.ownerPaused && !explicit) throw new Error('The owner must resume this paused job before the agent revises it.');
  const otherJobs = await ctx.db.query('creations').withIndex('state_updated', (q: any) => q.eq('state', 'building')).collect();
  if (otherJobs.some((job: any) => job.ownerAgentId === agent.agentId && job.creationId !== checked.previous?.creationId)) throw new Error('Pause or finish the other active creation first.');
  const now = Date.now(), start = currentPosition(citizen, now);
  const walkable = await loadWorldWalkability(ctx, checked.world);
  const path = findRoute(start.x, start.y, checked.approach.x, checked.approach.y, checked.world, walkable);
  if (!path?.length) throw new Error('No safe route reaches the construction approach.');
  let at = now + 900; const route = [{ ...start, at }];
  for (const point of path.slice(1)) { const previous = route[route.length - 1]; at += Math.hypot(point.x - previous.x, point.y - previous.y) / 2.2 * 1000; route.push({ ...point, at }); }
  const progress = checked.previous?.progress ?? 0;
  const switches: Record<string, boolean> = { ...(checked.previous?.switches ?? {}) };
  // Doors are initially open; a citizen must never be entombed when construction finishes.
  for (const binding of plan.bindings) if (binding.behavior === 'door' && plan.circuits.find(c => c.id === binding.signalId)?.type === 'switch' && switches[binding.signalId] === undefined) switches[binding.signalId] = true;
  const signals = safeDoorState({ plan }, evaluateSignals(plan, switches, now), await ctx.db.query('citizens').collect(), now);
  await payToTreasury(ctx, { fromAgentId: agent.agentId, amount: checked.cost, kind: 'build_fee', reason: `${citizen.name} reserved materials for ${plan.name}.`, sourceId: `creation:${agent.agentId}:${requestId}` });
  const fields = { ownerAgentId: agent.agentId, plotId: checked.plot.plotId, requestId, name: plan.name, kind: plan.kind, plan, progress, switches, signals, revision: (checked.previous?.revision ?? 0) + 1, state: 'building', paid: (checked.previous?.paid ?? 0) + checked.cost, consent: explicit ? 'explicit' : 'standing', updatedAt: now, lastStepAt: at, startsAt: at, ownerPaused: false, pauseReason: undefined };
  let rowId = checked.previous?._id, creationId = checked.previous?.creationId;
  if (rowId) await ctx.db.patch(rowId, fields);
  else { rowId = await ctx.db.insert('creations', { ...fields, creationId: 'pending', createdAt: now }); creationId = `creation:${rowId}`; await ctx.db.patch(rowId, { creationId }); }
  if (request) await ctx.db.patch(request._id, { creationId });
  else await ctx.db.insert('creationRequests', { ownerAgentId: agent.agentId, requestId, digest, creationId });
  await ctx.db.patch(citizen._id, { route, recentRoutes: appendRouteHistory(citizen, route, now), fx: start.x, fy: start.y, tx: checked.approach.x, ty: checked.approach.y, t0: route[0].at, t1: at, activeBuildId: creationId, activeTool: 'hammer', buildingStartsAt: at, buildingUntil: at + (plan.parts.length - progress) * 1000 + 15000, activity: `walking to build ${plan.name}` });
  await ctx.db.insert('events', { kind: 'creation_started', actorId: agent.agentId, payload: { creationId, parts: plan.parts.length, revision: fields.revision }, gloss: `${citizen.name} reserved ${checked.cost} Earth Tokens of materials and began ${plan.name}.` });
  return { ok: true, ...publicCreation(await ctx.db.get(rowId)) };
}

export async function controlCreation(ctx: any, agentId: string, action: any, ownerControl = false) {
  const row = await byId(ctx, action.creationId);
  if (!row || row.ownerAgentId !== agentId) throw new Error('Only the owner can control this construction.');
  if (action.expectedRevision !== row.revision) throw new Error('Creation revision changed; inspect and retry.');
  if (!['pause', 'resume'].includes(action.command)) throw new Error('Choose pause or resume.');
  if (row.state === 'built') throw new Error('Construction is complete. Submit an extension instead.');
  const agent = await ctx.db.query('agents').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
  if (action.command === 'resume' && !ownerControl && (row.ownerPaused || row.consent === 'standing' && agent?.autonomy !== 'active')) throw new Error('The owner must resume this paused job.');
  const now = Date.now();
  if (action.command === 'pause' && row.state === 'paused') {
    if (ownerControl && !row.ownerPaused) {
      await ctx.db.patch(row._id, { ownerPaused: true, revision: row.revision + 1, updatedAt: now });
      return { ok: true, ...publicCreation(await ctx.db.get(row._id)) };
    }
    return { ok: true, ...publicCreation(row) };
  }
  const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', agentId)).first();
  let startAt = now;
  if (action.command === 'resume') {
    if (!citizen || citizen.drivenUntil > now) throw new Error('Release owner control before resuming construction.');
    const jobs = await ctx.db.query('creations').withIndex('state_updated', (q: any) => q.eq('state', 'building')).collect();
    if (jobs.some((job: any) => job.ownerAgentId === agentId && job.creationId !== row.creationId) || citizen.activeBuildId && citizen.activeBuildId !== row.creationId && citizen.buildingUntil > now) throw new Error('Pause or finish the other active build first.');
    const checked = await validateCreation(ctx, agent, row.plan, row.creationId, row.revision, true);
    const from = currentPosition(citizen, now), walkable = await loadWorldWalkability(ctx, checked.world);
    const path = findRoute(from.x, from.y, checked.approach.x, checked.approach.y, checked.world, walkable);
    if (!path?.length) throw new Error('No safe route reaches this paused construction.');
    let at = now + 900; const route = [{ ...from, at }];
    for (const point of path.slice(1)) { const previous = route[route.length - 1]; at += Math.hypot(point.x - previous.x, point.y - previous.y) / 2.2 * 1000; route.push({ ...point, at }); }
    startAt = at;
    await ctx.db.patch(citizen._id, { route, recentRoutes: appendRouteHistory(citizen, route, now), fx: from.x, fy: from.y, tx: checked.approach.x, ty: checked.approach.y, t0: route[0].at, t1: at, activeBuildId: row.creationId, activeTool: 'hammer', buildingStartsAt: at, buildingUntil: at + 15000, activity: `returning to build ${row.name}` });
  }
  await ctx.db.patch(row._id, { state: action.command === 'pause' ? 'paused' : 'building', revision: row.revision + 1, lastStepAt: startAt, startsAt: startAt, updatedAt: now, ownerPaused: action.command === 'pause' && (ownerControl || row.ownerPaused), pauseReason: action.command === 'pause' ? 'Paused by the owner or agent.' : undefined, ...(ownerControl && action.command === 'resume' ? { consent: 'explicit' } : {}) });
  if (citizen?.activeBuildId === row.creationId && action.command === 'pause') { const pos = currentPosition(citizen, now); const route = [{ ...pos, at: now }]; await ctx.db.patch(citizen._id, { route, recentRoutes: appendRouteHistory(citizen, route, now), fx: pos.x, fy: pos.y, tx: pos.x, ty: pos.y, t0: now, t1: now, activeBuildId: undefined, activeTool: undefined, buildingStartsAt: undefined, buildingUntil: undefined, activity: `paused ${row.name}` }); }
  return { ok: true, ...publicCreation(await ctx.db.get(row._id)) };
}

function safeDoorState(row: any, desired: Record<string, boolean>, citizens: any[], now: number) {
  const safe = { ...desired };
  for (const binding of row.plan.bindings) {
    if (binding.behavior !== 'door' || safe[binding.signalId]) continue;
    const part = row.plan.parts.find((p: any) => p.id === binding.partId);
    if (citizens.some((c: any) => { const pos = currentPosition(c, now); return Math.floor(pos.x) >= Math.floor(row.plan.x + part.x) && Math.floor(pos.x) < Math.ceil(row.plan.x + part.x + part.w) && Math.floor(pos.y) >= Math.floor(row.plan.y + part.z) && Math.floor(pos.y) < Math.ceil(row.plan.y + part.z + part.d); })) safe[binding.signalId] = true;
  }
  return safe;
}
export async function useCreation(ctx: any, citizen: any, action: any) {
  const row = await byId(ctx, action.creationId);
  if (!row || row.state !== 'built') throw new Error('Finish construction before using its components.');
  if (action.expectedRevision !== undefined && action.expectedRevision !== row.revision) throw new Error('Creation revision changed; inspect and retry.');
  const part = row.plan.parts.find((p: any) => p.id === action.partId);
  if (!part || !['door', 'lamp', 'switch'].includes(part.shape)) throw new Error('Choose a door, lamp or switch part.');
  const pos = currentPosition(citizen, Date.now());
  if (Math.hypot(pos.x - row.plan.x - part.x - part.w / 2, pos.y - row.plan.y - part.z - part.d / 2) > 3) throw new Error('Walk within three tiles to use this component.');
  if (!['toggle', 'open', 'close'].includes(action.event)) throw new Error('Use toggle, open or close.');
  let binding = row.plan.bindings.find((b: any) => b.partId === part.id);
  const signal = row.plan.circuits.find((c: any) => c.id === binding?.signalId);
  if (!signal || signal.type !== 'switch') throw new Error('This component is driven by logic; use its source switch.');
  const switches = { ...row.switches, [signal.id]: action.event === 'toggle' ? !row.switches[signal.id] : action.event === 'open' };
  const desired = evaluateSignals(row.plan, switches, Date.now()), citizens = await ctx.db.query('citizens').collect();
  const signals = safeDoorState(row, desired, citizens, Date.now());
  if (Object.keys(desired).some(k => desired[k] !== signals[k])) throw new Error('The doorway is occupied. Wait until it is clear before closing.');
  await ctx.db.patch(row._id, { switches, signals, revision: row.revision + 1, updatedAt: Date.now() });
  await ctx.db.insert('events', { kind: 'creation_used', actorId: citizen.agentId, payload: { creationId: row.creationId, partId: part.id, event: action.event }, gloss: `${citizen.name} used ${part.id} at ${row.name}.` });
  return { ok: true, ...publicCreation(await ctx.db.get(row._id)) };
}

/** Bounded resumable deterministic execution of already authorized plans; no model calls. */
export async function tickCreations(ctx: any, now = Date.now()) {
  const governance = await ctx.db.query('governanceConfig').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
  if (governance?.townPaused) return { ok: true, paused: true, advanced: 0 };
  const jobs = await ctx.db.query('creations').withIndex('state_updated', (q: any) => q.eq('state', 'building')).take(16);
  const citizens = await ctx.db.query('citizens').collect();
  let advanced = 0;
  for (const row of jobs) {
    const agent = await ctx.db.query('agents').withIndex('agentId', (q: any) => q.eq('agentId', row.ownerAgentId)).first();
    const plot = await ctx.db.query('plots').withIndex('plotId', (q: any) => q.eq('plotId', row.plotId)).first();
    if (!agent || plot?.ownerAgentId !== row.ownerAgentId || row.consent === 'standing' && agent.autonomy !== 'active') {
      await ctx.db.patch(row._id, { state: 'paused', pauseReason: 'Ownership or standing consent changed.', revision: row.revision + 1, updatedAt: now });
      const c = citizens.find((item: any) => item.agentId === row.ownerAgentId);
      if (c?.activeBuildId === row.creationId) {
        const pos = currentPosition(c, now), route = [{ ...pos, at: now }];
        await ctx.db.patch(c._id, { fx: pos.x, fy: pos.y, tx: pos.x, ty: pos.y, route, recentRoutes: appendRouteHistory(c, route, now), t0: now, t1: now, activeBuildId: undefined, activeTool: undefined, buildingStartsAt: undefined, buildingUntil: undefined, activity: `paused ${row.name}` });
      }
      continue;
    }
    const builder = citizens.find((c: any) => c.agentId === row.ownerAgentId);
    if (!builder || builder.activeBuildId !== row.creationId || builder.drivenUntil > now) { await ctx.db.patch(row._id, { state: 'paused', pauseReason: 'Builder commitment changed; resume from the site.', updatedAt: now, revision: row.revision + 1 }); continue; }
    if (now < row.startsAt || now < row.lastStepAt + 1000) continue;
    const extent = creationExtent(row.plan), pos = currentPosition(builder, now);
    if (Math.hypot(pos.x - row.plan.x - Math.floor(extent.w / 2), pos.y - row.plan.y - extent.h) > 1.5) continue;
    const amount = Math.min(8, Math.floor((now - row.lastStepAt) / 1000));
    let progress = row.progress;
    // Do not place a solid part over an occupied body; retry without swallowing the step.
    for (let i = 0; i < amount && progress < row.plan.parts.length; i++) {
      const candidate = { plan: row.plan, signals: row.signals, progress: progress + 1 };
      const previous = new Set(creationCollision({ ...candidate, progress }).map(c => `${c.x},${c.y}`));
      const newCells = creationCollision(candidate).filter(c => !previous.has(`${c.x},${c.y}`));
      if (citizens.some((c: any) => { const p = currentPosition(c, now); return newCells.some(cell => Math.floor(p.x) === cell.x && Math.floor(p.y) === cell.y); })) break;
      progress++;
    }
    if (progress === row.progress) continue;
    const finished = progress === row.plan.parts.length, desired = evaluateSignals(row.plan, row.switches, now);
    const signals = safeDoorState(row, desired, citizens, now);
    await ctx.db.patch(row._id, { progress, state: finished ? 'built' : 'building', revision: row.revision + 1, signals, lastStepAt: now, updatedAt: now, ...(finished ? { completedAt: now } : {}) });
    const citizen = citizens.find((c: any) => c.agentId === row.ownerAgentId);
    if (citizen?.activeBuildId === row.creationId) await ctx.db.patch(citizen._id, { activity: finished ? `completed ${row.name}` : `building ${row.name}: ${progress}/${row.plan.parts.length} parts`, ...(finished ? { activeBuildId: undefined, activeTool: undefined, buildingStartsAt: undefined, buildingUntil: undefined } : { activeBuildId: row.creationId, activeTool: 'hammer', buildingStartsAt: now, buildingUntil: now + 15000 }) });
    if (finished && row.kind === 'home' && !agent.settledAt) await ctx.db.patch(agent._id, { settledAt: now });
    if (finished) await ctx.db.insert('events', { kind: 'creation_completed', actorId: row.ownerAgentId, payload: { creationId: row.creationId, revision: row.revision + 1 }, gloss: `${row.name} is complete, with its door and light controls ready to use.` });
    advanced++;
  }
  // Round-robin by updatedAt keeps timer work bounded across a growing world.
  const built = await ctx.db.query('creations').withIndex('state_updated', (q: any) => q.eq('state', 'built')).take(32);
  for (const row of built) {
    const desired = evaluateSignals(row.plan, row.switches, now), signals = safeDoorState(row, desired, citizens, now);
    await ctx.db.patch(row._id, { updatedAt: now, ...(JSON.stringify(signals) !== JSON.stringify(row.signals) ? { signals, revision: row.revision + 1 } : {}) });
  }
  return { ok: true, advanced };
}
