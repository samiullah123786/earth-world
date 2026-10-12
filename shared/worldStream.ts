/** Public snapshot deltas. Every connection starts with a full snapshot; no hidden authority. */
export type PublicSnapshot = Record<string, any>;
export type WorldDelta = { serverNow: number; scalar: Record<string, any>; lists: Record<string, { upserts: any[]; removed: string[] }> };
const LISTS = ['citizens', 'builds', 'creations', 'blocks', 'venues', 'farms', 'plots', 'zones', 'chunks'];
export function entityKey(list: string, row: any): string {
  if (list === 'citizens') return row.agentId;
  if (list === 'builds') return row.buildId;
  if (list === 'creations') return row.creationId;
  if (list === 'blocks') return `${row.x}:${row.y}:${row.level}`;
  return row.venueId ?? row.plotId ?? row.zoneId ?? `${row.x}:${row.y}`;
}
export function worldDelta(previous: PublicSnapshot, next: PublicSnapshot): WorldDelta {
  const lists: WorldDelta['lists'] = {}, scalar: Record<string, any> = {};
  for (const key of Object.keys(next)) if (!LISTS.includes(key) && key !== 'serverNow' && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) scalar[key] = next[key];
  for (const key of LISTS) {
    const before = new Map((previous[key] ?? []).map((row: any) => [entityKey(key, row), JSON.stringify(row)]));
    const after = new Map((next[key] ?? []).map((row: any) => [entityKey(key, row), row]));
    const upserts = (next[key] ?? []).filter((row: any) => before.get(entityKey(key, row)) !== JSON.stringify(row));
    const removed = [...before.keys()].filter(id => !after.has(id)) as string[];
    if (upserts.length || removed.length) lists[key] = { upserts, removed };
  }
  return { serverNow: next.serverNow, scalar, lists };
}
export function applyWorldDelta(previous: PublicSnapshot, delta: WorldDelta): PublicSnapshot {
  const next: PublicSnapshot = { ...previous, ...delta.scalar, serverNow: delta.serverNow };
  for (const key of LISTS) {
    const change = delta.lists[key]; if (!change) continue;
    const removed = new Set(change.removed), rows = new Map<string, any>((previous[key] ?? []).filter((row: any) => !removed.has(entityKey(key, row))).map((row: any) => [entityKey(key, row), row]));
    for (const row of change.upserts) rows.set(entityKey(key, row), row);
    next[key] = [...rows.values()];
  }
  return next;
}
