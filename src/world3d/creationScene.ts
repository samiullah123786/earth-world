import * as THREE from 'three';
import { partIsActive, type CreationRecord, type CreationPart } from '../../shared/creation';
import { ART } from './neighborhood';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const roofSource = new THREE.BufferGeometry();
roofSource.setAttribute('position', new THREE.Float32BufferAttribute([
  -.5, -.5, -.5, .5, -.5, -.5, 0, .5, -.5,
  -.5, -.5, .5, .5, -.5, .5, 0, .5, .5,
], 3));
roofSource.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3]);
// Unshared vertices keep roof slopes and gables hard-edged. Averaging the
// six shared corners made flat roof planes appear dented under daylight.
const ROOF = roofSource.toNonIndexed();
ROOF.computeVertexNormals();
const COLORS = { plank: ART.bark, stone: ART.shadow, brick: ART.soil, glass: ART.shadow, thatch: ART.bark, lantern: ART.sun, door: ART.bark, roof: ART.roof, switch: ART.selection, plaster: ART.curb, frame: ART.bark, mortar: ART.soil };
const materials = new Map<string, THREE.MeshStandardMaterial>();
const mat = (key: string, color: number, glass = false, lit = false) => {
  let m = materials.get(key); if (m) return m;
  m = new THREE.MeshStandardMaterial({ color, roughness: glass ? .3 : .88, transparent: glass, opacity: glass ? .65 : 1, emissive: lit ? ART.sun : 0, emissiveIntensity: lit ? 1.1 : 0 });
  materials.set(key, m); return m;
};
const cache = new WeakMap<THREE.Group, string>();

type Finish = { key: keyof typeof COLORS; matrix: THREE.Matrix4; roof: boolean; glass?: boolean; lit?: boolean; geometry?: 'roof' };
/** Native finish geometry is presentation inside ONE already committed part.
 * It adds no land, collision, paid components or action targets. */
export function creationPartFinishes(p: CreationPart, home: boolean, active: boolean): Finish[] {
  const result: Finish[] = [];
  const add = (key: Finish['key'], x: number, y: number, z: number, w: number, h: number, d: number, rotation = new THREE.Quaternion(), geometry?: 'roof') => {
    result.push({ key, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rotation, new THREE.Vector3(w, h, d)), roof: p.shape === 'roof', geometry, glass: key === 'glass', lit: p.shape === 'lamp' && active });
  };
  const box = (key: Finish['key'], x: number, y: number, z: number, w: number, h: number, d: number) => add(key, p.x + x + w / 2, p.y + y + h / 2, p.z + z + d / 2, w, h, d);
  if (p.shape === 'door') {
    const frame = Math.min(.09, p.h / 12), leafW = 1 - frame * 2, leafH = p.h - frame;
    box('frame', 0, 0, 0, frame, p.h, .18); box('frame', 1 - frame, 0, 0, frame, p.h, .18);
    box('frame', frame, p.h - frame, 0, leafW, frame, .18);
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), active ? -Math.PI / 2 : 0);
    const hinge = new THREE.Vector3(p.x + frame, p.y, p.z + .09);
    const leaf = (key: Finish['key'], x: number, y: number, z: number, w: number, h: number, d: number) => {
      const center = new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2).applyQuaternion(turn).add(hinge);
      add(key, center.x, center.y, center.z, w, h, d, turn);
    };
    leaf('door', 0, 0, -.05, leafW, leafH, .1);
    // Insets and a handle are attached to the same hinge as the leaf.
    leaf('plank', .08, .15, -.055, leafW - .16, Math.max(.1, leafH * .38), .012);
    leaf('plank', .08, leafH * .55, -.055, leafW - .16, Math.max(.1, leafH * .32), .012);
    leaf('stone', leafW - .13, leafH * .48, -.075, .04, .08, .025);
    return result;
  }
  if (p.shape === 'roof') {
    add('roof', p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2, p.w, p.h, p.d, undefined, 'roof');
    const rail = Math.min(.08, p.h / 5, p.w / 8, p.d / 8);
    box('frame', 0, 0, 0, rail, rail, p.d); box('frame', p.w - rail, 0, 0, rail, rail, p.d);
    box('roof', p.w / 2 - rail / 2, p.h - rail, 0, rail, rail, p.d);
    return result;
  }
  if (home && p.shape === 'block' && (p.material === 'plank' || p.material === 'glass')) {
    const rail = Math.min(.07, p.w / 8, p.d / 8, p.h / 8);
    box('plaster', rail / 2, 0, rail / 2, p.w - rail, p.h, p.d - rail);
    for (const x of [0, p.w - rail]) for (const z of [0, p.d - rail]) box('frame', x, 0, z, rail, p.h, rail);
    for (const y of [0, p.h - rail]) {
      box('frame', 0, y, 0, p.w, rail, rail); box('frame', 0, y, p.d - rail, p.w, rail, rail);
      box('frame', 0, y, rail, rail, rail, p.d - rail * 2); box('frame', p.w - rail, y, rail, rail, rail, p.d - rail * 2);
    }
    if (p.material === 'glass') {
      const w = p.w * .7, h = p.h * .54, x = (p.w - w) / 2, y = p.h * .28, t = rail / 2;
      // Recessed windows remain inside the solid glass part's exact bounds.
      for (const z of [0, p.d - t]) {
        box('glass', x, y, z, w, h, t);
        box('frame', x - rail, y - rail, z, w + rail * 2, rail, t);
        box('frame', x - rail, y + h, z, w + rail * 2, rail, t);
        box('frame', x - rail, y, z, rail, h, t); box('frame', x + w, y, z, rail, h, t);
        box('frame', p.w / 2 - rail / 2, y, z, rail, h, t);
      }
    }
    return result;
  }
  box(p.shape === 'switch' ? 'switch' : p.material, 0, 0, 0, p.w, p.h, p.d);
  if (home && p.shape === 'floor' && p.material === 'stone') {
    const seam = Math.min(.025, p.h / 4);
    for (let x = 1; x < p.w; x++) {
      box('mortar', x - seam / 2, 0, 0, seam, p.h, seam);
      box('mortar', x - seam / 2, 0, p.d - seam, seam, p.h, seam);
    }
  }
  return result;
}

