/**
 * One palette, built rather than picked.
 *
 * The old colours were chosen one at a time, each reasonable on its own: a
 * bright grass green, a separate brighter leaf green, a yellow flower, a purple
 * flower, a pink one. Nothing was wrong with any single value and the whole
 * read as programmer art, because twenty independent hues at full saturation is
 * what programmer art IS. The distance between that and something art-directed
 * is almost never better individual colours - it is fewer of them, related to
 * each other on purpose.
 *
 * So this file has no free hex values. Every colour is derived from four hue
 * anchors and a small set of moves - lighten, deepen, drain - which means two
 * greens picked a hundred lines apart are still siblings, and a change to the
 * anchor moves the whole family together.
 *
 * The second thing it does is make colour depend on the hour. A world lit the
 * same at dawn and dusk is a world with one photograph of itself; shifting the
 * ground warm at golden hour and blue after sunset costs nothing and is most of
 * why looking at it twice feels different.
 */

import * as THREE from 'three';

/** The four hues the whole world is built from, in degrees. */
export const ANCHORS = {
  /**
   * Everything growing. Deliberately yellow-of-green, not blue-of-green.
   *
   * Nudged warmer once the modelled buildings arrived: Kenney's kits are
   * painted in warm ochres and terracottas, and a cool meadow under them read
   * as two palettes meeting rather than one.
   */
  foliage: 88,
  /** Soil, timber, roof tile, thatch - one warm earth family. */
  earth: 27,
  /** Stone, road, metal. Barely a hue at all, biased cool so it reads as shade. */
  mineral: 214,
  /** The one cold accent: water, glass, and the gate. Used sparingly. */
  arcane: 191,
} as const;

type Anchor = keyof typeof ANCHORS;

/**
 * A colour from the system.
 *
 * `saturation` and `lightness` are the only dials, so nothing can wander off
 * the four hues by accident. Saturation is kept well under full throughout -
 * the single change that does most of the work.
 */
export function hue(anchor: Anchor, saturation: number, lightness: number, shift = 0): THREE.Color {
  return new THREE.Color().setHSL(
    (((ANCHORS[anchor] + shift) % 360) + 360) % 360 / 360,
    Math.max(0, Math.min(1, saturation)),
    Math.max(0, Math.min(1, lightness)),
  );
}

export const WORLD = {
  // Ground. Three greens that are obviously the same plant in different light.
  grass:      hue('foliage', 0.38, 0.43, -3),
  grassPale:  hue('foliage', 0.34, 0.50, -8),
  grassDeep:  hue('foliage', 0.40, 0.33, 6),
  blade:      hue('foliage', 0.36, 0.40, -4),
  reed:       hue('foliage', 0.28, 0.42, 22),
  leaf:       hue('foliage', 0.42, 0.30, 4),
  leafLight:  hue('foliage', 0.38, 0.39, -6),

  // Earth. Soil through to a fired roof tile, all one family.
  soil:       hue('earth', 0.34, 0.28),
  dirt:       hue('earth', 0.34, 0.42),
  crop:       hue('earth', 0.33, 0.31),
  trunk:      hue('earth', 0.32, 0.24),
  timber:     hue('earth', 0.35, 0.31),
  timberDark: hue('earth', 0.33, 0.17),
  thatch:     hue('earth', 0.38, 0.52, 14),
  roof:       hue('earth', 0.36, 0.35, -9),
  roofDark:   hue('earth', 0.33, 0.25, -11),
  plaster:    hue('earth', 0.30, 0.79, 6),
  cream:      hue('earth', 0.28, 0.71, 4),
  civic:      hue('earth', 0.29, 0.62, 9),

  // Mineral. Nearly grey, but cool, so shadow on stone looks like shadow.
  stone:      hue('mineral', 0.06, 0.53),
  stoneDark:  hue('mineral', 0.08, 0.36),
  road:       hue('earth', 0.08, 0.62, 6),
  metal:      hue('mineral', 0.10, 0.40),
  obsidian:   hue('mineral', 0.24, 0.12),
  fence:      hue('earth', 0.28, 0.34),
  lampPost:   hue('mineral', 0.12, 0.22),

  // The cold accent, spent in three places only.
  water:      hue('arcane', 0.44, 0.42),
  glass:      hue('arcane', 0.38, 0.72),
  portal:     hue('arcane', 0.72, 0.62),

  // Warm light sources, the only saturated things in the world.
  lamp:       hue('earth', 0.72, 0.62, 12),
  ember:      hue('earth', 0.80, 0.55, -4),
  gold:       hue('earth', 0.62, 0.50, 15),

  // Flowers. Three, related by lightness rather than scattered around the wheel.
  bloomWarm:  hue('earth', 0.55, 0.62, 22),
  bloomPale:  hue('foliage', 0.20, 0.78, -40),
  bloomCool:  hue('arcane', 0.32, 0.66, 46),
} as const;

/**
 * The sky, sun and haze at a given point in the day.
 *
 * `phase` runs 0 to 1 across a full cycle, 0.25 being noon. Everything the
 * atmosphere needs comes from here so the sky, the fog and the directional
 * light can never disagree about what time it is - which is the usual way a
 * day-night cycle ends up with a blue sky and an orange horizon at once.
 */
