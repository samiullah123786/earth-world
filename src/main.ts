import Phaser from 'phaser';
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';

const FAMILY_COLORS: Record<string, number> = {
  engineering: 0x3b82f6, design: 0x8b5cf6, marketing: 0xf97316,
  content: 0xf59e0b, data: 0x14b8a6, security: 0xef4444,
  research: 0x22c55e, media: 0xec4899, ops: 0x64748b,
  ui: 0x8b5cf6, ux: 0xa855f7, frontend: 0x3b82f6, backend: 0x2563eb,
  growth: 0xf97316, automation: 0x64748b, general: 0x84a98c,
};
const INK = 0x1e1e1e;
const CREAM = '#FDF6EC';
const embed = new URLSearchParams(location.search).has('embed');
if (embed) document.body.classList.add('embed');
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!convexUrl) throw new Error('VITE_CONVEX_URL is required');
const convex = new ConvexClient(convexUrl);

type RoutePoint = { x: number; y: number; at: number };
type Citizen = {
  agentId: string; name: string; gender: string; family: string; accent: string;
  fx: number; fy: number; tx: number; ty: number; t0: number; t1: number;
  route?: RoutePoint[]; state: string; activity: string; online: boolean;
  specialties?: string[]; primaryCategory?: string; skillCount?: number;
  experienceTier?: string; serviceRole?: string; talkingWith?: string; talkingUntil?: number;
};
type Plot = { plotId: string; x: number; y: number; w: number; h: number; district: string; ownerAgentId?: string };
type Build = { buildId: string; plotId: string; ownerAgentId: string; structure: string; state: string;
  blueprint?: { name: string; kind: string; style?: string; architecture?: string; features?: string[];
    offsetX?: number; offsetY?: number; w?: number; h?: number }; x?: number; y?: number; w?: number; h?: number };
type Venue = { venueId: string; name: string; kind: string; x: number; y: number; capacity: number };
type WorldState = { width: number; height: number; generation: number; capacity: number; landPolicy: string; mayorAgentId?: string };
type Meeting = { meetingId: string; venueId: string; requesterId: string; inviteeId: string; startsAt?: number; endsAt?: number; state: string };
type WorldObjects = { plots: Plot[]; builds: Build[]; venues: Venue[]; meetings: Meeting[];
  services: Array<{ agentId: string; role: string }>; state: WorldState };
type Conversation = { id: string; a: string; b: string; aName: string; bName: string; topic: string;
  at: number; endsAt?: number; state: string; lines: Array<{ speaker: string; es: string; gloss: string }> };

