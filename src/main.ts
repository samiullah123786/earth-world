import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import './style.css';
import { buildBoundaries, buildFarms, buildIsland, buildScatter, detailPalette } from './world3d/detail';
import { kitPalette, makeOfficeSash, makeTierMark, makeTool, toolMotion } from './world3d/citizenKit';

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
type Venue = { venueId?: string; x: number; y: number; kind: string; name: string };
type Farm = { x: number; y: number; crop: string; stage: number; tenders: number };
type Plot = { x: number; y: number; w: number; h: number; district: string; owned: boolean };
type Zone = { zoneId: string; name: string; kind: string; x: number; y: number; w: number; h: number };
type WorldState = {
  ok: boolean; serverNow: number; world: { width: number; height: number };
  gate: { x: number; y: number }; citizens: Citizen[]; builds: Build[]; venues: Venue[];
  farms?: Farm[]; plots?: Plot[]; zones?: Zone[];
  growth?: {
    population: number; capacity: number; plots: number; ownedPlots: number;
    occupancy: number; expandsAtOccupancy: number; headroom: number;
    generation: number; size: { width: number; height: number };
  };
};
type Terrain = { width: number; height: number; rows: string[] };

type CitizenModel = {
  group: THREE.Group; leftArm: THREE.Mesh; rightArm: THREE.Mesh;
  leftLeg: THREE.Mesh; rightLeg: THREE.Mesh; row: Citizen;
  hand: THREE.Group; toolKey: string; bob: number;
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
camera.position.set(52, 38, 68);

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

const hemi = new THREE.HemisphereLight(0xd9efff, 0x5f4d35, 2.2);
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

const BOX = new THREE.BoxGeometry(1, 1, 1);
const materials = {
  grass: new THREE.MeshStandardMaterial({ color: 0x69a84f, roughness: .92 }),
  dirt: new THREE.MeshStandardMaterial({ color: 0x8b6842, roughness: 1 }),
  road: new THREE.MeshStandardMaterial({ color: 0x999188, roughness: .95 }),
  water: new THREE.MeshPhysicalMaterial({ color: 0x3d7fd4, transparent: true, opacity: .82, roughness: .2, transmission: .06 }),
  crop: new THREE.MeshStandardMaterial({ color: 0x76502f, roughness: 1 }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x5b4226, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x2f713b, roughness: .9 }),
  leafLight: new THREE.MeshStandardMaterial({ color: 0x4b9149, roughness: .9 }),
  cream: new THREE.MeshStandardMaterial({ color: 0xe8d7b5, roughness: .86 }),
  plaster: new THREE.MeshStandardMaterial({ color: 0xf2e1bf, roughness: .84 }),
  timber: new THREE.MeshStandardMaterial({ color: 0x6b4227, roughness: .9 }),
  darkTimber: new THREE.MeshStandardMaterial({ color: 0x3f2a1f, roughness: .94 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x8a4a3a, roughness: .88 }),
  roofDark: new THREE.MeshStandardMaterial({ color: 0x65362e, roughness: .9 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8a8880, roughness: .96 }),
  stoneDark: new THREE.MeshStandardMaterial({ color: 0x5f625e, roughness: .98 }),
  civic: new THREE.MeshStandardMaterial({ color: 0xc0a879, roughness: .9 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd9a928, roughness: .48, metalness: .52 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x56636a, roughness: .52, metalness: .45 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x9ee9e9, transparent: true, opacity: .43, roughness: .12, transmission: .35 }),
  window: new THREE.MeshStandardMaterial({ color: 0xffcf63, emissive: 0xffa524, emissiveIntensity: 1.45, roughness: .35 }),
  cyan: new THREE.MeshStandardMaterial({ color: 0x49dbe6, emissive: 0x16a9c1, emissiveIntensity: 1.8 }),
  obsidian: new THREE.MeshStandardMaterial({ color: 0x1b1631, roughness: .48, metalness: .18 }),
  portal: new THREE.MeshPhysicalMaterial({ color: 0x72e8ff, emissive: 0x2cc7ef, emissiveIntensity: 2.4, transparent: true, opacity: .64, transmission: .22 }),
};

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
const DETAIL = detailPalette();
const KIT = kitPalette();
let farmSignature = '';
let boundarySignature = '';
/** Tiles nothing may walk into, rebuilt with the terrain. Explore uses it. */
let solid: Set<number> = new Set();
const solidKey = (x: number, z: number) => z * 4096 + x;
const pickables: THREE.Object3D[] = [];
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
  const mesh = new THREE.InstancedMesh(BOX, terrainMaterials[letter], locations.length);
  const matrix = new THREE.Matrix4();
  locations.forEach((spot, index) => {
    const height = letter === 'w' ? .34 : .5;
    matrix.compose(
      new THREE.Vector3(spot.x + .5, spot.top - height / 2, spot.z + .5),
      new THREE.Quaternion(), new THREE.Vector3(1, height, 1),
    );
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  terrainRoot.add(mesh);
}

function buildTerrain(data: Terrain) {
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

  const trunkMesh = new THREE.InstancedMesh(BOX, materials.trunk, treeTrunks.length);
  const crownMesh = new THREE.InstancedMesh(BOX, materials.leaf, treeTrunks.length * 2 + bushes.length);
  const matrix = new THREE.Matrix4();
  treeTrunks.forEach((spot, index) => {
    matrix.compose(new THREE.Vector3(spot.x + .5, 1.05, spot.z + .5), new THREE.Quaternion(), new THREE.Vector3(.32, 2.1, .32));
    trunkMesh.setMatrixAt(index, matrix);
    matrix.compose(new THREE.Vector3(spot.x + .5, 2.15, spot.z + .5), new THREE.Quaternion(), new THREE.Vector3(1.55, 1.15, 1.55));
    crownMesh.setMatrixAt(index * 2, matrix);
    matrix.compose(new THREE.Vector3(spot.x + .5, 2.9, spot.z + .5), new THREE.Quaternion(), new THREE.Vector3(.92, .72, .92));
    crownMesh.setMatrixAt(index * 2 + 1, matrix);
  });
  bushes.forEach((spot, index) => {
    matrix.compose(new THREE.Vector3(spot.x + .5, .5, spot.z + .5), new THREE.Quaternion(), new THREE.Vector3(.8, .8, .8));
    crownMesh.setMatrixAt(treeTrunks.length * 2 + index, matrix);
  });
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

function steppedRoof(group: THREE.Group, build: Build, roof: THREE.Material, start = 2.72) {
  let x = build.x - .18, z = build.y - .18;
  let w = build.w + .36, h = build.h + .36;
  let level = 0;
  while (w > .6 && h > .6 && level < 5) {
    addBlock(group, x, start + level * .48, z, w, .5, h, roof);
    x += .42; z += .42; w -= .84; h -= .84; level++;
  }
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

function buildStructures(builds: Build[], venues: Venue[], gate: { x: number; y: number }) {
  clearGroup(structureRoot);
  clearGroup(landmarkRoot);
  for (const build of builds) {
    const group = new THREE.Group();
    group.userData.build = build;
    const text = semantic(build);
    const seed = hash(`${build.x}:${build.y}:${text}`);
    if (build.state === 'building') makeScaffold(group, build);
    else if (/garden|park|fountain|training/.test(text)) makeGarden(group, build);
    else if (/bench|laptop/.test(text)) makeBench(group, build);
    else if (/greenhouse|orchard/.test(text) && !/home/.test(text)) makeGreenhouse(group, build);
    else if (/data.center|server/.test(text)) makeDataCenter(group, build);
    else if (/workshop|industry|sawtooth/.test(text)) makeWorkshop(group, build);
    else if (/bank/.test(text)) makeCivic(group, build, 'bank');
    else if (/civic|hall|library|pavilion|rotunda/.test(text)) makeCivic(group, build, 'hall');
    else makeHome(group, build, seed);
    structureRoot.add(group);
  }

  for (const venue of venues) {
    const marker = new THREE.Group();
    addBlock(marker, venue.x + .44, .15, venue.y + .44, .12, 2.4, .12, materials.darkTimber);
    addBlock(marker, venue.x + .56, 1.75, venue.y + .43, .85, .62, .08, materials.roof);
    marker.add(makeLabel(venue.name, '#b4551f', 260, 34, 1.75));
    const label = marker.children[marker.children.length - 1];
    label.position.set(venue.x + .5, 2.95, venue.y + .5);
    landmarkRoot.add(marker);
  }

  const gateGroup = new THREE.Group();
  for (const side of [-1, 1]) addBlock(gateGroup, gate.x + side - .25, .05, gate.y + .28, .5, 4.2, .5, materials.obsidian);
  addBlock(gateGroup, gate.x - 1.25, 3.9, gate.y + .28, 3, .55, .5, materials.obsidian);
  addBlock(gateGroup, gate.x - .68, .45, gate.y + .34, 1.36, 3.32, .3, materials.portal);
  const gateLight = new THREE.PointLight(0x4fdcff, 8, 12, 1.8);
  gateLight.position.set(gate.x, 2.3, gate.y + .5);
  gateGroup.add(gateLight);
  landmarkRoot.add(gateGroup);
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
  const group = new THREE.Group();
  group.userData.agentId = row.agentId;
  const family = new THREE.MeshStandardMaterial({ color: colorForFamily(row.family), roughness: .75 });
  const skinColors = [0xf0c39b, 0xd9a878, 0xb87952, 0x815238];
  const skin = new THREE.MeshStandardMaterial({ color: skinColors[hash(row.agentId) % skinColors.length], roughness: .78 });
  const hairColors = [0x34251d, 0x6a4528, 0xc28a3a, 0x24242b, 0x7a3232];
  const hair = new THREE.MeshStandardMaterial({ color: hairColors[hash(row.name) % hairColors.length], roughness: .9 });
  const boot = materials.darkTimber;

  const torso = addBlock(group, -.25, .75, -.15, .5, .72, .3, family);
  const head = addBlock(group, -.22, 1.5, -.19, .44, .44, .38, skin);
  addBlock(group, -.23, 1.86, -.2, .46, .12, .4, hair);
  const leftArm = addBlock(group, -.39, .79, -.11, .13, .66, .22, skin);
  const rightArm = addBlock(group, .26, .79, -.11, .13, .66, .22, skin);
  const leftLeg = addBlock(group, -.2, .12, -.11, .17, .64, .22, family);
  const rightLeg = addBlock(group, .03, .12, -.11, .17, .64, .22, family);
  addBlock(group, -.2, .06, -.17, .17, .14, .3, boot);
  addBlock(group, .03, .06, -.17, .17, .14, .3, boot);
  const badge = addBlock(group, -.06, 1.12, -.165, .12, .12, .04, materials.window);
  badge.userData.agentId = row.agentId;
  for (const mesh of [torso, head, leftArm, rightArm, leftLeg, rightLeg]) mesh.userData.agentId = row.agentId;

  // Everything below is a fact the Kernel already tracked and no renderer
  // ever drew: the office a citizen holds, the evidence tier they have
  // earned, and the tool they were given for contributing.
  if (row.serviceRole) group.add(makeOfficeSash(row.serviceRole, KIT));
  const tierMark = makeTierMark(row.experienceTier, KIT);
  if (tierMark) group.add(tierMark);

  // The hand is a pivot on the end of the right arm, so a carried tool
  // swings with the arm rather than floating beside the body.
  const hand = new THREE.Group();
  hand.position.set(.32, .5, 0);
  group.add(hand);
  const tool = makeTool(row.activeTool ?? row.carriedTool, KIT);
  if (tool) hand.add(tool);

  const label = makeLabel(row.name, '#1e1e1e');
  label.position.y = 2.52;
  label.userData.agentId = row.agentId;
  group.add(label);
  pickables.push(torso, head, leftArm, rightArm, leftLeg, rightLeg, badge);
  citizenRoot.add(group);
  return {
    group, leftArm, rightArm, leftLeg, rightLeg, row, hand,
    toolKey: String(row.activeTool ?? row.carriedTool ?? ''), bob: 0,
  };
}

function syncCitizens(rows: Citizen[]) {
  const awake = new Set(rows.filter((row) => !row.asleep).map((row) => row.agentId));
  for (const [agentId, model] of citizenModels) {
    if (!awake.has(agentId)) {
      citizenRoot.remove(model.group);
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
    model.row = row;
    // A citizen who picks up or puts down a tool changes in place; rebuilding
    // the whole body for it would drop them through a frame.
    const wanted = String(row.activeTool ?? row.carriedTool ?? '');
    if (wanted !== model.toolKey) {
      while (model.hand.children.length) model.hand.remove(model.hand.children[0]);
      const tool = makeTool(wanted || null, KIT);
      if (tool) model.hand.add(tool);
      model.toolKey = wanted;
    }
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

function animateCitizens(elapsed: number) {
  const now = Date.now() + clockOffset - 140;
  for (const model of citizenModels.values()) {
    const spot = positionFor(model.row, now);
    model.group.position.set(spot.x + .5, .02, spot.z + .5);
    if (spot.moving) {
      const swing = Math.sin(elapsed * 8 + hash(model.row.agentId) % 10) * .55;
      model.leftArm.rotation.x = swing;
      model.rightArm.rotation.x = -swing;
      model.leftLeg.rotation.x = -swing * .65;
      model.rightLeg.rotation.x = swing * .65;
      model.group.position.y = .02 + Math.abs(Math.sin(elapsed * 8)) * .035;
    } else {
      // Standing still is not one pose. A citizen mid-task swings the tool
      // they are actually holding, at the tempo that task deserves; everyone
      // else breathes.
      const busy = (model.row.workingUntil ?? 0) > Date.now() || (model.row.buildingUntil ?? 0) > Date.now();
      const motion = toolMotion(model.row.activeTool ?? model.row.carriedTool, busy);
      if (motion) {
        const swing = Math.sin(elapsed * motion.speed + hash(model.row.agentId) % 7);
        model.rightArm.rotation.x = -Math.abs(swing) * motion.amplitude;
        model.leftArm.rotation.x = Math.abs(swing) * motion.amplitude * .3;
        model.group.rotation.x = Math.abs(swing) * motion.lean * .12;
        model.leftLeg.rotation.x = model.rightLeg.rotation.x = 0;
      } else {
        const breathe = Math.sin(elapsed * 2 + hash(model.row.name) % 6) * .035;
        model.leftArm.rotation.x = breathe;
        model.rightArm.rotation.x = -breathe;
        model.group.rotation.x = 0;
        model.leftLeg.rotation.x = model.rightLeg.rotation.x = 0;
      }
    }
    // Face the way you are going, so a walking crowd does not moonwalk.
    const heading = model.group.userData.heading as number | undefined;
    if (spot.moving) {
      const next = Math.atan2(spot.x + .5 - model.group.position.x, spot.z + .5 - model.group.position.z);
      if (Number.isFinite(next) && (spot.x + .5 !== model.group.position.x || spot.z + .5 !== model.group.position.z)) {
        model.group.userData.heading = next;
      }
    }
    if (typeof heading === 'number') {
      let delta = heading - model.group.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      model.group.rotation.y += delta * .18;
    }
  }
}

function focusAt(x: number, z: number, distance = 12) {
  if (exploreMode) firstPerson.unlock();
  orbit.target.set(x, .8, z);
  camera.position.set(x + distance * .72, Math.max(7, distance * .72), z + distance);
  orbit.update();
}

function focusCitizen(agentId: string, open = true) {
  const model = citizenModels.get(agentId);
  const row = world?.citizens.find((citizen) => citizen.agentId === agentId);
  if (!row) return;
  selectedAgentId = agentId;
  const spot = model ? model.group.position : new THREE.Vector3(row.tx + .5, 0, row.ty + .5);
  focusAt(spot.x, spot.z, 7.5);
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
  const active = world.citizens.filter((row) => row.talkingWith && (!row.talkingUntil || row.talkingUntil > Date.now()));
  required('chat-count').textContent = active.length ? `${active.length} LIVE` : '';
  const dot = conversation.querySelector('.conversation-live-dot');
  dot?.classList.toggle('quiet', !active.length);
  if (!active.length) {
    const empty = document.createElement('div'); empty.className = 'chat-empty'; empty.textContent = 'No live conversation right now. Nothing opens automatically.';
    conversationBody.replaceChildren(empty);
    return;
  }
  conversationBody.replaceChildren(...active.map((row) => {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'chat-row';
    const other = world!.citizens.find((citizen) => citizen.agentId === row.talkingWith);
    item.innerHTML = `<b></b><span></span>`;
    item.querySelector('b')!.textContent = `${row.name} ↔ ${other?.name ?? 'citizen'}`;
    item.querySelector('span')!.textContent = row.activity || 'talking in the world';
    item.onclick = () => focusCitizen(row.agentId);
    return item;
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
  clockOffset = next.serverNow - Date.now();
  syncCitizens(next.citizens);
  const signature = JSON.stringify([next.builds, next.venues, next.gate]);
  if (signature !== structureSignature) {
    structureSignature = signature;
    buildStructures(next.builds, next.venues, next.gate);
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
    if (payload.ok && Number.isFinite(payload.balance)) required('wallet-balance').textContent = String(payload.balance);
  } catch { /* spectators truthfully keep a dash */ }
}

async function boot() {
  try {
    await Promise.all([refreshTerrain(), refreshState(), refreshFeed(), refreshWallet()]);
    loading.classList.add('done');
    if (terrain) {
      orbit.target.set(Math.min(38, terrain.width / 2), .8, Math.min(28, terrain.height / 2));
      orbit.update();
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
    if (solid.has(solidKey(tx, tz))) return true;
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
  const floor = EYE;
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
  const hit = raycaster.intersectObjects(pickables, false)[0];
  const agentId = hit?.object.userData.agentId as string | undefined;
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

function animate() {
  const now = performance.now();
  const delta = Math.min((now - lastFrame) / 1000, .05);
  lastFrame = now;
  elapsedSeconds += delta;
  moveFirstPerson(delta);
  panOverhead(delta);
  if (!exploreMode) orbit.update();
  animateCitizens(elapsedSeconds);
  const day = (Date.now() / 120000) % (Math.PI * 2);
  sun.position.set(Math.cos(day) * 55, 32 + Math.sin(day) * 18, Math.sin(day) * 44);
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
void boot();
window.setInterval(() => void refreshState().catch(() => undefined), 2000);
window.setInterval(() => void refreshFeed(), 10000);
window.setInterval(() => void refreshTerrain().catch(() => undefined), 60000);
window.setInterval(() => void refreshWallet(), 20000);
