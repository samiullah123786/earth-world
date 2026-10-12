import { expect, it } from 'vitest';
import * as THREE from 'three';
import { neighborhoodModel, ART } from '../src/world3d/neighborhood';
import type { Model } from '../src/world3d/assets';

it('shares textures and geometry while isolating workshop/live presentation from cached assets', () => {
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture, metalness: 1 });
  material.name = 'leaf';
  const geometry = new THREE.BoxGeometry();
  const source: Model = { name: 'test', url: '/models/test.glb', pieces: [{ geometry, material }], size: new THREE.Vector3(1, 1, 1), clips: [], scene: new THREE.Group() };
  const tree = neighborhoodModel(source, 'tree');
  const treeMaterial = tree.pieces[0].material as THREE.MeshStandardMaterial;
  expect(treeMaterial).not.toBe(material);
  expect(treeMaterial.map).toBe(texture);
  expect(tree.pieces[0].geometry).toBe(geometry);
  expect(treeMaterial.color.getHex()).toBe(ART.leaf);
  expect(treeMaterial.metalness).toBe(0);
  expect(material.metalness).toBe(1);
  expect(material.color.getHex()).toBe(0xffffff);
  expect(neighborhoodModel(source, 'home').pieces[0].material.customProgramCacheKey()).not.toBe(material.customProgramCacheKey());
});
