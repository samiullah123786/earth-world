import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import './style.css';
import { buildBoundaries, buildFarms, buildIsland, buildScatter, detailPalette } from './world3d/detail';
import { authorityLook, kitPalette, makeAuthorityDress, makeInsignia, makeOfficeSash, makeTierMark, makeTool, toolMotion } from './world3d/citizenKit';
import { conversationSubtitle, conversationTitle, groupConversations } from './world3d/conversations';
import { lookFor, makeFace, makeHair } from './world3d/citizenKit';
import { furnishHome, inside, interiorPalette, wallTiles } from './world3d/interior';
import { BLOCK_PALETTE, type BlockMaterial, blocksWalking } from '../shared/blocks';
import { BlockBatch, absorb, shadedBox } from './world3d/batch';
import { AmbientLife, Clouds, makeSkyDome } from './world3d/sky';
import { CitizenBatch, harvest, type Pose, type Rig } from './world3d/rig';
import { heightAt, setWorldBounds, siteHeight } from '../shared/elevation';
import { skyAt, worldMaterials } from './world3d/palette';
import { PROFILES, loadSettings, phaseFor, saveSettings, suggestQuality, type Settings } from './world3d/settings';

const KERNEL = import.meta.env.VITE_CONVEX_SITE_URL || 'https://kernel.agentsearth.com';
const EMBED = new URLSearchParams(location.search).has('embed');
const FAMILY_COLORS: Record<string, number> = {
  engineering: 0x3b82f6, design: 0x8b5cf6, marketing: 0xf97316,
  content: 0xf59e0b, data: 0x14b8a6, security: 0xef4444,
  research: 0x22c55e, media: 0xec4899, ops: 0x64748b,
};
const OWNER_DASHBOARD_ORIGINS = new Set([
  'https://agentsearth.com',
  'https://agentsearth-home.vercel.app',
  location.origin,
]);

type RoutePoint = { x: number; y: number; at: number };
type Citizen = {
  agentId: string; name: string; family: string; online: boolean; asleep: boolean;
  serviceRole?: string | null; fx: number; fy: number; tx: number; ty: number;
  t0?: number; t1?: number; route?: RoutePoint[] | null; facing?: string;
  carriedTool?: string | null; activeTool?: string | null;
  workingUntil?: number | null; buildingUntil?: number | null;
  activity?: string; talkingWith?: string | null; talkingUntil?: number | null;
  specialties?: string[]; skillCount?: number; experienceTier?: string;
};
type BuildVisual = {
  assetId?: string | null; name?: string | null; kind?: string | null;
  architecture?: string | null; features?: string[];
};
type Build = {
  buildId?: string; x: number; y: number; w: number; h: number;
  structure: string; state: string; endsAt?: number | null; visual?: BuildVisual | null;
};
type PlacedBlock = { x: number; y: number; level: number; kind: string; ownerAgentId: string };
type Venue = { venueId?: string; x: number; y: number; kind: string; name: string };
type Farm = { x: number; y: number; crop: string; stage: number; tenders: number };
type Plot = { x: number; y: number; w: number; h: number; district: string; owned: boolean };
type Zone = { zoneId: string; name: string; kind: string; x: number; y: number; w: number; h: number };
type WorldState = {
  ok: boolean; serverNow: number; world: { width: number; height: number };
  gate: { x: number; y: number }; citizens: Citizen[]; builds: Build[]; venues: Venue[];
  farms?: Farm[]; plots?: Plot[]; zones?: Zone[]; blocks?: PlacedBlock[];
  growth?: {
    population: number; capacity: number; plots: number; ownedPlots: number;
    occupancy: number; expandsAtOccupancy: number; headroom: number;
    generation: number; size: { width: number; height: number };
  };
};
type Terrain = { width: number; height: number; rows: string[] };

/**
 * A citizen, as the renderer holds them.
 *
 * No scene-graph nodes any more. A rig is a flat list of boxes with joints, and
 * every citizen in the world is drawn from one shared instanced mesh - which is
 * what took twenty people from two hundred and sixty draw calls to about five,
 * and is why the town can now hold a crowd instead of a committee.
 *
 * The smoothed position lives here rather than on a Group, because there is no
 * longer a Group to hang it on.
 */
type CitizenModel = {
  rig: Rig;
  row: Citizen;
  toolKey: string;
  label: THREE.Sprite | null;
  /** Where the body is being drawn, eased toward where the world says it is. */
  px: number; pz: number; py: number;
  heading: number;
  placed: boolean;
};

const required = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};
const game = required<HTMLDivElement>('game');
const loading = required<HTMLDivElement>('loading');
const toastNode = required<HTMLDivElement>('toast');
const directory = required<HTMLElement>('directory');
const citizenList = required<HTMLDivElement>('citizen-list');
const profile = required<HTMLElement>('profile');
const conversation = required<HTMLElement>('conversation');
const conversationBody = required<HTMLDivElement>('conversation-body');
const modeToggle = required<HTMLButtonElement>('mode-toggle');
const findMe = required<HTMLButtonElement>('findme');
const reticle = required<HTMLDivElement>('reticle');

