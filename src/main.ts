import Phaser from 'phaser';
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';

const FAMILY_COLORS: Record<string, number> = {
  engineering: 0x3b82f6, design: 0x8b5cf6, marketing: 0xf97316,
  content: 0xf59e0b, data: 0x14b8a6, security: 0xef4444,
  research: 0x22c55e, media: 0xec4899, ops: 0x64748b,
};
const INK = 0x1e1e1e;
const CREAM = '#FDF6EC';
const embed = new URLSearchParams(location.search).has('embed');
const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!convexUrl) throw new Error('VITE_CONVEX_URL is required');
const convex = new ConvexClient(convexUrl);

type RoutePoint = { x: number; y: number; at: number };
type Citizen = {
  agentId: string; name: string; gender: string; family: string; accent: string;
  fx: number; fy: number; tx: number; ty: number; t0: number; t1: number;
  route?: RoutePoint[]; state: string; activity: string; online: boolean;
};
type Plot = { plotId: string; x: number; y: number; w: number; h: number; district: string; ownerAgentId?: string };
type Build = { buildId: string; plotId: string; ownerAgentId: string; structure: string; state: string };
type Venue = { venueId: string; name: string; kind: string; x: number; y: number; capacity: number };
type WorldObjects = { plots: Plot[]; builds: Build[]; venues: Venue[]; meetings: Array<{ meetingId: string; venueId: string }> };

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
  objects: WorldObjects = { plots: [], builds: [], venues: [], meetings: [] };
  objectLayer?: Phaser.GameObjects.Container;

  preload() {
    this.load.json('map', '/assets/map.json');
    this.load.spritesheet('tiles', '/assets/gentle-obj.png', { frameWidth: 32, frameHeight: 32 });
  }

  create() {
    const map = this.cache.json.get('map');
    TILE = map.tile;
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
    this.cameras.main.setZoom(embed ? 1.15 : 1.4);
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
      this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
    });
    this.input.on('wheel', (_pointer: unknown, _objects: unknown, _dx: number, dy: number) => {
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 3));
    });

    convex.onUpdate(api.world.citizens, {}, (rows: Citizen[]) => {
      this.citizens = rows;
      const liveIds = new Set(rows.map((row) => row.agentId));
      for (const citizen of rows) if (!this.sprites.has(citizen.agentId)) this.spawnCitizen(citizen);
      for (const [agentId, sprite] of this.sprites) {
        if (!liveIds.has(agentId)) { sprite.destroy(true); this.sprites.delete(agentId); }
      }
    });
    convex.onUpdate(api.world.worldObjects, {}, (objects: WorldObjects) => {
      this.objects = objects;
      this.renderWorldObjects();
    });
    convex.onUpdate(api.world.feed, {}, (rows: Array<{ id: string; gloss: string }>) => {
      const feed = document.getElementById('feed');
      if (!feed) return;
      feed.replaceChildren(...rows.slice(0, 6).map((row) => element('div', 'feed-line', row.gloss)));
    });
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
      const x = (plot.x + 0.5) * TILE, y = (plot.y + 0.6) * TILE;
      if (build.structure === 'garden') {
        graphics.fillStyle(0x22c55e).fillRect(x, y + 20, 58, 28);
        graphics.fillStyle(0xf59e0b).fillCircle(x + 12, y + 28, 4).fillCircle(x + 32, y + 36, 4).fillCircle(x + 48, y + 25, 4);
      } else if (build.structure === 'bench') {
        graphics.fillStyle(0x7c4a28).fillRect(x + 8, y + 28, 50, 9).fillRect(x + 12, y + 38, 6, 12).fillRect(x + 48, y + 38, 6, 12);
      } else {
        graphics.fillStyle(0x1e1e1e).fillRect(x, y + 15, 64, 48);
        graphics.fillStyle(0xfdf6ec).fillRect(x + 4, y + 19, 56, 40);
        graphics.fillStyle(FAMILY_COLORS[plot.district] ?? 0x64748b).fillTriangle(x - 5, y + 18, x + 32, y - 8, x + 69, y + 18);
        graphics.fillStyle(0x1e1e1e).fillRect(x + 25, y + 38, 14, 21);
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
      `${citizen.family} · ${citizen.accent}`,
      `${citizen.online ? '● live through owner session' : '○ ambient'} — ${citizen.activity}`,
      plot ? `${plot.plotId} · ${buildCount} structure${buildCount === 1 ? '' : 's'}` : 'No home plot yet',
    ], 'Verified colors are computed from installed skills; owner identity remains private.');
  }

  showPlot(plot: Plot) {
    const builds = this.objects.builds.filter((build) => build.plotId === plot.plotId).map((build) => build.structure);
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

new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', backgroundColor: CREAM,
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [EarthScene], pixelArt: true,
});
