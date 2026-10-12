import * as THREE from 'three';
import { partIsActive, type CreationRecord } from '../../shared/creation';
import { ART } from './neighborhood';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const ROOF = new THREE.BufferGeometry();
ROOF.setAttribute('position', new THREE.Float32BufferAttribute([
  -.5, -.5, -.5, .5, -.5, -.5, 0, .5, -.5,
  -.5, -.5, .5, .5, -.5, .5, 0, .5, .5,
], 3));
ROOF.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3]);
ROOF.computeVertexNormals();
const COLORS = { plank: ART.curb, stone: ART.shadow, brick: ART.soil, glass: ART.sky, thatch: ART.bark, lantern: ART.sun, door: ART.bark, roof: ART.roof, switch: ART.selection };
const materials = new Map<string, THREE.MeshStandardMaterial>();
const mat = (key: string, color: number, glass = false, lit = false) => {
  let m = materials.get(key); if (m) return m;
  m = new THREE.MeshStandardMaterial({ color, roughness: glass ? .3 : .88, transparent: glass, opacity: glass ? .65 : 1, emissive: lit ? ART.sun : 0, emissiveIntensity: lit ? 1.1 : 0 });
  materials.set(key, m); return m;
};
const cache = new WeakMap<THREE.Group, string>();

/** Exact committed parts/state only. Cached batches do not rebuild for unrelated world polls. */
export function syncCreationScene(root: THREE.Group, records: CreationRecord[], heightAt: (x: number, z: number) => number): THREE.Object3D[] {
  const signature = JSON.stringify(records.map(r => [r.creationId, r.revision, r.progress, r.signals, r.plan]));
  if (cache.get(root) === signature) return root.children;
  cache.set(root, signature);
  for (const node of [...root.children]) { root.remove(node); (node as THREE.InstancedMesh).dispose?.(); }
  const buckets = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[]; tags: { creationId: string; partId: string }[] }>();
  const lamps: THREE.Vector3[] = [];
  for (const record of records) {
    const extentX = Math.max(...record.plan.parts.map(p => p.x + p.w)), extentZ = Math.max(...record.plan.parts.map(p => p.z + p.d));
    // One level foundation for the assembly, matching terrain building-pad behavior.
    const ground = heightAt(record.plan.x + extentX / 2, record.plan.y + extentZ / 2);
    for (const p of record.plan.parts.slice(0, record.progress)) {
      const active = partIsActive(record.plan, p.id, record.signals), roof = p.shape === 'roof';
      const key = `${p.shape}:${p.material}:${p.shape === 'lamp' && active ? 'lit' : 'plain'}`;
      const color = roof ? COLORS.roof : p.shape === 'door' ? COLORS.door : p.shape === 'switch' ? COLORS.switch : COLORS[p.material];
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { geometry: roof ? ROOF : BOX, material: mat(key, color, p.material === 'glass', p.shape === 'lamp' && active), matrices: [], tags: [] }; buckets.set(key, bucket); }
      let x = record.plan.x + p.x + p.w / 2, z = record.plan.y + p.z + p.d / 2;
      const scale = new THREE.Vector3(p.w, p.h, p.d), rotation = new THREE.Quaternion();
      if (p.shape === 'door') {
        scale.set(.85, p.h, .12);
        if (active) { rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2); x = record.plan.x + p.x + .075; z = record.plan.y + p.z + .5; }
        else { x = record.plan.x + p.x + .5; z = record.plan.y + p.z + .075; }
      }
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, ground + p.y + p.h / 2, z), rotation, scale);
      if (p.shape === 'lamp' && active) lamps.push(new THREE.Vector3(x, ground + p.y + p.h / 2, z));
      bucket.matrices.push(matrix); bucket.tags.push({ creationId: record.creationId, partId: p.id });
    }
  }
  for (const bucket of buckets.values()) {
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.matrices.length);
    bucket.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.tags = bucket.tags; mesh.computeBoundingSphere(); root.add(mesh);
    if (bucket.geometry === ROOF) mesh.userData.roofMatrices = bucket.matrices;
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