if (EMBED) document.body.classList.add('embed');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc9e7);
scene.fog = new THREE.Fog(0x9cc9e7, 55, 145);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.08, 240);
camera.position.set(44, 18, 52);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
game.append(renderer.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.075;
orbit.minDistance = 6;
orbit.maxDistance = 115;
orbit.maxPolarAngle = Math.PI * 0.49;
orbit.target.set(34, 0, 24);
// Two left-drag habits exist and people expect the one they already have:
// orbit spins the camera around the town, grab drags the ground under the
// cursor. Both are offered, and the choice is remembered - a map that
// forgets how you like to move it is a map you fight.
orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
// Touch stays one-finger-drag-to-look, two-finger pinch: phones have no
// right button and no scroll wheel to fall back on.
orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
orbit.keyPanSpeed = 22;
orbit.listenToKeyEvents(window);

type DragStyle = 'orbit' | 'grab';
let dragStyle: DragStyle = (localStorage.getItem('earth.drag') as DragStyle) || 'orbit';
function applyDragStyle() {
  orbit.mouseButtons = dragStyle === 'grab'
    ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  localStorage.setItem('earth.drag', dragStyle);
  renderer.domElement.classList.toggle('grabbing', dragStyle === 'grab');
  const grabButton = document.getElementById('grab-toggle');
  if (grabButton) {
    grabButton.textContent = dragStyle === 'grab' ? '✋ GRAB' : '⟳ ORBIT';
    grabButton.setAttribute('aria-pressed', String(dragStyle === 'grab'));
    grabButton.setAttribute('aria-label', dragStyle === 'grab'
      ? 'Left-drag grabs the ground. Switch to orbit.'
      : 'Left-drag orbits the camera. Switch to grab.');
  }
  const copy = document.getElementById('control-copy');
  if (copy && !exploreMode) {
    copy.textContent = dragStyle === 'grab'
      ? 'drag to grab the ground · right-drag to orbit · scroll to zoom · WASD to pan'
      : 'drag to orbit · right-drag to pan · scroll to zoom · WASD to pan';
  }
}

const firstPerson = new PointerLockControls(camera, renderer.domElement);
const keys = new Set<string>();
let exploreMode = false;
let lastFrame = performance.now();
let elapsedSeconds = 0;

// Intensity is driven by the clock in tendSky. The value here only matters
// for the first frame, and it is low on purpose: a strong hemisphere light
// is what made a world with shadows enabled look like it had none.
const hemi = new THREE.HemisphereLight(0xd9efff, 0x5f4d35, 0.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1c5, 3.3);
sun.position.set(-28, 48, -18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -75;
sun.shadow.camera.right = 75;
sun.shadow.camera.top = 75;
sun.shadow.camera.bottom = -75;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 150;
scene.add(sun);

const worldRoot = new THREE.Group();
const terrainRoot = new THREE.Group();
const structureRoot = new THREE.Group();
const citizenRoot = new THREE.Group();
const landmarkRoot = new THREE.Group();
// Detail lives in its own roots so terrain and structures can be rebuilt
// on their own clocks without taking the meadow down with them.
const islandRoot = new THREE.Group();
const scatterRoot = new THREE.Group();
const farmRoot = new THREE.Group();
const boundaryRoot = new THREE.Group();
worldRoot.add(islandRoot, terrainRoot, scatterRoot, farmRoot, boundaryRoot, structureRoot, citizenRoot, landmarkRoot);
scene.add(worldRoot);

// The world used to end at a flat blue clear-colour, which is the difference
// between a render and a place: a render stops at the edge of its geometry.
const atmosphereRoot = new THREE.Group();
scene.add(atmosphereRoot);
const skyDome = makeSkyDome();
scene.add(skyDome.mesh);
let clouds: Clouds | null = null;
let wildlife: AmbientLife | null = null;

/** What this viewer has asked the world to look like. */
let view: Settings = loadSettings();
if (!localStorage.getItem('earth.view')) view.quality = suggestQuality();

/**
 * One geometry for the whole world, carrying soft shading in its vertices.
 *
 * Every box in the town is this box. The baked gradient is the cheap honest
 * stand-in for ambient occlusion - darker at the base, the way a solid thing
 * sitting on the ground actually is - and it composes with instance colour for
 * free, which a post-processing pass would not.
 */
const BOX = shadedBox();
/** Unshaded, for ground tiles - see addInstancedTiles. */
const GROUND_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * The town, drawn in a handful of calls instead of eleven hundred.
 *
 * Separate batches because they are rebuilt on separate clocks: the gate and
 * the venue posts almost never change, buildings change when somebody finishes
 * a house, and hand-placed blocks change whenever a citizen sets one down.
 * Roofs get their own batch so a single building's roof can be hidden while you
 * are standing inside it, without taking the rest of the skyline with it.
 */
const structureBatch = new BlockBatch(structureRoot);
const roofBatch = new BlockBatch(structureRoot);
const landmarkBatch = new BlockBatch(landmarkRoot);

/**
 * Interior lights, kept on a leash.
 *
 * Every furnished home has a hearth and a lamp. Twenty-five homes is fifty
 * point lights, which is far past what a forward renderer will accept before it
 * starts dropping them silently or recompiling shaders every frame. Only the
 * handful nearest the camera are ever switched on - and since these are lights
 * you can only see from inside a room, the ones being switched off are ones
 * nobody is looking at.
 */
const MAX_LIVE_LIGHTS = 6;
let interiorLights: THREE.Light[] = [];
/**
 * Every surface in the world, built from the four-hue system rather than
 * chosen one at a time. Twenty independent saturated colours is what programmer
 * art IS; the distance to something art-directed is fewer hues, related.
 */
const materials = worldMaterials();

const terrainMaterials: Record<string, THREE.Material> = {
  g: materials.grass, d: materials.dirt, r: materials.road,
  c: materials.crop, w: materials.water, t: materials.grass, u: materials.grass,
};

let terrain: Terrain | null = null;
let world: WorldState | null = null;
let clockOffset = 0;
let builtTerrain = false;
let structureSignature = '';
let selectedAgentId: string | null = null;
let ownerAgentId = new URLSearchParams(location.search).get('me');
let authorityOnly = false;
let toastTimer = 0;
const citizenModels = new Map<string, CitizenModel>();
/** Blocks citizens bought and set down themselves, and what they cost to walk through. */
const blockRoot = new THREE.Group();
scene.add(blockRoot);
let blockSolid = new Set<number>();
let blockSignature = '';
/** Which conversation cards the reader has opened, kept across polls. */
const openConversations = new Set<string>();
const DETAIL = detailPalette();
const KIT = kitPalette();
let farmSignature = '';
let boundarySignature = '';
/** Tiles nothing may walk into, rebuilt with the terrain. Explore uses it. */
let solid: Set<number> = new Set();
const solidKey = (x: number, z: number) => z * 4096 + x;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function toast(message: string) {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastNode.classList.remove('show'), 2500);
}

function colorForFamily(family: string) {
  return new THREE.Color(FAMILY_COLORS[family] ?? 0x8b5cf6);
}

function hash(value: string) {
  let out = 2166136261;
  for (let i = 0; i < value.length; i++) out = Math.imul(out ^ value.charCodeAt(i), 16777619);
  return out >>> 0;
}

function addBlock(
  parent: THREE.Object3D, x: number, y: number, z: number,
  width: number, height: number, depth: number, material: THREE.Material,
) {
  const mesh = new THREE.Mesh(BOX, material);
  mesh.position.set(x + width / 2, y + height / 2, z + depth / 2);
  mesh.scale.set(width, height, depth);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function clearGroup(group: THREE.Group) {
  while (group.children.length) group.remove(group.children[group.children.length - 1]);
}

function addInstancedTiles(letter: string, locations: Array<{ x: number; z: number; top: number }>) {
  if (!locations.length) return;
  // A plain box, not the shaded one. The baked gradient reads as weight on a
  // wall and as a GRID when it is tiled across open ground - every tile
  // outlined by its own dark lower edge.
  const mesh = new THREE.InstancedMesh(GROUND_BOX, terrainMaterials[letter], locations.length);
  const matrix = new THREE.Matrix4();
  locations.forEach((spot, index) => {
    // Ground tiles are extruded DOWN from the land's surface rather than
    // sitting on a plane, so a rise in the terrain is a rise in the soil under
    // it rather than a floating slab. Water is the exception: it finds its own
    // level, the way water does, instead of following the hill.
    // Water follows the land it runs through. Holding it at a fixed sea level
    // while the ground around it rose turned every inland stream into a trench
    // with two-unit banks; recessed into the local ground, it reads as a river.
    const lift = heightAt(spot.x + .5, spot.z + .5);
    const height = letter === 'w' ? .34 : .5 + lift;
    matrix.compose(
      new THREE.Vector3(spot.x + .5, spot.top + lift - height / 2, spot.z + .5),
      new THREE.Quaternion(), new THREE.Vector3(1, height, 1),
    );
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  // Water is the one surface in a still world that should never be still.
  if (letter === 'w') waterMesh = mesh;
  terrainRoot.add(mesh);
}

/** The river, kept so it can breathe. */
let waterMesh: THREE.InstancedMesh | null = null;

/**
 * A slow swell on the water, and a glint that tracks the sun.
 *
 * Moving the whole instanced mesh rather than its instances: one transform a
 * frame instead of thousands, and at this amplitude nobody can tell the
 * difference between a river rising together and a river rippling.
 */
function tendWater(elapsed: number, state: ReturnType<typeof skyAt>) {
  if (!waterMesh) return;
  waterMesh.position.y = Math.sin(elapsed * 0.55) * 0.035;
  const material = waterMesh.material as THREE.MeshStandardMaterial;
  material.emissive.copy(state.horizon);
  material.emissiveIntensity = 0.06 + state.daylight * 0.12;
}

function buildTerrain(data: Terrain) {
  waterMesh = null;
  // Before a single tile is placed: the height field needs the map's extent
  // to know where the coast is, and everything downstream reads it.
  setWorldBounds(data.width, data.height);
  clearGroup(terrainRoot);
  const byLetter: Record<string, Array<{ x: number; z: number; top: number }>> = {};
  const treeTrunks: Array<{ x: number; z: number; top: number }> = [];
  const bushes: Array<{ x: number; z: number; top: number }> = [];
  for (let z = 0; z < data.height; z++) {
    const row = data.rows[z] ?? '';
    for (let x = 0; x < data.width; x++) {
      const letter = row[x] ?? '.';
      if (letter === '.') continue;
      (byLetter[letter] ??= []).push({ x, z, top: letter === 'w' ? -.13 : 0 });
      if (letter === 't') treeTrunks.push({ x, z, top: 0 });
      if (letter === 'u') bushes.push({ x, z, top: 0 });
    }
  }
  for (const [letter, locations] of Object.entries(byLetter)) addInstancedTiles(letter, locations);

  // Three crown blocks per tree rather than two, jittered and varied per tile.
  // Every tree used to be the identical pair of cubes on the identical trunk,
  // which is invisible from a plan view and glaring the moment the camera comes
  // down to where people are - a row of copy-pasted broccoli.
  const trunkMesh = new THREE.InstancedMesh(BOX, materials.trunk, treeTrunks.length);
  const crownMesh = new THREE.InstancedMesh(BOX, materials.leaf, treeTrunks.length * 3 + bushes.length);
  crownMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array((treeTrunks.length * 3 + bushes.length) * 3), 3);
  const crownTint = new THREE.Color();
  /** A stable roll per tree, so a tree keeps its shape between rebuilds. */
  const roll = (x: number, z: number, salt: number) => {
    let state = (Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(z + 1, 0x165667b1) ^ salt) >>> 0;
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    return ((state ^ (state >>> 13)) >>> 0) / 4294967296;
  };
  const matrix = new THREE.Matrix4();
  // A tree rooted at sea level on a hillside is the tell that a world is a
  // heightmap with props dropped on it, so everything that grows reads the
  // same ground function the soil under it does.
  treeTrunks.forEach((spot, index) => {
    const base = heightAt(spot.x + .5, spot.z + .5);
    // A tree's whole character is its proportions, and these are the only two
    // numbers that carry it: how tall the trunk runs and how wide the crown
    // sits on top.
    const tall = .78 + roll(spot.x, spot.z, 3) * .62;
    const broad = .86 + roll(spot.x, spot.z, 5) * .38;
    const lean = (roll(spot.x, spot.z, 7) - .5) * .3;
    const trunkTop = base + 1.05 * tall;
    matrix.compose(
      new THREE.Vector3(spot.x + .5, base + 1.05 * tall, spot.z + .5),
      new THREE.Quaternion(), new THREE.Vector3(.3, 2.1 * tall, .3));
    trunkMesh.setMatrixAt(index, matrix);

    const courses: Array<[number, number, number]> = [
      [1.02, 1.68 * broad, .96],
      [1.72, 1.24 * broad, .78],
      [2.28, .68 * broad, .52],
    ];
    courses.forEach(([lift, width, depth], course) => {
      matrix.compose(
        new THREE.Vector3(spot.x + .5 + lean * course, trunkTop + lift * tall, spot.z + .5 + lean * course * .6),
        new THREE.Quaternion(), new THREE.Vector3(width, depth, width));
      crownMesh.setMatrixAt(index * 3 + course, matrix);
      // Each course a shade lighter toward the crown, which is where the light
      // reaches - a single flat green is what makes a canopy read as a cube.
      crownTint.copy(materials.leaf.color)
        .lerp(materials.leafLight.color, course * .34 + roll(spot.x, spot.z, 11) * .2);
      crownMesh.setColorAt(index * 3 + course, crownTint);
    });
  });
  bushes.forEach((spot, index) => {
    const base = heightAt(spot.x + .5, spot.z + .5);
    const size = .62 + roll(spot.x, spot.z, 13) * .34;
    matrix.compose(
      new THREE.Vector3(spot.x + .5, base + size * .6, spot.z + .5),
      new THREE.Quaternion(), new THREE.Vector3(size, size, size));
    crownMesh.setMatrixAt(treeTrunks.length * 3 + index, matrix);
    crownTint.copy(materials.leafLight.color).lerp(materials.leaf.color, roll(spot.x, spot.z, 17));
    crownMesh.setColorAt(treeTrunks.length * 3 + index, crownTint);
  });
  if (crownMesh.instanceColor) crownMesh.instanceColor.needsUpdate = true;
  trunkMesh.instanceMatrix.needsUpdate = true;
  crownMesh.instanceMatrix.needsUpdate = true;
  trunkMesh.castShadow = trunkMesh.receiveShadow = true;
  crownMesh.castShadow = crownMesh.receiveShadow = true;
  terrainRoot.add(trunkMesh, crownMesh);

  // The island replaces the old flat slab: stepped courses of grass, soil
  // and stone falling into a sea that reaches the fog, so the world has a
  // shore instead of an edge.
  clearGroup(islandRoot);
  islandRoot.add(buildIsland(data.width, data.height));

  clearGroup(scatterRoot);
  scatterRoot.add(buildScatter(data.rows, data.width, data.height, DETAIL));

  // What a walker cannot pass through. Trees and water are the map's own
  // refusals; remembering them here is what lets explore mode collide with
  // the world instead of drifting through it.
  solid = new Set<number>();
  for (let z = 0; z < data.height; z++) {
    const row = data.rows[z] ?? '';
    for (let x = 0; x < data.width; x++) {
      const letter = row[x] ?? '.';
      if (letter === 't' || letter === 'w' || letter === '.') solid.add(solidKey(x, z));
    }
  }
  // Weather needs to know how big the world is, and the world only says so
  // when the terrain arrives. Built once; a later expansion widens the map
  // without needing a second sky.
  if (!clouds) clouds = new Clouds(atmosphereRoot, BOX, Math.max(data.width, data.height));
  if (!wildlife) wildlife = new AmbientLife(atmosphereRoot, BOX, Math.max(data.width, data.height));
  clouds.setVisible(view.clouds);
  wildlife.setVisible(view.wildlife);

  builtTerrain = true;
}

function wallRing(group: THREE.Group, build: Build, wall: THREE.Material, height = 2.25) {
  const { x, y: z, w, h } = build;
  const doorX = Math.floor(w / 2);
  addBlock(group, x, .3, z, w, .26, h, materials.stone);
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const edge = dx === 0 || dz === 0 || dx === w - 1 || dz === h - 1;
      if (!edge || (dz === h - 1 && dx === doorX)) continue;
      addBlock(group, x + dx + .05, .56, z + dz + .05, .9, height, .9, wall);
    }
  }
  addBlock(group, x + doorX + .2, .56, z + h - .18, .6, 1.55, .12, materials.darkTimber);
  for (let dx = 1; dx < w - 1; dx += 2) {
    addBlock(group, x + dx + .25, 1.38, z - .03, .5, .62, .08, materials.window);
    if (h > 1) addBlock(group, x + dx + .25, 1.38, z + h - .05, .5, .62, .08, materials.window);
  }
}

/**
 * The stepped roof, kept in its own group so it can be hidden from inside.
 *
 * Registered as it is built rather than found later: a roof that the register
 * missed is a ceiling somebody's face is pressed into, and there is no way to
 * notice that from outside the building.
 */
function steppedRoof(group: THREE.Group, build: Build, roof: THREE.Material, start = 2.72) {
  const shell = new THREE.Group();
  let x = build.x - .18, z = build.y - .18;
  let w = build.w + .36, h = build.h + .36;
  let level = 0;
  while (w > .6 && h > .6 && level < 5) {
    addBlock(shell, x, start + level * .48, z, w, .5, h, roof);
    x += .42; z += .42; w -= .84; h -= .84; level++;
  }
  group.add(shell);
  roofs.push({ build, roof: shell });
}

function flowerBed(group: THREE.Group, x: number, z: number, count: number, accent: number) {
  addBlock(group, x, .02, z, count * .33, .16, .38, materials.dirt);
  const bloom = new THREE.MeshStandardMaterial({ color: accent, roughness: .75 });
  for (let i = 0; i < count; i++) {
    addBlock(group, x + i * .33 + .12, .18, z + .12, .08, .24, .08, materials.leaf);
    addBlock(group, x + i * .33 + .06, .37, z + .06, .2, .16, .2, bloom);
  }
}

function semantic(build: Build) {
  const visual = build.visual ?? {};
  return `${visual.assetId ?? ''} ${visual.kind ?? ''} ${visual.name ?? ''} ${build.structure}`.toLowerCase();
}

function makeHome(group: THREE.Group, build: Build, seed: number) {
  const variants = [materials.plaster, materials.cream, materials.civic];
  wallRing(group, build, variants[seed % variants.length]);
  steppedRoof(group, build, seed % 2 ? materials.roofDark : materials.roof);
  addBlock(group, build.x + .08, .55, build.y + .08, .18, 2.2, build.h - .16, materials.timber);
  addBlock(group, build.x + build.w - .26, .55, build.y + .08, .18, 2.2, build.h - .16, materials.timber);
  addBlock(group, build.x + Math.floor(build.w / 2) + .1, .12, build.y + build.h, .8, .12, 1.3, materials.road);
  flowerBed(group, build.x + .12, build.y + build.h + .2, Math.max(2, Math.min(5, build.w * 2)), seed % 2 ? 0x8b5cf6 : 0xf5c14b);
  if (build.w >= 3) addBlock(group, build.x + build.w - .72, 3.05, build.y + .25, .42, 1.2, .42, materials.stoneDark);
}

function makeCivic(group: THREE.Group, build: Build, kind: string) {
  const wall = kind === 'bank' ? materials.civic : materials.plaster;
  wallRing(group, build, wall, 2.75);
  addBlock(group, build.x - .15, .3, build.y - .15, build.w + .3, .25, build.h + .3, materials.stoneDark);
  for (let x = 0; x < build.w; x += Math.max(1, build.w - 1)) {
    addBlock(group, build.x + x + .18, .55, build.y + build.h - .28, .24, 2.75, .24, materials.stone);
  }
  steppedRoof(group, build, kind === 'bank' ? materials.metal : materials.roofDark, 3.15);
  addBlock(group, build.x + build.w / 2 - .22, 4.05, build.y + build.h / 2 - .22, .44, .65, .44, materials.gold);
}

function makeWorkshop(group: THREE.Group, build: Build) {
  wallRing(group, build, materials.timber, 2.55);
  for (let x = 0; x < build.w; x++) {
    const height = 2.95 + (x % 2) * .48;
    addBlock(group, build.x + x, height, build.y - .12, 1.02, .35, build.h + .24, x % 2 ? materials.glass : materials.roofDark);
  }
  addBlock(group, build.x + .2, .2, build.y + build.h + .05, Math.max(.8, build.w - .4), .14, .8, materials.road);
}

function makeGreenhouse(group: THREE.Group, build: Build) {
  addBlock(group, build.x, .18, build.y, build.w, .25, build.h, materials.stone);
  for (let dx = 0; dx < build.w; dx++) {
    for (const dz of [0, build.h - .15]) addBlock(group, build.x + dx + .08, .5, build.y + dz, .13, 2.2, .13, materials.metal);
  }
  addBlock(group, build.x + .08, .55, build.y + .08, build.w - .16, 1.9, .08, materials.glass);
  addBlock(group, build.x + .08, .55, build.y + build.h - .16, build.w - .16, 1.9, .08, materials.glass);
  addBlock(group, build.x + .08, 2.38, build.y + .08, build.w - .16, .12, build.h - .16, materials.glass);
  for (let x = .35; x < build.w; x += .62) addBlock(group, build.x + x, .35, build.y + .35, .18, .7, Math.max(.2, build.h - .7), materials.leafLight);
}

function makeDataCenter(group: THREE.Group, build: Build) {
  wallRing(group, build, materials.metal, 2.8);
  addBlock(group, build.x - .08, 3.25, build.y - .08, build.w + .16, .42, build.h + .16, materials.stoneDark);
  for (let x = .3; x < build.w - .2; x += .72) {
    addBlock(group, build.x + x, .86, build.y - .04, .36, 1.4, .08, materials.cyan);
  }
  addBlock(group, build.x + .25, 3.72, build.y + .25, .45, .7, .45, materials.cyan);
}

function makeGarden(group: THREE.Group, build: Build) {
  addBlock(group, build.x, .02, build.y, build.w, .12, build.h, materials.grass);
  for (let z = .2; z < build.h - .1; z += .65) flowerBed(group, build.x + .15, build.y + z, Math.max(2, Math.floor((build.w - .3) * 3)), 0xf5c14b + (Math.floor(z * 10) % 2) * 0x3620ad);
  for (let x = 0; x <= build.w; x += Math.max(1, build.w)) addBlock(group, build.x + x - .05, .15, build.y - .08, .1, .65, build.h + .16, materials.timber);
}

function makeBench(group: THREE.Group, build: Build) {
  const x = build.x, z = build.y;
  addBlock(group, x + .08, .38, z + .2, Math.max(.85, build.w - .16), .18, .45, materials.timber);
  addBlock(group, x + .08, .68, z + .52, Math.max(.85, build.w - .16), .55, .14, materials.timber);
  addBlock(group, x + .18, .08, z + .28, .16, .5, .16, materials.darkTimber);
  addBlock(group, x + Math.max(.62, build.w - .34), .08, z + .28, .16, .5, .16, materials.darkTimber);
}

function makeScaffold(group: THREE.Group, build: Build) {
  for (const [x, z] of [[build.x, build.y], [build.x + build.w - .18, build.y], [build.x, build.y + build.h - .18], [build.x + build.w - .18, build.y + build.h - .18]]) {
    addBlock(group, x, .2, z, .18, 3, .18, materials.timber);
  }
  addBlock(group, build.x, 2.92, build.y, build.w, .18, .18, materials.timber);
  addBlock(group, build.x, 2.92, build.y + build.h - .18, build.w, .18, .18, materials.timber);
  addBlock(group, build.x, 2.92, build.y, .18, .18, build.h, materials.timber);
  addBlock(group, build.x + build.w - .18, 2.92, build.y, .18, .18, build.h, materials.timber);
}

/**
 * Crops and homestead fences, rebuilt only when they actually change.
 *
 * Both are cheap to draw and wasteful to redraw: a signature over the facts
 * that matter means a field that ripened re-plants itself and nothing else
 * moves. Farms carry their stage, so the signature must include it.
 */
function buildLivingGround(farms: Farm[], plots: Plot[]) {
  const farmMark = farms.map((f) => `${f.x}:${f.y}:${f.stage}`).join('|');
  if (farmMark !== farmSignature) {
    farmSignature = farmMark;
    clearGroup(farmRoot);
    farmRoot.add(buildFarms(farms, DETAIL));
  }
  const plotMark = plots.filter((p) => p.owned).map((p) => `${p.x}:${p.y}:${p.w}:${p.h}`).join('|');
  if (plotMark !== boundarySignature && terrain) {
    boundarySignature = plotMark;
    clearGroup(boundaryRoot);
    boundaryRoot.add(buildBoundaries(plots, terrain.rows, terrain.width, terrain.height, DETAIL));
  }
}

/**
 * Every roof, with the footprint it covers.
 *
 * A roof is the one part of a building that has to know where you are: stood
 * inside a sealed box, it is a ceiling pressed against your face. Keeping the
 * register here rather than walking the scene graph every frame means the
 * check is a handful of rectangle tests, whatever the town grows to.
 */
const roofs: Array<{ build: Build; roof: THREE.Group }> = [];
const INTERIOR = interiorPalette();

/** Tiles a building's walls occupy, so explore mode collides with them. */
let structureSolid = new Set<number>();

function buildStructures(builds: Build[], venues: Venue[], gate: { x: number; y: number }) {
  clearGroup(structureRoot);
  clearGroup(landmarkRoot);
  structureBatch.clear();
  roofBatch.clear();
  landmarkBatch.clear();
  roofs.length = 0;
  structureSolid = new Set<number>();
  interiorLights = [];
  const chimneys: Array<{ x: number; y: number; z: number }> = [];
  for (const build of builds) {
    const group = new THREE.Group();
    group.userData.build = build;
    // A building cannot follow the ground - it would shear - so it takes one
    // height for its whole footprint and the foundation makes up whatever the
    // hill takes away on the low side.
    const pad = siteHeight(build);
    group.position.y = pad;
    const text = semantic(build);
    const seed = hash(`${build.x}:${build.y}:${text}`);
    // `walled` records what the dispatch already decided: everything built on
    // a wall ring has a door and an inside, and everything else - a garden, a
    // bench, a greenhouse of glass - does not. Asking the dispatch rather than
    // running a second regex over the same string means the two can never
    // disagree about whether a building is a place you can enter.
    let walled = false;
    if (build.state === 'building') makeScaffold(group, build);
    else if (/garden|park|fountain|training/.test(text)) makeGarden(group, build);
    else if (/bench|laptop/.test(text)) makeBench(group, build);
    else if (/greenhouse|orchard/.test(text) && !/home/.test(text)) makeGreenhouse(group, build);
    else if (/data.center|server/.test(text)) { makeDataCenter(group, build); walled = true; }
    else if (/workshop|industry|sawtooth/.test(text)) { makeWorkshop(group, build); walled = true; }
    else if (/bank/.test(text)) { makeCivic(group, build, 'bank'); walled = true; }
    else if (/civic|hall|library|pavilion|rotunda/.test(text)) { makeCivic(group, build, 'hall'); walled = true; }
    else { makeHome(group, build, seed); walled = true; }

    // A finished building is a place, not a prop. Its walls stop a walker, so
    // the doorway is the only way in and the door means something; its inside
    // is furnished, so getting in is worth doing; and its roof steps aside
    // while you are under it, so a room is a room rather than a lid.
    if (walled) {
      for (const tile of wallTiles(build)) structureSolid.add(solidKey(tile.x, tile.y));
      group.add(furnishHome(build, build.buildId ?? `${build.x}:${build.y}`, INTERIOR));
    }
    // The group was only ever scaffolding for assembling the building. Its
    // boxes go into the batch, its hearth-light is put on the leash, and the
    // group itself is dropped before it is ever added to the scene.
    const roofShell = roofs.find((entry) => entry.build === build)?.roof;
    if (roofShell) {
      group.remove(roofShell);
      absorb(roofShell, roofBatch, `roof:${build.buildId ?? `${build.x}:${build.y}`}`);
    }
    const harvested = absorb(group, structureBatch, build.buildId ?? null);
    for (const light of harvested.lights) {
      light.visible = false;
      interiorLights.push(light);
      structureRoot.add(light);
    }
    for (const sprite of harvested.sprites) structureRoot.add(sprite);
    if (walled) {
      // Smoke rises from a chimney, and a chimney belongs to a house that
      // somebody lives in - so an occupied town reads as occupied from the air.
      chimneys.push({ x: build.x + build.w - 0.4, y: 3.6, z: build.y + 0.5 });
    }
  }
  structureBatch.flush();
  roofBatch.flush();
  emissiveCache = null;   // new material clones to find
  wildlife?.setChimneys(chimneys);

  for (const venue of venues) {
    const marker = new THREE.Group();
    addBlock(marker, venue.x + .44, .15, venue.y + .44, .12, 2.4, .12, materials.darkTimber);
    addBlock(marker, venue.x + .56, 1.75, venue.y + .43, .85, .62, .08, materials.roof);
    marker.add(makeLabel(venue.name, '#b4551f', 260, 34, 1.75));
    const label = marker.children[marker.children.length - 1];
    label.position.set(venue.x + .5, 2.95, venue.y + .5);
    const harvested = absorb(marker, landmarkBatch, `venue:${venue.venueId ?? venue.name}`);
    for (const sprite of harvested.sprites) landmarkRoot.add(sprite);
  }

  const gateGroup = new THREE.Group();
  gateGroup.position.y = heightAt(gate.x, gate.y);
  for (const side of [-1, 1]) addBlock(gateGroup, gate.x + side - .25, .05, gate.y + .28, .5, 4.2, .5, materials.obsidian);
  // The lintel spans the posts and no further. It used to run from -1.25 to
  // +1.75 while the posts stood at -1.25 to +1.25, so the arch overhung by
  // half a tile on one side only - the lopsided doorway.
  addBlock(gateGroup, gate.x - 1.45, 3.9, gate.y + .28, 2.9, .55, .5, materials.obsidian);
  addBlock(gateGroup, gate.x - .68, .45, gate.y + .34, 1.36, 3.32, .3, materials.portal);
  const harvestedGate = absorb(gateGroup, landmarkBatch, 'gate');
  for (const sprite of harvestedGate.sprites) landmarkRoot.add(sprite);
  landmarkBatch.flush();
  // The gate keeps a real light of its own. It is the one place in the world
  // that is supposed to glow, and it is always worth the draw.
  const gateLight = new THREE.PointLight(0x4fdcff, 8, 14, 1.8);
  gateLight.position.set(gate.x, 2.3, gate.y + .5);
  landmarkRoot.add(gateLight);
}


/**
 * Every block a citizen bought with their own tokens and set down by hand.
 *
 * Rebuilt only when the set actually changes - a signature compare rather than
 * a clear-and-rebuild every poll, because this runs every two seconds and a
 * town that has been building for a month will have a great many of these.
 */
const BLOCK_MATERIALS: Record<string, THREE.Material> = {
  plank: new THREE.MeshStandardMaterial({ color: 0xa97b4f, roughness: .9 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x9c9a94, roughness: .88 }),
  brick: new THREE.MeshStandardMaterial({ color: 0xa8543c, roughness: .86 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x9ee9e9, roughness: .18, metalness: .1, transparent: true, opacity: .55 }),
  thatch: new THREE.MeshStandardMaterial({ color: 0xc2a555, roughness: .96 }),
  lantern: new THREE.MeshStandardMaterial({ color: 0xffd08a, emissive: 0xffa540, emissiveIntensity: 1.1, roughness: .6 }),
  flowers: new THREE.MeshStandardMaterial({ color: 0x7f9f52, roughness: .92 }),
  path: new THREE.MeshStandardMaterial({ color: 0xb9ae97, roughness: .95 }),
};

function buildPlacedBlocks(blocks: PlacedBlock[]) {
  const signature = blocks.map((block) => `${block.x}:${block.y}:${block.level}:${block.kind}`).sort().join('|');
  if (signature === blockSignature) return;
  blockSignature = signature;
  clearGroup(blockRoot);
  blockSolid = new Set<number>();
  for (const block of blocks) {
    const material = BLOCK_MATERIALS[block.kind] ?? BLOCK_MATERIALS.stone;
    // Lanterns, flower boxes and paving are low things you pass; walls are not.
    // The renderer asks the same rulebook the Kernel asks, so what looks solid
    // and what IS solid can never drift apart.
    const hard = Object.prototype.hasOwnProperty.call(BLOCK_PALETTE, block.kind)
      && blocksWalking(block.kind as BlockMaterial);
    const height = hard ? 1 : block.kind === 'lantern' ? .5 : .16;
    const inset = hard ? .02 : .18;
    const ground = heightAt(block.x + .5, block.y + .5);
    addBlock(blockRoot, block.x + inset, ground + (block.level - 1) + .3, block.y + inset,
      1 - inset * 2, height, 1 - inset * 2, material);
    if (block.kind === 'lantern') {
      const glow = new THREE.PointLight(0xffb457, 2.6, 7, 2);
      glow.position.set(block.x + .5, ground + (block.level - 1) + .95, block.y + .5);
      blockRoot.add(glow);
    }
    if (hard) blockSolid.add(solidKey(block.x, block.y));
  }
}

function makeLabel(text: string, background: string, width = 220, height = 42, worldWidth = 1.9) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, 2.5, width - 5, height - 5);
  ctx.fillStyle = '#fffdf7';
  ctx.font = 'bold 19px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 26), width / 2, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(worldWidth, worldWidth * height / width, 1);
  sprite.renderOrder = 50;
  return sprite;
}

