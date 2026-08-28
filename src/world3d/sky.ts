/**
 * Sky, weather, and the small moving things that make a place look inhabited.
 *
 * The world used to end at a flat blue clear-colour. That is the difference
 * between a render and a place: a render stops at the edge of its geometry, and
 * a place carries on past it. What is here is a gradient dome, clouds that
 * drift and birds that circle.
 *
 * All of it is instanced: the entire atmosphere costs two draw calls, which is
 * the only reason it is affordable in a renderer that was already over budget.
 */

import * as THREE from 'three';
import type { Sky as SkyState } from './palette';

/**
 * The dome.
 *
 * Rendered on the inside of a sphere with depth writing off and a huge radius,
 * so it sits behind everything without ever clipping into the terrain. The
 * gradient is a shader rather than a texture because a texture at this size
 * bands visibly, and a two-colour lerp in a fragment shader does not.
 */
export function makeSkyDome(): { mesh: THREE.Mesh; setColors: (state: SkyState) => void } {
  const uniforms = {
    zenith: { value: new THREE.Color(0x6ba8d8) },
    horizon: { value: new THREE.Color(0xc9dced) },
    // How sharply one becomes the other. A soft falloff reads as haze.
    falloff: { value: 0.62 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform float falloff;
      varying vec3 vDirection;
      void main() {
        // Height above the horizon, eased so the band sits where the eye
        // expects it rather than exactly halfway up the dome.
        float h = clamp(vDirection.y * 0.5 + 0.5, 0.0, 1.0);
        float t = pow(smoothstep(0.42, 1.0, h), falloff);
        gl_FragColor = vec4(mix(horizon, zenith, t), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
  mesh.scale.setScalar(600);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return {
    mesh,
    setColors: (state) => {
      uniforms.zenith.value.copy(state.zenith);
      uniforms.horizon.value.copy(state.horizon);
    },
  };
}

/** A stable stream of numbers, so the same sky appears every session. */
function streamOf(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0;
    return ((state ^ (state >>> 15)) >>> 0) / 4294967296;
  };
}

type Drifting = { base: THREE.Vector3; size: THREE.Vector3; speed: number; phase: number };

/**
 * Clouds, as slabs of boxes.
 *
 * Voxel clouds rather than billboards or volumetrics, because the world they
 * float over is made of boxes and a soft photographic cloud above a blocky town
 * looks like two projects stapled together. They wrap around rather than
 * despawning, so the sky never empties.
 */
export class Clouds {
  private mesh: THREE.InstancedMesh;
  private parts: Drifting[] = [];
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private span: number;

  constructor(root: THREE.Group, geometry: THREE.BufferGeometry, worldSize: number, count = 22) {
    const random = streamOf(0x51ee7);
    this.span = worldSize * 1.9;
    for (let index = 0; index < count; index++) {
      // Each cloud is a few overlapping slabs, which gives a silhouette rather
      // than a floating brick.
      const cx = random() * this.span - this.span * 0.25;
      const cz = random() * this.span - this.span * 0.25;
      const cy = 44 + random() * 26;
      const scale = 0.7 + random() * 1.5;
      const speed = 0.28 + random() * 0.4;
      const lumps = 3 + Math.floor(random() * 3);
      for (let lump = 0; lump < lumps; lump++) {
        this.parts.push({
          base: new THREE.Vector3(
            cx + (random() - 0.5) * 16 * scale,
            cy + (random() - 0.5) * 3,
            cz + (random() - 0.5) * 12 * scale),
          size: new THREE.Vector3(
            (7 + random() * 12) * scale,
            2.2 + random() * 2.4,
            (6 + random() * 9) * scale),
          speed,
          phase: random() * Math.PI * 2,
        });
      }
    }
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, metalness: 0,
      transparent: true, opacity: 0.9, fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.parts.length);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    root.add(this.mesh);
  }

  update(elapsed: number, state: SkyState): void {
    (this.mesh.material as THREE.MeshStandardMaterial).color
      .copy(state.horizon).lerp(new THREE.Color(0xffffff), 0.55);
    for (let index = 0; index < this.parts.length; index++) {
      const part = this.parts[index];
      // Wrapping in place rather than respawning: a cloud that vanishes at the
      // edge of the world is more distracting than no cloud at all.
      const drift = (part.base.x + elapsed * part.speed) % this.span;
      const x = drift < 0 ? drift + this.span : drift;
      this.position.set(
        x - this.span * 0.25,
        part.base.y + Math.sin(elapsed * 0.12 + part.phase) * 0.7,
        part.base.z);
      this.matrix.compose(this.position, this.quaternion, part.size);
      this.mesh.setMatrixAt(index, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(on: boolean) { this.mesh.visible = on; }
}

/**
 * Birds.
 *
 * One instanced mesh, because a flock is the cheapest thing in the scene and
 * ought to stay that way.
 */
export class AmbientLife {
  private mesh: THREE.InstancedMesh;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private color = new THREE.Color();
  private flocks: Array<{ cx: number; cz: number; cy: number; radius: number; speed: number; offset: number }> = [];
  private chimneys: Array<{ x: number; y: number; z: number; seed: number }> = [];
  private capacity: number;

  constructor(private root: THREE.Group, private geometry: THREE.BufferGeometry, worldSize: number) {
    const random = streamOf(0xb17d5);
    for (let index = 0; index < 5; index++) {
      this.flocks.push({
        cx: worldSize * (0.25 + random() * 0.5),
        cz: worldSize * (0.25 + random() * 0.5),
        cy: 16 + random() * 12,
        radius: 9 + random() * 16,
        speed: 0.22 + random() * 0.18,
        offset: random() * Math.PI * 2,
      });
    }
    this.capacity = 5 * 6 + 64 * 5;
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, transparent: true, opacity: 0.85, vertexColors: true,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    root.add(this.mesh);
  }

  /**
   * Kept as a no-op so the caller does not have to know smoke is gone.
   *
   * The renderer still knows where every chimney is; nothing is drawn on them.
   */
  setChimneys(_spots: Array<{ x: number; y: number; z: number }>): void {
    this.chimneys = [];
  }

  update(elapsed: number, state: SkyState): void {
    let index = 0;
    const write = (x: number, y: number, z: number, size: number, tint: THREE.Color, alpha: number) => {
      if (index >= this.capacity) return;
      this.position.set(x, y, z);
      this.scale.setScalar(size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(index, this.matrix);
      this.mesh.setColorAt(index, this.color.copy(tint).multiplyScalar(alpha));
      index++;
    };

    // Birds only in daylight. A flock at midnight is a bat, and nobody asked
    // for bats.
    if (state.daylight > 0.25) {
      const feather = new THREE.Color(0x2c2f3a).lerp(state.sun, 0.25);
      for (const flock of this.flocks) {
        for (let bird = 0; bird < 6; bird++) {
          const angle = elapsed * flock.speed + flock.offset + bird * 0.5;
          write(
            flock.cx + Math.cos(angle) * flock.radius,
            flock.cy + Math.sin(angle * 1.7 + bird) * 1.4,
            flock.cz + Math.sin(angle) * flock.radius,
            0.34, feather, 1);
        }
      }
    }

    // Chimney smoke used to rise here, and it was removed rather than fixed
    // twice over.
    //
    // The bug: each puff faded by multiplying its colour toward zero, because
    // one instanced mesh shares a single opacity and per-instance alpha was not
    // available. Multiplying a colour to zero does not fade it - it turns it
    // BLACK. So every occupied house wore a column of black cubes, which is
    // exactly what it looked like.
    //
    // It could have been fixed by shrinking the puffs instead, or by lerping
    // them toward the sky. It is gone instead because smoke over a bright town
    // was never carrying its weight, and a wrong thing removed beats a wrong
    // thing patched.

    this.mesh.count = index;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setVisible(on: boolean) { this.mesh.visible = on; }
}