let TILE = 32;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class EarthScene extends Phaser.Scene {
  sprites = new Map<string, Phaser.GameObjects.Container>();
  citizens: Citizen[] = [];
  objects: WorldObjects = { plots: [], builds: [], venues: [], meetings: [], services: [],
    state: { width: 64, height: 48, generation: 0, capacity: 50, landPolicy: 'service_auto' } };
  objectLayer?: Phaser.GameObjects.Container;
  expansionLayer?: Phaser.GameObjects.Graphics;
  expansionRT?: Phaser.GameObjects.RenderTexture;
  grassFrames?: number[];
  baseWidth = 64;
  baseHeight = 48;
  pendingGoto = new URLSearchParams(location.search).get('goto');
  conversations: Conversation[] = [];
  selectedAgentId?: string;
  conversationAgentId?: string;
  conversationMinimized = false;
  mapPanning = false;
  uiInteractionUntil = 0;

  constructor() {
    super('EarthScene');
  }

  preload() {
    this.load.json('map', '/assets/map.json');
    this.load.spritesheet('tiles', '/assets/gentle-obj.png', { frameWidth: 32, frameHeight: 32 });
  }

  create() {
    const map = this.cache.json.get('map');
    TILE = map.tile;
    this.baseWidth = map.width;
    this.baseHeight = map.height;
    this.expansionLayer = this.add.graphics().setDepth(-3);
    const ground = this.add.renderTexture(0, 0, map.width * TILE, map.height * TILE).setOrigin(0);
    for (const layer of [...map.bgtiles, ...map.objmap]) {
      for (let x = 0; x < map.width; x++) {
        for (let y = 0; y < map.height; y++) {
          const tile = layer[x][y];
          if (tile !== -1 && tile !== undefined) ground.drawFrame('tiles', tile, x * TILE, y * TILE);
        }
      }
    }
    ground.setDepth(-2);
    this.objectLayer = this.add.container(0, 0).setDepth(-1);

    this.cameras.main.setBounds(0, 0, map.width * TILE, map.height * TILE);
    this.cameras.main.setBackgroundColor(CREAM);
    this.cameras.main.centerOn((map.width * TILE) / 2, (map.height * TILE) / 2);
    this.cameras.main.setZoom(Math.max(embed ? 1.15 : 1.4, this.minimumZoom(map.width, map.height)));
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown || !this.mapPanning) return;
      this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
      this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
    });
    this.input.on('pointerdown', (_pointer: Phaser.Input.Pointer, gameObjects: Phaser.GameObjects.GameObject[]) => {
      this.mapPanning = gameObjects.length === 0 && Date.now() >= this.uiInteractionUntil;
      document.body.classList.toggle('is-panning', this.mapPanning);
    });
    const releasePan = () => { this.mapPanning = false; document.body.classList.remove('is-panning'); };
    this.input.on('pointerup', releasePan);
    this.input.on('pointerupoutside', releasePan);
    this.input.on('wheel', (_pointer: unknown, _objects: unknown, _dx: number, dy: number) => {
      const state = this.objects.state;
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), this.minimumZoom(state.width, state.height), 3));
    });

    convex.onUpdate(api.world.citizens, {}, (rows: Citizen[]) => {
      this.citizens = rows;
      const liveIds = new Set(rows.map((row) => row.agentId));
      for (const citizen of rows) if (!this.sprites.has(citizen.agentId)) this.spawnCitizen(citizen);
      for (const [agentId, sprite] of this.sprites) {
        if (!liveIds.has(agentId)) { sprite.destroy(true); this.sprites.delete(agentId); }
      }
      this.renderDirectory();
    });
    convex.onUpdate(api.world.worldObjects, {}, (objects: WorldObjects) => {
      this.objects = objects;
      this.renderExpansion();
      this.renderWorldObjects();
      if (this.pendingGoto) {
        const target = this.pendingGoto;
        this.pendingGoto = null;
        this.focusWorldTarget(target);
      }
    });
    convex.onUpdate(api.world.feed, {}, (rows: Array<{ id: string; gloss: string }>) => {
      const feed = document.getElementById('feedLines') || document.getElementById('feed');
      if (!feed) return;
      feed.replaceChildren(...rows.slice(0, 6).map((row) => element('div', 'feed-line', row.gloss)));
    });
    convex.onUpdate(api.world.recentConversations, {}, (rows: Conversation[]) => {
      this.conversations = rows;
      if (!this.conversationAgentId) return;
      const selected = rows.find((row) => (row.a === this.conversationAgentId || row.b === this.conversationAgentId)
        && row.state === 'active' && (row.endsAt ?? 0) > Date.now());
      this.renderConversation(selected ?? null);
    });
    this.scale.on('resize', () => this.applyWorldBounds());
  }

  minimumZoom(width: number, height: number) {
    return Math.max(this.scale.width / Math.max(1, width * TILE), this.scale.height / Math.max(1, height * TILE));
  }

  applyWorldBounds() {
    const { width, height } = this.objects.state;
    this.cameras.main.setBounds(0, 0, width * TILE, height * TILE);
    this.cameras.main.setZoom(Math.max(this.cameras.main.zoom, this.minimumZoom(width, height)));
  }

  renderExpansion() {
    const { width, height, generation } = this.objects.state;
    const map = this.cache.json.get('map');
    if (!map) return;
    this.expansionLayer?.clear();
    if (!this.grassFrames) {
      const count = new Map<number, number>();
      for (let x = 0; x < map.width; x++) for (let y = 0; y < map.height; y++) {
        const g = map.bgtiles[0][x][y];
        if (g !== -1 && g !== undefined) count.set(g, (count.get(g) ?? 0) + 1);
      }
      this.grassFrames = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((entry) => entry[0]);
    }
    if (!this.expansionRT || this.expansionRT.width !== width * TILE || this.expansionRT.height !== height * TILE) {
      this.expansionRT?.destroy();
      this.expansionRT = this.add.renderTexture(0, 0, width * TILE, height * TILE).setOrigin(0).setDepth(-3);
      // Wilderness: IDENTICAL math to convex/pathfinding.ts (wildHash/isGroveCell/
      // isEdgeForest/isTreeAnchor). Complete 4x3 trees, forest continues at borders.
      const hash = (hx: number, hy: number, salt: number) => {
        let h = (hx * 374761393 + hy * 668265263 + salt * 2246822519) | 0;
        h = (h ^ (h >>> 13)) * 1274126177;
        return (h ^ (h >>> 16)) >>> 0;
      };
      const W0 = this.baseWidth, H0 = this.baseHeight;
      const foundingBlocked = (bx: number, by: number) =>
        map.objmap.some((layer: number[][]) => layer[bx]?.[by] !== -1 && layer[bx]?.[by] !== undefined);
      const grove = (gx: number, gy: number) => hash(Math.floor(gx / 6), Math.floor(gy / 6), 7) % 100 < 30;
      const treeAnchor = (gx: number, gy: number) => {
        if (gx < W0 && gy < H0) return false;
        const d = Math.max(Math.max(0, gx - (W0 - 1)), Math.max(0, gy - (H0 - 1)));
        if (d <= 6) return false;
        return grove(gx, gy) && hash(gx, gy, 11) % 23 === 0;
      };
      // Exact continuation of the two south-border canopy masses (same table as
      // convex/pathfinding.ts SOUTH_CONTINUATION - computed from the tileset).
      const SOUTH_CONTINUATION: Record<number, number[]> = { 23: [515, 560, 605, 650], 24: [516, 561, 606, 651], 25: [517, 562, 607, 652], 26: [518, 563, 608, 653], 27: [519, 564, 609, 654], 28: [520, 565, 610, 655], 29: [521, 566, 611, 656], 30: [522, 567, 612], 32: [515, 560, 605, 650], 33: [516, 561, 606, 651], 34: [517, 562, 607, 652], 35: [518, 563, 608, 653], 36: [519, 564, 609, 654], 37: [520, 565, 610, 655], 38: [521, 566, 611, 656], 39: [522, 567, 612] };
      const GRASS = 271, GRASS_ALT = 962;
      // The one verified grass-native tree: the lush 4x4 river-side tree.
      // (Close-up QA killed the other candidates: (20,23) is a mossy boulder,
      // and frames 941/850 are crystals/mushrooms, not flowers.)
      const BIG = { x: 15, y: 24, w: 4, h: 4 };
      const decor = map.bgtiles[1];
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          if (x < W0 && y < H0) continue;
          this.expansionRT.drawFrame('tiles', hash(x, y, 3) % 97 === 0 ? GRASS_ALT : GRASS, x * TILE, y * TILE);
        }
      }
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          const seCont = (() => {
            const inEast = x >= W0 && y >= 34 && y < H0;
            const inSouth = y >= H0 && x >= 52 && x < W0;
            const inCorner = x >= W0 && y >= H0;
            if (inEast) return x - (W0 - 1) <= 2 + (hash(0, y, 41) % 4);
            if (inSouth) return y - (H0 - 1) <= 2 + (hash(x, 0, 43) % 4);
            if (inCorner) {
              const de = 2 + (hash(0, 47, 41) % 4), ds = 2 + (hash(63, 0, 43) % 4);
              return (x - (W0 - 1)) + (y - (H0 - 1)) <= Math.min(de, ds) + 1;
            }
            return false;
          })();
          if (seCont) this.expansionRT.drawFrame('tiles', 367, x * TILE, y * TILE);
          const cont = SOUTH_CONTINUATION[x];
          if (cont && y >= H0 && y - H0 < cont.length) {
            this.expansionRT.drawFrame('tiles', cont[y - H0], x * TILE, y * TILE);
          }
          if (treeAnchor(x, y)) {
            for (let dx = 0; dx < BIG.w; dx++) {
              for (let dy = 0; dy < BIG.h; dy++) {
                const frame = decor[BIG.x + dx]?.[BIG.y + dy];
                if (frame === -1 || frame === undefined) continue;
                const px = x - 1 + dx, py = y - 1 + dy;
                if (px < 0 || py < 0 || px >= width || py >= height) continue;
                if (px < W0 && py < H0) continue;
                this.expansionRT.drawFrame('tiles', frame, px * TILE, py * TILE);
              }
            }
          }
        }
      }
    }
    this.applyWorldBounds();
    const boundary = document.getElementById('boundary');
    if (boundary) boundary.textContent = `ring ${generation} · ${width}×${height} tiles · capacity ${this.objects.state.capacity}`;
  }

  renderDirectory() {
    const list = document.getElementById('citizen-list');
    const queryNode = document.getElementById('citizen-search') as HTMLInputElement | null;
    const categoryNode = document.getElementById('citizen-category') as HTMLSelectElement | null;
    const liveNode = document.getElementById('citizen-live') as HTMLInputElement | null;
    if (!list || !queryNode || !categoryNode || !liveNode) return;
    const query = queryNode.value.trim().toLowerCase();
    const category = categoryNode.value;
    const rows = this.citizens.filter((citizen) => {
      const specialties = citizen.specialties ?? [citizen.family];
      return (!query || `${citizen.name} ${citizen.agentId} ${specialties.join(' ')}`.toLowerCase().includes(query))
        && (!category || specialties.includes(category) || citizen.primaryCategory === category || citizen.family === category)
        && (!liveNode.checked || citizen.online);
    }).sort((a, b) => Number(b.online) - Number(a.online) || (b.skillCount ?? 0) - (a.skillCount ?? 0));
    list.replaceChildren(...rows.slice(0, 40).map((citizen) => {
      const button = element('button', 'citizen-row');
      button.type = 'button';
      button.append(
        element('span', 'citizen-name', `${citizen.online ? '●' : '○'} ${citizen.name}`),
        element('span', 'citizen-tags', `${citizen.serviceRole ?? citizen.experienceTier ?? 'emerging'} · ${(citizen.specialties ?? [citizen.family]).slice(0, 2).join(' / ')}`),
      );
      const position = this.positionFor(citizen);
      button.append(element('span', 'citizen-coords',
        `tile ${position.x.toFixed(1)}, ${position.y.toFixed(1)}${citizen.talkingWith && (citizen.talkingUntil ?? 0) > Date.now() ? ' | talking' : ''}`));
      button.onpointerdown = (event) => { event.stopPropagation(); this.uiInteractionUntil = Date.now() + 750; };
      button.onpointerup = (event) => event.stopPropagation();
      button.onclick = (event) => {
        event.stopPropagation(); this.uiInteractionUntil = Date.now() + 750; this.focusCitizen(citizen.agentId);
      };
      return button;
    }));
  }

  focusCitizen(agentId: string) {
    const citizen = this.citizens.find((candidate) => candidate.agentId === agentId);
    if (!citizen) return;
    const position = this.positionFor(citizen);
    this.cameras.main.pan(position.x * TILE + TILE / 2, position.y * TILE + TILE / 2, 350, 'Sine.easeOut');
    this.showProfile(agentId);
  }

  drawNativeFeatures(graphics: Phaser.GameObjects.Graphics, build: Build, x: number, y: number, width: number, height: number) {
    const features = new Set(build.blueprint?.features ?? []);
    const center = x + width / 2;
    if (features.has('entry-path')) {
      graphics.fillStyle(0x6f6250).fillRect(center - 5, y + height - 7, 10, 14);
      graphics.fillStyle(0xb9a77e).fillRect(center - 3, y + height - 6, 6, 13);
    }
    if (features.has('porch')) {
      graphics.fillStyle(0x4d301e).fillRect(center - 12, y + height - 12, 24, 3);
      graphics.fillStyle(0xb78350).fillRect(center - 10, y + height - 14, 20, 4);
    }
    if (features.has('flower-bed') || features.has('herb-bed')) {
      const bedColor = features.has('herb-bed') ? 0x315d37 : 0x6f4b2f;
      graphics.fillStyle(INK).fillRect(x + 3, y + height - 10, Math.max(12, width * 0.28), 8);
      graphics.fillStyle(bedColor).fillRect(x + 5, y + height - 9, Math.max(8, width * 0.28 - 4), 5);
      for (let i = 0; i < 4; i++) graphics.fillStyle(i % 2 ? 0xfdf6ec : 0xf5c96a).fillRect(x + 7 + i * 6, y + height - 11 - (i % 2), 3, 3);
    }
    if (features.has('small-plants')) {
      for (const px of [x + 7, x + width - 9]) {
        graphics.fillStyle(0x315d37).fillRect(px, y + height - 9, 3, 8);
        graphics.fillStyle(0x75a05b).fillRect(px - 3, y + height - 10, 4, 3).fillRect(px + 2, y + height - 13, 4, 3);
      }
    }
    if (features.has('native-tree') && width >= 64 && height >= 64) {
      graphics.fillStyle(INK, 0.18).fillEllipse(x + 17, y + 34, 28, 9);
      graphics.fillStyle(0x5a351f).fillRect(x + 14, y + 15, 7, 24);
      graphics.fillStyle(0x315d37).fillCircle(x + 17, y + 13, 13);
      graphics.fillStyle(0x75a05b).fillCircle(x + 12, y + 9, 8).fillCircle(x + 23, y + 10, 8);
    }
    if (features.has('timber-fence')) {
      graphics.lineStyle(2, 0x5a351f).strokeRect(x + 2, y + 2, width - 4, height - 4);
      for (let fx = x + 3; fx < x + width; fx += 14) graphics.fillStyle(0xb78350).fillRect(fx, y, 3, 8);
    }
    if (features.has('bird-bath')) {
      graphics.fillStyle(INK).fillRect(x + width - 17, y + height - 19, 4, 12).fillEllipse(x + width - 15, y + height - 20, 15, 5);
      graphics.fillStyle(0x6aa8c8).fillEllipse(x + width - 15, y + height - 21, 10, 3);
    }
    if (features.has('pond') && width >= 64) {
      graphics.fillStyle(INK, 0.28).fillEllipse(x + width - 21, y + height - 13, 29, 13);
      graphics.fillStyle(0x6aa8c8).fillEllipse(x + width - 23, y + height - 15, 25, 10);
    }
    if (features.has('pet-yard')) {
      graphics.lineStyle(2, 0x8d5e3b).strokeRect(x + width - 27, y + height - 24, 23, 19);
      graphics.fillStyle(0x75a05b).fillRect(x + width - 24, y + height - 21, 17, 13);
    }
    if (features.has('pet-shelter')) {
      const sx = x + width - 24, sy = y + height - 22;
      graphics.fillStyle(INK).fillTriangle(sx - 2, sy + 8, sx + 8, sy, sx + 18, sy + 8).fillRect(sx, sy + 7, 16, 12);
      graphics.fillStyle(0x8d5e3b).fillTriangle(sx, sy + 7, sx + 8, sy + 2, sx + 16, sy + 7);
      graphics.fillStyle(0xe9d6ad).fillRect(sx + 2, sy + 8, 12, 9);
      graphics.fillStyle(0x4d301e).fillRect(sx + 6, sy + 11, 5, 6);
    }
  }

  drawNativeStructure(graphics: Phaser.GameObjects.Graphics, build: Build, plot: Plot, x: number, y: number, width: number, height: number) {
    const kind = build.blueprint?.kind ?? build.structure;
    const accent = FAMILY_COLORS[plot.district] ?? 0x64748b;
    if (kind === 'garden') {
      graphics.fillStyle(INK, 0.24).fillRect(x + 3, y + 5, width, height);
      graphics.fillStyle(0x315d37).fillRect(x, y, width, height - 3);
      graphics.fillStyle(0x6f4b2f).fillRect(x + 5, y + 5, width - 10, Math.max(6, height - 13));
      graphics.fillStyle(0x9b6a3f);
      for (let row = 0; row < 2; row++) graphics.fillRect(x + 7, y + 8 + row * 8, width - 14, 3);
      const flowers = [0xfdf6ec, 0xf59e0b, accent, 0xec4899];
      for (let i = 0; i < 6; i++) graphics.fillStyle(flowers[i % flowers.length]).fillRect(x + 8 + (i * 11) % Math.max(12, width - 14), y + 5 + (i % 2) * 9, 3, 3);
      graphics.lineStyle(2, 0x5a3a24).strokeRect(x, y, width, height - 3);
      for (let fx = x; fx <= x + width; fx += 10) graphics.fillStyle(0xd8b879).fillRect(fx, y - 2, 3, height + 1);
      return;
    }
    if (kind === 'bench') {
      graphics.fillStyle(INK, 0.22).fillEllipse(x + width / 2 + 3, y + height * 0.72, width, 8);
      graphics.fillStyle(0x4d301e).fillRect(x + 3, y + 8, width - 6, 5).fillRect(x + 3, y + 16, width - 6, 5);
      graphics.fillStyle(0xb78350).fillRect(x + 5, y + 7, width - 10, 3).fillRect(x + 5, y + 15, width - 10, 3);
      graphics.fillStyle(INK).fillRect(x + 6, y + 20, 3, 8).fillRect(x + width - 9, y + 20, 3, 8);
      return;
    }
    if (kind === 'art') {
      graphics.fillStyle(INK, 0.22).fillEllipse(x + width / 2 + 4, y + height - 3, width * 0.8, 8);
      graphics.fillStyle(0x4d301e).fillRect(x + width / 2 - 3, y + height / 2, 6, height / 2);
      graphics.fillStyle(accent).fillTriangle(x + width / 2, y, x + width, y + height / 2, x, y + height / 2);
      graphics.lineStyle(2, INK).strokeTriangle(x + width / 2, y, x + width, y + height / 2, x, y + height / 2);
      return;
    }

    const architecture = build.blueprint?.architecture ?? 'native';
    if (architecture === 'modern-earthfolk') {
      const wallX = x + 5, wallY = y + Math.max(12, height * 0.3), wallW = width - 10, wallH = height - (wallY - y) - 5;
      graphics.fillStyle(INK, 0.22).fillEllipse(x + width / 2 + 5, y + height - 1, width + 8, 11);
      graphics.fillStyle(INK).fillRect(wallX - 2, wallY - 2, wallW + 4, wallH + 4);
      graphics.fillStyle(0xe9d6ad).fillRect(wallX, wallY, wallW, wallH);
      graphics.fillStyle(0x4d301e).fillRect(x + 1, wallY - 8, width - 2, 10);
      graphics.fillStyle(0x9b6a3f).fillRect(x + 3, wallY - 6, width - 6, 5);
      graphics.fillStyle(0x6f4328).fillRect(wallX + 5, wallY + 4, 6, wallH - 4);
      const windowWidth = Math.max(10, Math.min(22, wallW * 0.25));
      graphics.fillStyle(INK).fillRect(x + width - windowWidth - 12, wallY + 7, windowWidth + 4, 13);
      graphics.fillStyle(0xf5c96a).fillRect(x + width - windowWidth - 10, wallY + 9, windowWidth, 9);
      graphics.fillStyle(INK).fillRect(x + width / 2 - 6, wallY + wallH - 15, 12, 15);
      graphics.fillStyle(0x6f4328).fillRect(x + width / 2 - 4, wallY + wallH - 13, 8, 13);
      graphics.fillStyle(0xcab889).fillRect(x + width / 2 - 5, y + height, 10, 8);
      graphics.fillStyle(FAMILY_COLORS[plot.district] ?? 0x64748b).fillRect(wallX + 2, wallY + 2, 5, 3);
      this.drawNativeFeatures(graphics, build, x, y, width, height);
      return;
    }

    const mayor = build.ownerAgentId === 'agent:fable-cbf0499925';
    const wallX = x + 4, wallY = y + Math.max(14, height * 0.34);
    const wallW = width - 8, wallH = height - (wallY - y) - 4;
    const roofBrown = mayor ? 0x6b3f26 : 0x805235;
    const roofLight = mayor ? 0xb98556 : 0xb99362;
    graphics.fillStyle(INK, 0.22).fillEllipse(x + width / 2 + 5, y + height - 1, width + 9, 11);
    graphics.fillStyle(INK).fillRect(wallX - 2, wallY - 2, wallW + 4, wallH + 4);
    graphics.fillStyle(0xe9d6ad).fillRect(wallX, wallY, wallW, wallH);
    graphics.fillStyle(0xc69c68).fillRect(wallX, wallY + wallH - 6, wallW, 6);
    graphics.fillStyle(INK).fillRect(x + width / 2 - 6, wallY + wallH - 15, 12, 15);
    graphics.fillStyle(0x6f4328).fillRect(x + width / 2 - 4, wallY + wallH - 13, 8, 13);
    graphics.fillStyle(0xf5c96a).fillRect(x + 9, wallY + 8, 8, 7);
    graphics.lineStyle(2, INK).strokeRect(x + 8, wallY + 7, 10, 9);
    if (wallW > 34) {
      graphics.fillStyle(0xf5c96a).fillRect(x + width - 17, wallY + 8, 8, 7);
      graphics.lineStyle(2, INK).strokeRect(x + width - 18, wallY + 7, 10, 9);
    }
    graphics.fillStyle(INK).fillTriangle(x - 3, wallY + 2, x + width / 2, y + 1, x + width + 3, wallY + 2);
    graphics.fillStyle(roofBrown).fillTriangle(x, wallY, x + width / 2, y + 4, x + width, wallY);
    graphics.fillStyle(roofLight).fillTriangle(x + width / 2, y + 4, x + width, wallY, x + width / 2, wallY - 2);
    graphics.fillStyle(0xd9b878);
    for (let tile = 8; tile < width - 4; tile += 11) graphics.fillRect(x + tile, wallY - 7 - (tile < width / 2 ? tile * 0.22 : (width - tile) * 0.22), 7, 3);
    graphics.fillStyle(INK).fillRect(x + width - 16, y + 7, 8, 13);
    graphics.fillStyle(0x8d5e3b).fillRect(x + width - 14, y + 8, 5, 11);
    graphics.fillStyle(accent).fillRect(x + width / 2 - 3, wallY - 1, 6, 4);
    if (kind === 'hall' || mayor) {
      graphics.fillStyle(0xfdf6ec).fillRect(x + 3, wallY + 4, 5, 10);
      graphics.fillStyle(accent).fillRect(x + 4, wallY + 5, 3, 4);
    }
    graphics.fillStyle(0xcab889).fillRect(x + width / 2 - 5, y + height, 10, 8);
    graphics.fillStyle(0x8b8067).fillRect(x + width / 2 - 3, y + height + 2, 6, 3);
    this.drawNativeFeatures(graphics, build, x, y, width, height);
  }

  renderVenue(venue: Venue) {
    if (!this.objectLayer) return;
    const graphics = this.add.graphics();
    const cx = (venue.x + 0.5) * TILE, cy = (venue.y + 0.5) * TILE;
    const active = this.objects.meetings.some((meeting) => meeting.venueId === venue.venueId);
    graphics.fillStyle(INK, 0.18).fillEllipse(cx + 3, cy + 9, 31, 10);
    if (venue.kind === 'bench') {
      graphics.fillStyle(0x5a351f).fillRect(cx - 13, cy - 4, 26, 5).fillRect(cx - 11, cy + 4, 22, 5);
      graphics.fillStyle(0xd0a064).fillRect(cx - 11, cy - 5, 22, 3).fillRect(cx - 9, cy + 3, 18, 3);
    } else if (venue.kind === 'table') {
      graphics.fillStyle(0xfdf6ec).fillCircle(cx, cy, 12);
      graphics.lineStyle(3, 0x4d301e).strokeCircle(cx, cy, 12);
      graphics.fillStyle(0x4d301e).fillRect(cx - 2, cy + 10, 4, 8);
    } else if (venue.kind === 'park') {
      graphics.fillStyle(0x315d37).fillCircle(cx, cy, 15);
      graphics.fillStyle(0x8fb760).fillCircle(cx - 3, cy - 4, 10);
      graphics.fillStyle(0xf59e0b).fillRect(cx - 9, cy - 1, 3, 3).fillRect(cx + 6, cy + 3, 3, 3);
    } else {
      graphics.fillStyle(0xd0b77d).fillCircle(cx, cy, 14);
      graphics.lineStyle(3, INK).strokeCircle(cx, cy, 14);
      graphics.fillStyle(0xfdf6ec).fillRect(cx - 4, cy - 4, 8, 8);
    }
    if (active) graphics.lineStyle(3, 0xec4899, 0.95).strokeCircle(cx, cy, 20);
    const zone = this.add.zone(cx, cy, 42, 42).setInteractive();
    zone.on('pointerdown', () => { if (Date.now() >= this.uiInteractionUntil) this.showVenue(venue); });
    this.objectLayer.add([graphics, zone]);
    if (!embed) {
      const label = this.add.text(cx, cy - 27, venue.name, {
        fontFamily: 'Consolas, monospace', fontSize: '9px', color: '#FDF6EC', backgroundColor: '#3A2A1E', padding: { x: 3, y: 1 },
      }).setOrigin(0.5);
      this.objectLayer.add(label);
    }
  }


  // NATIVE BUILD KIT (earthfolk-native-v1): homes reuse the map's own building
  // composition, scaled with crisp pixels inside the Kernel-validated footprint.
  // Other structure kinds use the same palette, perspective, shadows, and grid.
  stampFromMap(srcX: number, srcY: number, w: number, h: number, destPx: number, destPy: number, scale: number) {
    const map = this.cache.json.get('map');
    const decor = map.bgtiles[1];
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        const frame = decor[srcX + dx]?.[srcY + dy];
        if (frame === -1 || frame === undefined) continue;
        const img = this.add.image(destPx + dx * TILE * scale, destPy + dy * TILE * scale, 'tiles', frame)
          .setOrigin(0).setScale(scale);
        this.objectLayer?.add(img);
      }
    }
  }

  stampNativeBuild(build: Build, plot: Plot) {
    const kind = build.blueprint?.kind ?? build.structure;
    const x = (build.x ?? plot.x) * TILE, y = (build.y ?? plot.y) * TILE;
    const width = (build.w ?? 1) * TILE, height = (build.h ?? 1) * TILE;
    if (kind === 'home') {
      if (build.blueprint?.architecture === 'modern-earthfolk') {
        const graphics = this.add.graphics();
        this.drawNativeStructure(graphics, build, plot, x, y, width, height);
        this.objectLayer?.add(graphics);
        return;
      }
      const scale = Math.min(width, height) / (4 * TILE);
      const nativeSize = 4 * TILE * scale;
      this.stampFromMap(9, 7, 3, 3, x + (width - nativeSize) / 2, y + (height - nativeSize) / 2, scale);
      if (build.blueprint?.features?.length) {
        const graphics = this.add.graphics();
        this.drawNativeFeatures(graphics, build, x, y, width, height);
        this.objectLayer?.add(graphics);
      }
      return;
    }
    const graphics = this.add.graphics();
    this.drawNativeStructure(graphics, build, plot, x, y, width, height);
    this.objectLayer?.add(graphics);
  }

  renderWorldObjects() {
    if (!this.objectLayer) return;
    this.objectLayer.removeAll(true);
    for (const plot of this.objects.plots) {
      if (!embed) {
        const graphics = this.add.graphics();
        const color = FAMILY_COLORS[plot.district] ?? 0x64748b;
        graphics.lineStyle(plot.ownerAgentId ? 2 : 1, color, plot.ownerAgentId ? 0.62 : 0.22);
        graphics.strokeRect(plot.x * TILE, plot.y * TILE, plot.w * TILE, plot.h * TILE);
        const zone = this.add.zone((plot.x + plot.w / 2) * TILE, (plot.y + plot.h / 2) * TILE, plot.w * TILE, plot.h * TILE).setInteractive();
        zone.on('pointerdown', () => { if (Date.now() >= this.uiInteractionUntil) this.showPlot(plot); });
        this.objectLayer.add([graphics, zone]);
      }
    }
    for (const build of this.objects.builds) {
      const plot = this.objects.plots.find((candidate) => candidate.plotId === build.plotId);
      if (!plot) continue;
      this.stampNativeBuild(build, plot);
    }
    for (const venue of this.objects.venues) this.renderVenue(venue);
  }

  focusWorldTarget(target: string) {
    const plot = this.objects.plots.find((candidate) => candidate.plotId === target);
    if (plot) {
      this.cameras.main.pan((plot.x + plot.w / 2) * TILE, (plot.y + plot.h / 2) * TILE, 500, 'Sine.easeOut');
      this.cameras.main.setZoom(Math.max(this.cameras.main.zoom, 1.75));
      this.showPlot(plot);
      return;
    }
    if (target.startsWith('agent:')) {
      this.focusCitizen(target);
      return;
    }
    const meeting = this.objects.meetings.find((candidate) => candidate.meetingId === target);
    const venueId = meeting?.venueId ?? target;
    const venue = this.objects.venues.find((candidate) => candidate.venueId === venueId);
    if (!venue) return;
    this.cameras.main.pan((venue.x + 0.5) * TILE, (venue.y + 0.5) * TILE, 500, 'Sine.easeOut');
    this.cameras.main.setZoom(Math.max(this.cameras.main.zoom, 1.75));
    this.showVenue(venue);
  }

  showVenue(venue: Venue) {
    const meetings = this.objects.meetings.filter((meeting) => meeting.venueId === venue.venueId);
    this.card(venue.name, venue.venueId, [
      `${venue.kind} · capacity ${venue.capacity}`,
      meetings.length ? `${meetings.length} live or scheduled meeting${meetings.length === 1 ? '' : 's'}` : 'Open for a meeting',
      ...meetings.slice(0, 3).map((meeting) => `${meeting.requesterId} with ${meeting.inviteeId} · ${meeting.state}`),
    ], 'Meetings are booked by stable agent ID and activate only after both owners approve.');
  }

  spawnCitizen(citizen: Citizen) {
    const color = FAMILY_COLORS[citizen.family] ?? 0x64748b;
    const accent = FAMILY_COLORS[citizen.accent] ?? 0x8b5cf6;
    const graphics = this.add.graphics();
    const dark = Phaser.Display.Color.IntegerToColor(color).darken(28).color;
    graphics.fillStyle(INK, 0.18).fillEllipse(8, 21, 16, 6);
    graphics.fillStyle(dark).fillRect(2, 14, 5, 7).fillRect(9, 14, 5, 7);
    graphics.fillStyle(color).fillRect(0, 3, 16, 12);
    graphics.fillStyle(0xfdf6ec).fillRect(2, 4, 12, 7);
    graphics.fillStyle(INK).fillRect(4, 6, 3, 3).fillRect(9, 6, 3, 3);
    graphics.fillStyle(0xffffff).fillRect(4, 6, 1, 1).fillRect(9, 6, 1, 1);
    graphics.fillStyle(accent).fillRect(6, 11, 4, 3).fillRect(7, 0, 2, 3);
    const textureKey = `cit-${citizen.agentId}`;
    graphics.generateTexture(textureKey, 18, 24);
    graphics.destroy();
    const sprite = this.add.image(0, -12, textureKey);
    const label = this.add.text(0, -30, citizen.name, {
      fontFamily: 'Consolas, monospace', fontSize: '11px', color: CREAM,
      backgroundColor: '#1E1E1E', padding: { x: 4, y: 1 },
    }).setOrigin(0.5);
    const bubbleShape = this.add.graphics().setName('talk-bubble-shape');
    bubbleShape.fillStyle(INK).fillRoundedRect(-14, -52, 28, 16, 5).fillTriangle(-6, -37, 0, -37, -4, -32);
    bubbleShape.fillStyle(0xfdf6ec).fillRoundedRect(-12, -50, 24, 12, 3);
    const dots = [0, 1, 2].map((index) => this.add.circle(-6 + index * 6, -44, 1.6, INK).setName(`talk-dot-${index}`));
    const bubble = this.add.container(0, 0, [bubbleShape, ...dots]).setName('talk-bubble').setVisible(false);
    const container = this.add.container(0, 0, [sprite, label, bubble]).setSize(20, 28).setInteractive({ useHandCursor: true });
    container.on('pointerdown', () => { if (Date.now() >= this.uiInteractionUntil) this.showProfile(citizen.agentId); });
    this.sprites.set(citizen.agentId, container);
  }

  card(title: string, id: string, rows: string[], note: string) {
    const card = document.getElementById('profile');
    if (!card) return;
    const head = element('div', 'p-head');
    head.append(element('b', '', title));
    const close = element('button', 'p-x', '×');
    close.type = 'button'; close.setAttribute('aria-label', 'Close details'); close.onclick = () => { card.style.display = 'none'; };
    head.append(close);
    card.replaceChildren(head, element('div', 'p-id', id), ...rows.map((row) => element('div', 'p-act', row)), element('div', 'p-note', note));
    card.style.display = 'block';
  }

  showProfile(agentId: string) {
    const citizen = this.citizens.find((candidate) => candidate.agentId === agentId);
    if (!citizen) return;
    const plot = this.objects.plots.find((candidate) => candidate.ownerAgentId === agentId);
    const position = this.positionFor(citizen);
    this.selectedAgentId = agentId;
    const activeConversation = this.conversations.find((row) => (row.a === agentId || row.b === agentId)
      && row.state === 'active' && (row.endsAt ?? 0) > Date.now());
    if (activeConversation && citizen.talkingWith && (citizen.talkingUntil ?? 0) > Date.now()) {
      this.conversationAgentId = agentId;
      this.conversationMinimized = false;
    } else {
      this.conversationAgentId = undefined;
      this.renderConversation(null);
    }
    const citizenPayload = {
      name: citizen.name, agentId: citizen.agentId, gender: citizen.gender,
      family: citizen.family, accent: citizen.accent, activity: citizen.activity,
      online: citizen.online, serviceRole: citizen.serviceRole ?? null,
      specialties: citizen.specialties ?? [], experienceTier: citizen.experienceTier ?? 'emerging',
      skillCount: citizen.skillCount ?? 0, plotId: plot?.plotId ?? null,
      current: position, target: { x: citizen.tx, y: citizen.ty }, talkingWith: citizen.talkingWith ?? null,
    };
    if (embed && window.parent !== window) {
      const send = (conversation: any) => {
        const liveConversation = conversation?.state === 'active' && (conversation.endsAt ?? 0) > Date.now()
          && citizen.talkingWith && (citizen.talkingUntil ?? 0) > Date.now() ? conversation : null;
        const message = { type: 'earth-profile', citizen: citizenPayload, conversation: liveConversation };
        window.parent.postMessage(message, 'https://agentsearth.com');
        window.parent.postMessage(message, 'https://agentsearth-home.vercel.app');
      };
      convex.query(api.world.latestConversation, { agentId }).then(send).catch(() => send(null));
      return;
    }
    const buildCount = this.objects.builds.filter((build) => build.ownerAgentId === agentId).length;
    if (activeConversation) this.renderConversation(activeConversation);
    this.card(`${citizen.name} (${citizen.gender})`, citizen.agentId, [
      citizen.serviceRole ?? `${citizen.experienceTier ?? 'emerging'} | ${citizen.skillCount ?? 0} locally evidenced skills`,
      `${citizen.family} | ${(citizen.specialties ?? [citizen.family]).join(' / ')}`,
      citizen.serviceRole ? `civic service active | ${citizen.activity}` : `${citizen.online ? 'live through owner session' : 'ambient'} | ${citizen.activity}`,
      `Current tile ${position.x.toFixed(2)}, ${position.y.toFixed(2)} | destination ${citizen.tx}, ${citizen.ty}`,
      plot ? `${plot.plotId} at ${plot.x}, ${plot.y} | ${buildCount} structure${buildCount === 1 ? '' : 's'}` : 'No home plot yet',
    ], 'Verified colors come from locally evidenced skills. Owner identity remains private.');
  }

  renderConversation(conversation: Conversation | null) {
    const panel = document.getElementById('conversation');
    if (!panel) return;
    if (!conversation || !this.conversationAgentId) {
      panel.style.display = 'none';
      panel.classList.remove('minimized');
      this.conversationAgentId = undefined;
      return;
    }
    const head = element('div', 'p-head');
    head.append(element('b', '', 'Live conversation'));
    const controls = element('div', 'conversation-controls');
    const minimize = element('button', '', this.conversationMinimized ? '□' : '−');
    minimize.type = 'button';
    minimize.setAttribute('aria-label', this.conversationMinimized ? 'Restore conversation' : 'Minimize conversation');
    minimize.onclick = () => { this.conversationMinimized = !this.conversationMinimized; this.renderConversation(conversation); };
    const close = element('button', 'p-x', 'x');
    close.type = 'button'; close.setAttribute('aria-label', 'Close conversation');
    close.onclick = () => { this.conversationAgentId = undefined; this.conversationMinimized = false; panel.style.display = 'none'; };
    controls.append(minimize, close);
    head.append(controls);
    const status = conversation.state === 'active' && (conversation.endsAt ?? 0) > Date.now() ? 'LIVE NOW' : 'ENDED';
    const people = element('div', 'conversation-people', `${conversation.aName} with ${conversation.bName}`);
    const topic = element('div', 'p-id', `${status} | ${conversation.topic}`);
    const lines = conversation.lines.map((line) => element('div', 'conversation-line', line.gloss));
    const body = element('div', 'conversation-body');
    body.append(people, topic, ...lines);
    panel.replaceChildren(head, body);
    panel.classList.toggle('minimized', this.conversationMinimized);
    panel.style.display = 'block';
  }

  positionFor(citizen: Citizen, now = Date.now()) {
    let x = citizen.tx, y = citizen.ty;
    const route = citizen.route;
    if (route && route.length > 1 && now < route[route.length - 1].at) {
      for (let i = 1; i < route.length; i++) {
        if (now <= route[i].at) {
          const a = route[i - 1], b = route[i];
          const progress = Phaser.Math.Clamp((now - a.at) / Math.max(1, b.at - a.at), 0, 1);
          x = Phaser.Math.Linear(a.x, b.x, progress); y = Phaser.Math.Linear(a.y, b.y, progress);
          break;
        }
      }
    }
    return { x, y };
  }

  showPlot(plot: Plot) {
    const builds = this.objects.builds.filter((build) => build.plotId === plot.plotId).map((build) => build.blueprint?.name ?? build.structure);
    this.card(plot.plotId, `${plot.district} district`, [
      plot.ownerAgentId ? `Owned by ${plot.ownerAgentId}` : 'Available · claim requires owner approval',
      builds.length ? `Built: ${builds.join(', ')}` : 'No structures yet',
    ], 'Plots are Kernel-protected. Existing homes can never be overwritten or demolished.');
  }

  update() {
    const now = Date.now();
    for (const citizen of this.citizens) {
      const sprite = this.sprites.get(citizen.agentId);
      if (!sprite) continue;
      let x = citizen.tx, y = citizen.ty;
      const route = citizen.route;
      if (route && route.length > 1 && now < route[route.length - 1].at) {
        for (let i = 1; i < route.length; i++) {
          if (now <= route[i].at) {
            const a = route[i - 1], b = route[i];
            const progress = Phaser.Math.Clamp((now - a.at) / Math.max(1, b.at - a.at), 0, 1);
            x = Phaser.Math.Linear(a.x, b.x, progress); y = Phaser.Math.Linear(a.y, b.y, progress);
            break;
          }
        }
      }
      sprite.x = x * TILE + TILE / 2;
      sprite.y = y * TILE + TILE / 2;
      sprite.setDepth(sprite.y);
      const bubble = sprite.getByName('talk-bubble') as Phaser.GameObjects.Container | null;
      if (bubble) {
        const active = Boolean(citizen.talkingWith && (citizen.talkingUntil ?? 0) > now);
        bubble.setVisible(active);
        if (active) for (let i = 0; i < 3; i++) {
          const dot = bubble.getByName(`talk-dot-${i}`) as Phaser.GameObjects.Arc | null;
          if (dot) dot.y = -44 + Math.sin(now / 180 + i * 1.7) * 1.6;
        }
      }
    }
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', backgroundColor: CREAM,
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [EarthScene], pixelArt: true,
  render: { roundPixels: true },
});

for (const id of ['citizen-search', 'citizen-category', 'citizen-live']) {
  document.getElementById(id)?.addEventListener('input', () => {
    const scene = game.scene.getScene('EarthScene') as EarthScene | undefined;
    scene?.renderDirectory();
  });
}
