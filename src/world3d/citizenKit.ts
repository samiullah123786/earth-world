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



/**
 * What holding an office looks like.
 *
 * A sash was honest but nearly invisible: a strip of colour on a body
 * otherwise identical to everyone else's, which meant the Mayor and a
 * three-day-old newcomer read the same from any distance you would actually
 * watch this town from. Offices in Earth are narrow, revocable, and granted
 * only on published thresholds with the owner's consent - they are the most
 * consequential thing a citizen can hold, and they were the least legible.
 *
 * So an office now comes with a whole silhouette: a uniform coat, a headpiece
 * belonging to that work, and where it makes sense the thing the office
 * actually carries. Six roles, each recognisable at a glance from the far side
 * of the square, and none of it claimable - the Kernel decides who holds an
 * office, and it is always a server-owned fact.
 */
export type AuthorityLook = {
  /** The coat this office wears, replacing the citizen's own cloth. */
  coat: number;
  /** And its lining, for cuffs and hems. */
  trim: number;
  headpiece: 'cap' | 'brim' | 'hardhat' | 'helm' | 'crown' | 'none';
  /** What the office carries in its off hand, if anything. */
  carries: 'rod' | 'ledger' | 'staff' | 'none';
};

export function authorityLook(role: string | null | undefined): AuthorityLook | null {
  if (!role) return null;
  if (/mayor/i.test(role) && !/deputy/i.test(role)) {
    return { coat: 0x243a7a, trim: 0xd9a928, headpiece: 'crown', carries: 'none' };
  }
  if (/deputy/i.test(role)) {
    return { coat: 0x2f4d94, trim: 0xc0b06a, headpiece: 'cap', carries: 'none' };
  }
  if (/land steward|steward/i.test(role)) {
    return { coat: 0x6b5322, trim: 0xc9b183, headpiece: 'brim', carries: 'rod' };
  }
  if (/surveyor|boundary/i.test(role)) {
    return { coat: 0x1f6b6b, trim: 0x9fd8d3, headpiece: 'cap', carries: 'staff' };
  }
  if (/inspector|build/i.test(role)) {
    return { coat: 0x3a4551, trim: 0xf2b134, headpiece: 'hardhat', carries: 'ledger' };
  }
  if (/warden|security/i.test(role)) {
    return { coat: 0x7d2222, trim: 0xd7c9a7, headpiece: 'helm', carries: 'none' };
  }
  if (/greeter|community/i.test(role)) {
    return { coat: 0x2f7a4e, trim: 0xe4d9b2, headpiece: 'none', carries: 'none' };
  }
  if (/bank|manager|treasur/i.test(role)) {
    return { coat: 0x4a3560, trim: 0xd9a928, headpiece: 'cap', carries: 'ledger' };
  }
  // An office the renderer has not met yet still reads as an office rather
  // than silently rendering as an ordinary citizen.
  return { coat: 0x5a5a66, trim: 0xc8c2b4, headpiece: 'cap', carries: 'none' };
}

/** The headpiece and coat detail for an office, worn over the body. */
export function makeAuthorityDress(look: AuthorityLook, palette: KitPalette): THREE.Group {
  const group = new THREE.Group();
  const coat = new THREE.MeshStandardMaterial({ color: look.coat, roughness: .82 });
  const trim = new THREE.MeshStandardMaterial({ color: look.trim, roughness: .7, metalness: .25 });

  // The coat itself: a longer body than an ordinary tunic, with a hem, so the
  // silhouette differs before any colour is read.
  part(group, coat, -.28, .58, -.17, .56, .62, .32);
  part(group, trim, -.28, .52, -.175, .56, .09, .33);
  part(group, trim, -.06, .82, -.19, .12, .5, .04);

  switch (look.headpiece) {
    case 'crown':
      part(group, palette.gold, -.24, 2.0, -.2, .48, .1, .42);
      for (const dx of [-.2, -.02, .16]) part(group, palette.gold, dx, 2.09, -.2, .07, .14, .07);
      break;
    case 'cap':
      part(group, coat, -.25, 1.95, -.2, .5, .16, .44);
      part(group, trim, -.25, 1.93, -.42, .5, .06, .18);
      break;
    case 'brim':
      part(group, coat, -.24, 1.98, -.2, .48, .18, .42);
      part(group, coat, -.42, 1.95, -.38, .84, .06, .78);
      break;
    case 'hardhat':
      part(group, trim, -.25, 1.95, -.21, .5, .22, .46);
      part(group, trim, -.25, 1.93, -.46, .5, .07, .2);
      part(group, coat, -.04, 1.96, -.215, .08, .24, .47);
      break;
    case 'helm':
      part(group, palette.iron, -.25, 1.94, -.21, .5, .26, .46);
      part(group, palette.iron, -.06, 1.72, -.235, .12, .24, .06);
      part(group, trim, -.1, 2.16, -.2, .2, .12, .1);
      break;
    default:
      break;
  }
  return group;
}

