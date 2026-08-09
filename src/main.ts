import Phaser from 'phaser';
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';

// ── Earthfolk tokens ─────────────────────────────────────────────
const FAMILY_COLORS: Record<string, number> = {
  engineering: 0x3b82f6, design: 0x8b5cf6, marketing: 0xf97316,
  content: 0xf59e0b, data: 0x14b8a6, security: 0xef4444,
  research: 0x22c55e, media: 0xec4899, ops: 0x64748b,
};
const INK = 0x1e1e1e;
const CREAM = '#FDF6EC';

const embed = new URLSearchParams(location.search).has('embed');
const convex = new ConvexClient(import.meta.env.VITE_CONVEX_URL as string);

type Citizen = {
  agentId: string; name: string; gender: string; family: string; accent: string;
  fx: number; fy: number; tx: number; ty: number; t0: number; t1: number;
  state: string; activity: string; online: boolean;
};

let TILE = 32;

class EarthScene extends Phaser.Scene {
  sprites = new Map<string, Phaser.GameObjects.Container>();
  citizens: Citizen[] = [];
  selected: string | null = null;

  preload() {
    this.load.json('map', '/assets/map.json');
    this.load.spritesheet('tiles', '/assets/gentle-obj.png', { frameWidth: 32, frameHeight: 32 });
  }

  create() {
    const map = this.cache.json.get('map');
    TILE = map.tile;

    // Terrain: all layers drawn once into a single RenderTexture — fast,
    // physics-true, straight from the original map data (MIT, Earthfolk-recolored).
    const ground = this.add.renderTexture(0, 0, map.width * TILE, map.height * TILE).setOrigin(0);
    const layers = [...map.bgtiles, ...map.objmap];
    for (const layer of layers) {
      for (let x = 0; x < map.width; x++) {
        for (let y = 0; y < map.height; y++) {
          const t = layer[x][y];
          if (t === -1 || t === undefined) continue;
          ground.drawFrame('tiles', t, x * TILE, y * TILE);
        }
      }
    }
    ground.setDepth(-1);

    this.cameras.main.setBounds(0, 0, map.width * TILE, map.height * TILE);
    this.cameras.main.setBackgroundColor(CREAM);
    this.cameras.main.centerOn((map.width * TILE) / 2, (map.height * TILE) / 2);
    this.cameras.main.setZoom(embed ? 1.15 : 1.4);

    // pan + zoom
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      this.cameras.main.scrollX -= (p.x - p.prevPosition.x) / this.cameras.main.zoom;
      this.cameras.main.scrollY -= (p.y - p.prevPosition.y) / this.cameras.main.zoom;
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const z = this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1);
      this.cameras.main.setZoom(Phaser.Math.Clamp(z, 0.5, 3));
    });

    // Live citizens from the Kernel
    convex.onUpdate(api.world.citizens, {}, (rows: Citizen[]) => {
      this.citizens = rows;
      for (const c of rows) if (!this.sprites.has(c.agentId)) this.spawnCitizen(c);
    });
    // Live narrator feed → DOM ticker
    convex.onUpdate(api.world.feed, {}, (rows: { id: string; gloss: string }[]) => {
      const feed = document.getElementById('feed')!;
      feed.innerHTML = rows.slice(0, 6).map((r) => `<div class="feed-line">${r.gloss}</div>`).join('');
    });
  }

  spawnCitizen(c: Citizen) {
    const color = FAMILY_COLORS[c.family] ?? 0x64748b;
    const accent = FAMILY_COLORS[c.accent] ?? 0x8b5cf6;
    const g = this.add.graphics();
    const dark = Phaser.Display.Color.IntegerToColor(color).darken(28).color;
    // Our own pixel citizen: shadow, legs, body, face, eyes, emblem, antenna.
    g.fillStyle(INK, 0.18).fillEllipse(8, 21, 16, 6);
    g.fillStyle(dark).fillRect(2, 14, 5, 7).fillRect(9, 14, 5, 7);
    g.fillStyle(color).fillRect(0, 3, 16, 12);
    g.fillStyle(0xfdf6ec).fillRect(2, 4, 12, 7);
    g.fillStyle(INK).fillRect(4, 6, 3, 3).fillRect(9, 6, 3, 3);
    g.fillStyle(0xffffff).fillRect(4, 6, 1, 1).fillRect(9, 6, 1, 1);
    g.fillStyle(accent).fillRect(6, 11, 4, 3).fillRect(7, 0, 2, 3);
    g.generateTexture('cit-' + c.agentId, 18, 24);
    g.destroy();

    const sprite = this.add.image(0, -12, 'cit-' + c.agentId);
    const label = this.add
      .text(0, -30, c.name, {
        fontFamily: 'Consolas, monospace', fontSize: '11px',
        color: CREAM, backgroundColor: '#1E1E1E', padding: { x: 4, y: 1 },
      })
      .setOrigin(0.5);
    const cont = this.add.container(0, 0, [sprite, label]).setSize(20, 28).setInteractive();
    cont.on('pointerdown', () => this.showProfile(c.agentId));
    this.sprites.set(c.agentId, cont);
  }

  showProfile(agentId: string) {
    const c = this.citizens.find((x) => x.agentId === agentId);
    if (!c) return;
    const card = document.getElementById('profile')!;
    card.style.display = 'block';
    card.innerHTML = `
      <div class="p-head"><b>${c.name}</b> ${c.gender === 'female' ? '♀' : '♂'}
        <span class="p-x" onclick="this.closest('#profile').style.display='none'">✕</span></div>
      <div class="p-id">${c.agentId}</div>
      <div class="p-row"><i style="background:#${(FAMILY_COLORS[c.family] ?? 0).toString(16).padStart(6, '0')}"></i>${c.family} · <i style="background:#${(FAMILY_COLORS[c.accent] ?? 0).toString(16).padStart(6, '0')}"></i>${c.accent}</div>
      <div class="p-act">${c.online ? '🟢 live (owner connected)' : '🌙 ambient'} — ${c.activity}</div>
      <div class="p-note">Verified colors — computed from real skills, never claimed.</div>`;
  }

  update() {
    const now = Date.now();
    for (const c of this.citizens) {
      const s = this.sprites.get(c.agentId);
      if (!s) continue;
      const p = Phaser.Math.Clamp((now - c.t0) / Math.max(1, c.t1 - c.t0), 0, 1);
      s.x = (c.fx + (c.tx - c.fx) * p) * TILE + TILE / 2;
      s.y = (c.fy + (c.ty - c.fy) * p) * TILE + TILE / 2;
      s.setDepth(s.y);
    }
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: CREAM,
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [EarthScene],
  pixelArt: true,
});
