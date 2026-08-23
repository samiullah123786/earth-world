/**
 * The world's texture: the island it sits on, and everything growing on it.
 *
 * The terrain letters say what each tile IS - grass, road, water, field. This
 * module says what that looks like when you are standing in it: tufts bending
 * in the grass, flowers in the meadow, stones at the shoulder of a road,
 * fence posts around a homestead, lamps along the way, and crops that visibly
 * ripen because the Kernel already tracks their growth stage.
 *
 * Two rules hold it together.
 *
 * Nothing here is authoritative. Every decoration is derived from the same
 * terrain letters and Kernel rows every other window reads, seeded by tile so
 * the same blade of grass grows in the same place for every viewer, forever.
 * Reload and the world is identical; there is nothing to save.
 *
 * And nothing here is drawn one mesh at a time. A quarter of a million tiles
 * would bury the renderer in draw calls, so every family of decoration is one
 * InstancedMesh. Detail is free once it is batched; it is only expensive when
 * it is careless.
 */

import * as THREE from 'three';
import { heightAt } from '../../shared/elevation';

/** Deterministic per-tile randomness: same tile, same world, forever. */
export function tileRandom(x: number, z: number, salt = 0) {
  let hash = (x * 73856093) ^ (z * 19349663) ^ (salt * 83492791);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

type Placement = { pos: THREE.Vector3; scale: THREE.Vector3; rotY: number };

/** One instanced family, built from a list of placements. */
function instance(
  geometry: THREE.BufferGeometry, material: THREE.Material, places: Placement[],
  { shadow = true } = {},
) {
  if (!places.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, places.length);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const lifted = new THREE.Vector3();
  places.forEach((place, index) => {
    quaternion.setFromAxisAngle(axis, place.rotY);
    // Everything scattered on the meadow is placed in flat coordinates and
    // lifted onto the land here, in the one function they all pass through.
    // A tuft of grass at sea level on a hillside is the single clearest tell
    // that a world is a heightmap with props dropped over it.
    lifted.set(place.pos.x, place.pos.y + heightAt(place.pos.x, place.pos.z), place.pos.z);
    matrix.compose(lifted, quaternion, place.scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);

export type DetailPalette = {
  grassBlade: THREE.Material; flowerA: THREE.Material; flowerB: THREE.Material;
  flowerC: THREE.Material; stone: THREE.Material; fence: THREE.Material;
  lampPost: THREE.Material; lampGlow: THREE.Material; soil: THREE.Material;
  cropYoung: THREE.Material; cropRipe: THREE.Material; reed: THREE.Material;
};

export function detailPalette(): DetailPalette {
  return {
    grassBlade: new THREE.MeshStandardMaterial({ color: 0x74b355, roughness: .95 }),
    flowerA: new THREE.MeshStandardMaterial({ color: 0xf2d24b, roughness: .8 }),
    flowerB: new THREE.MeshStandardMaterial({ color: 0xe4657f, roughness: .8 }),
    flowerC: new THREE.MeshStandardMaterial({ color: 0x9d7bea, roughness: .8 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x8c8b86, roughness: 1 }),
    fence: new THREE.MeshStandardMaterial({ color: 0x7a5433, roughness: .95 }),
    lampPost: new THREE.MeshStandardMaterial({ color: 0x3a3a42, roughness: .7, metalness: .3 }),
    lampGlow: new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffb43a, emissiveIntensity: 2.4 }),
    soil: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 }),
    cropYoung: new THREE.MeshStandardMaterial({ color: 0x7fb04a, roughness: .95 }),
    cropRipe: new THREE.MeshStandardMaterial({ color: 0xd9b23f, roughness: .9 }),
    reed: new THREE.MeshStandardMaterial({ color: 0x4f8f5c, roughness: .95 }),
  };
}

/**
 * The island the town stands on.
 *
 * The world used to sit on a flat slab with square sides, which read exactly
 * as what it was: a plate. Land has depth and a shore. This gives it three
 * courses - grass lip, soil, then stone - each stepped inward, so the edge
 * reads as a cliff falling into water rather than a table someone set the
 * town on. The sea is a single plane below the lip, wide enough to reach the
 * fog, so there is no visible end of the world.
 */