/** What an office carries in its off hand: the tool of that work. */
export function makeInsignia(look: AuthorityLook, palette: KitPalette): THREE.Group | null {
  if (look.carries === 'none') return null;
  const group = new THREE.Group();
  const trim = new THREE.MeshStandardMaterial({ color: look.trim, roughness: .68, metalness: .3 });
  if (look.carries === 'rod') {
    // A measuring rod, banded, because a Land Steward settles boundaries.
    part(group, palette.wood, 0, 0, 0, .05, 1.1, .05);
    for (const y of [-.4, -.1, .2, .5]) part(group, trim, 0, y, 0, .07, .05, .07);
  }
  if (look.carries === 'staff') {
    part(group, palette.wood, 0, 0, 0, .05, 1.25, .05);
    part(group, trim, -.06, .62, -.06, .17, .17, .17);
  }
  if (look.carries === 'ledger') {
    part(group, palette.cloth, 0, 0, 0, .3, .38, .06);
    part(group, trim, .02, .02, -.04, .26, .32, .02);
  }
  return group;
}

/**
 * A citizen's own look, derived from who they verifiably are.
 *
 * Everyone wore the same body in four skin tones and five hair colours, so a
 * crowd read as one person copied twenty times. Identity here is not
 * decoration: it comes from the agentId and the verified family, which means
 * it is stable forever, unique in practice, and impossible to claim - the
 * same rule the rest of this world runs on.
 */
export type Look = {
  skin: number; hair: number; hairStyle: 'crop' | 'long' | 'topknot' | 'cap' | 'bald';
  build: 'slight' | 'average' | 'broad'; height: number;
  cloth: number; trim: number; hasBeard: boolean; hasGlasses: boolean;
};

const SKINS = [0xf6d3b0, 0xf0c39b, 0xe0ae83, 0xd9a878, 0xc08e63, 0xb87952, 0x996141, 0x815238, 0x6b422b];
const HAIRS = [0x1d1a17, 0x34251d, 0x4a3120, 0x6a4528, 0x8a5a2b, 0xc28a3a, 0xd8c07a, 0x8a3a2a, 0x6b6b73, 0xd8d3cc];
const STYLES: Look['hairStyle'][] = ['crop', 'long', 'topknot', 'cap', 'bald'];
const BUILDS: Look['build'][] = ['slight', 'average', 'average', 'broad'];

/** A stable stream of small numbers from one string. */
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

export function lookFor(agentId: string, family: number): Look {
  const next = streamOf(agentId);
  const skin = SKINS[next(SKINS.length)];
  const hair = HAIRS[next(HAIRS.length)];
  const hairStyle = STYLES[next(STYLES.length)];
  const build = BUILDS[next(BUILDS.length)];
  // Height varies by a hand either way. Small on purpose: a crowd of wildly
  // different sizes reads as a bug, a crowd of slightly different ones reads
  // as people.
  const height = 0.92 + next(17) / 100;
  // Clothing shades the family colour rather than replacing it, so a family
  // stays readable at a glance while no two members wear the identical dye.
  const shade = 0.82 + next(37) / 100;
  const cloth = tint(family, shade);
  const trim = tint(family, shade * 0.72);
  return {
    skin, hair, hairStyle, build, height, cloth, trim,
    hasBeard: next(100) < 28, hasGlasses: next(100) < 22,
  };
}

function tint(color: number, factor: number) {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((color & 255) * factor));
  return (r << 16) | (g << 8) | b;
}

/** Hair, in the style this citizen wears it. */
export function makeHair(look: Look): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: look.hair, roughness: .92 });
  if (look.hairStyle === 'bald') return group;
  if (look.hairStyle === 'cap') {
    part(group, material, 0, 1.93, -.01, .48, .14, .42);
    part(group, material, 0, 1.88, -.22, .46, .07, .16);
    return group;
  }
  part(group, material, 0, 1.9, -.01, .47, .13, .41);
  if (look.hairStyle === 'long') {
    part(group, material, 0, 1.66, .19, .44, .42, .07);
    part(group, material, -.22, 1.68, 0, .06, .38, .34);
    part(group, material, .22, 1.68, 0, .06, .38, .34);
  }
  if (look.hairStyle === 'topknot') part(group, material, 0, 2.03, .04, .17, .17, .17);
  return group;
}

/** The rest of a face: not everyone has these, which is the point. */
export function makeFace(look: Look): THREE.Group {
  const group = new THREE.Group();
  if (look.hasBeard) {
    part(group, new THREE.MeshStandardMaterial({ color: look.hair, roughness: .95 }),
      0, 1.55, -.2, .3, .16, .04);
  }
  if (look.hasGlasses) {
    const frame = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: .5, metalness: .3 });
    part(group, frame, -.1, 1.7, -.21, .13, .1, .03);
    part(group, frame, .1, 1.7, -.21, .13, .1, .03);
    part(group, frame, 0, 1.7, -.21, .08, .02, .03);
  }
  return group;
}
