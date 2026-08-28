import { describe, expect, it } from 'vitest';
import {
  CATALOGUE, DENSITY, assetsFor, facingOf, manifest, pick, rollOf,
} from './catalogue';

describe('the catalogue itself', () => {
  it('gives every asset a unique id', () => {
    const ids = CATALOGUE.map((asset) => asset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every asset a unique file', () => {
    const urls = CATALOGUE.map((asset) => asset.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('never ships an asset that may stand nowhere', () => {
    for (const asset of CATALOGUE) {
      expect(asset.habitats.length).toBeGreaterThan(0);
      expect(asset.weight).toBeGreaterThan(0);
      expect(asset.height).toBeGreaterThan(0);
    }
  });

  it('keeps a house out of the woods and a tree out of the plaza', () => {
    for (const asset of CATALOGUE) {
      if (asset.kind === 'home') expect(asset.habitats).toEqual(['plot']);
      if (asset.kind === 'tree') expect(asset.habitats).not.toContain('plot');
    }
  });

  it('offers something for every place a thing can stand', () => {
    expect(assetsFor('home', 'plot').length).toBeGreaterThan(6);
    expect(assetsFor('tree', 'wood').length).toBeGreaterThan(8);
    expect(assetsFor('flora', 'meadow').length).toBeGreaterThan(6);
    expect(assetsFor('civic', 'civic').length).toBeGreaterThan(4);
    // And nothing at all where nothing belongs.
    expect(assetsFor('home', 'wood')).toEqual([]);
  });
});

describe('a thing keeps the look it was given', () => {
  it('answers the same for one seed, always', () => {
    const pool = assetsFor('home', 'plot');
    for (const seed of ['build:abc', 'build:xyz', 'plot-42-42']) {
      expect(pick(pool, seed)!.id).toBe(pick(pool, seed)!.id);
      expect(facingOf(seed)).toBe(facingOf(seed));
    }
  });

  it('gives neighbouring ids different houses', () => {
    // The failure this guards: a hash whose low bits barely move across
    // sequential ids hands an entire street the same model.
    const pool = assetsFor('home', 'plot');
    const street = Array.from({ length: 24 }, (_, index) => pick(pool, `build:${1000 + index}`)!.id);
    expect(new Set(street).size).toBeGreaterThan(4);
  });

  it('spreads across the whole catalogue given enough things', () => {
    const pool = assetsFor('home', 'plot');
    const seen = new Set(
      Array.from({ length: 600 }, (_, index) => pick(pool, `home-seed-${index}`)!.id));
    expect(seen.size).toBe(pool.length);
  });

  it('respects the weights rather than spreading evenly', () => {
    const pool = assetsFor('tree', 'wood');
    const counts = new Map<string, number>();
    for (let index = 0; index < 6000; index++) {
      const asset = pick(pool, `t-${index}`)!;
      counts.set(asset.id, (counts.get(asset.id) ?? 0) + 1);
    }
    const common = pool.find((asset) => asset.weight === 4)!;
    const rare = pool.find((asset) => asset.weight === 1)!;
    // A weight of four should appear substantially more than a weight of one.
    expect(counts.get(common.id)!).toBeGreaterThan(counts.get(rare.id)! * 2);
  });

  it('faces things four ways, all of them square to the grid', () => {
    const angles = new Set(
      Array.from({ length: 200 }, (_, index) => facingOf(`f-${index}`).toFixed(4)));
    expect(angles.size).toBe(4);
    for (const angle of angles) {
      expect(Number(angle) % (Math.PI / 2)).toBeCloseTo(0, 3);
    }
  });
});

describe('the roll behind it', () => {
  it('stays inside zero and one', () => {
    for (let index = 0; index < 500; index++) {
      const value = rollOf(`seed-${index}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('does not clump, which is what a weak hash does', () => {
    const buckets = new Array(10).fill(0);
    for (let index = 0; index < 4000; index++) {
      buckets[Math.floor(rollOf(`agent:${index}`) * 10)] += 1;
    }
    for (const bucket of buckets) {
      expect(bucket).toBeGreaterThan(4000 / 10 * 0.6);
      expect(bucket).toBeLessThan(4000 / 10 * 1.4);
    }
  });
});

describe('placement density', () => {
  it('gathers more at the roadside than in open field', () => {
    expect(DENSITY.verge).toBeGreaterThan(DENSITY.meadow);
  });

  it('puts nothing loose on somebody\'s plot or in the plaza', () => {
    expect(DENSITY.plot).toBe(0);
    expect(DENSITY.civic).toBe(0);
  });
});

describe('the manifest', () => {
  it('lists every file once', () => {
    expect(manifest().length).toBe(CATALOGUE.length);
    expect(new Set(manifest()).size).toBe(manifest().length);
  });

  it('can be narrowed to one kind for staged loading', () => {
    const trees = manifest('tree');
    expect(trees.length).toBeGreaterThan(10);
    expect(trees.every((url) => url.includes('/tree/'))).toBe(true);
  });
});