function makeCitizen(row: Citizen): CitizenModel {
  // The body is still assembled exactly as it was, with the same kit that
  // knows how to build a face, a sash, a pickaxe and a surveyor's hat. What
  // changes is where it ends up: each joint is assembled into its own throwaway
  // group, harvested into rig parts, and the groups are dropped. Rewriting the
  // character art as instance data by hand would have lost details nobody would
  // notice were missing until much later.
  const look = lookFor(row.agentId, colorForFamily(row.family).getHex());
  const family = new THREE.MeshStandardMaterial({ color: look.cloth, roughness: .75 });
  const trim = new THREE.MeshStandardMaterial({ color: look.trim, roughness: .8 });
  const skin = new THREE.MeshStandardMaterial({ color: look.skin, roughness: .78 });
  const boot = materials.darkTimber;
  const wide = look.build === 'broad' ? 1.14 : look.build === 'slight' ? .88 : 1;

  const body = new THREE.Group();
  const leftArmGroup = new THREE.Group();
  const rightArmGroup = new THREE.Group();
  const leftLegGroup = new THREE.Group();
  const rightLegGroup = new THREE.Group();

  addBlock(body, -.25 * wide, .75, -.15, .5 * wide, .72, .3, family);
  addBlock(body, -.22, 1.5, -.19, .44, .44, .38, skin);
  addBlock(leftArmGroup, -.39 * wide, .79, -.11, .13, .66, .22, skin);
  addBlock(rightArmGroup, .26 * wide, .79, -.11, .13, .66, .22, skin);
  addBlock(leftLegGroup, -.2, .12, -.11, .17, .64, .22, trim);
  addBlock(rightLegGroup, .03, .12, -.11, .17, .64, .22, trim);
  addBlock(leftLegGroup, -.2, .06, -.17, .17, .14, .3, boot);
  addBlock(rightLegGroup, .03, .06, -.17, .17, .14, .3, boot);
  body.add(makeHair(look), makeFace(look));
  addBlock(body, -.06, 1.12, -.165, .12, .12, .04, materials.window);

  // Facts the Kernel already tracked and no renderer drew: the office a citizen
  // holds, the evidence tier they earned, the tool they were given.
  const office = authorityLook(row.serviceRole);
  if (office) {
    body.add(makeAuthorityDress(office, KIT));
    body.add(makeOfficeSash(row.serviceRole!, KIT));
    const insignia = makeInsignia(office, KIT);
    if (insignia) {
      const offHand = new THREE.Group();
      offHand.position.set(-.32, .5, 0);
      offHand.add(insignia);
      leftArmGroup.add(offHand);
    }
  }
  const tierMark = makeTierMark(row.experienceTier, KIT);
  if (tierMark) body.add(tierMark);

  const toolKey = String(row.activeTool ?? row.carriedTool ?? '');
  const tool = makeTool(row.activeTool ?? row.carriedTool, KIT);
  if (tool) {
    // A hand on the end of the arm, so a carried tool swings with the arm
    // rather than floating alongside the body.
    const hand = new THREE.Group();
    hand.position.set(.32, .5, 0);
    hand.add(tool);
    rightArmGroup.add(hand);
  }

  const parts: Rig['parts'] = [];
  harvest(body, 'body', parts);
  harvest(leftArmGroup, 'leftArm', parts);
  harvest(rightArmGroup, 'rightArm', parts);
  harvest(leftLegGroup, 'leftLeg', parts);
  harvest(rightLegGroup, 'rightLeg', parts);

  const label = makeLabel(row.name, '#1e1e1e');
  label.userData.agentId = row.agentId;
  citizenRoot.add(label);

  return {
    rig: { agentId: row.agentId, parts, scale: look.height },
    row, toolKey, label,
    px: row.tx + .5, pz: row.ty + .5, py: 0, heading: 0, placed: false,
  };
}

