import { BLOCK_PALETTE } from './blocks';

export const CREATION_VERSION = 'earth-creation-v1';
export const CREATION_LIMITS = { parts: 128, circuits: 32, height: 4, extent: 8, bytes: 32768, creationsPerOwner: 8 };
export const CREATION_MATERIALS = {
  plank: { ...BLOCK_PALETTE.plank, density: .6, strength: 64, span: 3 },
  stone: { ...BLOCK_PALETTE.stone, density: 2.4, strength: 300, span: 1 },
  brick: { ...BLOCK_PALETTE.brick, density: 1.8, strength: 200, span: 2 },
  glass: { ...BLOCK_PALETTE.glass, density: 1, strength: 18, span: 1 },
  thatch: { ...BLOCK_PALETTE.thatch, density: .2, strength: 8, span: 2 },
  lantern: { ...BLOCK_PALETTE.lantern, density: .2, strength: 3, span: 1 },
} as const;
export type CreationMaterial = keyof typeof CREATION_MATERIALS;
export type CreationShape = 'block' | 'beam' | 'floor' | 'roof' | 'door' | 'lamp' | 'switch';
export type CreationPart = { id: string; shape: CreationShape; material: CreationMaterial; x: number; y: number; z: number; w: number; h: number; d: number };
export type Circuit = { id: string; type: 'switch' | 'and' | 'or' | 'not' | 'timer'; inputs: string[]; period?: number };
export type CreationPlan = { version: typeof CREATION_VERSION; name: string; x: number; y: number; kind: 'home' | 'object'; parts: CreationPart[]; circuits: Circuit[]; bindings: { partId: string; signalId: string; behavior: 'door' | 'light' | 'switch' }[] };
export type CreationRecord = { creationId: string; ownerAgentId: string; requestId?: string; name: string; revision: number; state: 'building' | 'built' | 'paused'; progress: number; plan: CreationPlan; signals: Record<string, boolean>; switches?: Record<string, boolean> };
const SHAPES = new Set(['block', 'beam', 'floor', 'roof', 'door', 'lamp', 'switch']);
const TYPES = new Set(['switch', 'and', 'or', 'not', 'timer']);
const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(v)) throw new Error('Part and signal IDs must be short lowercase identifiers.'); return v; };
const obj = (v: unknown): Record<string, any> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('A creation must contain objects.'); return v as Record<string, any>; };
const keys = (v: Record<string, any>, allowed: string[]) => { if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Unsupported creation field; plans contain data, never code or asset URLs.'); };
const quarter = (v: unknown, max: number, positive = false): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < (positive ? .25 : 0) || v > max || !Number.isInteger(v * 4)) throw new Error('Part dimensions use quarter-tile units inside the creation limits.'); return v; };

