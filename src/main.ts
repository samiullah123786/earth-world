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
  blueprint?: { name: string; kind: string }; x?: number; y?: number; w?: number; h?: number };
type Venue = { venueId: string; name: string; kind: string; x: number; y: number; capacity: number };
type WorldState = { width: number; height: number; generation: number; capacity: number; landPolicy: string };
type WorldObjects = { plots: Plot[]; builds: Build[]; venues: Venue[]; meetings: Array<{ meetingId: string; venueId: string }>;
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
    this.expansionLayer.fillStyle(0xa8c66c, 1).fillRect(0, 0, width * TILE, height * TILE);
    this.expansionLayer.fillStyle(0xd8c28f, 0.9);
    for (let x = this.baseWidth; x < width; x += 8) this.expansionLayer.fillRect(x * TILE, 0, TILE, height * TILE);
    for (let y = this.baseHeight; y < height; y += 8) this.expansionLayer.fillRect(0, y * TILE, width * TILE, TILE);
    for (let y = 1; y < height; y += 3) {
      for (let x = 1; x < width; x += 3) {
        if (x < this.baseWidth && y < this.baseHeight) continue;
        const value = (x * 31 + y * 17 + generation * 13) % 19;
        if (value < 3) this.expansionLayer.fillStyle(value === 0 ? 0xf59e0b : 0x6e9f4b, 0.75).fillRect(x * TILE + 7, y * TILE + 9, 4, 4);
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

  renderWorldObjects() {
    if (!this.objectLayer) return;
    this.objectLayer.removeAll(true);
    for (const plot of this.objects.plots) {
      const graphics = this.add.graphics();
      const color = FAMILY_COLORS[plot.district] ?? 0x64748b;
      graphics.lineStyle(plot.ownerAgentId ? 2 : 1, color, plot.ownerAgentId ? 0.8 : 0.28);
      graphics.strokeRect(plot.x * TILE, plot.y * TILE, plot.w * TILE, plot.h * TILE);
      const zone = this.add.zone((plot.x + plot.w / 2) * TILE, (plot.y + plot.h / 2) * TILE, plot.w * TILE, plot.h * TILE).setInteractive();
      zone.on('pointerdown', () => this.showPlot(plot));
      this.objectLayer.add([graphics, zone]);
    }
    for (const build of this.objects.builds) {
      const plot = this.objects.plots.find((candidate) => candidate.plotId === build.plotId);
      if (!plot) continue;
      const graphics = this.add.graphics();
      const x = ((build.x ?? plot.x) + 0.15) * TILE, y = ((build.y ?? plot.y) + 0.15) * TILE;
      const width = Math.max(24, (build.w ?? 2) * TILE - 10), height = Math.max(24, (build.h ?? 2) * TILE - 10);
      const kind = build.blueprint?.kind ?? build.structure;
      if (kind === 'garden') {
        graphics.fillStyle(0x22c55e).fillRect(x, y, width, height);
        graphics.fillStyle(0xf59e0b).fillCircle(x + width * 0.25, y + height * 0.35, 4).fillCircle(x + width * 0.55, y + height * 0.68, 4).fillCircle(x + width * 0.8, y + height * 0.3, 4);
      } else if (kind === 'bench') {
        graphics.fillStyle(0x7c4a28).fillRect(x + 2, y + height * 0.4, width - 4, 5)
          .fillRect(x + 4, y + height * 0.4 + 5, 4, height * 0.35)
          .fillRect(x + width - 8, y + height * 0.4 + 5, 4, height * 0.35);
      } else if (kind === 'art') {
        graphics.fillStyle(INK).fillRect(x + width / 2 - 5, y + height / 2, 10, height / 2);
        graphics.fillStyle(FAMILY_COLORS[plot.district] ?? 0x8b5cf6).fillTriangle(x + width / 2, y, x + width, y + height / 2, x, y + height / 2);
      } else {
        graphics.fillStyle(0x1e1e1e).fillRect(x, y + 10, width, height - 10);
        graphics.fillStyle(0xfdf6ec).fillRect(x + 4, y + 14, width - 8, height - 18);
        graphics.fillStyle(FAMILY_COLORS[plot.district] ?? 0x64748b).fillTriangle(x - 4, y + 12, x + width / 2, y - 8, x + width + 4, y + 12);
        graphics.fillStyle(0x1e1e1e).fillRect(x + width / 2 - 6, y + height - 18, 12, 14);
      }
      this.objectLayer.add(graphics);
    }
    for (const venue of this.objects.venues) {
      const graphics = this.add.graphics();
      graphics.fillStyle(0xfdf6ec, 0.9).fillCircle(venue.x * TILE, venue.y * TILE, 8);
      graphics.lineStyle(2, INK, 0.85).strokeCircle(venue.x * TILE, venue.y * TILE, 8);
      if (this.objects.meetings.some((meeting) => meeting.venueId === venue.venueId)) {
        graphics.lineStyle(3, 0xec4899, 0.9).strokeCircle(venue.x * TILE, venue.y * TILE, 14);
      }
      this.objectLayer.add(graphics);
    }
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
    const buildCount = this.objects.builds.filter((build) => build.ownerAgentId === agentId).length;
    this.card(`${citizen.name} ${citizen.gender === 'female' ? '♀' : '♂'}`, citizen.agentId, [
      citizen.serviceRole ?? `${citizen.experienceTier ?? 'emerging'} · ${citizen.skillCount ?? 0} locally evidenced skills`,
      `${citizen.family} · ${(citizen.specialties ?? [citizen.family]).join(' / ')}`,
      citizen.serviceRole ? `● civic service active — ${citizen.activity}` : `${citizen.online ? '● live through owner session' : '○ ambient'} — ${citizen.activity}`,
      plot ? `${plot.plotId} · ${buildCount} structure${buildCount === 1 ? '' : 's'}` : 'No home plot yet',
    ], 'Verified colors are computed from installed skills; owner identity remains private.');
  }

  showPlot(plot: Plot) {
    const builds = this.objects.builds.filter((build) => build.plotId === plot.plotId).map((build) => build.blueprint?.name ?? build.structure);
    this.card(plot.plotId, `${plot.district} district`, [
      plot.ownerAgentId ? `Owned by ${plot.ownerAgentId}` : 'Available — claim requires owner approval',
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
});

for (const id of ['citizen-search', 'citizen-category', 'citizen-live']) {
  document.getElementById(id)?.addEventListener('input', () => {
    const scene = game.scene.getScene('EarthScene') as EarthScene | undefined;
    scene?.renderDirectory();
  });
}
