/**
 * What a citizen wears and carries.
 *
 * The Kernel has tracked all of this for a long time and no renderer ever
 * showed any of it: tools are earned through contribution, experience tiers
 * are computed from real evidence, and civic office is held by appointment.
 * A world where every citizen is an identical blank makes all of that
 * invisible - and the whole premise of AgentsEarth is that what you see is
 * earned and checkable.
 *
 * So a citizen carrying a pickaxe holds a pickaxe. An authority wears the
 * sash of their office. A polymath's insignia sits above them. None of it is
 * decoration for its own sake; every piece is a fact the Kernel already
 * knows, finally drawn.
 */

import * as THREE from 'three';

const BOX = new THREE.BoxGeometry(1, 1, 1);

export type KitPalette = {
  wood: THREE.Material; iron: THREE.Material; copper: THREE.Material;
  cloth: THREE.Material; leaf: THREE.Material; gold: THREE.Material;
  glass: THREE.Material;
};

export function kitPalette(): KitPalette {
  return {
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4227, roughness: .92 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: .42, metalness: .68 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: .5, metalness: .5 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0xb03a3a, roughness: .9 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x3f8f4c, roughness: .9 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9a928, roughness: .38, metalness: .7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9ee9e9, roughness: .2, metalness: .1, transparent: true, opacity: .7 }),
  };
}

const part = (
  parent: THREE.Object3D, material: THREE.Material,
  x: number, y: number, z: number, w: number, h: number, d: number, rotZ = 0,
) => {
  const mesh = new THREE.Mesh(BOX, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(w, h, d);
  mesh.rotation.z = rotZ;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
};

/**
 * The tool a citizen is carrying, built to be parented to their right hand.
 *
 * Returns null for a citizen carrying nothing, which is most of them - a
 * tool is earned, and handing everyone one would make the earning worthless.
 */
export function makeTool(tool: string | null | undefined, palette: KitPalette): THREE.Group | null {
  if (!tool) return null;
  const group = new THREE.Group();
  switch (tool) {
    case 'pickaxe':
      part(group, palette.wood, 0, -0.18, 0, 0.05, 0.72, 0.05);
      part(group, palette.iron, 0, 0.2, 0, 0.44, 0.07, 0.07);
      part(group, palette.iron, -0.2, 0.14, 0, 0.08, 0.14, 0.06, 0.5);
      part(group, palette.iron, 0.2, 0.14, 0, 0.08, 0.14, 0.06, -0.5);
      break;
    case 'axe':
      part(group, palette.wood, 0, -0.18, 0, 0.05, 0.7, 0.05);
      part(group, palette.iron, 0.12, 0.18, 0, 0.26, 0.24, 0.06);
      part(group, palette.iron, 0.24, 0.18, 0, 0.08, 0.32, 0.05);
      break;
    case 'watering_can':
      part(group, palette.copper, 0, 0, 0, 0.26, 0.28, 0.24);
      part(group, palette.copper, 0.2, 0.06, 0, 0.22, 0.06, 0.06, -0.35);
      part(group, palette.copper, 0, 0.19, 0, 0.09, 0.1, 0.09);
      // The handle, because a can without one is a bucket.
      part(group, palette.copper, -0.16, 0.12, 0, 0.05, 0.2, 0.05, 0.4);
      break;
    case 'hammer':
      part(group, palette.wood, 0, -0.16, 0, 0.05, 0.6, 0.05);
      part(group, palette.iron, 0, 0.18, 0, 0.3, 0.14, 0.12);
      break;
    default:
      // An unknown tool still shows as something held, rather than the
      // citizen's hands quietly lying about being empty.
      part(group, palette.wood, 0, 0, 0, 0.1, 0.42, 0.1);
      part(group, palette.iron, 0, 0.24, 0, 0.16, 0.12, 0.12);
  }
  return group;
}

/** Civic office, worn where everyone can see it. */
export function makeOfficeSash(role: string, palette: KitPalette): THREE.Group {
  const group = new THREE.Group();
  const colour = /mayor|deputy/i.test(role) ? 0xd9a928
    : /warden|security/i.test(role) ? 0xc0392b
      : /greeter|community/i.test(role) ? 0x2f8f5a
        : /inspector|build/i.test(role) ? 0x2f6fae
          : /steward|land|surveyor/i.test(role) ? 0x8a6b2f
            : 0x6b5fa8;
  const sash = new THREE.MeshStandardMaterial({ color: colour, roughness: .78 });
  // Across the chest, corner to corner, the way a sash actually sits.
  part(group, sash, 0, 1.05, -0.17, 0.52, 0.14, 0.03, 0.5);
  part(group, palette.gold, 0.16, 0.94, -0.185, 0.1, 0.1, 0.03);
  return group;
}

/**
 * The insignia above a citizen: how much verified evidence they carry.
 *
 * Emerging gets nothing - a newcomer should look like a newcomer - and each
 * tier above adds one floating mark, so standing in a crowd tells you who has
 * been here and done the work.
 */
export function makeTierMark(tier: string | undefined, palette: KitPalette): THREE.Group | null {
  const marks = tier === 'polymath' ? 3 : tier === 'seasoned' ? 2 : tier === 'practiced' ? 1 : 0;
  if (!marks) return null;
  const group = new THREE.Group();
  const material = tier === 'polymath' ? palette.gold : palette.iron;
  for (let index = 0; index < marks; index++) {
    const mark = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), material);
    mark.position.set((index - (marks - 1) / 2) * 0.17, 2.16, 0);
    group.add(mark);
  }
  group.name = 'tier-mark';
  return group;
}

/** Which arm swing a tool implies: work looks different from walking. */
export function toolMotion(activeTool: string | null | undefined, working: boolean) {
  if (!working || !activeTool) return null;
  if (activeTool === 'watering_can') return { amplitude: 0.35, speed: 3.2, lean: 0.2 };
  if (activeTool === 'axe' || activeTool === 'pickaxe') return { amplitude: 1.15, speed: 6.5, lean: 0.35 };
  return { amplitude: 0.7, speed: 4.5, lean: 0.25 };
}
