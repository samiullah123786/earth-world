/**
 * Drawing the whole town in a handful of draw calls.
 *
 * Every separate mesh is a separate draw call, and browsers start dropping
 * frames somewhere past five hundred of them. This world was issuing one
 * thousand one hundred and forty: twenty-five buildings at thirty-five meshes
 * each, twenty citizens at thirteen, and - the detail that gives the game away
 * - eight thousand three hundred plants at FIVE, because the decoration layer
 * was already instanced and nothing else was.
 *
 * So the fix is not a different engine. Every engine issues draw calls the same
 * way. The fix is to stop handing the GPU one box at a time.
 *
 * The whole renderer already funnels through a single primitive, `addBlock`,
 * which builds one Mesh per plank. This module replaces the destination rather
 * than the callers: boxes accumulate here, and one InstancedMesh per STYLE -
 * not per colour - draws all of them together. Colour rides along per instance,
 * so a timber wall and a stone wall share a draw call as long as they shade the
 * same way. Twenty-odd materials collapse to a handful of styles, and the town
 * goes from over a thousand draw calls to roughly ten.
 */

import * as THREE from 'three';

/**
 * A unit box carrying soft shading baked into its vertices.
 *
 * Voxel worlds live or die on the darkness in their crevices, and real ambient
 * occlusion means either a post-processing pass that costs more than it is
 * worth here, or neighbour lookups the batch deliberately does not have. This
 * is the cheap honest version: every box is darker at its base and along its
 * lower edges, the way a solid object sitting on the ground actually is.
 * Three.js multiplies vertex colour by instance colour by material colour, so
 * it composes with everything else for free.
 */
export function shadedBox(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const position = box.getAttribute('position');
  const shade = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const y = position.getY(index);      // -0.5 at the base, +0.5 at the top
    const z = position.getZ(index);
    // A vertical gradient does most of the work; a slight north-south bias
    // keeps flat-on faces from reading as one dead colour under a low sun.
    // Darkens only. An earlier version brightened the top face past 1.0, which
    // on a sunlit meadow blew the whole ground out to near-white.
    const vertical = 0.68 + (y + 0.5) * 0.32;
    const facing = 1 + z * 0.04;
    const value = Math.min(1.0, vertical * facing);
    shade[index * 3] = value;
    shade[index * 3 + 1] = value;
    shade[index * 3 + 2] = value;
  }
  box.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  return box;
}

/**
 * How a surface shades, with its colour removed and its roughness rounded.
 *
 * Two blocks that differ only in colour belong in the same draw call - that is
 * what per-instance colour is for. But the first version keyed on EXACT
 * roughness, and a citizen's tunic at 0.75, skin at 0.78 and trousers at 0.80
 * are three visually identical surfaces that were being drawn three separate
 * times. Rounding to a tenth collapses them into one bucket and changes nothing
 * anybody can see.
 *
 * Transparency and emission are deliberately NOT rounded away: a lit window
 * merged into a wall would be a real visual change, not a rounding error.
 */
function styleKeyOf(material: THREE.Material): string {
  const standard = material as THREE.MeshStandardMaterial;
  const step = (value: number) => Math.round(value * 10) / 10;
  return [
    step(standard.roughness ?? 1),
    step(standard.metalness ?? 0),
    material.transparent ? 1 : 0,
    step(material.opacity ?? 1),
    (standard.emissive?.getHex?.() ?? 0),
    step(standard.emissiveIntensity ?? 0),
    material.side ?? THREE.FrontSide,
  ].join('|');
}

type Bucket = {
  material: THREE.MeshStandardMaterial;
  matrices: THREE.Matrix4[];
  colors: THREE.Color[];
  /** Which citizen or building each instance belongs to, for picking. */
  tags: (string | null)[];
};

const SCRATCH = new THREE.Matrix4();
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_SCALE = new THREE.Vector3();
const NO_ROTATION = new THREE.Quaternion();

/**
 * Collects boxes, then draws them all at once.
 *
 * Deliberately not clever about when to flush: the caller knows when a build
 * pass is finished, and guessing would mean rebuilding the town mid-frame.
 */
export class BlockBatch {
  private buckets = new Map<string, Bucket>();
  private meshes: THREE.InstancedMesh[] = [];
  private geometry = shadedBox();

  constructor(private root: THREE.Group) {}

