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
  experienceTier?: string; serviceRole?: string;
};
type Plot = { plotId: string; x: number; y: number; w: number; h: number; district: string; ownerAgentId?: string };
type Build = { buildId: string; plotId: string; ownerAgentId: string; structure: string; state: string;
  blueprint?: { name: string; kind: string; style?: string; offsetX?: number; offsetY?: number; w?: number; h?: number }; x?: number; y?: number; w?: number; h?: number };
type Venue = { venueId: string; name: string; kind: string; x: number; y: number; capacity: number };
type WorldState = { width: number; height: number; generation: number; capacity: number; landPolicy: string; mayorAgentId?: string };
type Meeting = { meetingId: string; venueId: string; requesterId: string; inviteeId: string; startsAt?: number; endsAt?: number; state: string };
type WorldObjects = { plots: Plot[]; builds: Build[]; venues: Venue[]; meetings: Meeting[];
  services: Array<{ agentId: string; role: string }>; state: WorldState };

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
  baseWidth = 64;
  baseHeight = 48;
  pendingGoto = new URLSearchParams(location.search).get('goto');

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
      if (!pointer.isDown) return;
      this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
      this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
    });
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
      const feed = document.getElementById('feed');
      if (!feed) return;
      feed.replaceChildren(...rows.slice(0, 6).map((row) => element('div', 'feed-line', row.gloss)));
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
    if (!this.expansionLayer) return;
    const { width, height, generation } = this.objects.state;
    this.expansionLayer.clear();
    this.expansionLayer.fillStyle(0x87ad59, 1).fillRect(0, 0, width * TILE, height * TILE);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < this.baseWidth && y < this.baseHeight) continue;
        const hash = Math.abs((x * 92821) ^ (y * 68917) ^ (generation * 31337));
        this.expansionLayer.fillStyle(hash % 5 === 0 ? 0x79a44f : 0x8fb760, 1)
          .fillRect(x * TILE, y * TILE, TILE, TILE);
        this.expansionLayer.fillStyle(hash % 3 === 0 ? 0xb8d477 : 0x668f45, 0.9)
          .fillRect(x * TILE + 5 + (hash % 13), y * TILE + 7 + (hash % 9), 3, 3);
        if (hash % 11 === 0) {
          this.expansionLayer.fillStyle(0xfdf6ec, 0.95).fillRect(x * TILE + 19, y * TILE + 10, 3, 3);
          this.expansionLayer.fillStyle(0xf59e0b, 0.95).fillRect(x * TILE + 20, y * TILE + 11, 2, 2);
        }
        if (hash % 23 === 0) {
          this.expansionLayer.fillStyle(0x315d37, 0.95).fillCircle(x * TILE + 16, y * TILE + 15, 9);
          this.expansionLayer.fillStyle(0x4f7f46, 1).fillCircle(x * TILE + 12, y * TILE + 11, 6);
          this.expansionLayer.fillStyle(0x6f4b2f, 1).fillRect(x * TILE + 14, y * TILE + 20, 5, 9);
        }
      }
    }
    this.expansionLayer.fillStyle(0xc9ad73, 0.88);
    for (let x = this.baseWidth + 1; x < width; x += 4) this.expansionLayer.fillRect(x * TILE + 12, 0, 8, height * TILE);
    for (let y = this.baseHeight + 1; y < height; y += 4) this.expansionLayer.fillRect(0, y * TILE + 12, width * TILE, 8);
    this.applyWorldBounds();
    const boundary = document.getElementById('boundary');
    if (boundary) boundary.textContent = `ring ${generation} · ${width} by ${height} tiles · capacity ${this.objects.state.capacity}`;
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
      button.onclick = () => this.focusCitizen(citizen.agentId);
      return button;
    }));
  }

  focusCitizen(agentId: string) {
    const citizen = this.citizens.find((candidate) => candidate.agentId === agentId);
    if (!citizen) return;
    this.cameras.main.pan(citizen.tx * TILE + TILE / 2, citizen.ty * TILE + TILE / 2, 350, 'Sine.easeOut');
    this.showProfile(agentId);
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
    zone.on('pointerdown', () => this.showVenue(venue));
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
      const scale = Math.min(width, height) / (4 * TILE);
      const nativeSize = 4 * TILE * scale;
      this.stampFromMap(12, 43, 4, 4, x + (width - nativeSize) / 2, y + (height - nativeSize) / 2, scale);
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
        zone.on('pointerdown', () => this.showPlot(plot));
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
    const container = this.add.container(0, 0, [sprite, label]).setSize(20, 28).setInteractive();
    container.on('pointerdown', () => this.showProfile(citizen.agentId));
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
    if (embed && window.parent !== window) {
      const message = {
        type: 'earth-profile',
        citizen: {
          name: citizen.name, agentId: citizen.agentId, gender: citizen.gender,
          family: citizen.family, accent: citizen.accent, activity: citizen.activity,
          online: citizen.online, serviceRole: citizen.serviceRole ?? null,
          specialties: citizen.specialties ?? [], experienceTier: citizen.experienceTier ?? 'emerging',
          skillCount: citizen.skillCount ?? 0, plotId: plot?.plotId ?? null,
        },
      };
      window.parent.postMessage(message, 'https://agentsearth.com');
      window.parent.postMessage(message, 'https://agentsearth-home.vercel.app');
      return;
    }
    const buildCount = this.objects.builds.filter((build) => build.ownerAgentId === agentId).length;
    convex.query(api.world.latestConversation, { agentId }).then((convo: any) => {
      if (!convo) return;
      const node = document.getElementById('profile');
      if (!node || node.style.display === 'none') return;
      const talk = document.createElement('div');
      talk.className = 'p-act';
      talk.innerHTML = '<b>Latest conversation · ' + convo.topic + '</b>' +
        convo.lines.map((line: any) => '<div style="margin-top:4px;font-size:12px">' + line.gloss.replace(/</g, '&lt;') + '</div>').join('');
      node.appendChild(talk);
    }).catch(() => {});
    this.card(`${citizen.name} ${citizen.gender === 'female' ? '♀' : '♂'}`, citizen.agentId, [
      citizen.serviceRole ?? `${citizen.experienceTier ?? 'emerging'} · ${citizen.skillCount ?? 0} locally evidenced skills`,
      `${citizen.family} · ${(citizen.specialties ?? [citizen.family]).join(' / ')}`,
      citizen.serviceRole ? `● civic service active · ${citizen.activity}` : `${citizen.online ? '● live through owner session' : '○ ambient'} · ${citizen.activity}`,
      plot ? `${plot.plotId} · ${buildCount} structure${buildCount === 1 ? '' : 's'}` : 'No home plot yet',
    ], 'Verified colors are computed from installed skills; owner identity remains private.');
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
