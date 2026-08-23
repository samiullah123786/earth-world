/**
 * Every citizen in the town, drawn together.
 *
 * Buildings are static, so batching them is easy: build once, draw forever.
 * Citizens are the hard half - they walk, swing the tool they earned, turn to
 * face whoever they are shaking hands with, and each one wears a body derived
 * from their own agent id. Twenty of them cost two hundred and sixty draw
 * calls, and the whole point of this world is that it should hold far more than
 * twenty people.
 *
 * The approach here deliberately does NOT rewrite the character art. The kit in
 * citizenKit.ts already knows how to build a face, a sash, a pickaxe and a
 * surveyor's hat, and rewriting all of that as instance data by hand would lose
 * details nobody would notice were missing until much later. Instead a citizen
 * is assembled exactly as before, once, off-screen - and then HARVESTED: each
 * piece's local transform and colour is read out and the throwaway meshes are
 * dropped. What survives is a rig, a flat list of boxes each attached to a
 * joint, and every citizen in the world is drawn from one shared InstancedMesh
 * per surface style.
 *
 * Animation then happens on matrices rather than on scene-graph nodes. That is
 * also why the arms finally swing from the shoulder instead of from their own
 * middle: a rig has real pivots, where a Mesh rotating about its centre never
 * did.
 */

import * as THREE from 'three';

/** What a box is attached to. Everything else rides on the body. */
export type Joint = 'body' | 'head' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

/** Where each joint turns. A shoulder, not a mid-humerus. */
export const PIVOTS: Record<Joint, THREE.Vector3> = {
  body: new THREE.Vector3(0, 0, 0),
  head: new THREE.Vector3(0, 1.5, 0),
  leftArm: new THREE.Vector3(-0.325, 1.45, 0),
  rightArm: new THREE.Vector3(0.325, 1.45, 0),
  leftLeg: new THREE.Vector3(-0.115, 0.76, 0),
  rightLeg: new THREE.Vector3(0.115, 0.76, 0),
};

export type RigPart = {
  joint: Joint;
  /** Local transform, relative to the citizen standing at the origin. */
  matrix: THREE.Matrix4;
  color: THREE.Color;
  /** Which shading bucket this box belongs in. */
  style: string;
};

export type Rig = {
  agentId: string;
  parts: RigPart[];
  /** Height multiplier from this citizen's own look. */
  scale: number;
};

/**
 * Which bucket a surface belongs in, rounded.
 *
 * A citizen's tunic at 0.75, their skin at 0.78 and their trousers at 0.80 are
 * three visually identical surfaces. Keyed exactly they were three draw calls
 * per person; rounded to a tenth they are one, and nothing looks different.
 */
function styleOf(material: THREE.Material): string {
  const standard = material as THREE.MeshStandardMaterial;
  const step = (value: number) => Math.round(value * 10) / 10;
  return [
    step(standard.roughness ?? 1), step(standard.metalness ?? 0),
    material.transparent ? 1 : 0, step(material.opacity ?? 1),
    standard.emissive?.getHex?.() ?? 0, step(standard.emissiveIntensity ?? 0),
  ].join('|');
}

/**
 * Read a throwaway group of meshes into rig parts.
 *
 * `world.updateMatrixWorld` first, because the kit nests a tool inside a hand
 * group inside the citizen, and only the composed world matrix knows where the
 * pickaxe head actually ended up.
 */
export function harvest(source: THREE.Object3D, joint: Joint, into: RigPart[]): RigPart[] {
  source.updateMatrixWorld(true);
  source.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    into.push({
      joint,
      matrix: mesh.matrixWorld.clone(),
      color: material.color?.clone?.() ?? new THREE.Color(0xffffff),
      style: styleOf(material),
    });
  });
  return into;
}

/** How each joint is turned this frame. */
export type Pose = {
  /** Where the citizen's feet are, in world space. */
  x: number; y: number; z: number;
  heading: number;
  /** Radians about X, per limb. */
  leftArm: number; rightArm: number; leftLeg: number; rightLeg: number;
  /** A forward lean, for work that deserves one. */
  lean: number;
  scale: number;
};

const STYLE_TEMPLATES: Record<string, THREE.MeshStandardMaterialParameters> = {};

/**
 * One InstancedMesh per surface style, holding every citizen in the world.
 *
 * Capacity is grown by rebuilding rather than by allocating for a city that may
 * never arrive: a town of thirty should not pay the memory of a town of four
 * thousand, and a rebuild costs one frame on the rare occasion the town doubles.
 */
export class CitizenBatch {
  private meshes = new Map<string, THREE.InstancedMesh>();
  private capacity = new Map<string, number>();
  private geometry: THREE.BufferGeometry;
  private tags = new Map<string, string[]>();