/** Canonicalize unknown input; never persist an unvalidated object or custom executable behavior. */
export function parseCreation(value: unknown): CreationPlan {
  if (JSON.stringify(value).length > CREATION_LIMITS.bytes) throw new Error('Creation plan is too large.');
  const p = obj(value); keys(p, ['version', 'name', 'kind', 'x', 'y', 'parts', 'circuits', 'bindings']);
  if (p.version !== CREATION_VERSION) throw new Error('Use earth-creation-v1.');
  if (typeof p.name !== 'string' || !/^[A-Za-z][A-Za-z0-9 '()-]{2,59}$/.test(p.name)) throw new Error('Use a public creation name of 3–60 characters without URLs, paths or private information.');
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0) throw new Error('Creation origin uses nonnegative whole map tiles.');
  if (p.kind !== undefined && !['home', 'object'].includes(p.kind)) throw new Error('Creation kind is home or object.');
  if (!Array.isArray(p.parts) || !p.parts.length || p.parts.length > CREATION_LIMITS.parts) throw new Error('A creation has 1–128 parts.');
  const parts: CreationPart[] = p.parts.map((raw: unknown) => {
    const v = obj(raw); keys(v, ['id', 'shape', 'material', 'x', 'y', 'z', 'w', 'h', 'd']);
    if (!SHAPES.has(v.shape) || !Object.prototype.hasOwnProperty.call(CREATION_MATERIALS, v.material)) throw new Error('Choose a supported shape and material.');
    const part = { id: id(v.id), shape: v.shape, material: v.material, x: quarter(v.x, 8), y: quarter(v.y, 4), z: quarter(v.z, 8), w: quarter(v.w, 8, true), h: quarter(v.h, 4, true), d: quarter(v.d, 8, true) };
    if (part.x + part.w > 8 || part.z + part.d > 8 || part.y + part.h > 4) throw new Error(`${part.id} exceeds the creation envelope.`);
    if (part.shape === 'floor' && (part.h > .25 || part.y !== 0)) throw new Error('Walkable floors are ground-level quarter-tile slabs in v1.');
    if (part.shape === 'door' && (part.w !== 1 || part.d !== 1 || part.h < 1.5)) throw new Error('Doors reserve a whole navigation tile and at least 1.5 tiles of clearance.');
    if ((part.shape === 'lamp' || part.shape === 'switch') && part.w * part.h * part.d > 1) throw new Error('Lamp and switch parts are compact fixtures.');
    return part;
  });
  if (new Set(parts.map(p => p.id)).size !== parts.length) throw new Error('Part IDs must be unique.');
  const rawCircuits = p.circuits ?? []; if (!Array.isArray(rawCircuits) || rawCircuits.length > 32) throw new Error('At most 32 signals per creation.');
  const circuits: Circuit[] = rawCircuits.map((raw: unknown) => {
    const c = obj(raw); keys(c, ['id', 'type', 'inputs', 'period']);
    if (!TYPES.has(c.type) || !Array.isArray(c.inputs) || c.inputs.length > 8) throw new Error('Use supported signals with at most eight inputs.');
    if (c.type === 'timer' && (!Number.isInteger(c.period) || c.period < 5 || c.period > 3600)) throw new Error('Timers use periods of 5–3600 seconds.');
    if (['switch', 'timer'].includes(c.type) && c.inputs.length) throw new Error('Source signals do not have inputs.');
    if (c.type === 'not' && c.inputs.length !== 1 || ['and', 'or'].includes(c.type) && !c.inputs.length) throw new Error('Logic gates need the correct number of inputs.');
    return { id: id(c.id), type: c.type, inputs: c.inputs.map(id), ...(c.type === 'timer' ? { period: c.period } : {}) };
  });
  if (new Set(circuits.map(c => c.id)).size !== circuits.length) throw new Error('Signal IDs must be unique.');
  const rawBindings = p.bindings ?? []; if (!Array.isArray(rawBindings) || rawBindings.length > parts.length) throw new Error('Bindings must refer to creation parts.');
  const bindings = rawBindings.map((raw: unknown) => {
    const b = obj(raw); keys(b, ['partId', 'signalId', 'behavior']);
    const partId = id(b.partId), signalId = id(b.signalId), part = parts.find(p => p.id === partId);
    if (!part || !circuits.some(c => c.id === signalId) || !['door', 'light', 'switch'].includes(b.behavior) || (b.behavior === 'door' ? part.shape !== 'door' : b.behavior === 'light' ? part.shape !== 'lamp' : part.shape !== 'switch' || circuits.find(c => c.id === signalId)?.type !== 'switch')) throw new Error('Bind a signal to a matching door or lamp.');
    return { partId, signalId, behavior: b.behavior as 'door' | 'light' | 'switch' };
  });
  if (new Set(bindings.map(b => b.partId)).size !== bindings.length) throw new Error('A part has at most one control binding.');
  for (const part of parts) if (['door', 'lamp', 'switch'].includes(part.shape) && !bindings.some(b => b.partId === part.id)) throw new Error(`${part.id} needs a control signal.`);
  const plan: CreationPlan = { version: CREATION_VERSION, name: p.name, kind: p.kind ?? 'object', x: p.x, y: p.y, parts, circuits, bindings };
  evaluateSignals(plan, {}, 0); // Missing references and combinational cycles are invalid.
  const physics = structuralIssues(plan); if (physics.length) throw new Error(physics.join(' '));
  return plan;
}

export const partBoundsOverlap = (a: CreationPart, b: CreationPart) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h && a.z < b.z + b.d && b.z < a.z + a.d;
const fixture = (p: CreationPart) => p.shape === 'switch' || p.shape === 'lamp';
/** Deterministic game support/load checks, not engineering-grade structural simulation. */
export function structuralIssues(plan: CreationPlan): string[] {
  const issues: string[] = [], supported = new Set<string>();
  const ordered = plan.parts; // Execution order is support order; reject roof-first plans.
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i], material = CREATION_MATERIALS[p.material];
    for (const q of ordered.slice(0, i)) if (!fixture(p) && !fixture(q) && partBoundsOverlap(p, q)) issues.push(`${p.id} overlaps ${q.id}.`);
    if (p.y === 0) { supported.add(p.id); continue; }
    const anchors = ordered.filter(q => supported.has(q.id) && !fixture(q) &&
      Math.abs(q.y + q.h - p.y) < .001 && q.x < p.x + p.w && p.x < q.x + q.w && q.z < p.z + p.d && p.z < q.z + q.d);
    const mount = fixture(p) && ordered.some(q => supported.has(q.id) && !fixture(q) &&
      p.y >= q.y && p.y + p.h <= q.y + q.h && p.x <= q.x + q.w + .25 && p.x + p.w >= q.x - .25 && p.z <= q.z + q.d + .25 && p.z + p.d >= q.z - .25);
    if (!anchors.length && !mount) { issues.push(`${p.id} has no grounded support.`); continue; }
    const volume = p.w * p.h * p.d, mass = volume * material.density;
    if (anchors.length && mass > anchors.reduce((sum, q) => sum + CREATION_MATERIALS[q.material].strength * Math.min(q.w, p.w) * Math.min(q.d, p.d), 0)) issues.push(`${p.id} exceeds its supports' load capacity.`);
    if (!mount) for (let x = p.x; x < p.x + p.w; x += .5) for (let z = p.z; z < p.z + p.d; z += .5) {
      const distance = Math.min(...anchors.map(q => Math.max(q.x - x, 0, x - (q.x + q.w)) + Math.max(q.z - z, 0, z - (q.z + q.d))));
      if (distance > material.span) { issues.push(`${p.id} overhang exceeds ${material.span} tiles.`); x = p.x + p.w; break; }
    }
    supported.add(p.id);
  }
  return [...new Set(issues)];
}

