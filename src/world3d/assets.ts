/**
 * Real models, made by somebody who draws for a living.
 *
 * The honest diagnosis of why this world looked like programmer art is that it
 * WAS programmer art: every house, tree, fence and person in it was assembled
 * at runtime out of axis-aligned boxes by code. No renderer fixes that. Unity,
 * Godot, Babylon and Unreal would each have reproduced the same picture,
 * because the picture was never a rendering problem - there simply were no
 * assets in the project, of any kind, at all.
 *
 * So this loads some. Kenney's kits are CC0 - public domain, no attribution
 * required, free - and between the suburban, commercial and nature kits there
 * are several hundred models drawn by a professional. They arrive as glTF, one
 * material each over a shared texture atlas, which is exactly the shape that
 * instances well: a whole street of houses is one draw call per building type.
 *
 * What matters about the CHARACTERS is worth stating separately, because it
 * decided the approach. They carry twenty-seven animations - idle, walk,
 * sprint, sit, pick-up, emote-yes, interact, and so on - and NO SKIN. They are
 * rigid parts moved by node transforms, not a skinned mesh deformed by bones.
 * Skinned characters in a browser start dropping frames somewhere around thirty
 * on screen; rigid parts are just boxes with better shapes on them, and go
 * through the same instanced batch the previous ones did. Twenty citizens, or
 * two thousand, still cost a handful of draw calls.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** One loaded model, flattened to what the batcher needs. */
export type Piece = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
};

export type Model = {
  name: string;
  pieces: Piece[];
  /** Size in world units, so a model can be scaled onto a plot. */
  size: THREE.Vector3;
  /** Animation clips, for the models that have them. */
  clips: THREE.AnimationClip[];
  /** The node hierarchy, kept for sampling animation onto instances. */
  scene: THREE.Object3D;
};

const loader = new GLTFLoader();
const cache = new Map<string, Promise<Model>>();

/**
 * Load one model, flattened and pre-transformed.
 *
 * Every mesh's own transform is baked into its geometry here, so the batcher
 * downstream only ever has to think about where the whole model goes - not
 * about the nested nodes a modelling package happened to leave behind.
 */
export function loadModel(url: string): Promise<Model> {
  const existing = cache.get(url);
  if (existing) return existing;

  const pending = new Promise<Model>((resolve, reject) => {
    loader.load(url, (gltf) => {
      const pieces: Piece[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        pieces.push({ geometry, material });
      });
      // Merge everything that shares a material into one piece.
      //
      // Kenney's kits paint a whole model from one texture atlas, so a cat that
      // arrives as seven meshes - body, head, ears, legs, tail - is seven draw
      // calls for one animal and no visual difference at all. Twelve animals
      // came to sixty-three calls before this; afterwards, twelve.
      const merged: Piece[] = [];
      const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const piece of pieces) {
        const list = byMaterial.get(piece.material) ?? [];
        list.push(piece.geometry);
        byMaterial.set(piece.material, list);
      }
      for (const [material, geometries] of byMaterial) {
        if (geometries.length === 1) {
          merged.push({ geometry: geometries[0], material });
          continue;
        }
        // Merging needs matching attribute sets; if a model mixes them, keep
        // the pieces rather than lose one.
        const one = mergeGeometries(geometries, false);
        if (one) merged.push({ geometry: one, material });
        else for (const geometry of geometries) merged.push({ geometry, material });
      }
      pieces.length = 0;
      pieces.push(...merged);

      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      resolve({
        name: url.split('/').pop() ?? url,
        pieces, size,
        clips: gltf.animations ?? [],
        scene: gltf.scene,
      });
    }, undefined, reject);
  });
  cache.set(url, pending);
  return pending;
}

export async function loadModels(urls: string[]): Promise<Model[]> {
  // Settled rather than all-or-nothing: one missing file should cost that one
  // model, not the whole town.
  const results = await Promise.allSettled(urls.map(loadModel));
  return results.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));
}

/**
 * Draws many copies of one model.
 *
 * One InstancedMesh per piece of the model - which for a Kenney kit is usually
 * one, because they share a texture atlas. A street of forty houses of the same
 * type is a single draw call.
 */
export class ModelInstances {
  private meshes: THREE.InstancedMesh[] = [];
  private matrices: THREE.Matrix4[] = [];
  private tags: string[] = [];

  constructor(private root: THREE.Object3D, private model: Model) {}

  add(matrix: THREE.Matrix4, tag = ''): void {
    this.matrices.push(matrix.clone());
    this.tags.push(tag);
  }

  flush(): void {
    this.dispose();
    if (!this.matrices.length) return;
    for (const piece of this.model.pieces) {
      const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, this.matrices.length);
      for (let index = 0; index < this.matrices.length; index++) {
        mesh.setMatrixAt(index, this.matrices[index]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      mesh.userData.tags = this.tags;
      this.root.add(mesh);
      this.meshes.push(mesh);
    }
  }

  clear(): void {
    this.matrices.length = 0;
    this.tags.length = 0;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh);
      mesh.dispose();
    }
    this.meshes = [];
  }

  get drawCalls(): number { return this.meshes.length; }
  get pickables(): THREE.Object3D[] { return this.meshes; }
}

/**
 * A transform that stands a model on a plot of a given size.
 *
 * Kenney's kits are modelled to a one-unit grid with the origin at the centre
 * of the footprint and the base on y=0, so this is mostly a scale and a shift -
 * but the shift matters: getting it wrong buries a house to its windows or
 * floats it a metre off the ground, and both look like the same bug.
 */
export function fitToPlot(
  model: Model, plot: { x: number; y: number; w: number; h: number }, ground: number,
  facing = 0,
): THREE.Matrix4 {
  const footprint = Math.max(model.size.x, model.size.z) || 1;
  // Nearly the whole parcel. The earlier 0.82 left a polite margin and made
  // every building read as a model on a lawn rather than as a house on its
  // plot - and next to two-metre trees, small enough that the town vanished
  // into the woodland.
  const scale = (Math.min(plot.w, plot.h) * 0.97) / footprint;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(plot.x + plot.w / 2, ground, plot.y + plot.h / 2),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing),
    new THREE.Vector3(scale, scale, scale),
  );
}