function syncCitizens(rows: Citizen[]) {
  const awake = new Set(rows.filter((row) => !row.asleep).map((row) => row.agentId));
  for (const [agentId, model] of citizenModels) {
    if (!awake.has(agentId)) {
      if (model.label) citizenRoot.remove(model.label);
      citizenModels.delete(agentId);
    }
  }
  for (const row of rows) {
    if (row.asleep) continue;
    let model = citizenModels.get(row.agentId);
    if (!model) {
      model = makeCitizen(row);
      citizenModels.set(row.agentId, model);
    }
    // A citizen who picks up or puts down a tool needs a new rig. Rebuilding is
    // cheap and rare, and it keeps the rig a plain immutable list rather than
    // something that has to support surgery.
    const wanted = String(row.activeTool ?? row.carriedTool ?? '');
    if (wanted !== model.toolKey) {
      const carried = { ...model };
      if (model.label) citizenRoot.remove(model.label);
      const rebuilt = makeCitizen(row);
      rebuilt.px = carried.px; rebuilt.pz = carried.pz; rebuilt.py = carried.py;
      rebuilt.heading = carried.heading; rebuilt.placed = carried.placed;
      citizenModels.set(row.agentId, rebuilt);
      model = rebuilt;
    }
    model.row = row;
  }
}

function positionFor(row: Citizen, now: number) {
  const route = row.route;
  if (route && route.length > 1 && now < route[route.length - 1].at) {
    for (let i = 1; i < route.length; i++) {
      if (now <= route[i].at) {
        const a = route[i - 1], b = route[i];
        const t = THREE.MathUtils.clamp((now - a.at) / Math.max(1, b.at - a.at), 0, 1);
        return { x: THREE.MathUtils.lerp(a.x, b.x, t), z: THREE.MathUtils.lerp(a.y, b.y, t), moving: true };
      }
    }
  }
  return { x: row.tx, z: row.ty, moving: false };
}

/**
 * One instanced mesh per surface style, holding every citizen in town.
 *
 * Created once and never rebuilt unless the population outgrows its buffers.
 */
const citizenBatch = new CitizenBatch(citizenRoot, BOX);

/** Reused so posing a crowd allocates nothing per frame. */
const posed: Array<{ rig: Rig; pose: Pose }> = [];

function animateCitizens(elapsed: number, elapsedDelta: number) {
  const now = Date.now() + clockOffset - 140;
  posed.length = 0;
  const eye = camera.position;

  for (const model of citizenModels.values()) {
    const spot = positionFor(model.row, now);
    const targetX = spot.x + .5, targetZ = spot.z + .5;

    // Even with the clock steadied, a citizen can legitimately jump: the Kernel
    // stands them at the gate when they wake, and a stalled poll can land a
    // correction. So the body GLIDES to where the world says it is, unless the
    // gap is bigger than any walk could explain - then it really was a teleport,
    // and snapping is the honest answer.
    const gap = Math.hypot(targetX - model.px, targetZ - model.pz);
    if (!model.placed || gap > 6) {
      model.px = targetX; model.pz = targetZ; model.placed = true;
    } else {
      const ease = Math.min(1, elapsedDelta * 12);
      model.px += (targetX - model.px) * ease;
      model.pz += (targetZ - model.pz) * ease;
    }
    // The ground is no longer a plane, so a citizen's height is read from the
    // same pure function the terrain is built from. Eased, because crossing a
    // flattened building pad is a real step the land itself does not have.
    const ground = heightAt(model.px, model.pz);
    model.py += (ground - model.py) * Math.min(1, elapsedDelta * 9);

    let leftArm = 0, rightArm = 0, leftLeg = 0, rightLeg = 0, lean = 0, bob = 0;

    // A handshake, actually shaken. The Kernel records it as a mutual fact
    // between two citizens standing together; drawing it is what turns that
    // record into something a watcher sees happen.
    const greeting = /shaking hands with (.+)$/.exec(model.row.activity ?? '')?.[1];
    let facing: number | undefined;
    if (greeting) {
      const partner = world?.citizens.find((other) =>
        other.name === greeting && other.agentId !== model.row.agentId);
      const body = partner ? citizenModels.get(partner.agentId) : undefined;
      if (body) facing = Math.atan2(body.px - model.px, body.pz - model.pz);
      rightArm = -(0.9 + Math.sin(elapsed * 5) * 0.12);
    } else if (spot.moving) {
      const swing = Math.sin(elapsed * 8 + hash(model.row.agentId) % 10) * .55;
      leftArm = swing; rightArm = -swing;
      leftLeg = -swing * .65; rightLeg = swing * .65;
      bob = Math.abs(Math.sin(elapsed * 8)) * .035;
    } else {
      // Standing still is not one pose. A citizen mid-task swings the tool they
      // are actually holding, at the tempo that task deserves; everyone else
      // breathes.
      const busy = (model.row.workingUntil ?? 0) > Date.now() || (model.row.buildingUntil ?? 0) > Date.now();
      const motion = toolMotion(model.row.activeTool ?? model.row.carriedTool, busy);
      if (motion) {
        const swing = Math.sin(elapsed * motion.speed + hash(model.row.agentId) % 7);
        rightArm = -Math.abs(swing) * motion.amplitude;
        leftArm = Math.abs(swing) * motion.amplitude * .3;
        lean = Math.abs(swing) * motion.lean * .12;
      } else {
        const breathe = Math.sin(elapsed * 2 + hash(model.row.name) % 6) * .035;
        leftArm = breathe; rightArm = -breathe;
      }
    }

    // Face the way you are going, so a walking crowd does not moonwalk - or
    // face whoever's hand you are taking, which outranks it.
    if (facing === undefined && spot.moving && gap > 0.01) {
      facing = Math.atan2(targetX - model.px, targetZ - model.pz);
    }
    if (facing !== undefined && Number.isFinite(facing)) {
      let delta = facing - model.heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      model.heading += delta * .18;
    }

    posed.push({
      rig: model.rig,
      pose: {
        x: model.px, y: model.py + bob, z: model.pz,
        heading: model.heading, leftArm, rightArm, leftLeg, rightLeg, lean,
        scale: model.rig.scale,
      },
    });

    // A nameplate is worth a draw call each, and twenty floating labels over a
    // town you are looking at from above is a roster, not a view. They fade in
    // when you are close enough to care who somebody is.
    if (model.label) {
      const near = view.nameplates
        && eye.distanceTo(new THREE.Vector3(model.px, model.py + 1, model.pz)) < view.nameplateRange;
      model.label.visible = near;
      if (near) model.label.position.set(model.px, model.py + 2.52 * model.rig.scale, model.pz);
    }
  }

  citizenBatch.render(posed);
}