export function evaluateSignals(plan: CreationPlan, switches: Record<string, boolean>, now: number): Record<string, boolean> {
  const result: Record<string, boolean> = {}, visiting = new Set<string>(), circuits = new Map(plan.circuits.map(c => [c.id, c]));
  const get = (key: string): boolean => {
    if (Object.prototype.hasOwnProperty.call(result, key)) return result[key];
    const c = circuits.get(key); if (!c) throw new Error(`Unknown signal ${key}.`);
    if (visiting.has(key)) throw new Error('Signal cycles require a delay component; cycles are not supported in v1.');
    visiting.add(key); const inputs = c.inputs.map(get);
    const value = c.type === 'switch' ? switches[key] === true : c.type === 'timer' ? Math.floor(now / (c.period! * 1000)) % 2 === 1 : c.type === 'not' ? !inputs[0] : c.type === 'and' ? inputs.every(Boolean) : inputs.some(Boolean);
    visiting.delete(key); result[key] = value; return value;
  };
  for (const c of plan.circuits) get(c.id);
  return result;
}

export function creationCost(plan: CreationPlan): number { return plan.parts.reduce((n, p) => n + Math.max(1, Math.ceil(p.w * p.h * p.d * CREATION_MATERIALS[p.material].price)), 0); }
export function creationExtent(plan: CreationPlan) { return { w: Math.ceil(Math.max(...plan.parts.map(p => p.x + p.w))), h: Math.ceil(Math.max(...plan.parts.map(p => p.z + p.d))) }; }
export function partIsActive(plan: CreationPlan, partId: string, signals: Record<string, boolean>): boolean { const binding = plan.bindings.find(b => b.partId === partId); return Boolean(binding && signals[binding.signalId]); }
/** Ground-level static collision derives from the exact committed parts and door state. */
export function creationCollision(record: Pick<CreationRecord, 'plan' | 'signals' | 'progress'>): Array<{ x: number; y: number }> {
  const cells = new Map<string, { x: number; y: number }>();
  for (const p of record.plan.parts.slice(0, record.progress)) {
    if (['floor', 'roof', 'lamp', 'switch'].includes(p.shape) || p.y >= 1.5 || p.y + p.h <= .25 || p.shape === 'door' && partIsActive(record.plan, p.id, record.signals)) continue;
    for (let x = Math.floor(p.x); x < Math.ceil(p.x + p.w); x++) for (let z = Math.floor(p.z); z < Math.ceil(p.z + p.d); z++) {
      const cell = { x: record.plan.x + x, y: record.plan.y + z }; cells.set(`${cell.x},${cell.y}`, cell);
    }
  }
  return [...cells.values()];
}

/** An editable home assembled from supported parts, with separately controlled door/light. */
export function starterHome(x: number, y: number, name = 'Timber Courtyard Home'): CreationPlan {
  const parts: CreationPart[] = [{ id: 'foundation', shape: 'floor', material: 'stone', x: 0, y: 0, z: 0, w: 5, h: .25, d: 5 }];
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
    if (x > 0 && x < 4 && z > 0 && z < 4 || z === 4 && x === 2) continue;
    parts.push({ id: `wall-${x}-${z}`, shape: 'block', material: (z === 0 && (x === 1 || x === 3)) ? 'glass' : 'plank', x, y: .25, z, w: 1, h: 2, d: 1 });
  }
  parts.push({ id: 'front-door', shape: 'door', material: 'plank', x: 2, y: .25, z: 4, w: 1, h: 2, d: 1 });
  parts.push({ id: 'roof', shape: 'roof', material: 'plank', x: 0, y: 2.25, z: 0, w: 5, h: .75, d: 5 });
  parts.push({ id: 'entry-lamp', shape: 'lamp', material: 'lantern', x: 3, y: 1.75, z: 3.75, w: .25, h: .25, d: .25 });
  parts.push({ id: 'light-switch', shape: 'switch', material: 'plank', x: 3, y: 1, z: 3.75, w: .25, h: .25, d: .25 });
  return parseCreation({ version: CREATION_VERSION, name, kind: 'home', x, y, parts, circuits: [{ id: 'door-power', type: 'switch', inputs: [] }, { id: 'light-power', type: 'switch', inputs: [] }], bindings: [{ partId: 'front-door', signalId: 'door-power', behavior: 'door' }, { partId: 'entry-lamp', signalId: 'light-power', behavior: 'light' }, { partId: 'light-switch', signalId: 'light-power', behavior: 'switch' }] });
}