  private jointMatrix = new THREE.Matrix4();
  private bodyMatrix = new THREE.Matrix4();
  private partMatrix = new THREE.Matrix4();
  private pivotOut = new THREE.Matrix4();
  private pivotBack = new THREE.Matrix4();
  private rotation = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scaleVector = new THREE.Vector3();

  constructor(private root: THREE.Group, geometry: THREE.BufferGeometry) {
    this.geometry = geometry;
  }

  private ensure(style: string, needed: number): THREE.InstancedMesh {
    const existing = this.meshes.get(style);
    if (existing && (this.capacity.get(style) ?? 0) >= needed) return existing;
    if (existing) {
      this.root.remove(existing);
      existing.dispose();
    }
    // Round up so a town gaining one citizen does not rebuild every buffer.
    const size = Math.max(64, Math.ceil(needed * 1.5));
    const [roughness, metalness, transparent, opacity, emissive, emissiveIntensity] =
      style.split('|').map(Number);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness, metalness,
      transparent: Boolean(transparent), opacity,
      emissive: new THREE.Color(emissive), emissiveIntensity,
      vertexColors: true,
      ...STYLE_TEMPLATES[style],
    });
    const mesh = new THREE.InstancedMesh(this.geometry, material, size);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // the batch spans the whole town
    mesh.count = 0;
    this.root.add(mesh);
    this.meshes.set(style, mesh);
    this.capacity.set(style, size);
    return mesh;
  }

  /**
   * Draw every citizen, in whatever pose they are in this instant.
   *
   * Called once per frame with the whole cast, rather than per citizen, because
   * the instance buffers must be filled contiguously - and because writing them
   * in one pass is what keeps this to a handful of draw calls however many
   * people are in town.
   */
  render(entries: Array<{ rig: Rig; pose: Pose }>): void {
    const counts = new Map<string, number>();
    for (const style of this.meshes.keys()) counts.set(style, 0);

    // First pass: how many instances each style needs this frame.
    const needed = new Map<string, number>();
    for (const entry of entries) {
      for (const part of entry.rig.parts) {
        needed.set(part.style, (needed.get(part.style) ?? 0) + 1);
      }
    }
    for (const [style, count] of needed) this.ensure(style, count);
    for (const style of this.meshes.keys()) {
      counts.set(style, 0);
      this.tags.set(style, this.tags.get(style) ?? []);
    }

    for (const entry of entries) {
      const { pose, rig } = entry;
      // The citizen's own transform: where they stand, which way they face,
      // how tall they happen to be.
      this.position.set(pose.x, pose.y, pose.z);
      this.quaternion.setFromEuler(new THREE.Euler(pose.lean, pose.heading, 0, 'YXZ'));
      this.scaleVector.setScalar(pose.scale);
      this.bodyMatrix.compose(this.position, this.quaternion, this.scaleVector);

      for (const part of rig.parts) {
        const angle = part.joint === 'leftArm' ? pose.leftArm
          : part.joint === 'rightArm' ? pose.rightArm
            : part.joint === 'leftLeg' ? pose.leftLeg
              : part.joint === 'rightLeg' ? pose.rightLeg
                : 0;
        if (angle !== 0) {
          const pivot = PIVOTS[part.joint];
          this.pivotOut.makeTranslation(pivot.x, pivot.y, pivot.z);
          this.pivotBack.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
          this.rotation.makeRotationX(angle);
          this.jointMatrix.copy(this.pivotOut).multiply(this.rotation).multiply(this.pivotBack);
          this.partMatrix.copy(this.bodyMatrix).multiply(this.jointMatrix).multiply(part.matrix);
        } else {
          this.partMatrix.copy(this.bodyMatrix).multiply(part.matrix);
        }
        const mesh = this.meshes.get(part.style)!;
        const index = counts.get(part.style) ?? 0;
        mesh.setMatrixAt(index, this.partMatrix);
        mesh.setColorAt(index, part.color);
        const tags = this.tags.get(part.style)!;
        tags[index] = rig.agentId;
        counts.set(part.style, index + 1);
      }
    }

    for (const [style, mesh] of this.meshes) {
      mesh.count = counts.get(style) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.userData.tags = this.tags.get(style);
    }
  }

  get drawCalls(): number {
    let count = 0;
    for (const mesh of this.meshes.values()) if (mesh.count > 0) count++;
    return count;
  }

  get pickables(): THREE.Object3D[] {
    return [...this.meshes.values()];
  }

  /** Which citizen a ray hit, if it hit one. */
  static agentAt(intersection: THREE.Intersection): string | null {
    const tags = intersection.object.userData.tags as string[] | undefined;
    if (!tags || intersection.instanceId === undefined) return null;
    return tags[intersection.instanceId] ?? null;
  }
}
