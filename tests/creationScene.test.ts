import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { starterHome, type CreationRecord } from '../shared/creation';
import { creationPartFinishes, revealCreationInteriors, syncCreationScene } from '../src/world3d/creationScene';

const record = (id = 'creation:test'): CreationRecord => {
  const plan = starterHome(10, 10);
  return { creationId: id, ownerAgentId: 'agent:test', name: plan.name, revision: 1, state: 'built', progress: plan.parts.length, plan,
    signals: { 'door-power': true, 'light-power': false } };
};
const UNIT = new THREE.Box3(new THREE.Vector3(-.5, -.5, -.5), new THREE.Vector3(.5, .5, .5));

describe('native assembly finish keeps the committed contract', () => {
  it('keeps every finish inside its own part in both door states', () => {
    const plan = starterHome(0, 0);
    for (const part of plan.parts) for (const active of [false, true]) {
      const bounds = new THREE.Box3(new THREE.Vector3(part.x, part.y, part.z), new THREE.Vector3(part.x + part.w, part.y + part.h, part.z + part.d)).expandByScalar(.00001);
      for (const finish of creationPartFinishes(part, true, active)) {
        expect(bounds.containsBox(UNIT.clone().applyMatrix4(finish.matrix)), `${part.id}/${finish.key}/${active}`).toBe(true);
      }
    }
  });

  it('keeps timber objects honest and only paints home wall panels with plaster', () => {
    const wall = starterHome(0, 0).parts.find(p => p.id === 'wall-0-0')!;
    expect(creationPartFinishes(wall, false, false).map(p => p.key)).toEqual(['plank']);
    expect(creationPartFinishes(wall, true, false).some(p => p.key === 'plaster')).toBe(true);
  });

  it('draws only committed progress and keeps finish picks attached to their real part', () => {
    const root = new THREE.Group(), row = record();
    syncCreationScene(root, [{ ...row, state: 'building', progress: 0 }], () => 0);
    expect(root.children).toHaveLength(0);
    syncCreationScene(root, [{ ...row, state: 'building', progress: 1 }], () => 0);
    for (const mesh of root.children) expect(mesh.userData.tags.every((tag: any) => tag.partId === 'foundation' && tag.creationId === row.creationId)).toBe(true);
    syncCreationScene(root, [row], () => 0);
    expect(root.children.length).toBeLessThanOrEqual(12);
    const allowed = new Set(row.plan.parts.map(p => p.id));
    for (const mesh of root.children) expect(mesh.userData.tags.every((tag: any) => allowed.has(tag.partId))).toBe(true);
  });

  it('hides the entire roof finish of just the occupied home and restores it', () => {
    const root = new THREE.Group(), first = record(), second = record('creation:neighbor');
    second.plan = { ...second.plan, x: 30 };
    syncCreationScene(root, [first, second], () => 0);
    const roofs = root.children.filter(mesh => mesh.userData.roofMatrices) as THREE.InstancedMesh[];
    expect(roofs.length).toBeGreaterThan(1);
    revealCreationInteriors(root, [first, second], { x: 12, z: 12 });
    for (const mesh of roofs) for (let i = 0; i < mesh.count; i++) {
      const matrix = new THREE.Matrix4(); mesh.getMatrixAt(i, matrix);
      expect(Math.abs(matrix.determinant()) < .00001).toBe(mesh.userData.tags[i].creationId === first.creationId);
    }
    revealCreationInteriors(root, [first, second], null);
    for (const mesh of roofs) for (let i = 0; i < mesh.count; i++) {
      const matrix = new THREE.Matrix4(); mesh.getMatrixAt(i, matrix);
      expect(Math.abs(matrix.determinant())).toBeGreaterThan(0);
    }
    const sloped = roofs.find(mesh => !mesh.geometry.index && mesh.geometry.getAttribute('position').count === 24)!;
    const normals = sloped.geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(normals, i);
      expect(a.distanceTo(new THREE.Vector3().fromBufferAttribute(normals, i + 1))).toBeLessThan(.00001);
      expect(a.distanceTo(new THREE.Vector3().fromBufferAttribute(normals, i + 2))).toBeLessThan(.00001);
    }
  });
});