export type Sky = {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  ground: THREE.Color;
  fog: THREE.Color;
  sunIntensity: number;
  ambientIntensity: number;
  /** 0 at night, 1 in full day - drives whether windows and lamps are lit. */
  daylight: number;
  /** Multiplier on every emissive surface, so the town lights up after dark. */
  glow: number;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function skyAt(phase: number): Sky {
  // Elevation of the sun, -1 (midnight) through +1 (noon).
  //
  // Phase 0 is dawn, 0.25 noon, 0.5 dusk, 0.75 midnight - which means a plain
  // sine, with no quarter-turn offset. An earlier version subtracted a quarter
  // turn and put noon at phase 0.5, so the "noon" preset rendered the world at
  // thirty per cent daylight and every fixed hour was wrong by six of them.
  const elevation = Math.sin(phase * Math.PI * 2);
  // Widened deliberately. A tighter curve saturated at full daylight by the
  // time the sun was a quarter of the way up, which made dawn, golden hour and
  // noon render identically - three presets, one picture.
  const day = Math.max(0, Math.min(1, (elevation + 0.12) / 0.92));
  // Golden hour peaks where the sun is near the horizon, in either direction.
  // Scaled against a boosted daylight term rather than the raw one, so the warm
  // cast is actually visible at the hour it is named after.
  const golden = Math.max(0, 1 - Math.abs(elevation) * 2.2) * Math.min(1, day * 2.5);

  const zenith = new THREE.Color().setHSL(
    lerp(228, 205, day) / 360, lerp(0.46, 0.52, day), lerp(0.13, 0.53, day));
  const horizon = new THREE.Color().setHSL(
    lerp(228, lerp(198, 28, golden), day) / 360,
    lerp(0.30, lerp(0.40, 0.72, golden), day),
    lerp(0.14, lerp(0.76, 0.66, golden), day));
  const sun = new THREE.Color().setHSL(
    lerp(220, lerp(44, 22, golden), day) / 360,
    lerp(0.30, lerp(0.28, 0.68, golden), day),
    lerp(0.55, lerp(0.92, 0.66, golden), day));

  return {
    zenith, horizon, sun,
    ground: WORLD.grassDeep.clone().multiplyScalar(lerp(0.24, 1, day)),
    fog: horizon.clone().lerp(zenith, 0.28),
    // Brightness does not track elevation one-for-one. The sun twenty degrees
    // above the horizon is still a bright sun - it is WARM and LOW, not dim -
    // and tying intensity straight to elevation made golden hour render as a
    // gloomy afternoon. It holds near full while the sun is up and falls away
    // quickly once it is not.
    //
    // Twice wrong in both directions, and the second was worse.
    //
    // The original rig ran ambient 2.2 against a sun of 3.3 - a ratio at which
    // nothing in the world had any shape, because the fill drowned the key.
    // Fixing the RATIO by cutting both to 0.68 and 2.4 fixed the flatness and
    // took a third of the total light out of the world with it, so the place
    // read as permanently overcast and full noon looked like dusk.
    //
    // What was needed was the ratio AND the level: roughly three to one, at a
    // sun brighter than the original. Night keeps a real floor - moonlight, not
    // a power cut - because a town you cannot see is not a mood, it is a bug
    // report.
    sunIntensity: lerp(1.15, 3.25, Math.min(1, day * 1.9)),
    // Sky light, which matters most exactly when the sun does not: at golden
    // hour a low sun grazes flat ground and barely lights it, and what keeps a
    // meadow from going black is the sky above it. Still well under the sun, so
    // the directional light can cast - the old rig had ambient at 2.2 against a
    // sun of 3.3, a ratio at which nothing in the world had any shape.
    ambientIntensity: lerp(0.85, 1.15, Math.min(1, day * 1.9)),
    daylight: day,
    // How hard every window, lamp and hearth in the town burns.
    //
    // A fixed emissive intensity means the windows that look right at noon are
    // invisible at midnight, which throws away the best hour this world has:
    // a dark valley with a lit town in it. They come up as the light goes down.
    glow: 1 + (1 - day) * 2.6,
  };
}

/** Materials built from the system, replacing the hand-picked set. */
export function worldMaterials() {
  const standard = (color: THREE.Color, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color: color.clone(), roughness, ...extra });

  return {
    grass: standard(WORLD.grass, 0.94),
    dirt: standard(WORLD.dirt, 1),
    road: standard(WORLD.road, 0.96),
    water: new THREE.MeshStandardMaterial({
      color: WORLD.water.clone(), roughness: 0.16, metalness: 0.06,
      transparent: true, opacity: 0.86,
    }),
    crop: standard(WORLD.crop, 1),
    trunk: standard(WORLD.trunk, 1),
    leaf: standard(WORLD.leaf, 0.92),
    leafLight: standard(WORLD.leafLight, 0.92),
    cream: standard(WORLD.cream, 0.86),
    plaster: standard(WORLD.plaster, 0.84),
    timber: standard(WORLD.timber, 0.9),
    darkTimber: standard(WORLD.timberDark, 0.94),
    roof: standard(WORLD.roof, 0.88),
    roofDark: standard(WORLD.roofDark, 0.9),
    stone: standard(WORLD.stone, 0.96),
    stoneDark: standard(WORLD.stoneDark, 0.98),
    civic: standard(WORLD.civic, 0.9),
    gold: standard(WORLD.gold, 0.46, { metalness: 0.55 }),
    metal: standard(WORLD.metal, 0.5, { metalness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({
      color: WORLD.glass.clone(), roughness: 0.1, metalness: 0.02,
      transparent: true, opacity: 0.42,
    }),
    window: standard(WORLD.lamp, 0.35, { emissive: WORLD.ember.clone(), emissiveIntensity: 1.5 }),
    cyan: standard(WORLD.portal, 0.4, { emissive: WORLD.portal.clone(), emissiveIntensity: 1.7 }),
    obsidian: standard(WORLD.obsidian, 0.5, { metalness: 0.2 }),
    portal: new THREE.MeshStandardMaterial({
      color: WORLD.portal.clone(), emissive: WORLD.portal.clone(), emissiveIntensity: 2.3,
      transparent: true, opacity: 0.66, roughness: 0.25,
    }),
  };
}
