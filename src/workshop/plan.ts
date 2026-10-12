import { CATALOGUE, rollOf, type Asset } from '../../shared/catalogue';

export const PLAN_VERSION = 'earth-neighborhood-draft-v1';
export const SIZE = 32;
export type QuarterTurn = 0 | 1 | 2 | 3;
export type Placement = { id: string; assetId: string; x: number; y: number; rotation: QuarterTurn };
export type Plan = { version: typeof PLAN_VERSION; name: string; seed: string; objects: Placement[] };
export type Block = { asset: Asset; label: string; w: number; h: number; category: string };
const homeNames = ['Courtyard house', 'Gabled house', 'Flat-roof house', 'Timber house', 'Wide house', 'Compact house', 'Garden house', 'Terrace house', 'Tall house', 'Family house', 'Corner house', 'Town house'];
const civicNames = ['Corner shop', 'Guild hall', 'Workshop', 'Reading room', 'Exchange', 'Community hall', 'Market house', 'Studio'];
export const BLOCKS: Block[] = CATALOGUE.filter(a => a.kind !== 'flora').map(asset => {
  const index = CATALOGUE.filter(a => a.kind === asset.kind).findIndex(a => a.id === asset.id);
  return {
    asset, label: asset.kind === 'home' ? homeNames[index] : asset.kind === 'civic' ? civicNames[index]
      : asset.kind === 'tree' ? `${asset.tags.includes('conifer') ? 'Pine' : asset.tags.includes('palm') ? 'Palm' : 'Leafy tree'} ${index + 1}`
        : ['Fountain', 'Flower bed · red', 'Flower bed · yellow', 'Flower bed · mixed', 'Grass garden', 'Log garden'][index],
    w: asset.kind === 'home' ? 4 : asset.kind === 'civic' ? 5 : asset.kind === 'garden' && index === 0 ? 3 : 2,
    h: asset.kind === 'home' ? 3 : asset.kind === 'civic' ? 4 : asset.kind === 'garden' && index === 0 ? 3 : 2,
    category: asset.kind === 'home' ? 'Homes' : asset.kind === 'civic' ? 'Community' : 'Landscape',
  };
});
export function blockFor(id: string): Block {
  const block = BLOCKS.find(b => b.asset.id === id);
  if (!block) throw new Error(`Unknown block: ${String(id).slice(0, 60)}`);
  return block;
}
export function footprint(p: Placement) {
  const b = blockFor(p.assetId);
  return p.rotation % 2 ? { w: b.h, h: b.w } : { w: b.w, h: b.h };
}
export function roadAt(x: number, y: number): boolean {
  return (x >= 14 && x < 18) || (y >= 14 && y < 18);
}
export function placementError(p: Placement, objects: Placement[]): string | null {
  const { w, h } = footprint(p);
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) return 'Positions must be whole tiles.';
  if (![0, 1, 2, 3].includes(p.rotation)) return 'Rotation must be 0, 1, 2, or 3 quarter turns.';
  if (p.x < 0 || p.y < 0 || p.x + w > SIZE || p.y + h > SIZE) return 'Keep this block inside the neighborhood.';
  for (let y = p.y; y < p.y + h; y++) for (let x = p.x; x < p.x + w; x++) {
    if (roadAt(x, y)) return 'Keep the shared roads clear. Choose a grassy site.';
  }
  for (const other of objects) {
    if (other.id === p.id) continue;
    const f = footprint(other);
    if (p.x < other.x + f.w && p.x + w > other.x && p.y < other.y + f.h && p.y + h > other.y) {
      return `This site overlaps ${blockFor(other.assetId).label.toLowerCase()}.`;
    }
  }
  return null;
}
/** Untrusted agent output never supplies URLs, geometry, scripts, or authority. */
export function parsePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose a neighborhood plan JSON object.');
  const data = raw as Record<string, unknown>;
  if (data.version !== PLAN_VERSION) throw new Error(`Plan version must be ${PLAN_VERSION}.`);
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) throw new Error('Give the plan a name of 1–80 characters.');
  if (typeof data.seed !== 'string' || data.seed.length > 80) throw new Error('The seed must be text of at most 80 characters.');
  if (!Array.isArray(data.objects) || data.objects.length > 200) throw new Error('A draft supports at most 200 blocks.');
  const objects: Placement[] = [];
  const ids = new Set<string>();
  for (const value of data.objects) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Every block must be an object.');
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(v.id) || ids.has(v.id)) throw new Error('Block IDs must be unique, short identifiers.');
    if (typeof v.assetId !== 'string') throw new Error('Every block needs an approved assetId.');
    blockFor(v.assetId);
    if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.rotation !== 'number') throw new Error('Block coordinates and rotation must be numbers.');
    const p: Placement = { id: v.id, assetId: v.assetId, x: v.x, y: v.y, rotation: v.rotation as QuarterTurn };
    const error = placementError(p, objects);
    if (error) throw new Error(`${v.id}: ${error}`);
    ids.add(p.id); objects.push(p);
  }
  return { version: PLAN_VERSION, name: data.name.trim(), seed: data.seed, objects };
}
export type Recipe = 'village' | 'research' | 'garden';
/** Seeded composition, not an LLM. External brains may return the same format. */
export function generatePlan(seed: string, recipe: Recipe): Plan {
  const objects: Placement[] = [];
  const add = (assetId: string, x: number, y: number, rotation: QuarterTurn = 0) => {
    const p = { id: `draft:${objects.length + 1}`, assetId, x, y, rotation };
    if (!placementError(p, objects)) objects.push(p);
  };
  const sites = [[8, 9], [20, 9], [8, 20], [20, 20], [2, 9], [26, 20]];
  sites.forEach(([x, y], i) => {
    if (recipe === 'garden' && i > 2) return;
    const home = Math.floor(rollOf(`${seed}:house:${i}`) * 12);
    add(recipe === 'research' && i < 2 ? `civic-${i === 0 ? 'd' : 'h'}` : `home-${String.fromCharCode(97 + home)}`, x, y, y >= 18 ? 2 : 0);
  });
  add('garden-0', 20, 3);
  add('garden-1', 8, 5); add('garden-2', 25, 9); add('garden-3', 8, 25);
  const density = recipe === 'garden' ? .65 : .35;
  for (let y = 1; y < 30; y += 3) for (let x = 1; x < 30; x += 3) {
    if (rollOf(`${seed}:tree:${x}:${y}`) > density) continue;
    const kind = Math.floor(rollOf(`${seed}:species:${x}:${y}`) * 10);
    add(`tree-${kind}`, x, y);
  }
  return { version: PLAN_VERSION, seed, name: recipe === 'research' ? 'Research commons' : recipe === 'garden' ? 'Garden neighborhood' : 'Earthfolk village', objects };
}
export class History {
  private undoStack: Plan[] = [];
  private redoStack: Plan[] = [];
  constructor(public current: Plan) {}
  commit(next: Plan) { this.undoStack.push(this.current); this.undoStack = this.undoStack.slice(-50); this.current = next; this.redoStack = []; }
  undo() { const p = this.undoStack.pop(); if (p) { this.redoStack.push(this.current); this.current = p; } }
  redo() { const p = this.redoStack.pop(); if (p) { this.undoStack.push(this.current); this.current = p; } }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
