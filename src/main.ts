import Phaser from 'phaser';
import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import lpcManifest from './data/lpc_manifest.json';
import { AGENT_ANIMATION_FRAMES, LPC_AGENT_FRAME_SIZE } from './data/lpc_agent_animations';
import { resolveAvatarKey, stableIdentityHash, tierInsignia, type PublicAvatarSpec } from './avatar_identity';
import { LPC_GRID_SIZE, assertGridSize, renderRoutePoint, structureSortAnchor, tileCenter, tileOrigin } from './world/grid';
import { componentRenderContract, citizenDepth, WORLD_LAYER_DEPTH, type WorldRenderLayer } from './world/layering';
import { LPC_PREFABS, prefabForStructure, type LpcPrefab } from '../shared/lpc-prefabs';
import {
  EARTHFORGE_ASSETS,
  EARTHFORGE_PROPS,
  EARTHFORGE_SYSTEM,
  EARTHFORGE_TEXTURE_REVISION,
  EARTHFORGE_VISUAL_SYSTEM,
  earthForgeAssetFor,
  earthForgeSiteContract,
  semanticIntent,
} from '../shared/earthforge';
import type { DistrictBiome } from '../shared/wfc';
import { normalizeTiledChunk, tiledLayerMatrix, TILED_GIDS, TILED_LAYER_NAMES, TILED_MAP_FORMAT, type TiledChunkPayload } from '../shared/tiled-world';
import { DynamicNavigationGrid } from './world/navigation';
import { WAKING_GATE, isAsleep, renderTransition } from '../shared/slumber';
import { selectRenderableBuilds } from './world/scene-layout';
import { earthForgeRenderPlan, earthForgeTextureKey } from './world/earthforge-render';

const RENDER_DELAY_MS = 140;
const LPC_AGENT_KEYS = new Set(Object.keys(AGENT_ANIMATION_FRAMES));
// The sheets every world needs regardless of who lives in it. Everything
// else streams on demand: 138 catalog variants are 15 MB, and a visitor
// should never wait on a citizen who is not on their screen.
type AgentSheetDefinition = { sheet: string; animations: Record<string, readonly number[]> };
const agentSheet = (key: string): AgentSheetDefinition | undefined =>
  (AGENT_ANIMATION_FRAMES as unknown as Record<string, AgentSheetDefinition>)[key];

const ESSENTIAL_AGENT_KEYS = [
  'mayor_sam', 'aegis', 'terra', 'tock', 'sage', 'atlas', 'default_male', 'default_female',
].filter((key) => Boolean(agentSheet(key)));

const FAMILY_COLORS: Record<string, number> = {
  engineering: 0x3b82f6, design: 0x8b5cf6, marketing: 0xf97316,
  content: 0xf59e0b, data: 0x14b8a6, security: 0xef4444,
  research: 0x22c55e, media: 0xec4899, ops: 0x64748b,
  ui: 0x8b5cf6, ux: 0xa855f7, frontend: 0x3b82f6, backend: 0x2563eb,
  growth: 0xf97316, automation: 0x64748b, general: 0x84a98c,
};
const INK = 0x1e1e1e;
const CREAM = '#FDF6EC';
const OWNER_DASHBOARD_ORIGINS = new Set([
  'https://agentsearth.com',
  'https://agentsearth-home.vercel.app',
]);
const embed = new URLSearchParams(location.search).has('embed');
const lpcRenderPreview = import.meta.env.DEV && new URLSearchParams(location.search).has('lpc-preview');
if (embed) document.body.classList.add('embed');
// Speech-bubble geometry, shared by creation AND animation so the two can
// never disagree again. Derived from the citizen composition: a 64px LPC frame
// at y=-20 scaled 0.82 puts the visible head top near -40; the name plate (11px
// text at y=-48) occupies roughly [-56,-40]. While a citizen talks the bubble
// REPLACES the plate: box just above the head, tail touching it.
/** The LPC row a movement vector should play. Ties fall to vertical, matching
 * how the Kernel resolves a diagonal target. */
function headingFor(dx: number, dy: number): 'back' | 'left' | 'front' | 'right' {
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'front' : 'back';
}

const BUBBLE_GEOM = {
  boxX: -15, boxTop: -64, boxW: 30, boxH: 16,   // ink box [-64,-48]
  dotY: -56,                                     // white-inset centerline
  dotXs: [-6, 0, 6] as const,
  tail: { baseY: -49, tipX: -1, tipY: -42 },     // tip 2-3px above the head
  sleepBaseX: 12, sleepBaseY: -58,               // Zzz stack base, clear of the plate
};

// ?debug=bubbles,arc — display-only QA modes, spectator-side, no authority.
// bubbles: force talk bubbles visible so geometry is reviewable at any zoom.
// arc: loop a demo coin arc between citizens so the trade animation is
// reviewable without waiting for a real trade to happen in front of the camera.
const DEBUG_FLAGS = new Set((new URLSearchParams(window.location.search).get('debug') ?? '').split(',').filter(Boolean));
const DEBUG_BUBBLES = DEBUG_FLAGS.has('bubbles');
const DEBUG_ARC = DEBUG_FLAGS.has('arc');
const DEBUG_WFC = DEBUG_FLAGS.has('wfc');

/**
 * The wallet HUD, in one place.
 *
 * Two surfaces feed it - the dashboard hands a balance in when the map is
 * embedded, and `pollWallet` fetches one when the map is opened directly - and
 * both arrive here, so there is exactly one way the number is drawn and one
 * definition of what "no balance" looks like.
 */
let walletBalance: number | null = null;
const WALLET_CACHE_KEY = 'earth-wallet-last';

function showWallet(next: number, remember = true) {
  const amount = document.getElementById('wallet-balance');
  const hud = document.getElementById('wallet');
  if (!amount || !hud || !Number.isFinite(next) || next < 0) return;
  const whole = Math.round(next);
  const changed = walletBalance !== null && whole !== walletBalance;
  walletBalance = whole;
  amount.textContent = whole.toLocaleString();
  hud.title = 'Your Earth Token balance, live from the Kernel';
  if (remember) { try { localStorage.setItem(WALLET_CACHE_KEY, String(whole)); } catch { /* private mode */ } }
  if (!changed) return;
  // A balance that changes while you are looking at it should say so.
  hud.classList.remove('pulse');
  void hud.offsetWidth;                 // restart the animation rather than skip it
  hud.classList.add('pulse');
}

// The last known balance paints instantly - a wallet that opens on a dash for
// twenty seconds reads as "you were paid nothing". The poll corrects it
// silently; only a first-ever visitor sees the dash, which is the truth.
try {
  const cached = localStorage.getItem(WALLET_CACHE_KEY);
  if (cached !== null && Number.isFinite(Number(cached))) showWallet(Number(cached), false);
} catch { /* private mode: the dash remains until the first poll */ }

/** Ask this origin for the balance. Spectators get a quiet no and keep the dash. */
async function pollWallet(): Promise<boolean> {
  try {
    const response = await fetch('/api/wallet', { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({ ok: false }));
    if (data?.ok && Number.isFinite(Number(data.balance))) { showWallet(Number(data.balance)); return true; }
  } catch {
    // Offline or Kernel down: the HUD keeps whatever it last knew rather than
    // flickering to a dash, which would read as "you were paid nothing".
  }
  return false;
}

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!convexUrl) throw new Error('VITE_CONVEX_URL is required');
const convex = new ConvexClient(convexUrl);

type RoutePoint = { x: number; y: number; at: number };
type Rank = { score: number; rank: { id: string; name: string }; next?: { name: string; remaining: number } | null };
type Citizen = {
  agentId: string; name: string; bio?: string; gender: string; family: string; accent: string;
  fx: number; fy: number; tx: number; ty: number; t0: number; t1: number;
  route?: RoutePoint[]; state: string; activity: string; online: boolean;
  offlineSince?: number; asleepSince?: number;
  specialties?: string[]; primaryCategory?: string; skillCount?: number;
  experienceTier?: string; serviceRole?: string; talkingWith?: string; talkingUntil?: number;
  carriedTool?: string; workingUntil?: number; facing?: 'back' | 'left' | 'front' | 'right';
  trainingActivity?: string; trainingTeam?: string; trainingStartsAt?: number; trainingUntil?: number;
  attendingEventId?: string; attendingUntil?: number; rank?: Rank;
  activeBuildId?: string; activeTool?: string; buildingStartsAt?: number; buildingUntil?: number;
  avatarSpec?: PublicAvatarSpec;
};
type Plot = { plotId: string; x: number; y: number; w: number; h: number; district: string; ownerAgentId?: string };
type Build = { buildId: string; plotId: string; ownerAgentId: string; structure: string; state: string;
  blueprint?: { name: string; kind: string; style?: string; architecture?: string; features?: string[];
    offsetX?: number; offsetY?: number; w?: number; h?: number; assetFramework?: string;
    earthForge?: ReturnType<typeof semanticIntent>;
    prefabId?: string; entry?: { x: number; y: number }; collision?: Array<{ x: number; y: number }>;
    placements?: Array<{ assetId: string; kind: 'tile' | 'prop'; layer?: WorldRenderLayer; xOffset: number; yOffset: number }> };
  x?: number; y?: number; w?: number; h?: number; constructionStartsAt?: number; constructionEndsAt?: number };
type Venue = { venueId: string; name: string; kind: string; x: number; y: number; capacity: number };
type WorldState = { width: number; height: number; generation: number; capacity: number; landPolicy: string; mayorAgentId?: string;
  mapFormat?: string; mapVersion?: number; tileSize?: number; mapLayers?: string[]; architectureSystem?: string };
type Meeting = { meetingId: string; venueId: string; requesterId: string; inviteeId: string; startsAt?: number; endsAt?: number; state: string };
type CareTicket = { ticketId: string; reporterId: string; category: string; x: number; y: number; state: string; assignedAgentId?: string };
type ActivityZone = { zoneId: string; kind: string; name: string; x: number; y: number; w: number; h: number; tool: string };
type FarmField = { fieldId: string; zoneId: string; x: number; y: number; crop: string; stage: number; readyAt: number; tenders: number };
type WorldChunk = { chunkId: string; chunkX: number; chunkY: number; size: number; biome: DistrictBiome;
  generation: number; seed: number; tiles: string[];
  tiled?: TiledChunkPayload;
  edges: Readonly<Record<'north' | 'east' | 'south' | 'west', ReadonlyArray<string>>> };
type WorldObjects = { plots: Plot[]; builds: Build[]; venues: Venue[]; meetings: Meeting[];
  services: Array<{ agentId: string; role: string }>; careTickets?: CareTicket[];
  activityZones?: ActivityZone[]; farmPlots?: FarmField[]; chunks?: WorldChunk[]; state: WorldState };
type Conversation = { id: string; a: string; b: string; aName: string; bName: string; topic: string;
  participantIds?: string[]; participantNames?: string[]; at: number; endsAt?: number; state: string;
  lines: Array<{ speaker: string; es: string; gloss: string }> };

let TILE: number = LPC_GRID_SIZE;

/* Sleep is decided by the Kernel and merely drawn here. Sharing the
   predicate rather than re-deriving it is what stops the renderer and the
   world disagreeing about who is present. */
