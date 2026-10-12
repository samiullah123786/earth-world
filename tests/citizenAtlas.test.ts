import { expect, it } from 'vitest';
import * as THREE from 'three';
import { skinAtlasMaterial } from '../src/world3d/rig';
import { fitToPlot, type Model } from '../src/world3d/assets';
import { WORLD_SCALE } from '../src/world3d/neighborhood';

it('wraps the kit repeating UVs before selecting a citizen skin cell', () => {
  const texture = new THREE.Texture();
  const material = skinAtlasMaterial(texture, 12);
  expect(texture.flipY).toBe(false);
  const shader = { vertexShader: '#include <uv_vertex>', fragmentShader: '', uniforms: {} };
  material.onBeforeCompile(shader as any, {} as any);
  expect(shader.vertexShader).toContain('fract(vMapUv)');
  // Actual kit legs use negative U and V above 1. None may enter a neighbor skin.
  for (const [u, v] of [[-.2473, 1.7838], [-.5284, 1.9931], [.9976, 1.7457]]) {
    for (const slot of [0, 11, 143]) {
      const x = (slot % 12) / 12, y = Math.floor(slot / 12) / 12;
      const mapped = [u, v].map(n => (n - Math.floor(n)) * .998 / 12 + .001 / 12);
      expect(x + mapped[0]).toBeGreaterThan(x);
      expect(x + mapped[0]).toBeLessThan(x + 1 / 12);
      expect(y + mapped[1]).toBeGreaterThan(y);
      expect(y + mapped[1]).toBeLessThan(y + 1 / 12);
    }
  }
});

it('gives a compact legacy house human scale without widening its footprint', () => {
  const model = { size: new THREE.Vector3(1.45, .7682, 1.178) } as Model;
  const matrix = fitToPlot(model, { x: 10, y: 10, w: 2, h: 2 }, .2, 0, WORLD_SCALE.homeMinimumHeight);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  expect(model.size.y * scale.y).toBeCloseTo(2);
  expect(model.size.x * scale.x).toBeLessThan(2);
  expect(model.size.z * scale.z).toBeLessThan(2);
  expect(model.size.y * scale.y).toBeGreaterThan(WORLD_SCALE.citizenHeight);
});
