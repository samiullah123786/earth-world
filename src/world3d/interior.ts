/**
 * Homes you can walk into.
 *
 * The houses in this world were always hollow - a ring of walls with a gap in
 * the south face, exactly like the voxel extrusion the Kernel describes. But
 * nothing enforced the walls, so a walker drifted through them as if they were
 * paint, and nothing was inside, so drifting through got you an empty box with
 * a roof over it. A door you can ignore is not a door, and a room with nothing
 * in it is not a room.
 *
 * Three things make a house enterable, and all three are needed together:
 *
 * THE WALLS STOP YOU. The ring becomes real collision, so the doorway is the
 * only way in. This is what makes the door mean something.
 *
 * THERE IS SOMETHING INSIDE. A floor, a bed, a hearth, a table - laid out from
 * the building's own footprint, so a big house is furnished like a big house
 * rather than a small one with gaps.
 *
 * THE ROOF GETS OUT OF THE WAY. Standing inside a sealed box, a roof is a
 * ceiling you press your face into. It hides while you are indoors and comes
 * back when you leave.
 *
 * The geometry here is pure and matches shared/voxel.ts, which is the Kernel's
 * own description of the same building. Two renderers disagreeing about where
 * a door is would put a citizen through a wall.
 */

import * as THREE from 'three';

export type Footprint = { x: number; y: number; w: number; h: number };

/**
 * The doorway, on the south face.
 *
 * Deliberately the same arithmetic as `structureVoxels` in shared/voxel.ts and
 * `wallRing` in the renderer. It is written once here and read by both the
 * collision map and the furniture, because a door in two places is a citizen
 * walking through a wall.
 */
export function doorTile(build: Footprint): { x: number; y: number } {
  return { x: build.x + Math.floor(build.w / 2), y: build.y + build.h - 1 };
}

/** Is this tile inside the walls rather than part of them? */
export function isInterior(build: Footprint, x: number, y: number): boolean {
  return x > build.x && x < build.x + build.w - 1
    && y > build.y && y < build.y + build.h - 1;
}

/** Every tile of the wall ring except the doorway. */
export function wallTiles(build: Footprint): Array<{ x: number; y: number }> {
  const door = doorTile(build);
  const out: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < build.h; dy++) {
    for (let dx = 0; dx < build.w; dx++) {
      const x = build.x + dx, y = build.y + dy;
      const edge = dx === 0 || dy === 0 || dx === build.w - 1 || dy === build.h - 1;
      if (!edge) continue;
      if (x === door.x && y === door.y) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/** Is a point standing inside this building's walls? */
export function inside(build: Footprint, x: number, z: number): boolean {
  return x >= build.x && x < build.x + build.w && z >= build.y && z < build.y + build.h;
}

/**
 * How much room there is to furnish.
 *
 * A three-by-three house has exactly one interior tile, which is a cupboard.
 * Anything smaller has none at all, and hanging furniture in a wall would look
 * worse than an empty room.
 */
export function interiorSize(build: Footprint): { w: number; h: number } {
  return { w: Math.max(0, build.w - 2), h: Math.max(0, build.h - 2) };
}

/** A stable stream of small numbers, so one house is furnished the same way forever. */
function streamOf(seed: string) {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  return (max: number) => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0;
    return (state >>> 8) % max;
  };
}

export type InteriorPalette = {
  floor: THREE.Material; rug: THREE.Material; timber: THREE.Material;
  cloth: THREE.Material; hearth: THREE.Material; ember: THREE.Material;
  metal: THREE.Material;
};

export function interiorPalette(): InteriorPalette {
  return {
    floor: new THREE.MeshStandardMaterial({ color: 0x8a6647, roughness: .92 }),
    rug: new THREE.MeshStandardMaterial({ color: 0x9c4b52, roughness: .96 }),
    timber: new THREE.MeshStandardMaterial({ color: 0x6b4227, roughness: .9 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0xdcd3c2, roughness: .95 }),
    hearth: new THREE.MeshStandardMaterial({ color: 0x6e6a66, roughness: .95 }),
    ember: new THREE.MeshStandardMaterial({
      color: 0xff9a3c, emissive: 0xff6a12, emissiveIntensity: 1.4, roughness: .7,
    }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: .5, metalness: .6 }),
  };
}