export function buildIsland(width: number, height: number) {
  const group = new THREE.Group();
  const courses = [
    { inset: 0, top: -0.02, depth: 1.1, color: 0x5f8f45, rough: 1 },
    { inset: 0.9, top: -1.1, depth: 2.4, color: 0x6b4a2c, rough: 1 },
    { inset: 2.4, top: -3.4, depth: 5.5, color: 0x6d6b65, rough: 1 },
    { inset: 4.6, top: -8.8, depth: 6, color: 0x55534e, rough: 1 },
  ];
  for (const course of courses) {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width + 3 - course.inset * 2, course.depth, height + 3 - course.inset * 2),
      new THREE.MeshStandardMaterial({ color: course.color, roughness: course.rough }),
    );
    slab.position.set(width / 2, course.top - course.depth / 2, height / 2);
    slab.receiveShadow = true;
    group.add(slab);
  }

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 6, height * 6),
    new THREE.MeshStandardMaterial({
      color: 0x2f6fae, roughness: .28, metalness: .05,
      transparent: true, opacity: .93,
    }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(width / 2, -0.75, height / 2);
  sea.receiveShadow = true;
  sea.name = 'sea';
  group.add(sea);
  return group;
}

/**
 * Everything that grows, sits and stands on the ground.
 *
 * Walkability is never touched: a citizen's route is the Kernel's business
 * and decoration must never imply a wall where the world says there is none.
 * So tufts and flowers sit ON walkable tiles, and the only things with real
 * presence - boulders, fence posts, lamps - go where the map already says
 * nothing may walk, or on the verge between road and field.
 */
export function buildScatter(
  rows: string[], width: number, height: number, palette: DetailPalette,
) {
  const group = new THREE.Group();
  const tufts: Placement[] = [];
  const flowersA: Placement[] = [];
  const flowersB: Placement[] = [];
  const flowersC: Placement[] = [];
  const pebbles: Placement[] = [];
  const reeds: Placement[] = [];

  const letterAt = (x: number, z: number) => (rows[z]?.[x] ?? '.');

  for (let z = 0; z < height; z++) {
    const row = rows[z] ?? '';
    for (let x = 0; x < width; x++) {
      const letter = row[x] ?? '.';
      if (letter === '.') continue;
      const roll = tileRandom(x, z, 1);

      if (letter === 'g' || letter === 'u') {
        // Grass is not a colour, it is a texture. Three or four blades a tile
        // on most of the meadow is what stops a lawn reading as felt.
        if (roll < 0.55) {
          const blades = 2 + Math.floor(tileRandom(x, z, 2) * 3);
          for (let blade = 0; blade < blades; blade++) {
            const jitterX = tileRandom(x, z, 10 + blade);
            const jitterZ = tileRandom(x, z, 20 + blade);
            const tall = 0.16 + tileRandom(x, z, 30 + blade) * 0.22;
            tufts.push({
              pos: new THREE.Vector3(x + 0.15 + jitterX * 0.7, tall / 2, z + 0.15 + jitterZ * 0.7),
              scale: new THREE.Vector3(0.07, tall, 0.07),
              rotY: jitterX * Math.PI,
            });
          }
        }
        // Flowers are rare on purpose. A meadow with a flower every tile is a
        // carpet; one every twenty tiles is a meadow you notice.
        const bloom = tileRandom(x, z, 3);
        if (bloom > 0.94) {
          const stem = 0.26;
          const pick = bloom > 0.98 ? flowersC : bloom > 0.96 ? flowersB : flowersA;
          pick.push({
            pos: new THREE.Vector3(x + 0.5, stem, z + 0.5),
            scale: new THREE.Vector3(0.16, 0.16, 0.16),
            rotY: bloom * Math.PI * 4,
          });
          tufts.push({
            pos: new THREE.Vector3(x + 0.5, stem / 2, z + 0.5),
            scale: new THREE.Vector3(0.05, stem, 0.05),
            rotY: 0,
          });
        }
      }

      // Stones gather at the shoulder of a road, the way they do on any track
      // that has been walked for years.
      if (letter === 'g' && roll > 0.88) {
        const beside = ['r', 'c'].includes(letterAt(x + 1, z)) || ['r', 'c'].includes(letterAt(x - 1, z))
          || ['r', 'c'].includes(letterAt(x, z + 1)) || ['r', 'c'].includes(letterAt(x, z - 1));
        if (beside) {
          const size = 0.16 + tileRandom(x, z, 4) * 0.22;
          pebbles.push({
            pos: new THREE.Vector3(x + 0.3 + roll * 0.4, size / 2, z + 0.3 + tileRandom(x, z, 5) * 0.4),
            scale: new THREE.Vector3(size, size * 0.7, size),
            rotY: roll * Math.PI,
          });
        }
      }

      // Reeds where land meets water: the one detail that makes a shoreline
      // look like a shoreline instead of a cut.
      if ((letter === 'g' || letter === 'd')
        && (letterAt(x + 1, z) === 'w' || letterAt(x - 1, z) === 'w'
          || letterAt(x, z + 1) === 'w' || letterAt(x, z - 1) === 'w')) {
        const stalks = 2 + Math.floor(tileRandom(x, z, 6) * 3);
        for (let stalk = 0; stalk < stalks; stalk++) {
          const tall = 0.4 + tileRandom(x, z, 40 + stalk) * 0.5;
          reeds.push({
            pos: new THREE.Vector3(
              x + 0.2 + tileRandom(x, z, 50 + stalk) * 0.6, tall / 2,
              z + 0.2 + tileRandom(x, z, 60 + stalk) * 0.6),
            scale: new THREE.Vector3(0.05, tall, 0.05),
            rotY: tileRandom(x, z, 70 + stalk) * Math.PI,
          });
        }
      }
    }
  }

  const blade = new THREE.BoxGeometry(1, 1, 1);
  const petal = new THREE.SphereGeometry(1, 6, 4);
  for (const [places, material, geometry] of [
    [tufts, palette.grassBlade, blade],
    [reeds, palette.reed, blade],
    [pebbles, palette.stone, new THREE.DodecahedronGeometry(1, 0)],
    [flowersA, palette.flowerA, petal],
    [flowersB, palette.flowerB, petal],
    [flowersC, palette.flowerC, petal],
  ] as Array<[Placement[], THREE.Material, THREE.BufferGeometry]>) {
    const mesh = instance(geometry, material, places, { shadow: false });
    if (mesh) group.add(mesh);
  }
  return group;
}