  /**
   * Record one box. Same arguments as the Mesh-per-plank version it replaced,
   * so the fifty-odd call sites across terrain, buildings and interiors did not
   * have to change at all.
   */
  add(
    x: number, y: number, z: number,
    width: number, height: number, depth: number,
    material: THREE.Material, tag: string | null = null,
  ): void {
    const key = styleKeyOf(material);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // One material per style, cloned so per-instance colour is free to vary
      // without the original material's colour fighting it.
      const source = material as THREE.MeshStandardMaterial;
      const shared = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: source.roughness ?? 1,
        metalness: source.metalness ?? 0,
        transparent: material.transparent,
        opacity: material.opacity,
        emissive: source.emissive?.clone?.() ?? new THREE.Color(0x000000),
        emissiveIntensity: source.emissiveIntensity ?? 0,
        side: material.side,
        vertexColors: true,
      });
      bucket = { material: shared, matrices: [], colors: [], tags: [] };
      this.buckets.set(key, bucket);
    }
    SCRATCH_POS.set(x + width / 2, y + height / 2, z + depth / 2);
    SCRATCH_SCALE.set(width, height, depth);
    bucket.matrices.push(new THREE.Matrix4().compose(SCRATCH_POS, NO_ROTATION, SCRATCH_SCALE));
    bucket.colors.push((material as THREE.MeshStandardMaterial).color?.clone?.() ?? new THREE.Color(0xffffff));
    bucket.tags.push(tag);
  }

  /**
   * Record a box that already has a transform.
   *
   * This is how existing scene-graph code gets batched without being rewritten:
   * a builder assembles its meshes into a throwaway Group exactly as before,
   * and `absorb` reads each one's composed world matrix straight in - rotation
   * and nesting included, which the corner-and-size form cannot express.
   */
  addMatrix(matrix: THREE.Matrix4, material: THREE.Material, tag: string | null = null): void {
    const key = styleKeyOf(material);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const source = material as THREE.MeshStandardMaterial;
      bucket = {
        material: new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: source.roughness ?? 1,
          metalness: source.metalness ?? 0,
          transparent: material.transparent,
          opacity: material.opacity,
          emissive: source.emissive?.clone?.() ?? new THREE.Color(0x000000),
          emissiveIntensity: source.emissiveIntensity ?? 0,
          side: material.side,
          vertexColors: true,
        }),
        matrices: [], colors: [], tags: [],
      };
      this.buckets.set(key, bucket);
    }
    bucket.matrices.push(matrix.clone());
    bucket.colors.push((material as THREE.MeshStandardMaterial).color?.clone?.() ?? new THREE.Color(0xffffff));
    bucket.tags.push(tag);
  }

  /** Build the instanced meshes. Everything added since the last clear lands here. */
  flush(): THREE.InstancedMesh[] {
    for (const bucket of this.buckets.values()) {
      if (!bucket.matrices.length) continue;
      const mesh = new THREE.InstancedMesh(this.geometry, bucket.material, bucket.matrices.length);
      for (let index = 0; index < bucket.matrices.length; index++) {
        mesh.setMatrixAt(index, bucket.matrices[index]);
        mesh.setColorAt(index, bucket.colors[index]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The town is rebuilt from the Kernel's own bounds, so the automatic
      // bounding sphere is fine - but it must be computed once or half the
      // world vanishes the moment the camera turns.
      mesh.computeBoundingSphere();
      mesh.userData.tags = bucket.tags;
      mesh.userData.originals = bucket.matrices.slice();
      this.root.add(mesh);
      this.meshes.push(mesh);
    }
    return this.meshes;
  }

  /** Throw away everything, including the GPU buffers. */
  clear(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh);
      mesh.dispose();
    }
    this.meshes = [];
    for (const bucket of this.buckets.values()) {
      bucket.matrices.length = 0;
      bucket.colors.length = 0;
      bucket.tags.length = 0;
    }
  }


  /**
   * Hide or restore every instance carrying one tag.
   *
   * Instancing means a roof is no longer an object with a `visible` flag, so
   * hiding one building's roof while you stand inside it needs this: the
   * instances belonging to that tag are collapsed to zero scale and put back
   * from their stored originals afterwards. It walks every instance, which is
   * fine because it only runs when somebody crosses a threshold - not per frame.
   */
  setHidden(tag: string, hidden: boolean): void {
    for (const mesh of this.meshes) {
      const tags = mesh.userData.tags as (string | null)[] | undefined;
      const originals = mesh.userData.originals as THREE.Matrix4[] | undefined;
      if (!tags || !originals) continue;
      let touched = false;
      for (let index = 0; index < tags.length; index++) {
        if (tags[index] !== tag) continue;
        if (hidden) SCRATCH.makeScale(0, 0, 0);
        else SCRATCH.copy(originals[index]);
        mesh.setMatrixAt(index, SCRATCH);
        touched = true;
      }
      if (touched) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** What this batch actually costs, for the performance readout. */
  get drawCalls(): number {
    return this.meshes.length;
  }

  get instanceCount(): number {
    return this.meshes.reduce((sum, mesh) => sum + mesh.count, 0);
  }

  /** Which tag sits under a ray, if any - instanced picking. */
  tagAt(intersection: THREE.Intersection): string | null {
    const tags = intersection.object.userData.tags as (string | null)[] | undefined;
    if (!tags || intersection.instanceId === undefined) return null;
    return tags[intersection.instanceId] ?? null;
  }

  get pickables(): THREE.Object3D[] {
    return this.meshes;
  }
}

/** Reuse one scratch matrix rather than allocating per instance per frame. */
export function composeInto(
  target: THREE.Matrix4,
  x: number, y: number, z: number,
  width: number, height: number, depth: number,
): THREE.Matrix4 {
  SCRATCH_POS.set(x + width / 2, y + height / 2, z + depth / 2);
  SCRATCH_SCALE.set(width, height, depth);
  return target.compose(SCRATCH_POS, NO_ROTATION, SCRATCH_SCALE);
}

export { SCRATCH as scratchMatrix };

/**
 * Pour a scene-graph group into a batch, and drop the group.
 *
 * The renderer's builders - houses, gardens, the gate, interiors - each
 * assemble a Group of Meshes. Rather than rewriting all of them to speak
 * instance-buffer, this reads the finished Group and throws it away. Lights and
 * sprites are handed back instead of absorbed, because neither is a box and
 * both still need to live in the scene graph.
 */
export function absorb(
  group: THREE.Object3D, batch: BlockBatch, tag: string | null = null,
): { lights: THREE.Light[]; sprites: THREE.Object3D[] } {
  group.updateMatrixWorld(true);
  const lights: THREE.Light[] = [];
  const sprites: THREE.Object3D[] = [];
  group.traverse((node) => {
    if ((node as THREE.Light).isLight) { lights.push(node as THREE.Light); return; }
    if ((node as THREE.Sprite).isSprite) { sprites.push(node); return; }
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    batch.addMatrix(mesh.matrixWorld, mesh.material as THREE.Material, tag);
  });
  return { lights, sprites };
}
