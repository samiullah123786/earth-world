import * as THREE from 'three';
import type { Model } from './assets';

/** Shared workshop/live presentation tokens; never geometry or land authority. */
export const ART = {
  background: 0xe6e9dd, grass: 0xa2b17b, soil: 0xb9a587, road: 0xd8d1b7,
  curb: 0xeee7d4, grid: 0x637451, sun: 0xfff0d2, sky: 0xfffdf2,
  shadow: 0x768b81, selection: 0x355c3d, invalid: 0x9b352c, ghost: 0x5c854c,
  leaf: 0x77935c, bark: 0x8f7052, roof: 0xa86e4e,
};

/** Clone only materials: source meshes, textures and the loader cache stay intact. */
export function neighborhoodModel(source: Model, kind: string): Model {
  return { ...source, pieces: source.pieces.map(piece => {
    const material = piece.material.clone() as THREE.MeshStandardMaterial;
    if ('metalness' in material) material.metalness = 0;
    if (kind === 'tree') {
      material.roughness = 1;
      material.color.set(/leaf/i.test(material.name) ? ART.leaf : ART.bark);
    }
    if (kind === 'home' || kind === 'civic') {
      material.onBeforeCompile = shader => {
        shader.uniforms.earthRoof = { value: new THREE.Color(ART.roof) };
        shader.fragmentShader = 'uniform vec3 earthRoof;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          if (diffuseColor.g > diffuseColor.r * 1.25 && diffuseColor.g > diffuseColor.b * 1.12) {
            float shade = clamp(diffuseColor.g * 2.0, 0.4, 1.4);
            diffuseColor.rgb = earthRoof * shade;
          }`);
      };
      material.customProgramCacheKey = () => 'earth-neighborhood-roof-v1';
    }
    return { ...piece, material };
  }) };
}

/** Shared human scale in tiles. Legacy buildings may raise walls, never widen land. */
export const WORLD_SCALE = { citizenHeight: 1.2, homeMinimumHeight: 2, civicMinimumHeight: 3 };