/**
 * Crops, at the stage the Kernel says they have actually reached.
 *
 * Growth is time on the Kernel's side, computed rather than stored, so a
 * field ripens on its own and every viewer sees the same stage. Painting all
 * fields identically would hide the only farming in the world; four visibly
 * different stages make a harvest something you can watch approach.
 */
export function buildFarms(
  farms: Array<{ x: number; y: number; crop: string; stage: number; tenders: number }>,
  palette: DetailPalette,
) {
  const group = new THREE.Group();
  const soil: Placement[] = [];
  const young: Placement[] = [];
  const ripe: Placement[] = [];

  for (const field of farms) {
    // Tilled rows, raised a little, so a field reads as worked ground.
    soil.push({
      pos: new THREE.Vector3(field.x + 0.5, 0.06, field.y + 0.5),
      scale: new THREE.Vector3(0.96, 0.12, 0.96),
      rotY: 0,
    });
    const stage = Math.max(0, Math.min(4, field.stage));
    if (stage === 0) continue;
    const tall = 0.12 + stage * 0.17;
    const bucket = stage >= 4 ? ripe : young;
    // Four stalks a tile, in rows, because a crop is planted, not scattered.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        bucket.push({
          pos: new THREE.Vector3(field.x + 0.3 + col * 0.4, 0.12 + tall / 2, field.y + 0.3 + row * 0.4),
          scale: new THREE.Vector3(0.1, tall, 0.1),
          rotY: tileRandom(field.x, field.y, row * 2 + col) * 0.6,
        });
      }
    }
    // A ripe field carries heads on the stalks: the visible difference
    // between "growing" and "come and harvest me".
    if (stage >= 4) {
      ripe.push({
        pos: new THREE.Vector3(field.x + 0.5, 0.12 + tall + 0.08, field.y + 0.5),
        scale: new THREE.Vector3(0.3, 0.18, 0.3),
        rotY: 0,
      });
    }
  }

  for (const [places, material] of [
    [soil, palette.soil], [young, palette.cropYoung], [ripe, palette.cropRipe],
  ] as Array<[Placement[], THREE.Material]>) {
    const mesh = instance(BOX, material, places, { shadow: false });
    if (mesh) group.add(mesh);
  }
  return group;
}