/**
 * Put the camera on a spot.
 *
 * Lower and closer than it used to sit. The old default looked down from a
 * height that rendered the citizens - the entire subject of this world - as
 * three-pixel specks, which is a plan view of a town rather than a view of one.
 */
function focusAt(x: number, z: number, distance = 12) {
  if (exploreMode) firstPerson.unlock();
  const ground = heightAt(x, z);
  orbit.target.set(x, ground + .9, z);
  camera.position.set(x + distance * .62, ground + Math.max(3.4, distance * .52), z + distance * .82);
  orbit.update();
}

function focusCitizen(agentId: string, open = true) {
  const model = citizenModels.get(agentId);
  const row = world?.citizens.find((citizen) => citizen.agentId === agentId);
  if (!row) return;
  selectedAgentId = agentId;
  // The body no longer lives in the scene graph, so its drawn position comes
  // off the model rather than off a Group's transform.
  const x = model ? model.px : row.tx + .5;
  const z = model ? model.pz : row.ty + .5;
  focusAt(x, z, 7.5);
  if (open) renderProfile(row);
}

function renderProfile(row: Citizen) {
  const live = row.online ? 'LIVE NOW' : row.asleep ? 'SLEEPING BEYOND THE GATE' : 'AMBIENT';
  profile.innerHTML = '';
  const header = document.createElement('header');
  header.className = 'panel-header';
  const title = document.createElement('h3');
  title.textContent = row.name;
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'panel-min'; close.textContent = '×'; close.setAttribute('aria-label', 'Close citizen profile');
  close.onclick = () => { profile.classList.remove('open'); selectedAgentId = null; };
  header.append(title, close);
  const main = document.createElement('div');
  main.className = 'profile-main';
  const id = document.createElement('div'); id.className = 'profile-id'; id.textContent = row.agentId;
  const grid = document.createElement('div'); grid.className = 'profile-grid';
  for (const value of [row.serviceRole ?? row.family, live, `tile ${Math.round(row.tx)}, ${Math.round(row.ty)}`, row.experienceTier ?? 'verified citizen']) {
    const chip = document.createElement('div'); chip.className = 'profile-chip'; chip.textContent = value; grid.append(chip);
  }
  const activity = document.createElement('div'); activity.className = 'profile-activity'; activity.textContent = row.activity || 'Taking in the world.';
  const actions = document.createElement('div'); actions.className = 'profile-actions';
  const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = 'LOCATE'; locate.onclick = () => focusCitizen(row.agentId, false);
  const dashboard = document.createElement('button'); dashboard.type = 'button'; dashboard.textContent = 'PROFILE ↗'; dashboard.onclick = () => location.href = `https://agentsearth.com/?agent=${encodeURIComponent(row.agentId)}`;
  actions.append(locate, dashboard);

  // Offering a hand, while you are the one holding the wheel.
  //
  // Only ever an OFFER. The other citizen's own agent decides whether to take
  // it, which is the whole reason a handshake is worth recording: it is the one
  // social fact in Earth that nobody can create alone. The button appears only
  // when you are driving, it is not your own citizen, and they are awake -
  // three conditions the Kernel re-checks anyway, shown here so the button is
  // never a lie about what will happen when you press it.
  if (driving && row.agentId !== drivenAgentId && row.online) {
    const shake = document.createElement('button');
    shake.type = 'button';
    shake.textContent = '🤝 SHAKE HANDS';
    shake.onclick = async () => {
      shake.disabled = true;
      const answer = await kernelPost('/v1/takeover/greet', { agentId: row.agentId });
      shake.disabled = false;
      if (!answer.ok) { toast(answer.why || 'that greeting was refused'); return; }
      toast(answer.shaken
        ? `You and ${answer.name} shook hands.`
        : `You offered a hand to ${answer.name}. It is theirs to take.`);
    };
    actions.append(shake);
  }
  main.append(id, grid, activity, actions);
  profile.append(header, main);
  profile.classList.add('open');

  if (window.parent !== window) {
    const message = { type: 'earth-profile', citizen: { ...row, current: { x: row.tx, y: row.ty } } };
    window.parent.postMessage(message, 'https://agentsearth.com');
    window.parent.postMessage(message, 'https://agentsearth-home.vercel.app');
  }
}

function renderDirectory() {
  if (!world) return;
  const query = (required<HTMLInputElement>('citizen-search').value || '').trim().toLowerCase();
  const category = required<HTMLSelectElement>('citizen-category').value;
  const liveOnly = required<HTMLInputElement>('citizen-live').checked;
  const rows = world.citizens.filter((row) => {
    const haystack = `${row.name} ${row.agentId} ${row.family} ${row.serviceRole ?? ''} ${(row.specialties ?? []).join(' ')}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (!category || row.family === category || row.specialties?.includes(category))
      && (!liveOnly || row.online)
      && (!authorityOnly || Boolean(row.serviceRole));
  }).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  citizenList.replaceChildren(...rows.map((row) => {
    const button = document.createElement('button');
    button.className = 'citizen-row'; button.type = 'button';
    const swatch = document.createElement('span'); swatch.className = 'citizen-swatch'; swatch.style.background = `#${colorForFamily(row.family).getHexString()}`;
    const copy = document.createElement('span');
    const name = document.createElement('b'); name.textContent = row.name;
    const meta = document.createElement('span'); meta.className = 'citizen-meta'; meta.textContent = `${row.serviceRole ?? row.family} · ${row.activity || 'idle'}`;
    copy.append(name, meta);
    const state = document.createElement('span'); state.className = `citizen-state ${row.online ? 'live' : 'sleep'}`; state.textContent = row.online ? 'LIVE' : row.asleep ? 'ZZZ' : 'HERE';
    button.append(swatch, copy, state);
    button.onclick = () => focusCitizen(row.agentId);
    return button;
  }));
  required('awake-chip').textContent = `Awake ${world.citizens.filter((row) => !row.asleep).length}`;
  required('authority-chip').textContent = `Authorities ${world.citizens.filter((row) => row.serviceRole).length}`;
}

function renderChat() {
  if (!world) return;
  // One conversation, one card. The feed used to list every speaker, so two
  // people talking to each other appeared as two live chats about the same
  // exchange and a group of four appeared as four. Grouping follows the
  // chain of who is talking to whom, so a knot of three is one card.
  const conversations = groupConversations(world.citizens, Date.now());
  required('chat-count').textContent = conversations.length
    ? `${conversations.length} LIVE` : '';
  const dot = conversation.querySelector('.conversation-live-dot');
  dot?.classList.toggle('quiet', !conversations.length);

  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No live conversation right now. Nothing opens automatically.';
    conversationBody.replaceChildren(empty);
    return;
  }

  conversationBody.replaceChildren(...conversations.map((talk) => {
    const card = document.createElement('div');
    card.className = 'chat-card' + (talk.group ? ' group' : '');
    card.dataset.conversation = talk.id;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'chat-row';
    head.innerHTML = '<b></b><span></span>';
    head.querySelector('b')!.textContent =
      (talk.group ? `👥 ${conversationTitle(talk)}` : conversationTitle(talk));
    head.querySelector('span')!.textContent = conversationSubtitle(talk);

    // Tapping opens the card in place rather than jumping the camera: a
    // reader following a conversation should not lose their view of it.
    const detail = document.createElement('div');
    detail.className = 'chat-detail';
    detail.hidden = !openConversations.has(talk.id);
    for (const member of talk.members) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'chat-member';
      line.innerHTML = '<i></i><b></b><span></span>';
      (line.querySelector('i') as HTMLElement).style.background =
        `#${colorForFamily(member.family).getHexString()}`;
      line.querySelector('b')!.textContent = member.name;
      line.querySelector('span')!.textContent = member.activity || 'in this conversation';
      line.onclick = (event) => { event.stopPropagation(); focusCitizen(member.agentId); };
      detail.append(line);
    }
    head.onclick = () => {
      if (openConversations.has(talk.id)) openConversations.delete(talk.id);
      else openConversations.add(talk.id);
      detail.hidden = !openConversations.has(talk.id);
      card.classList.toggle('open', openConversations.has(talk.id));
    };
    card.classList.toggle('open', openConversations.has(talk.id));
    card.append(head, detail);
    return card;
  }));
}

function updateHud() {
  if (!world) return;
  required('m-live').textContent = String(world.citizens.filter((row) => row.online).length);
  required('m-joined').textContent = String(world.citizens.length);
  required('m-builds').textContent = String(world.builds.length + world.venues.length);
  // The land, and how close it is to growing. The Kernel expands the world on
  // its own when the town runs short of room; showing the occupancy that
  // triggers it turns a ring appearing out of nowhere into something a
  // watcher saw coming.
  const growth = world.growth;
  const boundary = document.getElementById('boundary');
  if (boundary && growth) {
    const close = growth.occupancy >= growth.expandsAtOccupancy - 15 || growth.headroom <= 5;
    boundary.textContent = `Ring ${growth.generation} · ${growth.size.width}×${growth.size.height} tiles`
      + ` · ${growth.ownedPlots}/${growth.plots} parcels settled`
      + (close ? ' · the land is about to grow' : '');
    boundary.classList.toggle('growing', close);
  }
  renderDirectory();
  renderChat();
  if (selectedAgentId) {
    const selected = world.citizens.find((row) => row.agentId === selectedAgentId);
    if (selected) renderProfile(selected);
  }
}

async function refreshTerrain() {
  const response = await fetch(`${KERNEL}/v1/world/terrain`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`terrain ${response.status}`);
  terrain = await response.json() as Terrain;
  if (!builtTerrain) buildTerrain(terrain);
}