const BOX = new THREE.BoxGeometry(1, 1, 1);

function slab(
  parent: THREE.Object3D, material: THREE.Material,
  x: number, y: number, z: number, w: number, h: number, d: number,
) {
  const mesh = new THREE.Mesh(BOX, material);
  mesh.position.set(x + w / 2, y + h / 2, z + d / 2);
  mesh.scale.set(w, h, d);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * What is actually in the house.
 *
 * Laid out from the footprint rather than dropped at fixed offsets, so a wide
 * house gets a table in the middle of a real floor instead of furniture piled
 * in one corner of a room it does not fit.
 */
export function furnishHome(build: Footprint, seed: string, palette: InteriorPalette): THREE.Group {
  const group = new THREE.Group();
  const room = interiorSize(build);
  if (room.w < 1 || room.h < 1) return group;
  const next = streamOf(seed);
  const ox = build.x + 1, oz = build.y + 1;

  // Floorboards, so the ground inside reads as a room rather than as the lawn
  // continuing under the walls.
  slab(group, palette.floor, ox, 0.3, oz, room.w, 0.08, room.h);

  // A bed against the back wall, always: this is somebody's home.
  const bedW = Math.min(room.w, 1.1);
  slab(group, palette.timber, ox + 0.05, 0.38, oz + 0.05, bedW, 0.22, Math.min(room.h, 1.9));
  slab(group, palette.cloth, ox + 0.08, 0.58, oz + 0.35, bedW - 0.06, 0.12, Math.min(room.h - 0.4, 1.5));
  slab(group, palette.cloth, ox + 0.1, 0.6, oz + 0.08, bedW - 0.1, 0.16, 0.28);

  // A hearth in the far corner, with something burning in it. The light is the
  // reason to go inside at all.
  if (room.w >= 2) {
    const hx = ox + room.w - 0.72;
    slab(group, palette.hearth, hx, 0.38, oz + 0.06, 0.66, 0.9, 0.5);
    slab(group, palette.ember, hx + 0.14, 0.44, oz + 0.16, 0.38, 0.24, 0.3);
    const fire = new THREE.PointLight(0xffa851, 3.4, 6.5, 2);
    fire.position.set(hx + 0.33, 0.75, oz + 0.31);
    group.add(fire);
  }

  // A table and a stool, once there is floor left to stand them on.
  if (room.w >= 2 && room.h >= 2) {
    const tx = ox + (room.w - 1.1) / 2, tz = oz + room.h - 1.15;
    slab(group, palette.timber, tx, 0.68, tz, 1.05, 0.09, 0.72);
    for (const [lx, lz] of [[0.06, 0.06], [0.9, 0.06], [0.06, 0.6], [0.9, 0.6]]) {
      slab(group, palette.timber, tx + lx, 0.38, tz + lz, 0.09, 0.32, 0.09);
    }
    slab(group, palette.timber, tx - 0.5, 0.38, tz + 0.2, 0.34, 0.3, 0.34);
    // Something on the table, varying by house, so no two rooms are identical.
    const clutter = next(3);
    if (clutter === 0) slab(group, palette.metal, tx + 0.4, 0.77, tz + 0.28, 0.18, 0.16, 0.18);
    if (clutter === 1) slab(group, palette.cloth, tx + 0.34, 0.77, tz + 0.22, 0.3, 0.06, 0.3);
    if (clutter === 2) slab(group, palette.timber, tx + 0.42, 0.77, tz + 0.3, 0.14, 0.2, 0.14);
  }

  // A rug, in a bigger room, because a bigger room looks empty without one.
  if (room.w >= 3 && room.h >= 3) {
    slab(group, palette.rug, ox + 0.6, 0.385, oz + 0.7, room.w - 1.4, 0.02, room.h - 1.6);
  }

  // Enough ambient light that the room is legible even without the hearth.
  const lamp = new THREE.PointLight(0xffe0b0, 1.5, 7, 2);
  lamp.position.set(ox + room.w / 2, 1.9, oz + room.h / 2);
  group.add(lamp);
  return group;
}
