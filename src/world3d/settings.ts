/**
 * What the viewer gets to decide.
 *
 * A world people watch on everything from a workstation to a phone on a train
 * cannot pick one quality level and be right. And beyond performance, half of
 * what people want from a window onto a living town is control over the view
 * itself: hold the clock at golden hour, turn off the nameplates to see the
 * place rather than the roster, drop the camera to the street.
 *
 * Every setting here is stored locally and applied on load, so the world a
 * person tuned is the world they come back to. Nothing here is sent anywhere:
 * these are preferences about looking, and the Kernel has no business knowing
 * how somebody likes their shadows.
 */

export type Quality = 'low' | 'balanced' | 'high';
/**
 * The hours this world keeps.
 *
 * There is no night, and no cycle that reaches one.
 *
 * A day-night cycle is a lovely thing in a game somebody has chosen to play
 * for an hour. This is a window onto a living town that people leave open, land
 * on from a link, and screenshot - and half of those moments falling in the
 * dark served nobody. It was tried both ways: weighted three-to-one toward
 * daylight, roughly one visit in four still arrived at night, and anybody who
 * left the tab open watched the town they came to see go black.
 *
 * The sun still moves - morning through golden hour is a real range and the
 * light genuinely changes across it. It just never sets.
 */
export type ClockMode = 'morning' | 'day' | 'noon' | 'golden';

export type Settings = {
  quality: Quality;
  shadows: boolean;
  clouds: boolean;
  wildlife: boolean;
  nameplates: boolean;
  /** Loose blades, pebbles and flowers strewn over open ground. */
  groundDetail: boolean;
  clock: ClockMode;
  /** How far a nameplate is still worth drawing, in tiles. */
  nameplateRange: number;
};

export const DEFAULTS: Settings = {
  quality: 'balanced',
  shadows: true,
  clouds: true,
  wildlife: true,
  nameplates: true,
  // Off.
  //
  // The meadow was strewn with thousands of grass blades, pebbles and flowers,
  // each drawn as a small box. At a distance it read as litter and up close as
  // green fence posts - a blade 0.38 units tall is fifteen per cent of a
  // person's height, which is not grass, it is a shrub. Real modelled trees and
  // planting do the job it was there to do, and do it properly. Anyone who
  // wants the old speckle back can switch it on.
  groundDetail: false,
  clock: 'day',
  nameplateRange: 26,
};

/**
 * What each quality level actually changes.
 *
 * Resolution scale first, because pixel count dominates everything else on the
 * machines that need this setting, and shadow map size second. That is the
 * whole list, deliberately: draw calls no longer belong on it, because the
 * renderer batches and there is no quality level at which the town is too
 * heavy to draw. A distance cull was drafted here and cut - a field nothing
 * reads is a setting that lies about what it does.
 */
export const PROFILES: Record<Quality, {
  pixelRatio: number; shadowMap: number; shadowsAllowed: boolean;
}> = {
  low: { pixelRatio: 1, shadowMap: 0, shadowsAllowed: false },
  balanced: { pixelRatio: 1.5, shadowMap: 2048, shadowsAllowed: true },
  high: { pixelRatio: 2, shadowMap: 4096, shadowsAllowed: true },
};

/** Where the clock sits when it is not following real time. 0.25 is noon. */
/**
 * Where the clock sits when it is not following real time.
 *
 * Phase 0 is sunrise and 0.25 is noon, so these are not evenly spaced: the sun
 * spends very little of a sine wave near the horizon, and dawn and golden hour
 * are entirely about being near the horizon.
 */
export const CLOCK_PHASES: Record<ClockMode, number> = {
  // Early, with long shadows and a warm cast, but fully lit.
  morning: 0.09,
  // Mid-morning: full daylight, sun off to one side so buildings still cast.
  // Noon is brighter and flatter - the shadows go straight down.
  day: 0.16,
  noon: 0.25,
  golden: 0.45,
};

const KEY = 'earth.view';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const stored = JSON.parse(raw) as Partial<Settings>;
    // Merged onto the defaults rather than trusted wholesale: a setting added
    // after somebody last visited must not arrive as undefined.
    return {
      ...DEFAULTS,
      ...stored,
      quality: (['low', 'balanced', 'high'] as const).includes(stored.quality as Quality)
        ? stored.quality as Quality : DEFAULTS.quality,
      // Anything saved under the old scheme - live, dawn, night - lands back
      // on daylight rather than resurrecting an hour that no longer exists.
      clock: (['morning', 'day', 'noon', 'golden'] as const).includes(stored.clock as ClockMode)
        ? stored.clock as ClockMode : DEFAULTS.clock,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* a viewer with storage blocked still gets to change the view */ }
}

/**
 * A first guess at what this machine can handle.
 *
 * Only ever used before somebody has expressed a preference. Guessing from
 * device memory and core count is crude, but it is far better than opening at
 * full resolution on a phone and letting the first impression be a slideshow.
 */
export function suggestQuality(): Quality {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (memory <= 4 || cores <= 4) return 'low';
  if (coarse || memory <= 8) return 'balanced';
  return 'high';
}

/** The clock phase to render at. Always daylight; see ClockMode. */
export function phaseFor(settings: Settings, _now: number): number {
  return CLOCK_PHASES[settings.clock] ?? CLOCK_PHASES.day;
}