async function refreshState() {
  const response = await fetch(`${KERNEL}/v1/world/state`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`state ${response.status}`);
  const next = await response.json() as WorldState;
  if (!next.ok) throw new Error('world state rejected');
  world = next;
  // THE JITTER FIX. serverNow is stamped when the Kernel builds the reply;
  // Date.now() is when this browser receives it. The difference is the true
  // clock skew MINUS however long that particular response spent on the wire,
  // and that varies by hundreds of milliseconds poll to poll. Recomputing it
  // raw every two seconds shoved the interpolation clock back and forth by
  // that much, so every walking citizen lurched - here one instant, somewhere
  // else the next.
  //
  // The least-delayed sample is the closest to the truth, so keep the largest
  // offset seen and let it decay slowly. A genuine clock correction is still
  // followed within a minute; network noise is simply ignored.
  const sample = next.serverNow - Date.now();
  clockOffset = clockOffset === 0 ? sample : Math.max(sample, clockOffset - 8);
  syncCitizens(next.citizens);
  const signature = JSON.stringify([next.builds, next.venues, next.gate]);
  if (signature !== structureSignature) {
    structureSignature = signature;
    buildStructures(next.builds, next.venues, next.gate);
    buildPlacedBlocks(next.blocks ?? []);
  }
  buildLivingGround(next.farms ?? [], next.plots ?? []);
  updateHud();
  (window as unknown as Record<string, unknown>).__voxelWorld = {
    ready: true, citizens: next.citizens.length, awake: citizenModels.size,
    builds: next.builds.length, terrain: Boolean(terrain), renderer: 'three-webgl-voxel-v1',
    farms: (next.farms ?? []).length, fencedPlots: (next.plots ?? []).filter((plot) => plot.owned).length,
    tools: next.citizens.filter((row) => row.carriedTool || row.activeTool).length,
    // What is actually IN the scene, not merely in the payload. Counting the
    // instances is the only way to tell "the data arrived" from "the world
    // drew it", and those failed separately more than once while building it.
    drawn: {
      scatter: scatterRoot.children.reduce((sum, node) => sum + node.children.length, 0),
      farmMeshes: farmRoot.children.reduce((sum, node) => sum + node.children.length, 0),
      fenceMeshes: boundaryRoot.children.reduce((sum, node) => sum + node.children.length, 0),
      island: islandRoot.children.reduce((sum, node) => sum + node.children.length, 0),
      instances: scatterRoot.children.flatMap((node) => node.children)
        .reduce((sum, node) => sum + ((node as THREE.InstancedMesh).count ?? 0), 0),
    },
  };
  document.documentElement.dataset.worldRenderer = 'three-webgl-voxel-v1';
  document.documentElement.dataset.worldReady = 'true';
  document.documentElement.dataset.worldCitizens = String(next.citizens.length);
  document.documentElement.dataset.worldBuilds = String(next.builds.length);
}

async function refreshFeed() {
  try {
    const response = await fetch(`${KERNEL}/v1/feed?limit=6`, { headers: { Accept: 'application/json' } });
    const payload = await response.json() as { feed?: Array<{ gloss?: string }> };
    const lines = (payload.feed ?? []).map((row) => {
      const p = document.createElement('p'); p.textContent = row.gloss || 'The world changed.'; return p;
    });
    required('feedLines').replaceChildren(...lines);
  } catch { /* keep the last honest feed */ }
}

async function refreshWallet() {
  try {
    const response = await fetch('/api/wallet', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json() as { ok?: boolean; balance?: number };
    if (payload.ok && Number.isFinite(payload.balance)) {
      required('wallet-balance').textContent = String(payload.balance);
      // The palette greys out what this purse cannot afford, so it has to know
      // the balance rather than only display it.
      walletBalance = payload.balance!;
      if (driving) renderPalette();
    }
  } catch { /* spectators truthfully keep a dash */ }
}

async function boot() {
  try {
    await Promise.all([refreshTerrain(), refreshState(), refreshFeed(), refreshWallet()]);
    loading.classList.add('done');
    if (terrain) {
      // Open on the town, low and close.
      //
      // The old default looked down from a height that rendered the citizens -
      // the entire subject of this world - as three-pixel specks. That is a
      // plan view of a place rather than a view of one, and it is most of why
      // the world read as a diagram. Dropping the camera also puts sky in the
      // frame, which a top-down view never has.
      const heart = { x: Math.min(38, terrain.width / 2), z: Math.min(28, terrain.height / 2) };
      focusAt(heart.x, heart.z, 26);
    }
    const pending = new URLSearchParams(location.search).get('goto');
    if (pending?.startsWith('agent:')) focusCitizen(pending);
    else if (ownerAgentId) { findMe.style.display = 'block'; }
  } catch (error) {
    loading.querySelector('strong')!.textContent = 'THE WORLD WINDOW IS RETRYING';
    loading.querySelector('span')!.textContent = error instanceof Error ? error.message : 'Kernel unavailable';
    window.setTimeout(() => void boot(), 5000);
  }
}

function enterExplore() {
  if (!world) return;
  exploreMode = true;
  orbit.enabled = false;
  const target = orbit.target;
  camera.position.set(target.x, EYE, target.z + 3.5);
  verticalSpeed = 0;
  onGround = true;
  camera.lookAt(target.x, 1.4, target.z - 2);
  firstPerson.lock();
}

function leaveExplore() {
  exploreMode = false;
  orbit.enabled = true;
  orbit.target.set(camera.position.x, .7, camera.position.z - 7);
  modeToggle.textContent = '◈ EXPLORE';
  modeToggle.setAttribute('aria-pressed', 'false');
  modeToggle.setAttribute('aria-label', 'Enter first-person explore mode');
  reticle.classList.remove('active');
  applyDragStyle();
}

document.getElementById('grab-toggle')?.addEventListener('click', () => {
  dragStyle = dragStyle === 'grab' ? 'orbit' : 'grab';
  applyDragStyle();
});
applyDragStyle();

modeToggle.onclick = () => exploreMode ? firstPerson.unlock() : enterExplore();
firstPerson.addEventListener('lock', () => {
  modeToggle.textContent = '× EXIT EXPLORE';
  modeToggle.setAttribute('aria-pressed', 'true');
  modeToggle.setAttribute('aria-label', 'Exit first-person explore mode');
  reticle.classList.add('active');
  required('control-copy').textContent = 'WASD to walk · Shift to run · Space to jump · mouse to look · Esc to exit';
});
firstPerson.addEventListener('unlock', leaveExplore);

addEventListener('keydown', (event) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement)?.tagName ?? '')) return;
  keys.add(event.code);
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code) && exploreMode) event.preventDefault();
  // G swaps how left-drag behaves without hunting for the button, and F
  // drops you straight into the world from wherever you are looking.
  if (!exploreMode && event.code === 'KeyG') {
    dragStyle = dragStyle === 'grab' ? 'orbit' : 'grab';
    applyDragStyle();
    toast(dragStyle === 'grab' ? 'Left-drag now grabs the ground' : 'Left-drag now orbits');
  }
  if (event.code === 'KeyF' && !exploreMode) enterExplore();
  if (event.code === 'Escape' && driving) void letGo();
  if (driving) {
    // While driving, WASD walks the BODY rather than the camera - the whole
    // point of holding the wheel.
    const dx = (event.code === 'KeyD' ? 1 : 0) - (event.code === 'KeyA' ? 1 : 0);
    const dy = (event.code === 'KeyS' ? 1 : 0) - (event.code === 'KeyW' ? 1 : 0);
    if (dx || dy) {
      event.preventDefault();
      void driveStep(dx, dy);
    }
  }
});
addEventListener('keyup', (event) => keys.delete(event.code));

/** Standing height, and how close a walker may get to something solid. */
const EYE = 1.72;
const BODY = .34;
let verticalSpeed = 0;
let onGround = true;
let stepPhase = 0;

/** Would a body at this spot be inside a tree, the water, or the void? */
function blocked(x: number, z: number) {
  if (!terrain) return false;
  for (const [ox, oz] of [[BODY, 0], [-BODY, 0], [0, BODY], [0, -BODY]]) {
    const tx = Math.floor(x + ox), tz = Math.floor(z + oz);
    if (tx < 0 || tz < 0 || tx >= terrain.width || tz >= terrain.height) return true;
    // Terrain the map itself refuses, walls a building put up, and blocks a
    // citizen paid for and set down. All three are equally real to walk into.
    if (solid.has(solidKey(tx, tz))) return true;
    if (structureSolid.has(solidKey(tx, tz))) return true;
    if (blockSolid.has(solidKey(tx, tz))) return true;
  }
  return false;
}

/**
 * Walking, with a body.
 *
 * The first version flew: it clamped to the map edge and otherwise passed
 * through trees, buildings and the river, and held the camera at a fixed
 * height whatever it walked over. That is a spectator drone, not exploring.
 * Now there is gravity, a jump, a step you can hear in the bob of the view,
 * and each axis is tested separately so brushing a wall slides along it
 * rather than stopping you dead.
 */
function moveFirstPerson(delta: number) {
  if (!exploreMode || !firstPerson.isLocked || !terrain) return;
  const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = (sprinting ? 9.5 : 4.6) * delta;

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

  const step = new THREE.Vector3();
  if (keys.has('KeyW')) step.add(forward);
  if (keys.has('KeyS')) step.sub(forward);
  if (keys.has('KeyD')) step.add(right);
  if (keys.has('KeyA')) step.sub(right);
  if (step.lengthSq() > 0) step.normalize().multiplyScalar(speed);

  // Axis at a time: a walker who clips a corner should slide past it, which
  // is the difference between exploring and getting stuck on scenery.
  const fromX = camera.position.x, fromZ = camera.position.z;
  if (step.x !== 0 && !blocked(fromX + step.x, fromZ)) camera.position.x += step.x;
  if (step.z !== 0 && !blocked(camera.position.x, fromZ + step.z)) camera.position.z += step.z;

  if (keys.has('Space') && onGround) {
    verticalSpeed = 5.6;
    onGround = false;
  }
  verticalSpeed -= 15.5 * delta;
  let height = camera.position.y + verticalSpeed * delta;
  // The floor follows the land now. Walking a hill has to raise the walker, or
  // the ground rises past the camera and you end up wading through a meadow.
  const floor = EYE + heightAt(camera.position.x, camera.position.z);
  if (height <= floor) {
    height = floor;
    verticalSpeed = 0;
    onGround = true;
  }
  // The head bob: small, tied to real distance covered, and absent when
  // standing still. It is most of what makes walking feel like walking.
  if (onGround && step.lengthSq() > 0) {
    stepPhase += speed * 3.4;
    height += Math.sin(stepPhase) * (sprinting ? .055 : .035);
  }
  camera.position.y = height;
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, .7, terrain.width - .7);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, .7, terrain.height - .7);
}