/** Exact committed parts/state only. Cached batches do not rebuild for unrelated world polls. */
export function syncCreationScene(root: THREE.Group, records: CreationRecord[], heightAt: (x: number, z: number) => number): THREE.Object3D[] {
  const signature = JSON.stringify(records.map(r => [r.creationId, r.revision, r.progress, r.signals, r.plan]));
  if (cache.get(root) === signature) return root.children;
  cache.set(root, signature);
  for (const node of [...root.children]) { root.remove(node); (node as THREE.InstancedMesh).dispose?.(); }
  const buckets = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[]; tags: { creationId: string; partId: string }[]; roof: boolean }>();
  const lamps: THREE.Vector3[] = [];
  for (const record of records) {
    const extentX = Math.max(...record.plan.parts.map(p => p.x + p.w)), extentZ = Math.max(...record.plan.parts.map(p => p.z + p.d));
    // One level foundation for the assembly, matching terrain building-pad behavior.
    const ground = heightAt(record.plan.x + extentX / 2, record.plan.y + extentZ / 2);
    for (const p of record.plan.parts.slice(0, record.progress)) {
      const active = partIsActive(record.plan, p.id, record.signals);
      const origin = new THREE.Matrix4().makeTranslation(record.plan.x, ground, record.plan.y);
      for (const finish of creationPartFinishes(p, record.plan.kind === 'home', active)) {
        const key = `${finish.key}:${finish.geometry ?? 'box'}:${finish.roof ? 'roof' : 'body'}:${finish.lit ? 'lit' : 'plain'}`;
        let bucket = buckets.get(key);
        if (!bucket) { bucket = { geometry: finish.geometry === 'roof' ? ROOF : BOX, material: mat(key, COLORS[finish.key], finish.glass, finish.lit), matrices: [], tags: [], roof: finish.roof }; buckets.set(key, bucket); }
        bucket.matrices.push(origin.clone().multiply(finish.matrix)); bucket.tags.push({ creationId: record.creationId, partId: p.id });
      }
      if (p.shape === 'lamp' && active) lamps.push(new THREE.Vector3(record.plan.x + p.x + p.w / 2, ground + p.y + p.h / 2, record.plan.y + p.z + p.d / 2));
    }
  }
  for (const bucket of buckets.values()) {
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.matrices.length);
    bucket.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.tags = bucket.tags; mesh.computeBoundingSphere(); root.add(mesh);
    if (bucket.roof) mesh.userData.roofMatrices = bucket.matrices;
  }
  root.userData.lamps = lamps;
  for (const light of root.userData.lightPool ?? []) root.add(light);
  return root.children.filter(node => (node as THREE.InstancedMesh).isInstancedMesh);
}

/** Four nearby, shadow-free lights keep working lamps affordable on mobile. */
export function tendCreationLighting(root: THREE.Group, eye: THREE.Vector3) {
  if (!root.userData.lightPool) {
    root.userData.lightPool = Array.from({ length: 4 }, () => {
      const light = new THREE.PointLight(ART.sun, 2.5, 5, 2);
      light.visible = false; root.add(light); return light;
    });
  }
  const lamps = (root.userData.lamps ?? []) as THREE.Vector3[];
  const nearby = lamps.filter(p => p.distanceToSquared(eye) < 400).sort((a, b) => a.distanceToSquared(eye) - b.distanceToSquared(eye)).slice(0, 4);
  (root.userData.lightPool as THREE.PointLight[]).forEach((light, index) => { light.visible = Boolean(nearby[index]); if (nearby[index]) light.position.copy(nearby[index]); });
}

/** Open the roof above the followed citizen without hiding other assemblies. */
export function revealCreationInteriors(root: THREE.Group, records: CreationRecord[], spot: { x: number; z: number } | null) {
  const hidden = new Set(records.filter(record => spot && spot.x >= record.plan.x && spot.z >= record.plan.y && spot.x < record.plan.x + Math.max(...record.plan.parts.map(p => p.x + p.w)) && spot.z < record.plan.y + Math.max(...record.plan.parts.map(p => p.z + p.d))).map(record => record.creationId));
  for (const node of root.children) {
    const mesh = node as THREE.InstancedMesh, originals = mesh.userData.roofMatrices as THREE.Matrix4[] | undefined;
    if (!originals) continue;
    const key = mesh.userData.tags.map((tag: { creationId: string }) => hidden.has(tag.creationId) ? '0' : '1').join('');
    if (mesh.userData.roofVisibility === key) continue;
    mesh.userData.roofVisibility = key;
    originals.forEach((matrix, index) => mesh.setMatrixAt(index, key[index] === '0' ? new THREE.Matrix4().makeScale(0, 0, 0) : matrix));
    mesh.instanceMatrix.needsUpdate = true;
  }
}