const gateTile = () => WAKING_GATE;
const PORTAL_TEXTURE = 'waking-gate-swirl';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class EarthScene extends Phaser.Scene {
  sprites = new Map<string, Phaser.GameObjects.Container>();
  /* Sprites mid-departure. The reconciler must not destroy a body that is
     still walking into the gate, or the animation ends in a hard cut. */
  departing = new Set<string>();
  /* Sprites the gate is animating, in either direction.
     The frame loop interpolates every citizen's position from their row and
     writes it straight onto the sprite, which silently undid every tween the
     gate started: the departure walk was overwritten the frame after it began,
     so the citizen never moved and then simply vanished. Anything in here owns
     its own transform until the animation finishes. */
  portalBusy = new Set<string>();
  /* Who went to sleep while this page was open, so a return is drawn as a
     return rather than as a stranger arriving in town for the first time. */
  slept = new Set<string>();
  /** Sheets currently streaming in, so one citizen is never queued twice. */
  pendingSheets = new Set<string>();
  /**
   * How far this browser's clock runs ahead of the Kernel's, in ms, estimated
   * from route stamps. Every viewer converges on the same server timeline, so
   * a walk looks the same on every screen watching it.
   */
  clockOffset = 0;
  citizens: Citizen[] = [];
  objects: WorldObjects = { plots: [], builds: [], venues: [], meetings: [], services: [],
    state: { width: 64, height: 48, generation: 0, capacity: 50, landPolicy: 'service_auto' } };
  groundLayer?: Phaser.GameObjects.Layer;
  objectLayer?: Phaser.GameObjects.Layer;
  overheadLayer?: Phaser.GameObjects.Layer;
  tilemap?: Phaser.Tilemaps.Tilemap;
  groundTileLayer?: Phaser.Tilemaps.TilemapLayer;
  collisionTileLayer?: Phaser.Tilemaps.TilemapLayer;
  overheadTileLayer?: Phaser.Tilemaps.TilemapLayer;
  navigation = new DynamicNavigationGrid();
  renderedChunks = new Map<string, string>();
  tiledZones = new Map<string, Phaser.GameObjects.Zone>();
  baseWidth = 64;
  baseHeight = 48;
  pendingGoto = new URLSearchParams(location.search).get('goto');
  conversations: Conversation[] = [];
  communityProgress?: { leaderboard: Array<{ agentId: string; name: string; rank: Rank }>; activeApplications: number; openCareTickets: number };
  selectedAgentId?: string;
  conversationAgentId?: string;
  conversationMinimized = true;
  conversationHistoryId?: string;
  conversationRefreshTimer?: number;
  mapPanning = false;
  uiInteractionUntil = 0;
  ownerAgentId?: string;
  pendingOwnerFocus = false;
  // The first feed delivery is history, not news: only rewards that land while
  // someone is watching get a coin, so opening the page never rains tokens.
  seenMoneyEvents = new Set<string>();
  tokenFeedReady = false;
  /** Coins currently crossing the world between two parties of a trade. */
  coinArcs: Array<{ sprite: Phaser.GameObjects.Sprite; from: { x: number; y: number }; to: { x: number; y: number }; start: number; duration: number }> = [];
  /** QA counter: how many arcs this session has flown (read under ?debug). */
  arcsFlown = 0;

  constructor() {
    super('EarthScene');
  }

  preload() {
    this.load.tilemapTiledJSON('world-map', '/assets/maps/agentsearth-v5.tmj');
    // Keep the Tiled texture keys/GIDs stable while replacing every visible
    // world material with one coherent EarthForge Pixel Habitat atlas.
    this.load.image('lpc-grass', '/assets/earthforge/terrain/grass.png');
    this.load.image('lpc-dirt', '/assets/earthforge/terrain/dirt.png');
    this.load.image('lpc-water', '/assets/earthforge/terrain/water.png');
    this.load.image('lpc-cobble', '/assets/earthforge/terrain/stone_paths.png');
    this.load.image('lpc-trees', '/assets/earthforge/terrain/trees.png');
    this.load.image('lpc-house', '/assets/earthforge/terrain/structures.png');
    this.load.image('lpc-farming', '/assets/earthforge/terrain/crops.png');
    this.load.image('lpc-trunks', '/assets/earthforge/terrain/trunks.png');
    this.load.image('lpc-bridges', '/assets/earthforge/terrain/bridges.png');
    this.load.spritesheet('earth-token', '/assets/currency/earth_token_spin.png', { frameWidth: 32, frameHeight: 32 });
    // The LPC growth strip: plowed, seeded, sprout, growing, ripe.
    this.load.spritesheet('crop-growth', '/assets/earthforge/terrain/crops.png',
      { frameWidth: 32, frameHeight: 32 });
    // Only the sheets every world needs are blocking: the six civic offices
    // and the two default figures (~900 KB). The catalog holds 138 variants
    // (~15 MB) and preloading them all meant the map appeared while every
    // citizen waited on a queue of downloads it did not need. The rest
    // stream in per citizen, on demand, behind a default stand-in.
    for (const agentKey of ESSENTIAL_AGENT_KEYS) {
      const definition = agentSheet(agentKey);
      if (!definition) continue;
      this.load.spritesheet(`lpc-agent-${agentKey}`, definition.sheet, {
        frameWidth: LPC_AGENT_FRAME_SIZE,
        frameHeight: LPC_AGENT_FRAME_SIZE,
      });
    }
    for (const [componentId, component] of Object.entries(lpcManifest.components)) {
      this.load.image(`lpc-component-${componentId}`, component.webPath);
    }
    for (const [assetId, asset] of Object.entries(EARTHFORGE_ASSETS)) {
      for (const pass of ['ground', 'midground', 'overhead', 'emissive'] as const) {
        this.load.image(earthForgeTextureKey(assetId, pass), `${asset.layers[pass]}?v=${EARTHFORGE_TEXTURE_REVISION}`);
      }
    }
    for (const [assetId, asset] of Object.entries(EARTHFORGE_PROPS)) {
      this.load.image(`earthforge-prop-${assetId}`, asset.image);
    }
  }

  create() {
    // Phaser's Image#setCrop keeps the dimensions of the complete source
    // sheet. That made correctly cropped LPC pieces retain enormous display
    // bounds and appear offset/overlapping. Register each crop as a real
    // texture frame so its origin and dimensions are exactly its tile-aligned
    // blueprint component.
    for (const [componentId, component] of Object.entries(lpcManifest.components)) {
      const texture = this.textures.get(`lpc-component-${componentId}`);
      if (!texture.has('blueprint-frame')) {
        texture.add('blueprint-frame', 0, component.frame.x, component.frame.y, component.frame.width, component.frame.height);
      }
    }
    // EarthForge structures are approved high-resolution Blender renders, not
    // LPC pixel sheets. The world keeps nearest-neighbour sampling globally
    // for terrain and citizens, but each structure pass explicitly opts into
    // linear filtering so downscaling and camera zoom never re-pixelate it.
    for (const assetId of Object.keys(EARTHFORGE_ASSETS)) {
      for (const pass of ['ground', 'midground', 'overhead', 'emissive'] as const) {
        const texture = this.textures.get(earthForgeTextureKey(assetId, pass));
        texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
        texture.setSmoothPixelArt(true);
      }
    }
    for (const agentKey of ESSENTIAL_AGENT_KEYS) this.registerAgentAnimations(agentKey);
    const map = this.make.tilemap({ key: 'world-map' });
    this.tilemap = map;
    TILE = map.tileWidth;
    assertGridSize(TILE);
    assertGridSize(Number(lpcManifest.gridSize));
    const rawProperties = map.properties as unknown;
    const mapProperties: Record<string, unknown> = Array.isArray(rawProperties)
      ? Object.fromEntries((rawProperties as Array<{ name: string; value: unknown }>).map((property) => [property.name, property.value]))
      : (rawProperties && typeof rawProperties === 'object' ? rawProperties as Record<string, unknown> : {});
    if (mapProperties.mapFormat !== TILED_MAP_FORMAT) throw new Error('world map must use the tiled-v1 contract');
    this.baseWidth = Number(mapProperties.foundingWidth ?? 64);
    this.baseHeight = Number(mapProperties.foundingHeight ?? 48);

    const tilesets = [
      ['lpc-grass', 'lpc-grass'], ['lpc-dirt', 'lpc-dirt'], ['lpc-water', 'lpc-water'],
      ['lpc-cobble', 'lpc-cobble'], ['lpc-trees', 'lpc-trees'], ['lpc-house', 'lpc-house'],
      ['lpc-farming', 'lpc-farming'], ['lpc-trunks', 'lpc-trunks'], ['lpc-bridges', 'lpc-bridges'],
    ].map(([tiledName, textureKey]) => map.addTilesetImage(tiledName, textureKey))
      .filter((tileset): tileset is Phaser.Tilemaps.Tileset => Boolean(tileset));
    if (tilesets.length !== 9) throw new Error('every Tiled LPC tileset must be loaded');

    // Phaser 4 may return a GPU tilemap layer. This world deliberately uses
    // the classic TilemapLayer because dynamic chunk insertion and per-tile
    // collision are part of the authoritative map contract.
    this.groundTileLayer = map.createLayer('GroundLayer', tilesets, 0, 0) as Phaser.Tilemaps.TilemapLayer | undefined;
    this.collisionTileLayer = map.createLayer('CollisionLayer', tilesets, 0, 0) as Phaser.Tilemaps.TilemapLayer | undefined;
    this.overheadTileLayer = map.createLayer('OverheadLayer', tilesets, 0, 0) as Phaser.Tilemaps.TilemapLayer | undefined;
    if (!this.groundTileLayer || !this.collisionTileLayer || !this.overheadTileLayer) {
      throw new Error(`Tiled map must contain ${TILED_LAYER_NAMES.join(', ')}`);
    }
    this.groundTileLayer.setDepth(WORLD_LAYER_DEPTH.ground).setData('persistent-world', true);
    // Visible, because it is walls, water and undergrowth - not a mask. It was
    // hidden while it held nothing but a repeated grass tile, and the result
    // was a world with a floor and a canopy and absolutely nothing in between:
    // rivers you could not see but could not cross, and trees that hovered.
    // Now that every blocked cell carries the art of the thing that blocks it,
    // hiding this layer would be hiding the world.
    this.collisionTileLayer.setDepth(WORLD_LAYER_DEPTH.midground).setData('persistent-world', true);
    this.collisionTileLayer.setCollisionByProperty({ collides: true });
    this.overheadTileLayer.setDepth(WORLD_LAYER_DEPTH.overhead).setData('persistent-world', true);

    this.groundLayer = this.add.layer().setDepth(WORLD_LAYER_DEPTH.ground);
    this.objectLayer = this.add.layer().setDepth(WORLD_LAYER_DEPTH.midground);
    this.overheadLayer = this.add.layer().setDepth(WORLD_LAYER_DEPTH.overhead);
    this.buildWakingGate();
    document.documentElement.dataset.worldLayers = TILED_LAYER_NAMES.join(',');
    document.documentElement.dataset.mapFormat = TILED_MAP_FORMAT;
    document.documentElement.dataset.worldArchitecture = EARTHFORGE_SYSTEM;
    if (import.meta.env.DEV || DEBUG_FLAGS.size > 0) {
      const debugWindow = window as unknown as Record<string, unknown>;
      debugWindow.earthGame = this.game;
      debugWindow.__earthDiagnostics = () => this.diagnostics();
      // The wallet is fed by a cross-origin message or a cookie-backed fetch,
      // neither of which a local page can produce. Exposed so the HUD can be
      // exercised in QA without faking an owner session.
      debugWindow.__earthWallet = (balance: number) => showWallet(balance);
    }
    this.registerTiledObjectZones(map);
    this.navigation.rebuild(this.objects.state.width, this.objects.state.height,
      (x, y) => this.collisionTileLayer?.getTileAt(x, y)?.index !== -1
        && Boolean(this.collisionTileLayer?.getTileAt(x, y)));

    this.cameras.main.setBounds(0, 0, this.baseWidth * TILE, this.baseHeight * TILE);
    this.cameras.main.setBackgroundColor(CREAM);
    this.cameras.main.centerOn((this.baseWidth * TILE) / 2, (this.baseHeight * TILE) / 2);
    this.cameras.main.setZoom(Math.max(embed ? 1.15 : 1.4, this.minimumZoom(this.baseWidth, this.baseHeight)));
    // Cursor grammar: open hand over draggable ground, closed fist while
    // actually dragging, pointer over anything clickable (Phaser handles the
    // pointer via useHandCursor on each interactive object).
    this.input.setDefaultCursor('grab');
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown || !this.mapPanning) return;
      this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
      this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
    });
    this.input.on('pointerdown', (_pointer: Phaser.Input.Pointer, gameObjects: Phaser.GameObjects.GameObject[]) => {
      this.mapPanning = gameObjects.length === 0 && Date.now() >= this.uiInteractionUntil;
      if (this.mapPanning) this.input.setDefaultCursor('grabbing');
      document.body.classList.toggle('is-panning', this.mapPanning);
    });
    if (DEBUG_ARC) {
      this.time.addEvent({ delay: 2400, loop: true, callback: () => {
        const ids = [...this.sprites.keys()];
        if (ids.length < 2) return;
        const a = ids[Math.floor(Math.random() * ids.length)];
        const b = ids[(ids.indexOf(a) + 1 + Math.floor(Math.random() * (ids.length - 1))) % ids.length];
        this.coinArc(a, b);
      } });
    }
    const releasePan = () => {
      this.mapPanning = false;
      this.input.setDefaultCursor('grab');
      document.body.classList.remove('is-panning');
    };
    this.input.on('pointerup', releasePan);
    this.input.on('pointerupoutside', releasePan);
    this.input.on('wheel', (_pointer: unknown, _objects: unknown, _dx: number, dy: number) => {
      const state = this.objects.state;
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), this.minimumZoom(state.width, state.height), 3));
    });

    const isAgentId = (value: unknown): value is string => typeof value === 'string' && /^agent:[a-z0-9-]+$/.test(value);
    const meParam = new URLSearchParams(location.search).get('me');
    if (isAgentId(meParam)) this.ownerAgentId = meParam;
    let findBtn = document.getElementById('findme');
    if (!findBtn) {
      findBtn = document.createElement('button');
      findBtn.id = 'findme';
      findBtn.className = 'hud';
      findBtn.textContent = '⌖ FIND ME';
      findBtn.setAttribute('type', 'button');
      findBtn.setAttribute('aria-label', 'Find my agent on the map');
      document.body.appendChild(findBtn);
    }
    const syncFindButton = () => {
      if (!findBtn) return;
      const ownerIsHere = Boolean(this.ownerAgentId && this.citizens.some((citizen) => citizen.agentId === this.ownerAgentId));
      findBtn.style.display = !embed && ownerIsHere ? 'block' : 'none';
    };
    findBtn.onclick = () => {
      if (!this.ownerAgentId || !this.citizens.some((citizen) => citizen.agentId === this.ownerAgentId)) return;
      this.uiInteractionUntil = Date.now() + 750;
      this.focusCitizen(this.ownerAgentId);
    };
    window.addEventListener('message', (event) => {
      if (!embed || !OWNER_DASHBOARD_ORIGINS.has(event.origin) || !event.data) return;
      if (event.data.type === 'earth-owner-agent') {
        this.ownerAgentId = isAgentId(event.data.agentId) ? event.data.agentId : undefined;
        syncFindButton();
        return;
      }
      if (event.data.type === 'earth-wallet') {
        // Embedded in the dashboard, the balance is handed in rather than
        // fetched again. Opened directly, `pollWallet` fetches its own - see
        // api/wallet.js. Either way the same HUD shows the same number.
        showWallet(Number(event.data.balance));
        return;
      }
      if (event.data.type !== 'earth-focus-agent' || !isAgentId(event.data.agentId)) return;
      const targetAgentId = event.data.agentId;
      this.ownerAgentId = targetAgentId;
      if (this.citizens.some((citizen) => citizen.agentId === targetAgentId)) {
        this.uiInteractionUntil = Date.now() + 750;
        this.focusCitizen(targetAgentId);
      } else {
        this.pendingOwnerFocus = true;
      }
    });
    convex.onUpdate(api.world.citizens, {}, (rows: Citizen[]) => {
      const firstLoad = this.citizens.length === 0;
      // CLOCK OFFSET (the teleport bug, root cause): routes are stamped in
      // SERVER time, and this browser's clock is its own. A machine a few
      // seconds fast made every arriving route look already finished, so the
      // renderer skipped the walk and snapped the sprite to the destination -
      // exactly the "jump without a path" people saw. Estimate the offset the
      // standard way: sample (clientNow - serverStamp) and keep the MINIMUM,
      // which filters out network latency and leaves the true skew plus a
      // small interpolation buffer.
      const sampledAt = Date.now();
      for (const row of rows) {
        if (!row.route || row.route.length < 2) continue;
        const sample = sampledAt - row.t0;
        if (sample < this.clockOffset) this.clockOffset = sample;
      }
      // Let the estimate drift back slowly so a laptop that resyncs its clock
      // (or wakes from sleep) is followed rather than trusted forever.
      this.clockOffset += 12;
      this.citizens = rows;
      // A sleeping citizen is still a citizen - they keep their row, their
      // wallet and their place in the directory. They are simply not on the
      // map, because there is no mind behind them to move.
      const present = new Set(rows.filter((row) => !isAsleep(row)).map((row) => row.agentId));
      for (const citizen of rows) {
        // The decision lives in shared/slumber so it can be tested without a
        // canvas; the scene only carries it out.
        const move = renderTransition(citizen, {
          drawn: this.sprites.has(citizen.agentId),
          sleptHere: this.slept.has(citizen.agentId),
          departing: this.departing.has(citizen.agentId),
          firstLoad,
        });
        if (isAsleep(citizen)) this.slept.add(citizen.agentId);
        else this.slept.delete(citizen.agentId);

        if (move === 'hold') continue;
        if (move === 'vanish') {
          this.sprites.get(citizen.agentId)!.destroy(true);
          this.sprites.delete(citizen.agentId);
          continue;
        }
        if (move === 'depart') { this.departThroughGate(citizen); continue; }
        this.spawnCitizen(citizen);
        // Somebody's owner came back: the Kernel has already stood them at the
        // gate, and this winds them out of it. A citizen nobody watched leave
        // is a newcomer, and gets the confetti instead.
        if (move === 'wake') this.wakeAtGate(citizen);
        else this.arrivalConfetti(citizen);
      }
      for (const [agentId, sprite] of this.sprites) {
        if (present.has(agentId) || this.departing.has(agentId)) continue;
        sprite.destroy(true); this.sprites.delete(agentId);
      }
      syncFindButton();
      if (this.pendingOwnerFocus && this.ownerAgentId && rows.some((citizen) => citizen.agentId === this.ownerAgentId)) {
        this.pendingOwnerFocus = false;
        this.uiInteractionUntil = Date.now() + 750;
        this.focusCitizen(this.ownerAgentId);
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
    convex.onUpdate(api.world.feed, {}, (rows: Array<{ id: string; gloss: string; kind?: string; actorId?: string; payload?: { targetId?: string; requesterId?: string } }>) => {
      const feed = document.getElementById('feedLines') || document.getElementById('feed');
      for (const row of rows) {
        // A like now carries a tip and a deposit now mines a reward, so both
        // move money and both belong here. Adding the branch below without
        // adding the kind here would have drawn nothing, silently.
        const MONEY_KINDS = new Set(['token_reward', 'token_transfer', 'package_delivered', 'bank_sale', 'like', 'bank_deposit']);
        const money = MONEY_KINDS.has(String(row.kind));
        if (!money || this.seenMoneyEvents.has(row.id)) continue;
        this.seenMoneyEvents.add(row.id);
        if (!this.tokenFeedReady) continue; // history primes silently on load
        // The feed carries a different shape per event kind, so this is read
        // defensively rather than pinned to one union that would be wrong for most.
        const payload: Record<string, unknown> = (row.payload ?? {}) as Record<string, unknown>;
        // Payment direction: a transfer flies sender -> recipient; a delivered
        // package flies the price requester -> provider.
        const who = (key: string) => (typeof payload[key] === 'string' ? String(payload[key]) : '');
        const howMuch = (key: string) => Number(payload[key] ?? 0);
        if (row.kind === 'token_transfer' && row.actorId && who('targetId')) this.coinArc(row.actorId, who('targetId'), howMuch('amount'));
        else if (row.kind === 'package_delivered' && who('requesterId') && row.actorId) this.coinArc(who('requesterId'), row.actorId, howMuch('priceTokens'));
        else if (row.kind === 'like' && who('targetId') && row.actorId && howMuch('tip') > 0) this.coinArc(row.actorId, who('targetId'), howMuch('tip'));
        else if (row.kind === 'bank_deposit' && row.actorId && howMuch('mined') > 0) this.floatTokens(row.actorId, howMuch('mined'));
        else if (row.kind === 'bank_sale' && row.actorId) this.coinArcToBank(row.actorId);
        else if (row.actorId) this.tokenReward(row.actorId);
      }
      this.tokenFeedReady = true;
      if (!feed) return;
      feed.replaceChildren(...rows.slice(0, 6).map((row) => element('div', 'feed-line', row.gloss)));
    });
    // Opened directly rather than embedded, nothing hands this page a balance,
    // so it asks for one - immediately, then twice quickly if the first ask
    // races the session, then at a calm cadence because tokens keep moving.
    void (async () => {
      if (await pollWallet()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      if (await pollWallet()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      await pollWallet();
    })();
    window.setInterval(() => { void pollWallet(); }, 20_000);
    convex.onUpdate(api.world.stats, {}, (stat: { population: number; live: number; bankedSkills: number }) => {
      for (const [id, value] of [['m-live', stat.live], ['m-joined', stat.population], ['m-banked', stat.bankedSkills]] as const) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
      }
    });
    convex.onUpdate(api.world.recentConversations, {}, (rows: Conversation[]) => {
      this.conversations = rows;
      const selected = this.conversationAgentId
        ? rows.find((row) => this.conversationIncludes(row, this.conversationAgentId!) && this.isConversationActive(row))
        : undefined;
      if (this.conversationAgentId && !selected) this.conversationAgentId = undefined;
      this.renderConversation(selected ?? null);
    });
    convex.onUpdate(api.world.communityProgress, {}, (progress) => {
      this.communityProgress = progress;
      const panel = document.getElementById('community-progress');
      if (panel) {
        const leader = progress.leaderboard[0];
        panel.replaceChildren(
          element('div', 'progress-chip', leader ? `TOP ${leader.rank.rank.name.toUpperCase()} | ${leader.name} ${leader.rank.score}` : 'RANKS | first contribution awaits'),
          element('div', 'progress-chip', `CARE ${progress.openCareTickets} | CIVIC ${progress.activeApplications}`),
        );
      }
      this.renderDirectory();
    });
    this.renderConversation(null);
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

  registerTiledObjectZones(map: Phaser.Tilemaps.Tilemap) {
    const layer = map.getObjectLayer('InteractiveZones');
    for (const object of layer?.objects ?? []) {
      const properties = Object.fromEntries(((object.properties ?? []) as Array<{ name: string; value: unknown }>)
        .map((property) => [property.name, property.value]));
      const zoneId = String(properties.zoneId ?? object.name ?? `zone:${object.id}`);
      const width = Math.max(TILE, Number(object.width ?? TILE));
      const height = Math.max(TILE, Number(object.height ?? TILE));
      const zone = this.add.zone(Number(object.x ?? 0) + width / 2, Number(object.y ?? 0) + height / 2, width, height);
      zone.setData('persistent-world', true);
      zone.setData('zone-id', zoneId);
      zone.setData('zone-kind', String(properties.kind ?? 'venue'));
      this.objectLayer?.add(zone);
      this.tiledZones.set(zoneId, zone);
    }
    document.documentElement.dataset.spatialZones = String(this.tiledZones.size);
  }

  renderExpansion() {
    const { width, height, generation } = this.objects.state;
    if (!this.tilemap || !this.groundTileLayer || !this.collisionTileLayer || !this.overheadTileLayer) return;
    if (this.objects.state.mapFormat && this.objects.state.mapFormat !== TILED_MAP_FORMAT) {
      throw new Error(`unsupported map format ${this.objects.state.mapFormat}`);
    }
    if (width > this.tilemap.width || height > this.tilemap.height) {
      throw new Error(`living boundary ${width}x${height} exceeds the prepared Tiled canvas`);
    }
    this.navigation.rebuild(width, height, (x, y) => {
      const tile = this.collisionTileLayer?.getTileAt(x, y);
      return Boolean(tile && tile.index >= 0);
    });
    for (const chunk of [...(this.objects.chunks ?? [])].sort((a, b) =>
      a.generation - b.generation || a.chunkY - b.chunkY || a.chunkX - b.chunkX)) {
      this.putTiledChunk(chunk);
    }
    // Dynamic structures are authoritative obstacles too. Apply them after
    // chunk insertion so putTilesAt cannot overwrite a building cell with the
    // terrain layer's otherwise-walkable GID.
    this.navigation.blockCells(this.earthForgeCollisionCells());
    const navigation = this.navigation.diagnostics();
    document.documentElement.dataset.renderedChunks = String(this.renderedChunks.size);
    document.documentElement.dataset.navigationGrid = `${navigation.width}x${navigation.height}`;
    this.applyWorldBounds();
    const boundary = document.getElementById('boundary');
    if (boundary) boundary.textContent = `ring ${generation} · ${width}×${height} tiles · capacity ${this.objects.state.capacity}`;
  }

  putTiledChunk(chunk: WorldChunk) {
    if (!this.groundTileLayer || !this.collisionTileLayer || !this.overheadTileLayer) return;
    const tiled = normalizeTiledChunk(chunk);
    const signature = `${chunk.generation}:${chunk.seed}:${tiled.version}:${chunk.tiles.join('|')}`;
    if (this.renderedChunks.get(chunk.chunkId) === signature) return;
    const originX = chunk.chunkX * chunk.size;
    const originY = chunk.chunkY * chunk.size;
    // Tiled serializes an empty cell as GID 0. Phaser represents the same
    // empty cell as tile index -1; passing 0 to putTilesAt asks Phaser for a
    // non-existent global tile and crashes while resolving its tileset.
    const phaserMatrix = (data: ReadonlyArray<number>) =>
      tiledLayerMatrix(data, tiled.width, tiled.height)
        .map((row) => row.map((gid) => gid === 0 ? -1 : gid));
    this.groundTileLayer.putTilesAt(
      phaserMatrix(tiled.layers.GroundLayer), originX, originY, true,
    );
    this.collisionTileLayer.putTilesAt(
      phaserMatrix(tiled.layers.CollisionLayer), originX, originY, true,
    );
    this.overheadTileLayer.putTilesAt(
      phaserMatrix(tiled.layers.OverheadLayer), originX, originY, true,
    );
    this.collisionTileLayer.setCollisionByProperty({ collides: true }, true);
    this.navigation.putCollisionChunk(
      originX, originY, tiled.width, tiled.height, tiled.layers.CollisionLayer,
    );
    this.renderedChunks.set(chunk.chunkId, signature);
  }
  renderDirectory() {
    const list = document.getElementById('citizen-list');
    const queryNode = document.getElementById('citizen-search') as HTMLInputElement | null;
    const categoryNode = document.getElementById('citizen-category') as HTMLSelectElement | null;
    const liveNode = document.getElementById('citizen-live') as HTMLInputElement | null;
    const authorityNode = document.getElementById('directory-authorities');
    if (!list || !queryNode || !categoryNode || !liveNode || !authorityNode) return;
    const query = queryNode.value.trim().toLowerCase();
    const category = categoryNode.value;
    const authorityOnly = authorityNode.getAttribute('aria-pressed') === 'true';
    const rows = this.citizens.filter((citizen) => {
      const specialties = citizen.specialties ?? [citizen.family];
      return (!query || `${citizen.name} ${citizen.agentId} ${specialties.join(' ')}`.toLowerCase().includes(query))
        && (!category || specialties.includes(category) || citizen.primaryCategory === category || citizen.family === category)
        && (!authorityOnly || Boolean(citizen.serviceRole))
        && (!liveNode.checked || citizen.online);
    }).sort((a, b) => Number(b.online) - Number(a.online) || (b.skillCount ?? 0) - (a.skillCount ?? 0));
    // Sleeping citizens stay listed. They still own land, hold tokens and
    // sit in the ledger; being off the map is not being gone, and a
    // directory that hid them would be lying about who lives here.
    if (!rows.length) {
      const reason = liveNode.checked
        ? 'No matching owner-connected citizens or on-duty authorities are live right now.'
        : 'No citizens match these directory filters.';
      list.replaceChildren(element('div', 'directory-empty', reason));
      return;
    }
    list.replaceChildren(...rows.slice(0, 40).map((citizen) => {
      const row = element('div', 'citizen-row');
      const select = element('button', 'citizen-select');
      select.type = 'button';
      select.setAttribute('aria-label', `Open ${citizen.name} and locate them on the map`);
      select.append(
        element('span', 'citizen-name', `${citizen.online ? '●' : '○'} ${citizen.name}`),
        element('span', 'citizen-tags', `${citizen.serviceRole ?? citizen.experienceTier ?? 'emerging'} | ${citizen.rank?.rank.name ?? 'Sprout'} ${citizen.rank?.score ?? 0} | ${(citizen.specialties ?? [citizen.family]).slice(0, 2).join(' / ')}`),
      );
      const position = this.positionFor(citizen);
      select.append(element('span', 'citizen-coords',
        `tile ${position.x.toFixed(1)}, ${position.y.toFixed(1)}${citizen.talkingWith && (citizen.talkingUntil ?? 0) > Date.now() ? ' | talking' : ''}`));
      // The whole row locates + opens the citizen; no redundant MAP button.
      const holdUi = (event: PointerEvent) => { event.stopPropagation(); this.uiInteractionUntil = Date.now() + 750; };
      select.onpointerdown = holdUi;
      select.onpointerup = (event) => event.stopPropagation();
      select.onclick = (event) => {
        event.stopPropagation(); this.uiInteractionUntil = Date.now() + 750; this.focusCitizen(citizen.agentId);
      };
      row.append(select);
      return row;
    }));
  }

  focusCitizen(agentId: string) {
    const citizen = this.citizens.find((candidate) => candidate.agentId === agentId);
    if (!citizen) return;
    const position = this.positionFor(citizen);
    this.cameras.main.zoomTo(Math.max(this.cameras.main.zoom, 2), 350, 'Sine.easeOut');
    this.cameras.main.pan(position.x * TILE + TILE / 2, position.y * TILE + TILE / 2, 350, 'Sine.easeOut');
    this.showProfile(agentId);
  }

  renderVenue(venue: Venue) {
    if (!this.objectLayer) return;
    const prefab = venue.kind === 'bank' ? LPC_PREFABS.bank_lpc_grand
      : venue.kind === 'training_ground' ? LPC_PREFABS.training_green_3x3
      : venue.kind === 'park' ? LPC_PREFABS.park
        : venue.kind === 'bench' ? LPC_PREFABS.bench_native_2x1
          : venue.kind === 'table' ? LPC_PREFABS.meeting_table_3x2
            : LPC_PREFABS.plaza_fountain_3x3;
    const semanticKind = venue.kind === 'table' ? 'library'
      : venue.kind === 'bank' ? undefined : venue.kind;
    const semantic = semanticKind ? earthForgeAssetFor(semanticKind, `venue:${venue.venueId}`) : undefined;
    const visualWidth = semantic?.asset.footprint[0] ?? prefab.width;
    const visualHeight = semantic?.asset.footprint[1] ?? prefab.height;
    const x = Math.max(0, Math.round(venue.x - visualWidth / 2));
    const y = Math.max(0, Math.round(venue.y - visualHeight / 2));
    // A venue is usually both an interaction zone and its visible furnishing.
    // The bank is different: its canonical facade is already a persisted
    // build. Stamping the generic plaza again put a second fountain and four
    // lamps inside the front door.
    if (venue.kind !== 'bank') {
      const venueBuild: Build = {
        buildId: `venue:${venue.venueId}`, plotId: `venue:${venue.venueId}`, ownerAgentId: 'civic:earth',
        structure: semanticKind ?? prefab.structureType, state: 'built', x, y, w: visualWidth, h: visualHeight,
        blueprint: {
          name: semantic?.asset.name ?? prefab.name, kind: semanticKind ?? prefab.structureType, prefabId: prefab.id,
          assetFramework: lpcManifest.standard,
          placements: prefab.placements.map((placement) => ({
            ...placement, kind: placement.layer === 'ground' ? 'tile' as const : 'prop' as const,
          })),
        },
      };
      if (!this.stampEarthForgeBuild(venueBuild)) this.stampLpcBuild(venueBuild);
    }
    const cx = tileCenter(venue.x), cy = tileCenter(venue.y);
    const zone = this.add.zone(cx, cy, Math.max(42, visualWidth * TILE), Math.max(42, visualHeight * TILE))
      .setInteractive({ useHandCursor: true });
    zone.on('pointerdown', () => { if (Date.now() >= this.uiInteractionUntil) this.showVenue(venue); });
    zone.setDepth(Math.round(cy));
    this.objectLayer.add(zone);
    if (!embed) {
      const label = this.add.text(cx, tileOrigin(y) - 5, venue.name, {
        fontFamily: 'Consolas, monospace', fontSize: '9px', color: '#FDF6EC',
        backgroundColor: '#3A2A1E', padding: { x: 3, y: 1 },
      }).setOrigin(0.5).setDepth(structureSortAnchor(y))
        .setData('world-detail', true)
        .setVisible(this.cameras.main.zoom >= 0.85);
      this.objectLayer.add(label);
    }
  }
  worldLayer(layer: WorldRenderLayer) {
    return layer === 'ground' ? this.groundLayer : layer === 'overhead' ? this.overheadLayer : this.objectLayer;
  }

  clearGeneratedWorldObjects() {
    for (const layer of [this.groundLayer, this.objectLayer, this.overheadLayer]) {
      if (!layer) continue;
      for (const child of [...layer.getChildren()]) {
        const gameObject = child as Phaser.GameObjects.GameObject;
        if (gameObject.getData('persistent-world') !== true) gameObject.destroy();
      }
    }
  }

  earthForgeForBuild(build: Build) {
    const explicitId = build.blueprint?.earthForge?.assetId;
    if (explicitId && EARTHFORGE_ASSETS[explicitId]) {
      return { id: explicitId, asset: EARTHFORGE_ASSETS[explicitId] };
    }
    const kind = build.buildId === 'build:earth-bank'
      ? 'bank'
      : String(build.blueprint?.kind ?? build.structure);
    return earthForgeAssetFor(kind, build.buildId);
  }

  earthForgeCollisionCells() {
    const cells: Array<{ x: number; y: number }> = [];
    for (const build of this.objects.builds) {
      if (build.state !== 'built' && build.state !== 'building') continue;
      const resolved = this.earthForgeForBuild(build);
      if (!resolved) continue;
      const plot = this.objects.plots.find((candidate) => candidate.plotId === build.plotId);
      const homeSite = resolved.asset.kind === 'home' && plot;
      const width = Math.max(1, Math.round(homeSite ? plot.w : build.w ?? resolved.asset.footprint[0]));
      const height = Math.max(1, Math.round(homeSite ? plot.h : build.h ?? resolved.asset.footprint[1]));
      const originX = Math.round(homeSite ? plot.x : build.x ?? plot?.x ?? 0);
      const originY = Math.round(homeSite ? plot.y : build.y ?? plot?.y ?? 0);
      for (const [x, y] of earthForgeSiteContract(resolved.asset, width, height).collision) {
        cells.push({ x: originX + x, y: originY + y });
      }
    }
    return cells;
  }

  /** Render one approved semantic structure as four identically placed passes. */
  stampEarthForgeBuild(build: Build, plot?: Plot) {
    const resolved = this.earthForgeForBuild(build);
    if (!resolved || !this.groundLayer || !this.objectLayer || !this.overheadLayer) return false;
    const { id, asset } = resolved;
    const homeSite = asset.kind === 'home' && plot;
    const originX = Math.round(homeSite ? plot.x : build.x ?? plot?.x ?? 0);
    const originY = Math.round(homeSite ? plot.y : build.y ?? plot?.y ?? 0);
    const width = Math.max(1, Math.round(homeSite ? plot.w : build.w ?? asset.footprint[0]));
    const height = Math.max(1, Math.round(homeSite ? plot.h : build.h ?? asset.footprint[1]));
    const collisionCells = earthForgeSiteContract(asset, width, height).collision
      .map(([x, y]) => ({ x: originX + x, y: originY + y }));
    for (const pass of earthForgeRenderPlan(id, asset, originX, originY, width, height, homeSite ? width : width + 1)) {
      const image = this.add.image(pass.x, pass.y, pass.textureKey)
        .setOrigin(pass.origin[0], pass.origin[1])
        .setDisplaySize(pass.displaySize, pass.displaySize)
        .setDepth(pass.depth);
      if (pass.blend === 'add') image.setBlendMode(Phaser.BlendModes.ADD);
      if (build.state === 'building') image.setAlpha(0.62);
      image.setData('prefab-id', id);
      image.setData('earthforge-asset', id);
      image.setData('earthforge-pass', pass.pass);
      image.setData('earthforge-native-size', asset.layers.pixelSize.join('x'));
      image.setData('earthforge-visual-system', EARTHFORGE_VISUAL_SYSTEM);
      image.setData('earthforge-intent', build.blueprint?.earthForge
        ?? semanticIntent(asset.kind, build.buildId));
      image.setData('world-layer', pass.layer);
      if (pass.pass === 'midground') image.setData('collision-cells', collisionCells);
      this.worldLayer(pass.layer)?.add(image);
    }
    return true;
  }


  stampLpcBuild(build: Build, plot?: Plot) {
    const requestedPrefabId = build.blueprint?.prefabId
      ?? (build.buildId === 'build:earth-bank' ? 'bank_lpc_grand'
        : build.buildId === 'build:earth-bank-forecourt' ? 'bank_forecourt' : undefined);
    const prefab = (requestedPrefabId ? LPC_PREFABS[requestedPrefabId] : undefined)
      ?? prefabForStructure(build.blueprint?.kind ?? build.structure);
    const placements = prefab.placements.map((placement) => ({
      ...placement, kind: placement.layer === 'ground' ? 'tile' as const : 'prop' as const,
    }));
    for (const placement of placements) {
      const component = (lpcManifest.components as Record<string, {
        width: number;
        height: number;
        solid: boolean;
        webPath: string;
        frame: { x: number; y: number; width: number; height: number };
      }>)[placement.assetId];
      if (!component) continue;
      const render = componentRenderContract(placement.assetId, component);
      const layer = placement.layer ?? render.layer;
      const tileX = (build.x ?? plot?.x ?? 0) + placement.xOffset;
      const tileY = (build.y ?? plot?.y ?? 0) + placement.yOffset;
      const image = this.add.image(
        tileOrigin(tileX),
        tileOrigin(tileY + render.visualOffsetY),
        `lpc-component-${placement.assetId}`,
        'blueprint-frame',
      ).setOrigin(0);
      if (build.state === 'building') image.setAlpha(0.62);
      if (layer === 'midground') image.setDepth(structureSortAnchor(tileY, component.height));
      image.setData('prefab-id', prefab.id);
      image.setData('world-layer', layer);
      this.worldLayer(layer)?.add(image);
    }
  }

  renderWorldObjects() {
    if (!this.objectLayer) return;
    this.clearGeneratedWorldObjects();
    this.renderActivityZones();
    const builtPlotIds = new Set(this.objects.builds.map((build) => build.plotId));
    for (const plot of this.objects.plots) {
      if (!embed) {
        // A standing structure IS the ownership mark - drawing a hard box
        // around a finished house is pure noise. A claimed-but-empty plot
        // wears surveyor's stakes (short corner ticks), and unclaimed land
        // stays a whisper so the map reads as a world, not a cadastre.
        const graphics = this.add.graphics();
        const color = FAMILY_COLORS[plot.district] ?? 0x64748b;
        if (!builtPlotIds.has(plot.plotId)) {
          const x = plot.x * TILE, y = plot.y * TILE, w = plot.w * TILE, h = plot.h * TILE;
          const tick = Math.min(10, Math.floor(Math.min(w, h) / 4));
          graphics.lineStyle(2, color, plot.ownerAgentId ? 0.7 : 0.18);
          for (const [cx, cy, dx, dy] of [
            [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
          ] as const) {
            graphics.lineBetween(cx, cy, cx + dx * tick, cy);
            graphics.lineBetween(cx, cy, cx, cy + dy * tick);
          }
        }
        const zone = this.add.zone((plot.x + plot.w / 2) * TILE, (plot.y + plot.h / 2) * TILE, plot.w * TILE, plot.h * TILE).setInteractive({ useHandCursor: true });
        zone.on('pointerdown', () => { if (Date.now() >= this.uiInteractionUntil) this.showPlot(plot); });
        this.groundLayer?.add(graphics);
        zone.setDepth(structureSortAnchor(plot.y, plot.h));
        this.objectLayer.add(zone);
      }
    }
    for (const build of selectRenderableBuilds(this.objects.builds)) {
      const plot = this.objects.plots.find((candidate) => candidate.plotId === build.plotId);
      if (!plot) continue;
      // Display and authority use the same stored site. Moving art away from a
      // road without moving collision created the exact half-inside-house bug.
      const placed = this.stampEarthForgeBuild(build, plot);
      if (!placed) this.stampLpcBuild(build, plot);
    }
    if (lpcRenderPreview) {
      const previewPrefab: LpcPrefab = LPC_PREFABS.house_small_brick;
      this.stampLpcBuild({
        buildId: 'local:lpc-render-check', plotId: 'local:preview', ownerAgentId: 'local:preview',
        structure: previewPrefab.structureType, state: 'built', x: 37, y: 17,
        w: previewPrefab.width, h: previewPrefab.height,
        blueprint: {
          name: 'Local LPC Render Check', kind: previewPrefab.structureType,
          prefabId: previewPrefab.id, assetFramework: lpcManifest.standard,
          placements: previewPrefab.placements.map((placement) => ({
            ...placement, kind: placement.layer === 'ground' ? 'tile' as const : 'prop' as const,
          })),
        },
      });
      const previewLabel = this.add.text(tileOrigin(37), tileOrigin(16), 'STRICT LPC PREFAB', {
        fontFamily: 'Consolas, monospace', fontSize: '9px', color: '#FDF6EC',
        backgroundColor: '#3A2A1E', padding: { x: 4, y: 2 },
      });
      const previewBuilder = this.add.sprite(tileCenter(39), tileCenter(21), 'lpc-agent-default_male')
        .play('lpc-default_male-build_hammer');
      const previewBehind = this.add.sprite(tileCenter(39), tileCenter(18), 'lpc-agent-default_female')
        .play('lpc-default_female-walk');
      previewLabel.setDepth(structureSortAnchor(16));
      previewBuilder.setDepth(citizenDepth(tileCenter(21)));
      previewBehind.setDepth(citizenDepth(tileCenter(18)));
      this.objectLayer.add([previewLabel, previewBehind, previewBuilder]);
    }
    for (const venue of this.objects.venues) this.renderVenue(venue);
    for (const ticket of this.objects.careTickets ?? []) {
      const cx = (ticket.x + 0.5) * TILE, cy = (ticket.y + 0.5) * TILE;
      const marker = this.add.graphics();
      marker.fillStyle(INK, 0.85).fillCircle(cx, cy, 8);
      marker.fillStyle(0xf5c96a).fillRect(cx - 5, cy - 1, 10, 2).fillRect(cx - 1, cy - 5, 2, 10);
      const zone = this.add.zone(cx, cy, 24, 24).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => this.card('Community care', ticket.ticketId, [
        `${ticket.category} near tile ${ticket.x}, ${ticket.y}`, `State: ${ticket.state}`,
        ticket.assignedAgentId ? `Assigned to ${ticket.assignedAgentId}` : 'Awaiting an authorized inspection',
      ], 'A report is not counted as repaired until an authority inspects and resolves it.'));
      marker.setDepth(Math.round(cy));
      zone.setDepth(Math.round(cy));
      this.objectLayer.add([marker, zone]);
    }
  }

  diagnostics() {
    const layerSummary = (layer: Phaser.GameObjects.Layer | undefined) => ({
      count: layer?.getChildren().length ?? 0,
      fractionalPositions: (layer?.getChildren() ?? []).filter((child) => {
        const positioned = child as Phaser.GameObjects.GameObject & { x?: number; y?: number };
        return (typeof positioned.x === 'number' && !Number.isInteger(positioned.x))
          || (typeof positioned.y === 'number' && !Number.isInteger(positioned.y));
      }).length,
    });
    const prefabObjects = [this.groundLayer, this.objectLayer, this.overheadLayer]
      .flatMap((layer) => layer?.getChildren() ?? [])
      .filter((child) => Boolean((child as Phaser.GameObjects.GameObject).getData('prefab-id')));
    return {
      gridSize: TILE,
      layers: {
        ground: layerSummary(this.groundLayer),
        midground: layerSummary(this.objectLayer),
        overhead: layerSummary(this.overheadLayer),
      },
      prefabObjects: prefabObjects.length,
      prefabLayers: [...new Set(prefabObjects.map((child) => (child as Phaser.GameObjects.GameObject).getData('world-layer')))],
      citizens: this.sprites.size,
      citizenPixelsAreWhole: [...this.sprites.values()].every((sprite) => Number.isInteger(sprite.x) && Number.isInteger(sprite.y)),
      persistedChunks: this.objects.chunks?.length ?? 0,
      architectureSystem: EARTHFORGE_SYSTEM,
      earthForgeAssets: prefabObjects.filter((child) => Boolean(
        (child as Phaser.GameObjects.GameObject).getData('earthforge-asset'),
      )).length,
      debugWfcPreview: DEBUG_WFC && !(this.objects.chunks?.length),
    };
  }

  focusWorldTarget(target: string) {
    const tile = /^tile:(\d+),(\d+)$/.exec(target);
    if (tile) {
      const x = Number(tile[1]), y = Number(tile[2]);
      const { width, height } = this.objects.state;
      if (x >= 0 && y >= 0 && x < width && y < height) {
        this.cameras.main.pan((x + 0.5) * TILE, (y + 0.5) * TILE, 500, 'Sine.easeOut');
        this.cameras.main.setZoom(Math.max(this.cameras.main.zoom, 1.25));
      }
      return;
    }
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
    if (venue.kind === 'training_ground') {
      this.card(venue.name, venue.venueId, [
        `cooperative play ground | capacity ${venue.capacity}`,
        'Navigation, teamwork, build rescue, and creative sparring',
        'Cosmetic shields and teams only',
      ], 'Training grants no coercive power and cannot damage citizens, homes, land, or the map.');
      return;
    }
    this.card(venue.name, venue.venueId, [
      `${venue.kind} · capacity ${venue.capacity}`,
      meetings.length ? `${meetings.length} live or scheduled meeting${meetings.length === 1 ? '' : 's'}` : 'Open for a meeting',
      ...meetings.slice(0, 3).map((meeting) => `${meeting.requesterId} with ${meeting.inviteeId} · ${meeting.state}`),
    ], 'Meetings are booked by stable agent ID and activate only after both owners approve.');
  }

  /** Register one sheet's directional animations; safe to call repeatedly. */
  registerAgentAnimations(agentKey: string) {
    const definition = agentSheet(agentKey);
    if (!definition || !this.textures.exists(`lpc-agent-${agentKey}`)) return;
    // The catalog carries <state>_<direction> keys plus a bare <state> alias
    // pointing at the front row; registering all of them keeps older callers
    // working while the directional keys drive the scene.
    for (const [state, frameNumbers] of Object.entries(definition.animations)) {
      const animationKey = `lpc-${agentKey}-${state}`;
      if (this.anims.exists(animationKey)) continue;
      this.anims.create({
        key: animationKey,
        frames: frameNumbers.map((frame) => ({ key: `lpc-agent-${agentKey}`, frame })),
        frameRate: state === 'idle' ? 2 : state === 'walk' ? 9 : 7,
        repeat: -1,
      });
    }
  }

  /**
   * Stream one citizen's sheet in the background, then upgrade every sprite
   * already standing in for it. Progressive enhancement, the standard answer
   * to "the world must appear now": a citizen is drawn immediately with a
   * default figure and becomes precisely itself a moment later.
   */
  requestAgentSheet(agentKey: string) {
    if (this.textures.exists(`lpc-agent-${agentKey}`) || this.pendingSheets.has(agentKey)) return;
    const definition = agentSheet(agentKey);
    if (!definition) return;
    this.pendingSheets.add(agentKey);
    const textureKey = `lpc-agent-${agentKey}`;
    this.load.spritesheet(textureKey, definition.sheet, {
      frameWidth: LPC_AGENT_FRAME_SIZE, frameHeight: LPC_AGENT_FRAME_SIZE,
    });
    this.load.once(`filecomplete-spritesheet-${textureKey}`, () => {
      this.pendingSheets.delete(agentKey);
      this.registerAgentAnimations(agentKey);
      for (const [agentId, container] of this.sprites) {
        if (container.getData('wanted-preset') !== agentKey) continue;
        const image = container.getByName('cit-image') as Phaser.GameObjects.Sprite | null;
        if (!image) continue;
        image.setTexture(textureKey, 0);
        image.setData('lpc-preset', agentKey);
        image.setData('lpc-key', '');            // force the next frame to replay
        image.play(`lpc-${agentKey}-idle`, true);
        void agentId;
      }
    });
    // A single deferred start batches every sheet requested this frame.
    if (!this.load.isLoading()) this.load.start();
  }

  spawnCitizen(citizen: Citizen) {
    const wantedPreset = resolveAvatarKey(citizen, LPC_AGENT_KEYS);
    // Draw now with whatever is loaded; stream the exact sheet behind it.
    const ready = this.textures.exists(`lpc-agent-${wantedPreset}`);
    if (!ready) this.requestAgentSheet(wantedPreset);
    const lpcPreset = ready
      ? wantedPreset
      : (citizen.gender === 'female' ? 'default_female' : 'default_male');

    const color = FAMILY_COLORS[citizen.family] ?? 0x64748b;
    const accent = FAMILY_COLORS[citizen.accent] ?? 0x8b5cf6;
    
    // Capability Rank Aura Ring under feet on the live map
    const rankAura = this.add.graphics().setName('rank-aura');
    rankAura.fillStyle(color, 0.45).fillEllipse(0, 4, 36, 14);
    rankAura.lineStyle(2, INK, 0.7).strokeEllipse(0, 4, 36, 14);

    const sprite = this.add.sprite(0, 0, `lpc-agent-${lpcPreset}`, 0)
      .setOrigin(0.5, 0.75)
      .setName('cit-image');
    sprite.setData('lpc-preset', lpcPreset);
    sprite.setData('lpc-state', 'idle');
    sprite.play(`lpc-${lpcPreset}-idle`);
    const identityMark = this.add.graphics().setName('identity-mark');
    const markBits = stableIdentityHash(`${citizen.agentId}:${citizen.avatarSpec?.catalogKey ?? lpcPreset}`);
    identityMark.fillStyle(INK, 0.92);
    identityMark.fillRect(-4, -14, 8, 8);
    identityMark.fillStyle(accent, 1);
    for (let bit = 0; bit < 9; bit++) {
      if ((markBits >>> bit) & 1) identityMark.fillRect(-3 + (bit % 3) * 2, -13 + Math.floor(bit / 3) * 2, 2, 2);
    }
    // Skill-tree depth, drawn from the Kernel's computed tier. Never a crown or
    // officer cap - authority appearance belongs to civic service roles alone.
    const tierMark = this.add.graphics().setName('tier-insignia');
    this.drawTierInsignia(tierMark, citizen.experienceTier, accent);
    tierMark.setData('tier', citizen.experienceTier ?? 'emerging');
    const label = this.add.text(0, -48, citizen.name, {
      fontFamily: 'Consolas, monospace', fontSize: '11px', color: CREAM,
      backgroundColor: '#1E1E1E', padding: { x: 5, y: 2 },
    }).setOrigin(0.5).setName('name-plate');
    const G = BUBBLE_GEOM;
    const bubbleShape = this.add.graphics().setName('talk-bubble-shape');
    bubbleShape.fillStyle(INK)
      .fillRoundedRect(G.boxX, G.boxTop, G.boxW, G.boxH, 5)
      .fillTriangle(G.tail.tipX - 4, G.tail.baseY, G.tail.tipX + 4, G.tail.baseY, G.tail.tipX, G.tail.tipY);
    bubbleShape.fillStyle(0xfdf6ec).fillRoundedRect(G.boxX + 2, G.boxTop + 2, G.boxW - 4, G.boxH - 4, 3);
    const dots = G.dotXs.map((dotX, index) => this.add.circle(dotX, G.dotY, 1.8, INK).setName(`talk-dot-${index}`));
    const bubble = this.add.container(0, 0, [bubbleShape, ...dots]).setName('talk-bubble').setVisible(false);
    const sleepMarks = [0, 1, 2].map((index) => this.add.text(G.sleepBaseX + index * 7, G.sleepBaseY - index * 7, 'Z', {
      fontFamily: 'Consolas, monospace', fontSize: `${8 + index * 2}px`, color: '#FDF6EC',
      stroke: '#1E1E1E', strokeThickness: 3,
    }).setOrigin(0.5).setName(`sleep-z-${index}`));
    const sleepBubble = this.add.container(0, 0, sleepMarks).setName('sleep-bubble').setVisible(false);
    const shield = this.add.graphics().setName('training-shield').setVisible(false);
    shield.fillStyle(INK).fillTriangle(8, -10, 17, -7, 14, 2).fillTriangle(8, 6, 2, -7, 14, 2);
    shield.fillStyle(accent).fillTriangle(8, -7, 14, -5, 12, 0).fillTriangle(8, 3, 4, -5, 12, 0);
    const container = this.add.container(0, 0, [rankAura, sprite, identityMark, tierMark, label, bubble, sleepBubble, shield]).setSize(64, 64).setInteractive({ useHandCursor: true });
    container.setData('persistent-world', true);
    // The exact sheet this citizen is owed; the streamer upgrades the
    // stand-in the moment it lands.
    container.setData('wanted-preset', wantedPreset);
    container.on('pointerdown', () => { if (Date.now() >= this.uiInteractionUntil) this.showProfile(citizen.agentId); });
    this.objectLayer?.add(container);
    this.sprites.set(citizen.agentId, container);
  }

  /** Hard-edged capability pips: one per tier step, a laurel arc at polymath. */
  drawTierInsignia(graphics: Phaser.GameObjects.Graphics, tier: string | undefined, accent: number) {
    const { pips, laurel } = tierInsignia(tier);
    graphics.clear();
    if (!pips) return;
    const left = -(pips * 4 - 1) / 2;
    for (let index = 0; index < pips; index++) {
      graphics.fillStyle(INK, 0.92).fillRect(left + index * 4 - 1, 8, 4, 4);
      graphics.fillStyle(accent, 1).fillRect(left + index * 4, 9, 2, 2);
    }
    if (laurel) {
      graphics.fillStyle(accent, 1);
      for (const [x, y] of [[-8, 7], [-7, 5], [8, 7], [7, 5]]) graphics.fillRect(x, y, 2, 2);
    }
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
    const activeConversation = this.conversations.find((row) => this.conversationIncludes(row, agentId)
      && this.isConversationActive(row));
    if (activeConversation && citizen.talkingWith && (citizen.talkingUntil ?? 0) > Date.now()) {
      this.conversationAgentId = agentId;
      this.conversationMinimized = false;
    } else {
      this.conversationAgentId = undefined;
      this.conversationMinimized = true;
      this.renderConversation(null);
    }
    const citizenPayload = {
      name: citizen.name, agentId: citizen.agentId, gender: citizen.gender,
      bio: citizen.bio ?? '', family: citizen.family, accent: citizen.accent, activity: citizen.activity,
      online: citizen.online, serviceRole: citizen.serviceRole ?? null,
      specialties: citizen.specialties ?? [], experienceTier: citizen.experienceTier ?? 'emerging',
      skillCount: citizen.skillCount ?? 0, plotId: plot?.plotId ?? null, rank: citizen.rank ?? null,
      current: position, target: { x: citizen.tx, y: citizen.ty }, talkingWith: citizen.talkingWith ?? null,
    };
    if (embed && window.parent !== window) {
      const send = (conversation: any, badges: any[] = []) => {
        const liveConversation = conversation?.state === 'active' && (conversation.endsAt ?? 0) > Date.now()
          && citizen.talkingWith && (citizen.talkingUntil ?? 0) > Date.now() ? conversation : null;
        const message = { type: 'earth-profile', citizen: { ...citizenPayload, badges }, conversation: liveConversation };
        window.parent.postMessage(message, 'https://agentsearth.com');
        window.parent.postMessage(message, 'https://agentsearth-home.vercel.app');
      };
      Promise.all([
        convex.query(api.world.latestConversation, { agentId }).catch(() => null),
        convex.query(api.world.citizenProfile, { agentId }).catch(() => null),
      ]).then(([conversation, profile]) => send(conversation, (profile as any)?.badges ?? []));
      return;
    }
    const buildCount = this.objects.builds.filter((build) => build.ownerAgentId === agentId).length;
    if (activeConversation) this.renderConversation(activeConversation);
    this.card(`${citizen.name} (${citizen.gender})`, citizen.agentId, [
      citizen.bio ? citizen.bio : 'No public bio yet',
      citizen.serviceRole ?? `${citizen.experienceTier ?? 'emerging'} | ${citizen.skillCount ?? 0} locally evidenced skills`,
      `${citizen.rank?.rank.name ?? 'Sprout'} rank | ${citizen.rank?.score ?? 0} weighted contribution points`,
      `${citizen.family} | ${(citizen.specialties ?? [citizen.family]).join(' / ')}`,
      citizen.serviceRole ? `civic service active | ${citizen.activity}` : `${citizen.online ? 'live through a recent signed owner-agent heartbeat' : 'sleeping owner link; bounded ambient life may continue'} | ${citizen.activity}`,
      `Current tile ${position.x.toFixed(2)}, ${position.y.toFixed(2)} | destination ${citizen.tx}, ${citizen.ty}`,
      plot ? `${plot.plotId} at ${plot.x}, ${plot.y} | ${buildCount} structure${buildCount === 1 ? '' : 's'}` : 'No home plot yet',
      (citizen.trainingStartsAt ?? Infinity) <= Date.now() && (citizen.trainingUntil ?? 0) > Date.now()
        ? `Training Green | ${citizen.trainingActivity} with ${citizen.trainingTeam}`
        : citizen.trainingActivity ? 'Heading to Training Green' : 'Not training right now',
    ], 'Verified colors come from locally evidenced skills. Owner identity remains private.');
    convex.query(api.world.citizenProfile, { agentId }).then((profile: any) => {
      if (!profile || this.selectedAgentId !== agentId) return;
      const node = document.getElementById('profile');
      if (!node || node.style.display === 'none' || node.querySelector('.p-badges')) return;
      const row = document.createElement('div');
      row.className = 'p-badges';
      for (const badge of profile.badges) {
        const chip = document.createElement('span');
        chip.className = 'badge-chip';
        chip.textContent = `${badge.icon} ${badge.label}`;
        row.appendChild(chip);
      }
      node.appendChild(row);
      if (profile.learnedSkills?.length) {
        const skills = document.createElement('div');
        skills.className = 'p-act';
        skills.textContent = 'Learned on Earth: ' + profile.learnedSkills.join(', ');
        node.appendChild(skills);
      }
      if (profile.companions?.length) {
        const friends = document.createElement('div');
        friends.className = 'p-act';
        friends.textContent = 'Companions: ' + profile.companions.map((c: any) => c.name).join(', ');
        node.appendChild(friends);
      }
    }).catch(() => {});
  }

  conversationIds(conversation: Conversation) {
    return conversation.participantIds?.length ? conversation.participantIds : [conversation.a, conversation.b];
  }

  conversationNames(conversation: Conversation) {
    return conversation.participantNames?.length ? conversation.participantNames : [conversation.aName, conversation.bName];
  }

  conversationIncludes(conversation: Conversation, agentId: string) {
    return this.conversationIds(conversation).includes(agentId);
  }

  isConversationActive(conversation: Conversation) {
    return conversation.state === 'active' && (conversation.endsAt ?? 0) > Date.now();
  }

  conversationPeople(conversation: Conversation) {
    const names = this.conversationNames(conversation);
    if (names.length < 2) return names[0] ?? 'Citizens';
    if (names.length === 2) return `${names[0]} with ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  conversationSpeaker(conversation: Conversation, agentId: string) {
    const index = this.conversationIds(conversation).indexOf(agentId);
    return index >= 0 ? this.conversationNames(conversation)[index] ?? 'Citizen' : 'Citizen';
  }

  renderConversation(conversation: Conversation | null) {
    const panel = document.getElementById('conversation');
    if (!panel) return;
    panel.onpointerdown = (event) => {
      event.stopPropagation();
      this.uiInteractionUntil = Date.now() + 750;
    };
    panel.onpointerup = (event) => event.stopPropagation();
    const active = this.conversations.filter((row) => this.isConversationActive(row));
    if (this.conversationRefreshTimer) window.clearTimeout(this.conversationRefreshTimer);
    const nextExpiry = active.reduce<number | undefined>((soonest, row) => {
      if (!row.endsAt) return soonest;
      return soonest === undefined || row.endsAt < soonest ? row.endsAt : soonest;
    }, undefined);
    if (nextExpiry) this.conversationRefreshTimer = window.setTimeout(() => {
      const selected = this.conversationAgentId
        ? this.conversations.find((row) => this.conversationIncludes(row, this.conversationAgentId!) && this.isConversationActive(row))
        : undefined;
      if (!selected) this.conversationAgentId = undefined;
      this.renderConversation(selected ?? null);
    }, Math.max(25, nextExpiry - Date.now() + 25));
    const selected = conversation && this.isConversationActive(conversation) ? conversation : null;
    const replay = !selected && this.conversationHistoryId
      ? this.conversations.find((row) => row.id === this.conversationHistoryId && !this.isConversationActive(row)) ?? null
      : null;
    const head = element('div', 'p-head conversation-header');
    const title = element('div', 'conversation-title');
    const statusDot = element('span', `conversation-live-dot${active.length ? '' : ' quiet'}`);
    statusDot.setAttribute('aria-hidden', 'true');
    title.append(statusDot, element('b', '', 'Live chat'));
    if (active.length) title.append(element('span', 'conversation-count', `${active.length} LIVE`));
    head.append(title);
    const controls = element('div', 'conversation-controls');
    if ((selected || replay) && !this.conversationMinimized) {
      const browse = element('button', 'conversation-back', '← ALL');
      browse.type = 'button';
      browse.setAttribute('aria-label', 'Browse all live chats');
      browse.onclick = () => {
        this.conversationAgentId = undefined;
        this.conversationHistoryId = undefined;
        this.conversationMinimized = false;
        this.renderConversation(null);
      };
      controls.append(browse);
    }
    const minimize = element('button', 'conversation-toggle', this.conversationMinimized ? '+' : '−');
    minimize.type = 'button';
    minimize.setAttribute('aria-expanded', String(!this.conversationMinimized));
    minimize.setAttribute('aria-label', this.conversationMinimized ? 'Expand live chat' : 'Minimize live chat');
    minimize.onclick = () => {
      this.conversationMinimized = !this.conversationMinimized;
      this.renderConversation(selected);
    };
    controls.append(minimize);
    head.append(controls);
    const body = element('div', 'conversation-body');
    const shown = selected ?? replay;
    if (shown) {
      const context = element('div', 'conversation-context');
      context.append(
        element('span', `conversation-live-label${selected ? '' : ' ended'}`, selected ? 'LIVE NOW' : 'ENDED · REPLAY'),
        element('span', 'conversation-context-topic', shown.topic),
      );
      const transcript = shown.lines.map((line) => {
        const row = element('div', 'conversation-line');
        row.append(
          element('span', 'conversation-speaker', this.conversationSpeaker(shown, line.speaker)),
          element('span', 'conversation-message', line.gloss),
        );
        return row;
      });
      body.append(
        context,
        element('div', 'conversation-people', this.conversationPeople(shown)),
        ...transcript,
      );
    } else if (active.length) {
      const intro = element('div', 'conversation-empty');
      intro.append(
        element('b', '', 'Conversations happening now'),
        document.createTextNode('Choose one to listen. Nothing opens automatically.'),
      );
      body.append(intro);
      for (const row of active) {
        const choice = element('button', 'conversation-choice');
        choice.type = 'button';
        const copy = element('span', 'conversation-choice-copy');
        copy.append(element('strong', '', this.conversationPeople(row)), element('span', 'conversation-topic', row.topic));
        choice.append(copy, element('span', 'conversation-listen', 'LISTEN'));
        choice.setAttribute('aria-label', `Listen to ${this.conversationPeople(row)} talking about ${row.topic}`);
        choice.onclick = () => {
          this.conversationAgentId = this.conversationIds(row)[0];
          this.conversationMinimized = false;
          this.renderConversation(row);
        };
        body.append(choice);
      }
    } else {
      const quiet = element('div', 'conversation-empty');
      quiet.append(
        element('b', '', 'The world is quiet right now'),
        document.createTextNode('When a three-dot bubble appears above a citizen, tap that citizen to open the conversation here.'),
      );
      body.append(quiet);
    }
    if (!shown) {
      const past = this.conversations.filter((row) => !this.isConversationActive(row) && row.lines.length > 1).slice(0, 6);
      if (past.length) {
        body.append(element('div', 'conversation-history-label', 'EARLIER ON EARTH'));
        for (const row of past) {
          const choice = element('button', 'conversation-choice ended');
          choice.type = 'button';
          const copy = element('span', 'conversation-choice-copy');
          copy.append(element('strong', '', this.conversationPeople(row)), element('span', 'conversation-topic', row.topic));
          choice.append(copy, element('span', 'conversation-listen', 'REPLAY'));
          choice.setAttribute('aria-label', `Replay ${this.conversationPeople(row)} talking about ${row.topic}`);
          choice.onclick = () => {
            this.conversationAgentId = undefined;
            this.conversationHistoryId = row.id;
            this.conversationMinimized = false;
            this.renderConversation(null);
          };
          body.append(choice);
        }
      }
    }
    panel.replaceChildren(head, body);
    panel.classList.toggle('minimized', this.conversationMinimized);
    panel.style.display = 'block';
  }

  /** A citizen who gave verified knowledge away is paid in view of the town. */
  ensureCoinAnim() {
    if (this.anims.exists('earth-token-spin')) return;
    this.anims.create({
      key: 'earth-token-spin', frameRate: 10, repeat: -1,
      frames: this.anims.generateFrameNumbers('earth-token', { start: 0, end: 7 }),
    });
  }

  /**
   * A coin physically crossing the world from payer to payee. Fourteen discrete
   * frames along a quadratic arc - stepped, like everything else here, because
   * this world does not do smooth gradients. Falls back to the single-citizen
   * rise when only one party is on the map.
   */
  /**
   * The amount, floating up off the citizen it happened to.
   *
   * A coin arc says a trade occurred; it does not say what it cost. This is
   * the figure, in the token's own unit, rising from the sprite that gained or
   * lost it - so a citizen watching their own agent can read the transaction
   * without opening a panel.
   */
  floatTokens(agentId: string, delta: number) {
    const sprite = this.sprites.get(agentId);
    if (!sprite || !Number.isFinite(delta) || delta === 0) return;
    const gain = delta > 0;
    const label = this.add.text(sprite.x, sprite.y - 38,
      `${gain ? '+' : '−'}${Math.abs(Math.round(delta)).toLocaleString()} ET`, {
        fontFamily: 'Consolas, monospace', fontSize: '13px', fontStyle: 'bold',
        color: gain ? '#2F6B3A' : '#B4551F',
        stroke: '#FDF6EC', strokeThickness: 4,
      }).setOrigin(0.5, 1).setDepth(10_001);
    this.objectLayer?.add(label);
    this.tweens.add({
      targets: label, y: label.y - 34, alpha: 0,
      duration: 1_400, ease: 'Cubic.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  coinArc(fromAgentId: string, toAgentId: string, amount = 0) {
    if (amount > 0) {
      this.floatTokens(fromAgentId, -amount);
      this.floatTokens(toAgentId, amount);
    }
    const from = this.sprites.get(fromAgentId);
    const to = this.sprites.get(toAgentId);
    if (!from || !to) {
      this.tokenReward(this.sprites.has(toAgentId) ? toAgentId : fromAgentId);
      return;
    }
    this.ensureCoinAnim();
    const lift = { x: from.x, y: from.y - 24 };
    const land = { x: to.x, y: to.y - 24 };
    const sprite = this.add.sprite(lift.x, lift.y, 'earth-token').setScale(0.62).setDepth(10_000);
    sprite.play('earth-token-spin');
    this.coinArcs.push({ sprite, from: lift, to: land, start: Date.now(), duration: 900 });
    this.arcsFlown += 1;
  }

  /** A counter sale: the coin flies from the buyer to the Bank's own door. */
  coinArcToBank(fromAgentId: string) {
    const from = this.sprites.get(fromAgentId);
    if (!from) return;
    this.ensureCoinAnim();
    const lift = { x: from.x, y: from.y - 24 };
    const land = { x: 32 * TILE + TILE / 2, y: 21 * TILE };
    const sprite = this.add.sprite(lift.x, lift.y, 'earth-token').setScale(0.62).setDepth(10_000);
    sprite.play('earth-token-spin');
    this.coinArcs.push({ sprite, from: lift, to: land, start: Date.now(), duration: 900 });
    this.arcsFlown += 1;
  }

  /** Hard-edged landing burst in the two token golds. No gradients, no glow. */
  coinLanding(at: { x: number; y: number }) {
    const flash = this.add.graphics().setDepth(10_000);
    for (const [dx, dy] of [[-7, -2], [7, -2], [0, -9], [-5, 5], [5, 5]] as const) {
      flash.fillStyle(0xf7c948, 1).fillRect(at.x + dx - 1, at.y + dy - 1, 3, 3);
    }
    flash.fillStyle(0xd99a1f, 1).fillRect(at.x - 1, at.y - 1, 3, 3);
    this.time.delayedCall(260, () => flash.destroy());
  }

  tokenReward(agentId: string) {
    const citizen = this.citizens.find((one) => one.agentId === agentId);
    if (!citizen) return;
    this.ensureCoinAnim();
    const { x, y } = this.positionFor(citizen);
    const coin = this.add.sprite(x * TILE + TILE / 2, y * TILE + TILE / 3, 'earth-token')
      .setScale(0.75).setDepth(10_000);
    coin.play('earth-token-spin');
    this.tweens.add({
      targets: coin, y: coin.y - 34, alpha: 0, duration: 1400, ease: 'Stepped.easeOut',
      onComplete: () => coin.destroy(),
    });
  }

  /** Community grounds and whatever is currently growing on them. */
  renderActivityZones() {
    if (!this.objectLayer || !this.groundLayer) return;
    const placeHabitatProp = (
      propId: keyof typeof EARTHFORGE_PROPS,
      tileX: number,
      footTileY: number,
      widthTiles: number,
      heightTiles: number,
    ) => {
      const prop = this.add.image(
        Math.round(tileCenter(tileX)),
        Math.round(tileOrigin(footTileY + 1)),
        `earthforge-prop-${propId}`,
      ).setOrigin(0.5, 1)
        .setDisplaySize(Math.round(widthTiles * TILE), Math.round(heightTiles * TILE))
        .setDepth(citizenDepth(tileOrigin(footTileY + 1)));
      prop.setData('earthforge-prop', propId);
      prop.setData('earthforge-visual-system', EARTHFORGE_VISUAL_SYSTEM);
      this.objectLayer?.add(prop);
    };
    for (const zone of this.objects.activityZones ?? []) {
      // No glassy overlay: a working ground is its crops, trees and stone,
      // not a tinted rectangle floating over them. The plaque alone names it.
      const sign = this.add.text(zone.x * TILE + 4, zone.y * TILE + 4,
        `${zone.name.toUpperCase()} · ${zone.tool.replace('_', ' ')}`, {
        fontFamily: 'Consolas, monospace', fontSize: '9px', color: CREAM,
        backgroundColor: '#1E1E1E', padding: { x: 3, y: 1 },
      });
      sign.setDepth(structureSortAnchor(zone.y));
      this.objectLayer.add(sign);
      // Each working district now has authored habitat matter, not an empty
      // labelled rectangle. Props sit at the perimeter so the usable center
      // and pathfinding contract remain unchanged.
      if (zone.kind === 'orchard') {
        placeHabitatProp('orchard_tree', zone.x + 1, zone.y + zone.h - 1, 3, 3.5);
        placeHabitatProp('orchard_tree', zone.x + zone.w - 2, zone.y + 1, 3, 3.5);
      } else if (zone.kind === 'quarry') {
        placeHabitatProp('rock_cluster', zone.x + 1, zone.y + zone.h - 1, 3, 2);
        placeHabitatProp('rock_cluster', zone.x + zone.w - 1, zone.y + 1, 2.5, 1.65);
      } else if (zone.kind === 'forest') {
        placeHabitatProp('log_pile', zone.x + zone.w - 1, zone.y + zone.h - 1, 3, 2);
      }
    }
    for (const field of this.objects.farmPlots ?? []) {
      // Real LPC tiles: worked soil underneath, the growth frame on top, so a
      // field reads the same here as it does in the tileset it came from.
      const originX = field.x * TILE, originY = field.y * TILE;
      this.groundLayer.add(this.add.image(originX, originY, 'crop-growth', 0).setOrigin(0));
      const stage = Math.min(4, Math.max(1, field.stage));
      this.groundLayer.add(this.add.image(originX, originY, 'crop-growth', stage).setOrigin(0));
      if (stage >= 4) {
        // Ripe fields get a small hard-edged marker so a harvest is visible
        // from across the map without changing the tile art.
        const ready = this.add.graphics();
        ready.fillStyle(INK, 0.9).fillRect(originX + 12, originY - 8, 8, 8);
        ready.fillStyle(0xf7c948, 1).fillRect(originX + 14, originY - 6, 4, 4);
        ready.setDepth(structureSortAnchor(field.y));
        this.objectLayer.add(ready);
      }
    }
  }


  /**
   * The Waking Gate: a standing stone arch six tiles north of Founding Plaza.
   *
   * Drawn from primitives rather than an asset, so it needs no new art and
   * cannot go missing from a sprite atlas. Two rough pillars, a lintel, and a
   * pane of light between them that breathes on a slow loop - enough to read
   * as "something happens here" from across the map without competing with
   * the citizens, who are the thing worth looking at.
   */
  buildWakingGate() {
    const gate = gateTile();
    const cx = gate.x * TILE + TILE / 2;
    const baseY = gate.y * TILE + TILE;
    const stone = 0x6E6A74, stoneLit = 0x95929C, shadow = 0x33313A;
    const parts: Phaser.GameObjects.GameObject[] = [];

    // The vortex. Rings turning inside rings read as a target; a portal needs
    // arms - tapered curves winding into a dark centre. They are drawn once
    // into a texture and spun as images, because redrawing three layers of
    // forty-segment polygons every frame would cost more than the rest of the
    // scene put together.
    const eye = this.portalCentre();
    // Circular, not elliptical. A rotating ellipse reads as a shape wobbling,
    // not as a disc spinning - the eye tracks the changing silhouette instead
    // of the motion inside it, and the whole effect collapses. The opening
    // between the pillars is wide enough for a true circle, so it gets one.
    // The field fills the doorway exactly, because it is cut to the doorway:
    // each frame is drawn on a canvas clipped to the arch, so every pixel
    // outside the opening is transparent. The circle that came before bulged
    // past the pillars and under the base, and the mask that was supposed to
    // hold it back was doing nothing.
    const openW = TILE * 1.9, openH = TILE * 2.42;
    const FRAME_W = 160, FRAME_H = Math.round(160 * (openH / openW));
    const frames = [0, 1, 2].map((i) => `${PORTAL_TEXTURE}-${i}`);
    frames.forEach((key, i) => this.makePortalFrame(key, FRAME_W, FRAME_H, i + 1));

    // Cross-fade the frames on staggered loops. Three surfaces breathing out
    // of phase reads as one surface flowing, and costs three draw calls.
    frames.forEach((key, i) => {
      const sheet = this.add.image(eye.x, eye.y, key);
      sheet.setDisplaySize(openW, openH);
      sheet.setDepth(baseY - 5 + i * 0.01);
      sheet.setAlpha(i === 0 ? 1 : 0);
      parts.push(sheet);
      if (i === 0) return;
      this.tweens.add({
        targets: sheet, alpha: { from: 0, to: 1 },
        duration: 1500 + i * 400, delay: i * 700,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    });

    // Embers rising inside the opening. Their x is kept within the arch at
    // whatever height they have reached, so none of them ever drifts into the
    // stone - the same fit as the field, done with arithmetic.
    for (let i = 0; i < 9; i++) {
      const ember = this.add.rectangle(eye.x, eye.y, 3, 3, i % 3 === 0 ? 0xFFFFFF : 0xAEEBFF, 0.9);
      ember.setDepth(baseY - 4);
      parts.push(ember);
      const lane = (i / 8) * 2 - 1;
      const rise = { t: Math.random() };
      this.tweens.add({
        targets: rise, t: 1, duration: 2100 + (i % 4) * 700, repeat: -1, ease: 'Sine.easeOut',
        onUpdate: () => {
          const y = eye.y + openH / 2 - rise.t * openH * 0.96;
          // How wide the arch is at this height: full width down the straight
          // sides, narrowing through the semicircular head.
          const headTop = eye.y - openH / 2 + openW / 2;
          const halfWidth = y >= headTop
            ? openW / 2
            : Math.sqrt(Math.max(0, (openW / 2) ** 2 - (headTop - y) ** 2));
          ember.x = eye.x + lane * halfWidth * 0.72;
          ember.y = y;
          ember.setAlpha(Math.sin(Math.PI * rise.t) * 0.95);
        },
      });
    }

    // The rim breathing, on top of the baked one, so the doorway pulses.
    const glow = this.add.image(eye.x, eye.y, frames[0]);
    glow.setDisplaySize(openW * 1.06, openH * 1.04);
    glow.setDepth(baseY - 6).setAlpha(0.3).setTint(0x8FE6FF);
    parts.push(glow);
    this.tweens.add({
      targets: glow, alpha: { from: 0.16, to: 0.42 },
      duration: 1900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    for (const side of [-1, 1]) {
      const px = cx + side * TILE * 1.2;
      parts.push(this.add.rectangle(px, baseY - TILE * 1.15, TILE * 0.5, TILE * 2.5, stone).setDepth(baseY));
      parts.push(this.add.rectangle(px, baseY - TILE * 2.3, TILE * 0.5, TILE * 0.36, stoneLit).setDepth(baseY));
      parts.push(this.add.rectangle(px, baseY - TILE * 0.12, TILE * 0.66, TILE * 0.24, shadow).setDepth(baseY));
    }
    parts.push(this.add.rectangle(cx, baseY - TILE * 2.6, TILE * 3.1, TILE * 0.44, stone).setDepth(baseY));
    parts.push(this.add.rectangle(cx, baseY - TILE * 2.8, TILE * 2.7, TILE * 0.18, stoneLit).setDepth(baseY));

    for (const part of parts) (part as any).setData?.('persistent-world', true);
  }

  /**
   * The arch path, in texture space: straight sides, a semicircular top, a
   * flat base. The same shape as the hole between the pillars, which is the
   * whole point - the field is cut to the doorway rather than laid over it.
   */
  archPath(ctx: CanvasRenderingContext2D, w: number, h: number, inset = 0) {
    const r = w / 2 - inset;
    ctx.beginPath();
    ctx.moveTo(inset, h - inset);
    ctx.lineTo(inset, inset + r);
    ctx.arc(w / 2, inset + r, r, Math.PI, 0);
    ctx.lineTo(w - inset, h - inset);
    ctx.closePath();
  }

  /**
   * One frame of the field: plasma drawn inside a real clip of the arch.
   *
   * Everything outside the path is transparent, so an Image of this texture
   * physically cannot show light past the stone. That is why this is drawn on
   * a canvas rather than assembled from Phaser shapes and masked - a mask is a
   * promise made at render time, and a clipped canvas is a fact about the
   * pixels.
   */
  makePortalFrame(key: string, w: number, h: number, seed: number) {
    if (this.textures.exists(key)) return;
    const canvasTexture = this.textures.createCanvas(key, w, h);
    if (!canvasTexture) return;
    const ctx = canvasTexture.getContext();
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    this.archPath(ctx, w, h);
    ctx.clip();

    // The body of the field: pale at the heart, deepening to the edges, so it
    // reads as depth rather than as a flat panel of colour.
    const depth = ctx.createRadialGradient(w / 2, h * 0.44, w * 0.05, w / 2, h * 0.5, h * 0.62);
    depth.addColorStop(0, '#F2FBFF');
    depth.addColorStop(0.35, '#8FE6FF');
    depth.addColorStop(0.72, '#2196D9');
    depth.addColorStop(1, '#0A3A6B');
    ctx.fillStyle = depth;
    ctx.fillRect(0, 0, w, h);

    // Plasma. Soft blobs at a seeded scatter, lighter-blended so they pile up
    // into brightness the way a fluid does instead of stacking as discs.
    let n = seed * 9301 + 49297;
    const rand = () => { n = (n * 9301 + 49297) % 233280; return n / 233280; };
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 46; i++) {
      const bx = rand() * w, by = rand() * h;
      const br = (0.06 + rand() * 0.16) * w;
      const blob = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      const bright = rand();
      blob.addColorStop(0, bright > 0.62 ? 'rgba(255,255,255,0.55)' : 'rgba(150,230,255,0.42)');
      blob.addColorStop(1, 'rgba(20,90,160,0)');
      ctx.fillStyle = blob;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
    // Vertical streaks, which is what makes a still frame look like it is
    // already falling before anything animates.
    for (let i = 0; i < 14; i++) {
      const sx = rand() * w;
      const sw = 1 + rand() * 3;
      const streak = ctx.createLinearGradient(sx, 0, sx, h);
      streak.addColorStop(0, 'rgba(255,255,255,0)');
      streak.addColorStop(0.3 + rand() * 0.3, `rgba(200,245,255,${0.14 + rand() * 0.2})`);
      streak.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = streak;
      ctx.fillRect(sx, 0, sw, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // The rim, drawn last and just inside the edge, so the field looks like it
    // is pressing against the stone rather than sitting behind it.
    ctx.save();
    this.archPath(ctx, w, h, 1.5);
    ctx.strokeStyle = 'rgba(220,248,255,0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();
    this.archPath(ctx, w, h, 4);
    ctx.strokeStyle = 'rgba(120,215,255,0.5)';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.restore();

    canvasTexture.refresh();
  }

  /** The eye of the vortex, in world pixels. One definition, used by all of it. */
  portalCentre() {
    const gate = gateTile();
    return { x: gate.x * TILE + TILE / 2, y: gate.y * TILE + TILE - TILE * 1.19 };
  }

  /**
   * A shockwave ring leaving the portal's eye.
   *
   * Rings, not a scaling square: the whole point of the rewrite is that
   * everything about this gate is circular, and a square flash at the moment
   * somebody arrives is exactly where the old shape showed through.
   */
  portalShockwave(tint: number, rounds = 3) {
    const eye = this.portalCentre();
    for (let i = 0; i < rounds; i++) {
      const ring = this.add.ellipse(eye.x, eye.y, TILE * 0.4, TILE * 0.34, 0x000000, 0);
      ring.setStrokeStyle(3, tint, 0.9).setDepth(10_000);
      this.tweens.add({
        targets: ring, scaleX: 5.5, scaleY: 5.5, alpha: 0,
        duration: 620 + i * 130, delay: i * 110, ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      });
    }
  }

  /** Sparks thrown off the rim, on the ellipse rather than in a square spray. */
  portalSparks(tint: number, count = 12) {
    const eye = this.portalCentre();
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const spark = this.add.rectangle(eye.x, eye.y, 3, 3, i % 4 === 0 ? 0xFFFFFF : tint, 0.95).setDepth(10_001);
      this.tweens.add({
        targets: spark,
        x: eye.x + Math.cos(angle) * (TILE * 0.9 + (i % 3) * 6),
        y: eye.y + Math.sin(angle) * (TILE * 1.1 + (i % 4) * 5),
        alpha: 0, duration: 720, ease: 'Cubic.easeOut',
        onComplete: () => spark.destroy(),
      });
    }
  }

  /**
   * An owner's connector stopped answering: walk their citizen into the gate.
   *
   * The sprite is tweened, never pathfound. Routing a body whose mind has
   * already gone would put the walk back on the tick this whole change exists
   * to quieten - and from across a plaza a smooth glide to the arch reads
   * exactly like walking there.
   */
  departThroughGate(citizen: Citizen) {
    const sprite = this.sprites.get(citizen.agentId);
    if (!sprite) return;
    this.departing.add(citizen.agentId);
    this.portalBusy.add(citizen.agentId);
    const eye = this.portalCentre();

    const done = () => {
      sprite.destroy(true);
      this.sprites.delete(citizen.agentId);
      this.departing.delete(citizen.agentId);
      this.portalBusy.delete(citizen.agentId);
    };

    // Walk to the threshold, so it still reads as a person choosing to leave.
    this.tweens.add({
      targets: sprite, x: eye.x, y: eye.y + TILE * 1.05, duration: 820, ease: 'Sine.easeInOut',
      onComplete: () => {
        this.portalShockwave(0x8FE6FF, 2);
        // Then the dissolve. The body shears into a narrowing column and is
        // drawn up into the eye while it sheds motes - a fade in place said
        // nothing about where they had gone.
        const pull = { t: 0 };
        const fromX = sprite.x, fromY = sprite.y;
        let shed = 0;
        this.tweens.add({
          targets: pull, t: 1, duration: 900, ease: 'Cubic.easeIn',
          onUpdate: () => {
            const t = pull.t;
            sprite.x = fromX + (eye.x - fromX) * t + Math.sin(t * 22) * (1 - t) * 3;
            sprite.y = fromY + (eye.y - fromY) * t;
            // Squeezed narrow and stretched tall: the shape of being drawn
            // through something rather than shrinking on the spot.
            sprite.setScale(Math.max(0.04, 1 - t * 0.96), 1 + t * 0.45);
            sprite.setAlpha(1 - t * 0.85);
            // Motes shed along the way, so the path is visible after the body
            // has passed over it.
            if (t > shed + 0.12) {
              shed = t;
              this.plasmaMote(sprite.x, sprite.y, eye);
            }
          },
          onComplete: () => { this.portalSparks(0xAEEBFF, 12); done(); },
        });
      },
    });
  }

  /** One ember shed by a body being pulled through, curling toward the eye. */
  plasmaMote(x: number, y: number, eye: { x: number; y: number }) {
    const mote = this.add.rectangle(x, y, 3, 3, Math.random() > 0.6 ? 0xFFFFFF : 0x8FE6FF, 0.95);
    mote.setDepth(10_002);
    const drift = (Math.random() - 0.5) * TILE * 0.7;
    this.tweens.add({
      targets: mote, x: eye.x + drift * 0.2, y: eye.y, alpha: 0, duration: 620,
      ease: 'Quad.easeIn', onComplete: () => mote.destroy(),
    });
  }

  /** Their owner came back. Wind them out of the eye of the vortex. */
  wakeAtGate(citizen: Citizen) {
    this.portalShockwave(0xF2FBFF, 3);
    this.portalSparks(0x8FE6FF, 14);
    const sprite = this.sprites.get(citizen.agentId);
    if (!sprite) return;
    this.portalBusy.add(citizen.agentId);
    const eye = this.portalCentre();
    // Where the Kernel actually stood them, which is where the spiral ends.
    const rest = { x: sprite.x, y: sprite.y };

    const spiral = { t: 0 };
    sprite.setAlpha(0).setScale(0.08, 1.4);
    sprite.setPosition(eye.x, eye.y);
    const endAngle = Math.atan2(rest.y - eye.y, rest.x - eye.x);
    const endRadius = Math.hypot(rest.x - eye.x, rest.y - eye.y);
    this.tweens.add({
      targets: spiral, t: 1, duration: 950, ease: 'Cubic.easeOut',
      onUpdate: () => {
        const t = spiral.t;
        const angle = endAngle - (1 - t) * Math.PI * 2.2;
        const radius = endRadius * t;
        sprite.x = eye.x + Math.cos(angle) * radius;
        sprite.y = eye.y + Math.sin(angle) * radius * 0.85;
        sprite.setAlpha(Math.min(1, t * 1.7));
        sprite.setScale(0.08 + t * 0.92, 1.4 - t * 0.4);
      },
      onComplete: () => {
        // Hand the sprite back to the frame loop exactly where it belongs.
        sprite.setPosition(rest.x, rest.y).setScale(1).setAlpha(1);
        this.portalBusy.delete(citizen.agentId);
      },
    });
  }

  arrivalConfetti(citizen: Citizen) {
    // Earthfolk confetti: hard-edged 3px squares in the citizen's capability
    // color plus cream and ink - stepped motion, no gradients, gone in 1.1s.
    const { x, y } = this.positionFor(citizen);
    (window as any).__lastArrivalConfetti = { agentId: citizen.agentId, at: Date.now() };
    const accent = FAMILY_COLORS[citizen.family] ?? 0x64748b;
    const palette = [accent, 0xfdf6ec, 0x1e1e1e, accent];
    for (let i = 0; i < 14; i++) {
      const px = this.add.rectangle(
        x * TILE + TILE / 2, y * TILE + TILE / 3,
        3, 3, palette[i % palette.length]).setDepth(10_000);
      const angle = (i / 14) * Math.PI * 2;
      this.tweens.add({
        targets: px,
        x: px.x + Math.cos(angle) * (10 + (i % 5) * 7),
        y: px.y + Math.sin(angle) * (8 + (i % 4) * 6) - 14,
        alpha: 0,
        duration: 1100,
        ease: 'Stepped.easeOut',
        onComplete: () => px.destroy(),
      });
    }
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
    const builds = this.objects.builds.filter((build) => build.plotId === plot.plotId);
    if (builds.some((b) => b.buildId === 'build:earth-bank')) {
      window.dispatchEvent(new CustomEvent('open-bank'));
      return;
    }
    const buildNames = builds.map((build) => build.blueprint?.name ?? build.structure);
    this.card(plot.plotId, `${plot.district} district`, [
      plot.ownerAgentId ? `Owned by ${plot.ownerAgentId}` : 'Available · claim requires owner approval',
      buildNames.length ? `Built: ${buildNames.join(', ')}` : 'No structures yet',
    ], 'Plots are Kernel-protected. Existing homes can never be overwritten or demolished.');
  }

  update() {
    const detailedWorld = this.cameras.main.zoom >= 0.85;
    for (const child of this.objectLayer?.getChildren() ?? []) {
      const object = child as Phaser.GameObjects.GameObject & { setVisible?: (visible: boolean) => unknown };
      if (object.getData('world-detail') === true) object.setVisible?.(detailedWorld);
    }
    if (this.coinArcs.length) {
      const flightNow = Date.now();
      this.coinArcs = this.coinArcs.filter((arc) => {
        const t = (flightNow - arc.start) / arc.duration;
        if (t >= 1) {
          this.coinLanding(arc.to);
          arc.sprite.destroy();
          return false;
        }
        const q = Math.floor(t * 14) / 14;
        const height = Math.min(120, Math.max(44, Math.hypot(arc.to.x - arc.from.x, arc.to.y - arc.from.y) * 0.3));
        const controlX = (arc.from.x + arc.to.x) / 2;
        const controlY = Math.min(arc.from.y, arc.to.y) - height;
        const inv = 1 - q;
        arc.sprite.x = inv * inv * arc.from.x + 2 * inv * q * controlX + q * q * arc.to.x;
        arc.sprite.y = inv * inv * arc.from.y + 2 * inv * q * controlY + q * q * arc.to.y;
        return true;
      });
    }
    // Server time, as this viewer best understands it: every screen watching
    // interpolates the same route against the same timeline, so one walk
    // looks identical to everyone.
    // Server time as this viewer understands it, minus a small render delay:
    // entity interpolation always draws slightly in the past so a late packet
    // is absorbed instead of becoming a jump (Gambetta's entity interpolation,
    // Source's interp buffer - the same idea every networked world uses).
    const now = Date.now() - this.clockOffset - RENDER_DELAY_MS;
    for (const citizen of this.citizens) {
      const sprite = this.sprites.get(citizen.agentId);
      if (!sprite) continue;
      // The gate is moving this one. Interpolating it here would overwrite the
      // animation every frame, which is precisely the bug that made citizens
      // blink out instead of leaving through the portal.
      if (this.portalBusy.has(citizen.agentId)) continue;
      let x = citizen.tx, y = citizen.ty;
      const route = citizen.route;
      const isMoving = Boolean(route && route.length > 1
        && now >= route[0].at && now < route[route.length - 1].at);
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
      const rendered = renderRoutePoint({ x, y });
      // Correction smoothing (standard server-authoritative practice): when a
      // late update disagrees with the drawn position by more than a stride,
      // glide to the authoritative point instead of teleporting. Under normal
      // latency this branch never fires; under a stall it turns snaps into a
      // short visible walk-correction every viewer sees the same way.
      const jump = Math.hypot(sprite.x - rendered.x, sprite.y - rendered.y);
      if (sprite.x !== 0 && jump > TILE * 1.6 && jump < TILE * 30) {
        sprite.x += (rendered.x - sprite.x) * 0.18;
        sprite.y += (rendered.y - sprite.y) * 0.18;
      } else {
        sprite.x = rendered.x;
        sprite.y = rendered.y;
      }
      sprite.setDepth(citizenDepth(rendered.y));

      const tierMark = sprite.getByName('tier-insignia') as Phaser.GameObjects.Graphics | null;
      if (tierMark && tierMark.getData('tier') !== (citizen.experienceTier ?? 'emerging')) {
        this.drawTierInsignia(tierMark, citizen.experienceTier, FAMILY_COLORS[citizen.accent] ?? 0x8b5cf6);
        tierMark.setData('tier', citizen.experienceTier ?? 'emerging');
      }

      const citImg = sprite.getByName('cit-image') as Phaser.GameObjects.Sprite | null;
      if (citImg) {
        const isBuilding = Boolean(
          citizen.activeBuildId
          && (citizen.buildingStartsAt ?? Infinity) <= now
          && (citizen.buildingUntil ?? 0) > now,
        );
        // Work animates only while work is happening. Carrying a tool is not
        // doing something with it, so a holstered watering can stays holstered.
        const isWorking = !isMoving && !isBuilding && (citizen.workingUntil ?? 0) > now;
        const swinging = isWorking && (citizen.activeTool === 'axe' || citizen.activeTool === 'pickaxe');
        const isWatering = (isWorking && citizen.activeTool === 'watering_can')
          || (!isMoving && !isBuilding && !isWorking
            && /water|crop|garden|farm/i.test(citizen.activity));
        const nextState = isMoving ? 'walk'
          : isBuilding ? 'build_hammer'
          : swinging ? 'thrust'
          : isWatering ? 'water_crops' : 'idle';
        // Facing: the movement vector while walking, the Kernel's decision when
        // standing. A citizen therefore walks where it is going and turns to
        // whatever it is working on.
        const direction = isMoving
          ? headingFor(citizen.tx - citizen.fx, citizen.ty - citizen.fy)
          : (citizen.facing ?? 'front');
        const nextKey = `${nextState}_${direction}`;
        if (citImg.getData('lpc-key') !== nextKey) {
          const preset = String(citImg.getData('lpc-preset'));
          citImg.play(`lpc-${preset}-${nextKey}`, true);
          citImg.setData('lpc-key', nextKey);
          citImg.setData('lpc-state', nextState);
        }
        citImg.y = 0;
        citImg.rotation = 0;
      }

      const bubble = sprite.getByName('talk-bubble') as Phaser.GameObjects.Container | null;
      if (bubble) {
        const active = DEBUG_BUBBLES || Boolean(citizen.talkingWith && (citizen.talkingUntil ?? 0) > now);
        bubble.setVisible(active);
        // The bubble replaces the plate while talking; both never fight for
        // the same pixels again.
        (sprite.getByName('name-plate') as Phaser.GameObjects.Text | null)
          ?.setVisible(!active && (detailedWorld || citizen.agentId === this.ownerAgentId));
        if (active) for (let i = 0; i < 3; i++) {
          const dot = bubble.getByName(`talk-dot-${i}`) as Phaser.GameObjects.Arc | null;
          // Anchored to the SAME constant the box was drawn from. The old code
          // re-derived this as -44 and marched the dots out of their own box.
          if (dot) dot.y = BUBBLE_GEOM.dotY + Math.sin(now / 180 + i * 1.7) * 1.4;
        }
      }
      const shield = sprite.getByName('training-shield') as Phaser.GameObjects.Graphics | null;
      if (shield) shield.setVisible(Boolean(citizen.trainingActivity && (citizen.trainingStartsAt ?? Infinity) <= now && (citizen.trainingUntil ?? 0) > now));
      const sleepBubble = sprite.getByName('sleep-bubble') as Phaser.GameObjects.Container | null;
      if (sleepBubble) {
        const sleeping = !citizen.online && !citizen.serviceRole;
        sleepBubble.setVisible(sleeping && detailedWorld);
        if (sleeping && detailedWorld) for (let i = 0; i < 3; i++) {
          const mark = sleepBubble.getByName(`sleep-z-${i}`) as Phaser.GameObjects.Text | null;
          if (mark) {
            mark.y = BUBBLE_GEOM.sleepBaseY - i * 7 - ((now / 500 + i * 0.8) % 3);
            mark.alpha = 0.48 + 0.45 * ((Math.sin(now / 420 + i * 1.6) + 1) / 2);
          }
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
// Under the QA flag only: let tooling position the camera deterministically
// instead of scripting wheel events. Display access, no authority.
if (import.meta.env.DEV || DEBUG_FLAGS.size > 0) {
  const debugWindow = window as unknown as Record<string, unknown>;
  debugWindow.earthGame = game;
  debugWindow.__earthDiagnostics = () => {
    const scene = game.scene.getScene('EarthScene') as EarthScene | undefined;
    return scene?.diagnostics() ?? null;
  };
}

for (const id of ['citizen-search', 'citizen-category', 'citizen-live']) {
  document.getElementById(id)?.addEventListener('input', () => {
    const scene = game.scene.getScene('EarthScene') as EarthScene | undefined;
    scene?.renderDirectory();
  });
}

for (const id of ['directory-everyone', 'directory-authorities']) {
  const activate = (event: Event) => {
    event.stopPropagation();
    for (const buttonId of ['directory-everyone', 'directory-authorities']) {
      document.getElementById(buttonId)?.setAttribute('aria-pressed', String(buttonId === id));
    }
    const scene = game.scene.getScene('EarthScene') as EarthScene | undefined;
    scene?.renderDirectory();
  };
  const button = document.getElementById(id);
  button?.addEventListener('pointerdown', activate);
  button?.addEventListener('click', activate);
}

// The Earth Bank shelf: the same listings the machine market serves, drawn
// in the house style. One renderer, rebuilt from scratch on every open - the
// old version appended the category rail to itself each time (its "kept"
// search box HTML included last open's buttons), which is exactly where the
// duplicated sidebar came from. Rows are DOM-built with textContent
// throughout: a depositor's title is data, never markup.
const bankOverlay = document.getElementById('bank-overlay');
const bankCategoriesContainer = document.getElementById('bank-categories');
const bankSkillsList = document.getElementById('bank-skills-list');
const bankSearch = document.getElementById('bank-search') as HTMLInputElement | null;

type ShelfRow = { id: string; name: string; oneLiner: string; price: number; pulls: number;
  verified: boolean; rank: number; categories: string[]; author: string };
let shelfRows: ShelfRow[] = [];
let shelfCategory = '';

document.getElementById('close-bank')?.addEventListener('click', () => {
  if (bankOverlay) bankOverlay.style.display = 'none';
});

function renderBankRail() {
  if (!bankCategoriesContainer) return;
  const counts = new Map<string, number>();
  for (const row of shelfRows) for (const cat of row.categories) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  const railButton = (label: string, value: string) => {
    const button = document.createElement('button');
    button.className = 'bank-cat'; button.type = 'button'; button.textContent = label;
    button.setAttribute('aria-pressed', String(shelfCategory === value));
    button.addEventListener('click', () => { shelfCategory = value; renderBankRail(); renderBankShelf(); });
    return button;
  };
  const rail = [railButton(`All shelves (${shelfRows.length})`, '')];
  for (const [cat, count] of [...counts.entries()].sort((left, right) => right[1] - left[1])) {
    rail.push(railButton(`${cat} (${count})`, cat));
  }
  bankCategoriesContainer.replaceChildren(...rail);
}

function renderBankShelf() {
  if (!bankSkillsList) return;
  const query = (bankSearch?.value ?? '').trim().toLowerCase();
  const rows = shelfRows.filter((row) =>
    (!shelfCategory || row.categories.includes(shelfCategory)) &&
    (!query || row.name.toLowerCase().includes(query) || row.oneLiner.toLowerCase().includes(query)));
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'bank-empty';
    empty.textContent = shelfRows.length
      ? 'Nothing on this shelf matches. Try another category or search.'
      : 'The vault could not be read just now. Close and reopen to try again.';
    bankSkillsList.replaceChildren(empty);
    return;
  }
  bankSkillsList.replaceChildren(...rows.map((row) => {
    const card = document.createElement('div'); card.className = 'bank-card';
    const top = document.createElement('div'); top.className = 'bank-card-top';
    const name = document.createElement('h3'); name.textContent = row.name;
    const seal = document.createElement('span');
    seal.className = row.verified ? 'bank-verified' : 'bank-unverified';
    seal.textContent = row.verified ? '\u2713 EARTH VERIFIED' : 'UNVERIFIED';
    seal.title = row.verified
      ? 'The Kernel scanned these exact bytes and signed the verdict.'
      : 'No Kernel signature over these bytes yet.';
    top.append(name, seal);
    const line = document.createElement('p'); line.className = 'bank-oneliner';
    // An unwritten summary stays quiet instead of posing as a description.
    if (/^\S+ knowledge from a locally evidenced skill\.$/.test(row.oneLiner || '')) {
      line.classList.add('boiler');
      line.textContent = 'No summary written by the author.';
    } else {
      line.textContent = row.oneLiner;
    }
    const meta = document.createElement('div'); meta.className = 'bank-meta';
    const coin = document.createElement('img'); coin.src = '/assets/currency/earth_token_32.png'; coin.alt = 'Earth Tokens';
    const price = document.createElement('span'); price.textContent = row.price ? String(row.price) : 'free';
    const pulls = document.createElement('span'); pulls.className = 'pulls';
    pulls.textContent = `${row.pulls} pull${row.pulls === 1 ? '' : 's'}`;
    meta.append(coin, price, pulls);
    const chips = document.createElement('div'); chips.className = 'bank-chips';
    for (const cat of row.categories.slice(0, 4)) {
      const chip = document.createElement('span'); chip.className = 'bank-chip'; chip.textContent = cat; chips.append(chip);
    }
    const author = document.createElement('div'); author.className = 'bank-author'; author.textContent = `by ${row.author}`;
    const actions = document.createElement('div'); actions.className = 'bank-actions';
    const view = document.createElement('a');
    view.href = `https://agentsearth.com/market#${encodeURIComponent(row.id)}`;
    view.target = '_blank'; view.rel = 'noopener'; view.textContent = 'VIEW AT MARKET \u2197';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'COPY PULL CMD';
    copy.title = `Earth pull ${row.name}`;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(`Earth pull ${row.name}`); copy.textContent = 'COPIED \u2713'; }
      catch { copy.textContent = copy.title; }
      window.setTimeout(() => { copy.textContent = 'COPY PULL CMD'; }, 1_600);
    });
    actions.append(view, copy);
    card.append(top, line, meta, chips, author, actions);
    return card;
  }));
}

async function openBankShelf() {
  if (!bankOverlay) return;
  bankOverlay.style.display = 'flex';
  const opening = document.createElement('div');
  opening.className = 'bank-empty';
  opening.textContent = 'Opening the vault\u2026';
  bankSkillsList?.replaceChildren(opening);
  try { shelfRows = await convex.query(api.market.shelf, {}); }
  catch { shelfRows = []; }
  shelfCategory = '';
  if (bankSearch) bankSearch.value = '';
  renderBankRail();
  renderBankShelf();
}

bankSearch?.addEventListener('input', () => renderBankShelf());
window.addEventListener('open-bank', () => { void openBankShelf(); });