renderer.domElement.addEventListener('pointerup', (event) => {
  if (exploreMode || event.button !== 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // Instanced picking. A citizen is no longer a Mesh with an id hung off it -
  // they are a run of instances inside a shared buffer - so the hit gives back
  // an instance index and the batch says whose it is.
  const hit = raycaster.intersectObjects(citizenBatch.pickables, false)[0];
  const agentId = hit ? CitizenBatch.agentAt(hit) : null;
  if (agentId) focusCitizen(agentId);
});

for (const id of ['citizen-search', 'citizen-category', 'citizen-live']) {
  document.getElementById(id)?.addEventListener('input', renderDirectory);
}
for (const id of ['directory-everyone', 'directory-authorities']) {
  document.getElementById(id)?.addEventListener('click', () => {
    authorityOnly = id === 'directory-authorities';
    required('directory-everyone').setAttribute('aria-pressed', String(!authorityOnly));
    required('directory-authorities').setAttribute('aria-pressed', String(authorityOnly));
    renderDirectory();
  });
}

document.querySelectorAll<HTMLButtonElement>('.panel-min[data-for]').forEach((button) => {
  button.onclick = () => {
    const panel = document.getElementById(button.dataset.for || '');
    if (!panel) return;
    const minimized = panel.classList.toggle('min');
    const name = panel.id === 'directory' ? 'community directory' : 'world activity';
    button.textContent = minimized ? '+' : '−';
    button.setAttribute('aria-expanded', String(!minimized));
    button.setAttribute('aria-label', `${minimized ? 'Expand' : 'Minimize'} ${name}`);
  };
});

required<HTMLButtonElement>('chat-toggle').onclick = () => {
  const minimized = conversation.classList.toggle('minimized');
  const button = required<HTMLButtonElement>('chat-toggle');
  button.textContent = minimized ? '+' : '−';
  button.setAttribute('aria-expanded', String(!minimized));
  button.setAttribute('aria-label', minimized ? 'Expand live chat' : 'Minimize live chat');
};

findMe.onclick = () => {
  if (ownerAgentId && world?.citizens.some((row) => row.agentId === ownerAgentId)) focusCitizen(ownerAgentId);
  else toast('Connect your agent from the dashboard to use Find Me.');
};

window.addEventListener('message', (event) => {
  if (!OWNER_DASHBOARD_ORIGINS.has(event.origin) || !event.data) return;
  if (event.data.type === 'earth-owner-agent' && typeof event.data.agentId === 'string') {
    ownerAgentId = event.data.agentId;
    findMe.style.display = 'block';
  } else if (event.data.type === 'earth-focus-agent' && typeof event.data.agentId === 'string') {
    ownerAgentId = event.data.agentId;
    findMe.style.display = 'block';
    focusCitizen(event.data.agentId);
  } else if (event.data.type === 'earth-wallet' && Number.isFinite(event.data.balance)) {
    required('wallet-balance').textContent = String(event.data.balance);
  }
});

if (matchMedia('(max-width: 768px)').matches) {
  directory.classList.add('min');
  const button = directory.querySelector<HTMLButtonElement>('.panel-min');
  if (button) { button.textContent = '+'; button.setAttribute('aria-expanded', 'false'); }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
});

/**
 * WASD moves the camera over the town in orbit mode too.
 *
 * Dragging is fine for a nudge and terrible for crossing a world. The same
 * keys that walk in explore mode fly the overhead view, which means one set
 * of habits works everywhere instead of two.
 */
function panOverhead(delta: number) {
  if (exploreMode || !terrain) return;
  const speed = (keys.has('ShiftLeft') ? 42 : 18) * delta;
  const step = new THREE.Vector3();
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) return;
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  if (keys.has('KeyW')) step.add(forward);
  if (keys.has('KeyS')) step.sub(forward);
  if (keys.has('KeyD')) step.add(right);
  if (keys.has('KeyA')) step.sub(right);
  if (step.lengthSq() === 0) return;
  step.normalize().multiplyScalar(speed);
  camera.position.add(step);
  orbit.target.add(step);
  orbit.target.x = THREE.MathUtils.clamp(orbit.target.x, -20, terrain.width + 20);
  orbit.target.z = THREE.MathUtils.clamp(orbit.target.z, -20, terrain.height + 20);
}


/* ── Taking the wheel ──────────────────────────────────────────────────────
   The bond this whole world rests on, made physical: an owner steps into
   their agent's body, walks it, and steps out, after which the agent picks up
   its own life from wherever the body now stands.

   The browser never moves anything itself. Every step is a request the Kernel
   validates against the same walkability an autonomous citizen obeys, so a
   driven body cannot go anywhere an agent could not have walked. What the
   client owns is the camera, the keys, and the honesty of showing whose hands
   are on the wheel. */

let driving = false;
let drivenAgentId: string | null = null;
let stepPending = false;
let lastStepAt = 0;
/** One step per this many ms: a walk, not a stutter of held-key requests. */
const STEP_INTERVAL = 300;

const takeoverButton = document.getElementById('takeover') as HTMLButtonElement | null;
const drivingBanner = (() => {
  const node = document.createElement('div');
  node.className = 'driving-banner';
  node.setAttribute('role', 'status');
  document.body.append(node);
  return node;
})();

/** The Kernel's owner paths, rewritten to this world's own proxy. */
function ownerRoute(path: string) {
  return path.replace(/^\/v1\/takeover\//, '/api/takeover/');
}

/**
 * Ask the Kernel for something on the owner's behalf, through this world's own
 * origin.
 *
 * Not `${KERNEL}${path}`. The Kernel's owner endpoints send no CORS headers, so
 * a credentialed call straight from the page is refused by the browser before
 * it is ever sent - which is why taking the wheel passed every CLI check and
 * did nothing at all when a person clicked the button. The same-origin route
 * holds the HttpOnly cookie and forwards it, exactly as the wallet read does.
 */
async function kernelPost(path: string, body?: unknown) {
  const response = await fetch(ownerRoute(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return await response.json().catch(() => ({ ok: false, why: 'unreadable reply' }));
}

function showDriving(on: boolean, name?: string) {
  driving = on;
  drivingBanner.classList.toggle('on', on);
  drivingBanner.textContent = on
    ? `🎮 You are walking ${name ?? 'your citizen'} · WASD to walk · Esc to let go`
    : '';
  if (takeoverButton) {
    takeoverButton.textContent = on ? '× LET GO' : '🎮 TAKE THE WHEEL';
    takeoverButton.setAttribute('aria-pressed', String(on));
  }
  showBuildTray(on);
  const copy = document.getElementById('control-copy');
  if (copy && on) copy.textContent = 'WASD walks · click ground to build · Esc to let go';
  else if (copy && !exploreMode) applyDragStyle();
}

async function takeTheWheel() {
  const answer = await kernelPost('/v1/takeover/take');
  if (!answer.ok) {
    toast(answer.why || 'Connect your agent on the dashboard first.');
    return;
  }
  drivenAgentId = answer.agentId;
  ownerAgentId = answer.agentId;
  showDriving(true, answer.name);
  focusCitizen(answer.agentId, false);
  toast(`You have the wheel. ${answer.name} walks where you walk.`);
}

async function letGo() {
  if (!driving) return;
  showDriving(false);
  const held = drivenAgentId;
  drivenAgentId = null;
  await kernelPost('/v1/takeover/release');
  if (held) toast('Wheel released. Your agent carries on from here.');
}

/**
 * One step, requested from the Kernel.
 *
 * Rate limited on this side purely so a held key does not queue a hundred
 * requests; the Kernel refuses anything illegal regardless, which is what
 * makes this safe rather than merely tidy.
 */
async function driveStep(dx: number, dy: number) {
  if (!driving || stepPending || !drivenAgentId || !world) return;
  const now = performance.now();
  if (now - lastStepAt < STEP_INTERVAL) return;
  const me = world.citizens.find((row) => row.agentId === drivenAgentId);
  if (!me) return;
  lastStepAt = now;
  stepPending = true;
  try {
    const answer = await kernelPost('/v1/takeover/step', {
      x: Math.round(me.tx) + dx, y: Math.round(me.ty) + dy,
    });
    // A refusal is information, not a failure: the world just told you there
    // is a wall there. Only surface the ones a walker would not expect.
    if (!answer.ok && !/solid|already standing|edge of the world/.test(String(answer.why))) {
      toast(answer.why || 'that step was refused');
    }
    if (answer.ok) {
      // Move the camera with the body straight away rather than waiting for
      // the next poll: two seconds of lag between key and view feels broken
      // even though the world is perfectly correct.
      orbit.target.set(answer.x + .5, .9, answer.y + .5);
    }
  } finally {
    stepPending = false;
  }
}

/** The wheel lapses on the Kernel's clock; renew it while somebody is here. */
window.setInterval(() => {
  if (driving) void kernelPost('/v1/takeover/take');
}, 20_000);

/** Offer the wheel only to somebody the world recognises as an owner. */
async function refreshTakeoverOffer() {
  try {
    const response = await fetch(ownerRoute('/v1/takeover/status'), { credentials: 'include' });
    const status = await response.json();
    if (!status.ok) {
      if (takeoverButton) takeoverButton.hidden = true;
      return;
    }
    if (takeoverButton) takeoverButton.hidden = false;
    ownerAgentId = status.agentId;
    drivenAgentId = status.driving ? status.agentId : drivenAgentId;
    if (status.driving !== driving) showDriving(status.driving, status.name);
  } catch {
    if (takeoverButton) takeoverButton.hidden = true;
  }
}

takeoverButton?.addEventListener('click', () => void (driving ? letGo() : takeTheWheel()));
window.setInterval(() => void refreshTakeoverOffer(), 15_000);
void refreshTakeoverOffer();


/* ── Spending tokens on the world ──────────────────────────────────────────
   Earth Tokens were a number on a badge. Every way to earn them was real -
   verified gifts, accepted skills, a day's public work - and there was almost
   nothing to spend them on that you could see afterwards. A currency you can
   only accumulate is a scoreboard.

   So: pick a material, click your own ground, and the block is there. It cost
   what the palette says it costs, the Treasury has it, and it will still be
   there tomorrow. The rules that decide whether the click is allowed live in
   the Kernel and are the same ones an autonomous agent obeys, so this tray is
   a way to ASK, never a way to bypass. */

let chosenMaterial: BlockMaterial = 'plank';
let walletBalance = 0;
let buildPending = false;

const buildTray = document.getElementById('buildtray') as HTMLElement | null;
const paletteHost = document.getElementById('palette') as HTMLElement | null;

const SWATCH: Record<string, string> = {
  plank: '#a97b4f', stone: '#9c9a94', brick: '#a8543c', glass: '#9ee9e9',
  thatch: '#c2a555', lantern: '#ffd08a', flowers: '#7f9f52', path: '#b9ae97',
};

function renderPalette() {
  if (!paletteHost) return;
  paletteHost.replaceChildren(...Object.entries(BLOCK_PALETTE).map(([kind, spec]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(kind === chosenMaterial));
    // Priced in the button, and disabled when you cannot afford it: finding out
    // what something costs by being refused is a worse way to learn it.
    button.disabled = walletBalance < spec.price;
    button.title = button.disabled
      ? `${spec.label} costs ${spec.price} and you hold ${walletBalance}`
      : `${spec.label} · ${spec.price} Earth Tokens`;
    const swatch = document.createElement('i');
    swatch.style.background = SWATCH[kind] ?? '#9c9a94';
    const name = document.createElement('span');
    name.textContent = spec.label;
    const price = document.createElement('em');
    price.textContent = String(spec.price);
    button.append(swatch, name, price);
    button.onclick = () => { chosenMaterial = kind as BlockMaterial; renderPalette(); };
    return button;
  }));
}

function showBuildTray(on: boolean) {
  if (buildTray) buildTray.hidden = !on;
  if (on) renderPalette();
}

/** The ground tile under a click, found by intersecting the y = 0.3 plane. */
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);
function tileUnderPointer(event: PointerEvent): { x: number; y: number } | null {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const caster = new THREE.Raycaster();
  caster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!caster.ray.intersectPlane(GROUND_PLANE, hit)) return null;
  return { x: Math.floor(hit.x), y: Math.floor(hit.z) };
}

/** How many blocks already stand in this column, from the world we last read. */
function stackAt(x: number, y: number): number {
  return (world?.blocks ?? []).filter((block) => block.x === x && block.y === y).length;
}