/**
 * Fences around claimed homesteads, and lamps where roads cross.
 *
 * Both are civic facts made visible: a fence says this ground belongs to
 * somebody, a lamp says the town maintains this junction. Unclaimed plots get
 * nothing - an empty parcel should look like open land, because it is.
 */
export function buildBoundaries(
  plots: Array<{ x: number; y: number; w: number; h: number; owned: boolean }>,
  rows: string[], width: number, height: number, palette: DetailPalette,
) {
  const group = new THREE.Group();
  const posts: Placement[] = [];
  const rails: Placement[] = [];
  const lampPosts: Placement[] = [];
  const lampHeads: Placement[] = [];

  for (const plot of plots) {
    if (!plot.owned) continue;
    for (let dx = 0; dx <= plot.w; dx++) {
      for (const edge of [0, plot.h]) {
        // Every other post, with a rail between: a fence, not a palisade.
        if ((dx + edge) % 2) continue;
        posts.push({
          pos: new THREE.Vector3(plot.x + dx, 0.32, plot.y + edge),
          scale: new THREE.Vector3(0.11, 0.64, 0.11), rotY: 0,
        });
      }
    }
    for (let dz = 0; dz <= plot.h; dz++) {
      for (const edge of [0, plot.w]) {
        if ((dz + edge) % 2) continue;
        posts.push({
          pos: new THREE.Vector3(plot.x + edge, 0.32, plot.y + dz),
          scale: new THREE.Vector3(0.11, 0.64, 0.11), rotY: 0,
        });
      }
    }
    rails.push({
      pos: new THREE.Vector3(plot.x + plot.w / 2, 0.46, plot.y),
      scale: new THREE.Vector3(plot.w, 0.06, 0.05), rotY: 0,
    });
    rails.push({
      pos: new THREE.Vector3(plot.x + plot.w / 2, 0.46, plot.y + plot.h),
      scale: new THREE.Vector3(plot.w, 0.06, 0.05), rotY: 0,
    });
    rails.push({
      pos: new THREE.Vector3(plot.x, 0.46, plot.y + plot.h / 2),
      scale: new THREE.Vector3(0.05, 0.06, plot.h), rotY: 0,
    });
    rails.push({
      pos: new THREE.Vector3(plot.x + plot.w, 0.46, plot.y + plot.h / 2),
      scale: new THREE.Vector3(0.05, 0.06, plot.h), rotY: 0,
    });
  }

  // Lamps at crossroads: a tile of road with road on all four sides.
  const isRoad = (x: number, z: number) => (rows[z]?.[x] ?? '.') === 'r';
  for (let z = 1; z < height - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      if (!isRoad(x, z)) continue;
      if (!(isRoad(x + 1, z) && isRoad(x - 1, z) && isRoad(x, z + 1) && isRoad(x, z - 1))) continue;
      // One lamp per junction, not one per tile of a wide crossing.
      if (x % 4 || z % 4) continue;
      lampPosts.push({
        pos: new THREE.Vector3(x + 0.1, 1.05, z + 0.1),
        scale: new THREE.Vector3(0.1, 2.1, 0.1), rotY: 0,
      });
      lampHeads.push({
        pos: new THREE.Vector3(x + 0.1, 2.2, z + 0.1),
        scale: new THREE.Vector3(0.26, 0.26, 0.26), rotY: 0,
      });
    }
  }

  for (const [places, material] of [
    [posts, palette.fence], [rails, palette.fence],
    [lampPosts, palette.lampPost], [lampHeads, palette.lampGlow],
  ] as Array<[Placement[], THREE.Material]>) {
    const mesh = instance(BOX, material, places);
    if (mesh) group.add(mesh);
  }
  return group;
}
