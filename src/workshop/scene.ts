import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModel, loadModels, ModelInstances, fitToPlot, type Model } from '../world3d/assets';
import { ART, neighborhoodModel } from '../world3d/neighborhood';
import { SIZE, blockFor, footprint, type Plan, type Placement } from './plan';

export class NeighborhoodScene {
  private scene = new THREE.Scene();
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.OrthographicCamera();
  private controls: OrbitControls;
  private root = new THREE.Group();
  private paths = new THREE.Group();
  private pavingMaterial = new THREE.MeshStandardMaterial({ color: ART.curb, roughness: 1 });
  private people = new THREE.Group();
  private batches: ModelInstances[] = [];
  private models = new Map<string, Model>();
  private ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  private marker: THREE.Mesh;
  private ghost: THREE.Group | null = null;
  private thumbnailRenderer: THREE.WebGLRenderer;
  private ray = new THREE.Raycaster();
  private revision = 0;
  private previewRevision = 0;
  private pickables: THREE.Object3D[] = [];
  private observer: ResizeObserver;
  private pointerStart = { x: 0, y: 0 };
  onPick: (id: string | null, x: number, y: number) => void = () => {};
  onHover: (x: number, y: number) => void = () => {};
  onStats: (calls: number) => void = () => {};
  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    host.append(this.renderer.domElement);
    this.scene.background = new THREE.Color(ART.background);
    this.scene.add(new THREE.HemisphereLight(ART.sky, ART.shadow, 2));
    const sun = new THREE.DirectionalLight(ART.sun, 3);
    sun.position.set(-10, 30, 16); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: .5, far: 80 });
    sun.shadow.normalBias = .06; sun.shadow.bias = -.0002;
    sun.target.position.set(16, 0, 16); this.scene.add(sun, sun.target);
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(SIZE, .6, SIZE), new THREE.MeshStandardMaterial({ color: ART.grass, roughness: 1 }));
    this.ground.position.set(16, -.3, 16); this.ground.receiveShadow = true; this.scene.add(this.ground);
    const base = new THREE.Mesh(new THREE.BoxGeometry(SIZE, .35, SIZE), new THREE.MeshStandardMaterial({ color: ART.soil }));
    base.position.set(16, -.76, 16); this.scene.add(base);
    const roadMaterial = new THREE.MeshStandardMaterial({ color: ART.road, roughness: 1 });
    for (const horizontal of [true, false]) {
      const road = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? SIZE : 4, .025, horizontal ? 4 : SIZE), roadMaterial);
      road.position.set(16, .015, 16); road.receiveShadow = true; this.scene.add(road);
    }
    const curbMaterial = new THREE.MeshStandardMaterial({ color: ART.curb, roughness: 1 });
    for (const n of [13.8, 18.2]) for (const horizontal of [true, false]) for (const center of [7, 25]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? 14 : .25, .08, horizontal ? .25 : 14), curbMaterial);
      curb.position.set(horizontal ? center : n, .03, horizontal ? n : center); curb.receiveShadow = true; this.scene.add(curb);
    }
    this.grid = new THREE.GridHelper(SIZE, SIZE, ART.grid, ART.grid);
    this.grid.position.set(16, .065, 16); this.grid.visible = false; this.scene.add(this.grid);
    this.marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: ART.selection, transparent: true, opacity: .24, depthWrite: false }));
    this.marker.rotation.x = -Math.PI / 2; this.marker.visible = false; this.scene.add(this.marker, this.root, this.people, this.paths);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableRotate = false; this.controls.enableDamping = false;
    this.controls.screenSpacePanning = false; this.controls.minZoom = .6; this.controls.maxZoom = 3.5;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.touches.ONE = THREE.TOUCH.PAN;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    this.controls.addEventListener('change', () => this.render());
    this.thumbnailRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.thumbnailRenderer.setSize(160, 120); this.thumbnailRenderer.setPixelRatio(1);
    this.thumbnailRenderer.toneMapping = THREE.ACESFilmicToneMapping; this.thumbnailRenderer.toneMappingExposure = 1.25;
    this.thumbnailRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.resetView();
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', e => { this.pointerStart = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', e => {
      if (Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) > 6) return;
      this.cast(e);
      const point = this.ray.intersectObject(this.ground)[0]?.point;
      if (!point) return;
      const hit = this.ray.intersectObjects(this.pickables)[0];
      const id = hit && hit.instanceId !== undefined ? hit.object.userData.tags[hit.instanceId] as string : null;
      this.onPick(id, Math.floor(point.x), Math.floor(point.z));
    });
    canvas.addEventListener('pointermove', e => {
      if (e.buttons) return;
      this.cast(e); const point = this.ray.intersectObject(this.ground)[0]?.point;
      if (point) this.onHover(Math.floor(point.x), Math.floor(point.z));
    });
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); host.dispatchEvent(new CustomEvent('scene-error', { detail: 'The graphics connection paused. Reload to restore your saved draft.' })); });
  }
  private cast(e: PointerEvent) {
    const box = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - box.left) / box.width * 2 - 1, -(e.clientY - box.top) / box.height * 2 + 1), this.camera);
  }
  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h); const aspect = w / h;
    // Fit the whole neighborhood between the heading and editing toolbar.
    const half = Math.max(16, 24 / aspect);
    this.camera.left = -half * aspect; this.camera.right = half * aspect;
    this.camera.top = half; this.camera.bottom = -half; this.camera.near = .1; this.camera.far = 200;
    this.camera.updateProjectionMatrix(); this.render();
  }
  resetView() { this.camera.position.set(49, 42, 55); this.camera.zoom = 1; this.controls.target.set(16, 0, 16); this.camera.updateProjectionMatrix(); this.controls.update(); this.render(); }
  zoom(factor: number) { this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, .6, 3.5); this.camera.updateProjectionMatrix(); this.render(); }
  toggleGrid(show: boolean) { this.grid.visible = show; this.render(); }
  togglePeople(show: boolean) { this.people.visible = show; this.render(); }
  private async model(id: string) {
    const cached = this.models.get(id); if (cached) return cached;
    const source = await loadModel(blockFor(id).asset.url);
    const block = blockFor(id);
    const model = neighborhoodModel(source, block.asset.kind);
    this.models.set(id, model); return model;
  }
  async setPlan(plan: Plan): Promise<void> {
    const revision = ++this.revision;
    await Promise.all([...new Set(plan.objects.map(p => p.assetId))].map(id => this.model(id)));
    if (revision !== this.revision) return;
    this.batches.forEach(b => b.dispose()); this.batches = []; this.pickables = [];
    this.paths.children.forEach(o => { const mesh = o as THREE.Mesh; mesh.geometry.dispose(); }); this.paths.clear();
    for (const p of plan.objects) {
      const block = blockFor(p.assetId);
      if (block.asset.kind !== 'home' && block.asset.kind !== 'civic') continue;
      const f = footprint(p);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(f.w + .15, .03, f.h + .15), this.pavingMaterial);
      pad.position.set(p.x + f.w / 2, .025, p.y + f.h / 2); pad.receiveShadow = true; this.paths.add(pad);
      const vertical = p.rotation % 2 === 0;
      const start = vertical ? (p.y < 14 ? p.y + f.h : p.y) : (p.x < 14 ? p.x + f.w : p.x);
      const end = vertical ? (p.y < 14 ? 14 : 18) : (p.x < 14 ? 14 : 18);
      const length = Math.abs(end - start);
      if (length < .1) continue;
      const path = new THREE.Mesh(new THREE.BoxGeometry(vertical ? .65 : length, .035, vertical ? length : .65), this.pavingMaterial);
      path.position.set(vertical ? p.x + f.w / 2 : (start + end) / 2, .025, vertical ? (start + end) / 2 : p.y + f.h / 2);
      path.receiveShadow = true; this.paths.add(path);
    }
    for (const id of new Set(plan.objects.map(p => p.assetId))) {
      const model = this.models.get(id)!; const batch = new ModelInstances(this.root, model);
      for (const p of plan.objects.filter(p => p.assetId === id)) {
        const f = footprint(p); batch.add(fitToPlot(model, { x: p.x, y: p.y, ...f }, .045, p.rotation * Math.PI / 2), p.id);
      }
      batch.flush(); this.batches.push(batch); this.pickables.push(...batch.pickables);
    }
    this.render();
  }
  async loadPeople() {
    const models = await loadModels(['a', 'c', 'g', 'm'].map(k => `/models/citizen/${k}.glb`));
    models.forEach((m, i) => {
      const person = m.scene.clone(true); person.scale.setScalar(1.4 / Math.max(m.size.y, .1));
      person.position.set([15, 17, 16, 15][i], .06, [11, 20, 24, 5][i]); person.rotation.y = i * Math.PI / 2;
      person.traverse(node => { const mesh = node as THREE.Mesh; if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; } });
      this.people.add(person);
    }); this.render();
  }
  select(p: Placement | null) {
    this.marker.visible = !!p;
    if (p) { const f = footprint(p); this.marker.scale.set(f.w, f.h, 1); this.marker.position.set(p.x + f.w / 2, .09, p.y + f.h / 2); }
    this.render();
  }
  async preview(p: Placement | null, valid = true) {
    const revision = ++this.previewRevision;
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.Material).dispose(); }); this.ghost = null; }
    if (!p) { this.render(); return; }
    const model = await this.model(p.assetId); if (revision !== this.previewRevision) return;
    const group = new THREE.Group();
    model.pieces.forEach(piece => {
      const material = piece.material.clone() as THREE.MeshStandardMaterial;
      material.transparent = true; material.opacity = .55; material.depthWrite = false;
      material.onBeforeCompile = piece.material.onBeforeCompile;
      material.customProgramCacheKey = piece.material.customProgramCacheKey;
      if (material.color) material.color.multiply(new THREE.Color(valid ? ART.ghost : ART.invalid));
      group.add(new THREE.Mesh(piece.geometry, material));
    });
    group.applyMatrix4(fitToPlot(model, { ...p, ...footprint(p) }, .12, p.rotation * Math.PI / 2));
    this.ghost = group; this.scene.add(group); this.render();
  }
  async thumbnail(id: string): Promise<string> {
    const model = await this.model(id), scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(ART.sky, ART.shadow, 2));
    const sun = new THREE.DirectionalLight(ART.sun, 3); sun.position.set(-3, 8, 4); scene.add(sun);
    const group = new THREE.Group(); model.pieces.forEach(p => group.add(new THREE.Mesh(p.geometry, p.material)));
    const max = Math.max(model.size.x, model.size.y, model.size.z, .1); group.scale.setScalar(2.4 / max);
    scene.add(group); const camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, .1, 30);
    camera.position.set(4, 3, 5); camera.lookAt(0, model.size.y / max * 1.1, 0);
    this.thumbnailRenderer.render(scene, camera); return this.thumbnailRenderer.domElement.toDataURL('image/png');
  }
  private render() { this.renderer.render(this.scene, this.camera); this.onStats(this.renderer.info.render.calls); }
}