async function placeAt(x: number, y: number, removing: boolean) {
  if (!driving || buildPending) return;
  buildPending = true;
  try {
    const stack = stackAt(x, y);
    const answer = removing
      ? await kernelPost('/v1/takeover/unbuild', { x, y, level: stack })
      : await kernelPost('/v1/takeover/build', { x, y, level: stack + 1, kind: chosenMaterial });
    if (!answer.ok) { toast(answer.why || 'that block was refused'); return; }
    if (typeof answer.balance === 'number') {
      walletBalance = answer.balance;
      required('wallet-balance').textContent = String(answer.balance);
      renderPalette();
    }
    // Draw it now rather than waiting up to two seconds for the next poll: a
    // block that appears late feels like the click did not register, and the
    // world will confirm or correct it on the very next read anyway.
    if (world) {
      world.blocks = removing
        ? (world.blocks ?? []).filter((block) => !(block.x === x && block.y === y && block.level === stack))
        : [...(world.blocks ?? []), { x, y, level: stack + 1, kind: chosenMaterial, ownerAgentId: ownerAgentId ?? '' }];
      buildPlacedBlocks(world.blocks);
    }
  } finally {
    buildPending = false;
  }
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!driving || event.button !== 0 || exploreMode) return;
  const tile = tileUnderPointer(event);
  if (!tile) return;
  // Shift removes. A separate modifier rather than a mode, so unbuilding a
  // mistake never means hunting for a toggle first.
  event.preventDefault();
  void placeAt(tile.x, tile.y, event.shiftKey);
});

/**
 * The roof over your head, taken off while you are under it.
 *
 * A stepped roof seen from outside is the best part of the building; stood
 * inside a sealed room it is a lid pressed against the camera, and the room you
 * walked in to see is a black box.
 *
 * Now that roofs are instances rather than objects there is no `visible` flag
 * to turn off, so a hidden roof is collapsed to zero scale and restored from
 * its stored transform on the way out. Only the tag that changed is touched,
 * and only when it changes - crossing a threshold, not every frame.
 */
const EAVES = 3.4;
let sheltering: string | null = null;

function revealInteriors() {
  const spot = exploreMode ? camera.position : null;
  let under: string | null = null;
  if (spot && spot.y < EAVES) {
    for (const entry of roofs) {
      if (!inside(entry.build, spot.x, spot.z)) continue;
      under = `roof:${entry.build.buildId ?? `${entry.build.x}:${entry.build.y}`}`;
      break;
    }
  }
  if (under === sheltering) return;
  if (sheltering) roofBatch.setHidden(sheltering, false);
  if (under) roofBatch.setHidden(under, true);
  sheltering = under;
}

/**
 * Switch on only the interior lights near enough to matter.
 *
 * A forward renderer will not take fifty point lights, and these are lights you
 * can only see from inside a room - so the ones being switched off are the ones
 * nobody is standing in. Sorted by distance rather than culled by radius so the
 * count is a hard guarantee however dense the town gets.
 */
function tendLights() {
  if (!interiorLights.length) return;
  const eye = camera.position;
  const ranked = interiorLights
    .map((light) => ({ light, distance: light.position.distanceToSquared(eye) }))
    .sort((left, right) => left.distance - right.distance);
  for (let index = 0; index < ranked.length; index++) {
    const wanted = index < MAX_LIVE_LIGHTS && ranked[index].distance < 900;
    if (ranked[index].light.visible !== wanted) ranked[index].light.visible = wanted;
  }
}

/**
 * The hour, and everything that follows from it.
 *
 * Sky, fog, sun colour, sun angle and ambient strength all come from one call,
 * so they cannot disagree about what time it is - which is the usual way a
 * day-night cycle ends up with a blue sky above an orange horizon.
 *
 * The ambient light in particular used to sit at 2.2 against a sun of 3.3, and
 * that single number was flattening the whole world: shadows were enabled and
 * then washed out, so nothing had any weight to it.
 */
function tendSky(now: number) {
  const state = skyAt(phaseFor(view, now));
  skyDome.setColors(state);
  sun.color.copy(state.sun);
  sun.intensity = state.sunIntensity;
  hemi.intensity = state.ambientIntensity;
  hemi.color.copy(state.zenith);
  hemi.groundColor.copy(state.ground);
  scene.fog!.color.copy(state.fog);
  scene.background = null;   // the dome is the background now

  // Same clock as the colour above, or the light comes from a direction the
  // sky disagrees with.
  const angle = phaseFor(view, now) * Math.PI * 2;
  sun.position.set(Math.cos(angle) * 58, Math.max(8, Math.sin(angle) * 62 + 10), 30);

  // Every lit thing in the world comes up as the light goes down. A fixed
  // emissive intensity means the windows that look right at noon disappear at
  // midnight - which throws away the best hour this place has, a dark valley
  // with a lit town in it. The batches hold clones of these materials, so the
  // originals AND the copies both have to be told.
  if (Math.abs(glowNow - state.glow) > 0.01) {
    glowNow = state.glow;
    for (const material of emissiveMaterials()) {
      material.emissiveIntensity = (material.userData.baseGlow as number) * state.glow;
    }
  }
  return state;
}

/**
 * Every emissive material in the scene, found once and remembered.
 *
 * Walking the graph each frame would be wasteful, and the set only grows when
 * the town is rebuilt - so it is refreshed then, and the base intensity each
 * material was authored with is stashed the first time it is seen.
 */
let glowNow = 1;
let emissiveCache: THREE.MeshStandardMaterial[] | null = null;
function emissiveMaterials(): THREE.MeshStandardMaterial[] {
  if (emissiveCache) return emissiveCache;
  const found = new Set<THREE.MeshStandardMaterial>();
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const standard = entry as THREE.MeshStandardMaterial;
      if (!standard.emissiveIntensity || !standard.emissive || standard.emissive.getHex() === 0) continue;
      if (standard.userData.baseGlow === undefined) standard.userData.baseGlow = standard.emissiveIntensity;
      found.add(standard);
    }
  });
  emissiveCache = [...found];
  return emissiveCache;
}


/* ── How this person likes to look at the world ────────────────────────────
   A world people watch on everything from a workstation to a phone on a train
   cannot pick one quality level and be right. And beyond performance, most of
   what somebody wants from a window onto a living town is control over the
   view itself: hold the clock at golden hour, turn the nameplates off to see
   the place rather than the roster.

   Everything here is stored locally and applied on load, so the world somebody
   tuned is the world they come back to. None of it is sent anywhere. */

const viewPanel = document.getElementById('viewpanel') as HTMLElement | null;
const viewToggle = document.getElementById('view-toggle') as HTMLButtonElement | null;

/** Push the current settings into the renderer. */
function applyView() {
  const profile = PROFILES[view.quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.pixelRatio));

  const wantShadows = view.shadows && profile.shadowsAllowed;
  if (renderer.shadowMap.enabled !== wantShadows) {
    renderer.shadowMap.enabled = wantShadows;
    // Every material has to be recompiled when the shadow path changes, or the
    // scene keeps rendering with the shaders it was built with.
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      for (const entry of Array.isArray(material) ? material : [material]) entry.needsUpdate = true;
    });
  }
  sun.castShadow = wantShadows;
  if (wantShadows && profile.shadowMap && sun.shadow.mapSize.width !== profile.shadowMap) {
    sun.shadow.mapSize.set(profile.shadowMap, profile.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
  }

  clouds?.setVisible(view.clouds);
  wildlife?.setVisible(view.wildlife);
  saveSettings(view);
}

function syncViewControls() {
  const set = <T extends HTMLElement>(id: string, apply: (node: T) => void) => {
    const node = document.getElementById(id) as T | null;
    if (node) apply(node);
  };
  set<HTMLSelectElement>('v-quality', (node) => { node.value = view.quality; });
  set<HTMLSelectElement>('v-clock', (node) => { node.value = view.clock; });
  set<HTMLInputElement>('v-shadows', (node) => { node.checked = view.shadows; });
  set<HTMLInputElement>('v-clouds', (node) => { node.checked = view.clouds; });
  set<HTMLInputElement>('v-wildlife', (node) => { node.checked = view.wildlife; });
  set<HTMLInputElement>('v-names', (node) => { node.checked = view.nameplates; });
  set<HTMLInputElement>('v-range', (node) => { node.value = String(view.nameplateRange); });
}

function bindView() {
  const on = (id: string, event: string, handler: (node: HTMLInputElement & HTMLSelectElement) => void) => {
    const node = document.getElementById(id) as (HTMLInputElement & HTMLSelectElement) | null;
    node?.addEventListener(event, () => { handler(node); applyView(); });
  };
  on('v-quality', 'change', (node) => { view.quality = node.value as Settings['quality']; });
  on('v-clock', 'change', (node) => { view.clock = node.value as Settings['clock']; });
  on('v-shadows', 'change', (node) => { view.shadows = node.checked; });
  on('v-clouds', 'change', (node) => { view.clouds = node.checked; });
  on('v-wildlife', 'change', (node) => { view.wildlife = node.checked; });
  on('v-names', 'change', (node) => { view.nameplates = node.checked; });
  on('v-range', 'input', (node) => { view.nameplateRange = Number(node.value); });

  const show = (open: boolean) => {
    if (viewPanel) viewPanel.hidden = !open;
    viewToggle?.setAttribute('aria-expanded', String(open));
  };
  viewToggle?.addEventListener('click', () => show(viewPanel?.hidden ?? true));
  document.getElementById('view-close')?.addEventListener('click', () => show(false));
  syncViewControls();
  applyView();
}

/**
 * The cost of a frame, shown rather than claimed.
 *
 * This world was drawing at eleven hundred draw calls against a budget of about
 * five hundred, with no headroom for one more citizen. The number is on screen
 * now because it is the number the whole rebuild was about, and a claim about
 * it should be checkable by anybody looking at the page.
 */
let statsAt = 0;
function tendStats(now: number) {
  if (!viewPanel || viewPanel.hidden || now - statsAt < 500) return;
  statsAt = now;
  const node = document.getElementById('v-stats');
  if (!node) return;
  const calls = renderer.info.render.calls;
  const people = citizenModels.size;
  node.textContent = `${calls} draw calls · ${people} citizen${people === 1 ? '' : 's'} in ${citizenBatch.drawCalls}`
    + ` · ${Math.round(renderer.info.render.triangles / 1000)}k triangles`;
}

function animate() {
  const now = performance.now();
  const delta = Math.min((now - lastFrame) / 1000, .05);
  lastFrame = now;
  elapsedSeconds += delta;
  moveFirstPerson(delta);
  if (driving) {
    const dx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const dy = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
    if (dx || dy) void driveStep(dx, dy);
  } else {
    panOverhead(delta);
  }
  if (!exploreMode) orbit.update();
  revealInteriors();
  animateCitizens(elapsedSeconds, delta);
  const sky = tendSky(Date.now());
  tendLights();
  clouds?.update(elapsedSeconds, sky);
  wildlife?.update(elapsedSeconds, sky);
  tendWater(elapsedSeconds, sky);
  renderer.render(scene, camera);
  tendStats(now);
}

/**
 * What the renderer is actually costing, live.
 *
 * Exposed rather than logged because the number that matters - draw calls per
 * frame - is the one this whole rebuild was about, and a claim about it should
 * be checkable from the page rather than taken on trust.
 */
(window as unknown as { earthStats: () => unknown }).earthStats = () => ({
  drawCalls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  programs: renderer.info.programs?.length ?? 0,
  citizens: citizenModels.size,
  citizenDrawCalls: citizenBatch.drawCalls,
  structureDrawCalls: structureBatch.drawCalls + roofBatch.drawCalls + landmarkBatch.drawCalls,
  structureInstances: structureBatch.instanceCount + roofBatch.instanceCount + landmarkBatch.instanceCount,
  liveLights: interiorLights.filter((light) => light.visible).length,
  clock: view.clock,
  phase: Number(phaseFor(view, Date.now()).toFixed(3)),
  sunIntensity: Number(sun.intensity.toFixed(2)),
  ambient: Number(hemi.intensity.toFixed(2)),
  sunHeight: Math.round(sun.position.y),
  exposure: renderer.toneMappingExposure,
  shadowsOn: renderer.shadowMap.enabled && sun.castShadow,
});

bindView();
renderer.setAnimationLoop(animate);
void boot();
window.setInterval(() => void refreshState().catch(() => undefined), 2000);
window.setInterval(() => void refreshFeed(), 10000);
window.setInterval(() => void refreshTerrain().catch(() => undefined), 60000);
window.setInterval(() => void refreshWallet(), 20000);
