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
  /** Which shading bucket this piece belongs in. */
  style: string;
  /**
   * The shape to draw.
   *
   * Carried per part rather than assumed, which is exactly what a modelled
   * character needs. The first version of this batch drew every part with one
   * shared unit cube, so harvesting a real character collected its transforms
   * and its colours perfectly - and then rendered the whole cast as boxes
   * anyway, which is a bug that looks like nothing happening at all.
   */
  geometry?: THREE.BufferGeometry;
  /** The material it came with, for a part that brought its own texture. */
  material?: THREE.Material;
};

export type Rig = {
  agentId: string;
  parts: RigPart[];
  /** Height multiplier from this citizen's own look. */
  scale: number;
  /**
   * Which cell of the skin atlas this citizen wears.
   *
   * Every citizen shares one mesh and one texture; what makes them look like
   * themselves is a UV offset written per instance. That is the whole trick
   * behind a town of thousands of distinct people costing six draw calls.
   */
  skinCell?: [number, number];
  /**
   * Where this rig's joints turn, when they are not the built-in ones.
   *
   * A modelled character brings its own proportions, and its shoulders are
   * wherever the artist put them. Reading the pivot off the model rather than
   * assuming the old box-body numbers is the difference between an arm that
   * swings and an arm that pivots through the chest.
   */
  pivots?: Partial<Record<Joint, THREE.Vector3>>;
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


/** Kenney's character nodes, mapped onto this rig's joints. */
const NODE_JOINTS: Record<string, Joint> = {
  torso: 'body', root: 'body', head: 'head',
  'arm-left': 'leftArm', 'arm-right': 'rightArm',
  'leg-left': 'leftLeg', 'leg-right': 'rightLeg',
};

/**
 * Turn a modelled character into a rig this batch can draw.
 *
 * The happy accident that made this cheap: Kenney's blocky characters are
 * built from exactly the joints this rig already had - torso, head, two arms,
 * two legs - moved by node rotations rather than by a skeleton deforming a
 * skin. Which means they need no skinning, no bone matrices, and no special
 * case; they go through the same instanced path the box people did, so a town
 * of two thousand modelled citizens costs what twenty did.
 *
 * The pivots come off the model rather than from this file's constants,
 * because an artist's shoulder is wherever they put it.
 */
export function rigFromModel(
  scene: THREE.Object3D, agentId: string, scale: number,
  skin?: { material: THREE.Material; cell: [number, number] },
): Rig {
  const parts: RigPart[] = [];
  const pivots: Partial<Record<Joint, THREE.Vector3>> = {};
  scene.updateMatrixWorld(true);
  scene.traverse((node) => {
    const joint = NODE_JOINTS[node.name];
    if (!joint) return;
    // The joint turns where its node sits, in the model's own space.
    pivots[joint] = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    // The node itself, and only the node. Walking its children as well
    // collected the torso twice - once reached through `root` and once as
    // itself - and drew every citizen's chest on top of their chest.
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    parts.push({
      joint, matrix: mesh.matrixWorld.clone(),
      color: material.color?.clone?.() ?? new THREE.Color(0xffffff),
      // One style for every citizen when they share the atlas, so all of them
      // land in the same six buckets - one per body part - however many people
      // are in town.
      style: skin ? 'atlas' : styleOf(material),
      // The whole point: the shape somebody drew, rather than a unit cube.
      geometry: mesh.geometry,
      material: skin ? skin.material : material,
    });
  });
  return { agentId, parts, scale, pivots, skinCell: skin?.cell };
}


/**
 * The material every citizen wears.
 *
 * One texture holding sixty-four skins in a grid, and a per-instance offset
 * that picks a cell. The alternative - a material per look - would be sixty-four
 * draw calls for a crowd that currently costs six, and would grow with the
 * town rather than staying flat.
 *
 * The shader edit is four lines. Three.js computes `vMapUv` from the mesh's own
 * UVs; this scales that into one cell and shifts it to the right square. Nothing
 * else about the standard material changes, so it keeps its lighting, its
 * shadows and its fog.
 */
export function skinAtlasMaterial(texture: THREE.Texture, grid: number): THREE.MeshStandardMaterial {
  texture.colorSpace = THREE.SRGBColorSpace;
  // Nearest, because these are blocky skins and smoothing them bleeds one
  // citizen's collar into the next citizen's cell.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;

  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.86 });
  const scale = (1 / grid).toFixed(8);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute vec2 aSkinCell;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = vMapUv * ${scale} + aSkinCell;
      #endif`,
    );
  };
  // Without this, a second material with the same parameters could be handed
  // this one's compiled program - and arrive without the attribute.
  material.customProgramCacheKey = () => `skin-atlas-${grid}`;
  return material;
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
  /** What each bucket is made of, keyed the same way the buckets are. */
  private shapes = new Map<string, { geometry: THREE.BufferGeometry; material?: THREE.Material }>();
  /** The per-instance atlas cell, one buffer per bucket. */
  private cells = new Map<string, THREE.InstancedBufferAttribute>();

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

  private ensure(key: string, needed: number): THREE.InstancedMesh {
    const existing = this.meshes.get(key);
    if (existing && (this.capacity.get(key) ?? 0) >= needed) return existing;
    if (existing) {
      this.root.remove(existing);
      existing.dispose();
    }
    // Round up so a town gaining one citizen does not rebuild every buffer.
    const size = Math.max(64, Math.ceil(needed * 1.5));
    const shape = this.shapes.get(key);
    let material: THREE.Material;
    if (shape?.material) {
      // A modelled part brings its own material - the character's texture
      // atlas - and a per-instance tint would only fight it.
      material = shape.material;
    } else {
      const [roughness, metalness, transparent, opacity, emissive, emissiveIntensity] =
        key.split('|').map(Number);
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness, metalness,
        transparent: Boolean(transparent), opacity,
        emissive: new THREE.Color(emissive), emissiveIntensity,
        vertexColors: true,
        ...STYLE_TEMPLATES[key],
      });
    }
    const mesh = new THREE.InstancedMesh(shape?.geometry ?? this.geometry, material, size);
    // The attribute the skin shader reads. Allocated with the mesh so it is
    // always exactly as long as the instance buffer beside it.
    const cell = new THREE.InstancedBufferAttribute(new Float32Array(size * 2), 2);
    cell.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('aSkinCell', cell);
    this.cells.set(key, cell);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // the batch spans the whole town
    mesh.count = 0;
    this.root.add(mesh);
    this.meshes.set(key, mesh);
    this.capacity.set(key, size);
    return mesh;
  }

  /** The bucket a part belongs in: the same shape AND the same shading. */
  private static keyOf(part: RigPart): string {
    return part.geometry ? `${part.geometry.uuid}|${part.style}` : part.style;
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
        const key = CitizenBatch.keyOf(part);
        needed.set(key, (needed.get(key) ?? 0) + 1);
        if (part.geometry && !this.shapes.has(key)) {
          this.shapes.set(key, { geometry: part.geometry, material: part.material });
        }
      }
    }
    for (const [key, count] of needed) this.ensure(key, count);
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
          const pivot = rig.pivots?.[part.joint] ?? PIVOTS[part.joint];
          this.pivotOut.makeTranslation(pivot.x, pivot.y, pivot.z);
          this.pivotBack.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
          this.rotation.makeRotationX(angle);
          this.jointMatrix.copy(this.pivotOut).multiply(this.rotation).multiply(this.pivotBack);
          this.partMatrix.copy(this.bodyMatrix).multiply(this.jointMatrix).multiply(part.matrix);
        } else {
          this.partMatrix.copy(this.bodyMatrix).multiply(part.matrix);
        }
        const key = CitizenBatch.keyOf(part);
        const mesh = this.meshes.get(key)!;
        const index = counts.get(key) ?? 0;
        mesh.setMatrixAt(index, this.partMatrix);
        // Per-instance colour only where the part has no material of its own.
        // Tinting a textured character would throw the atlas away.
        if (!this.shapes.get(key)?.material) mesh.setColorAt(index, part.color);
        const cell = this.cells.get(key);
        if (cell && rig.skinCell) {
          cell.setXY(index, rig.skinCell[0], rig.skinCell[1]);
        }
        const tags = this.tags.get(key)!;
        tags[index] = rig.agentId;
        counts.set(key, index + 1);
      }
    }

    for (const [style, mesh] of this.meshes) {
      mesh.count = counts.get(style) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const cell = this.cells.get(style);
      if (cell) cell.needsUpdate = true;
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
