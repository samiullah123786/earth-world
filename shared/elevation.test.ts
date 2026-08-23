import { describe, expect, it } from 'vitest';
import {
  RELIEF, foundationDepth, heightAt, isGentle, siteHeight, slopeAt,
} from './elevation';

describe('the ground is the same for everyone', () => {
  it('gives one tile the same height every time it is asked', () => {
    for (const [x, y] of [[0, 0], [31, 24], [137, 88], [-12, 240]]) {
      expect(heightAt(x, y)).toBe(heightAt(x, y));
    }
  });

  it('has no seam anywhere on the lattice, where value noise usually shows one', () => {
    // Crossing an integer boundary must not jump. This is the failure that
    // makes a heightmap look tiled, and it is invisible until it isn't.
    for (const edge of [10, 46, 92, -23]) {
      const before = heightAt(edge - 0.0001, 17.5);
      const after = heightAt(edge + 0.0001, 17.5);
      expect(Math.abs(after - before)).toBeLessThan(0.001);
    }
  });
});

describe('gentle where people walk', () => {
  it('never lets two neighbouring tiles differ by enough to read as a step', () => {
    let worst = 0;
    for (let x = 0; x < 160; x += 1) {
      for (let y = 0; y < 160; y += 1) {
        worst = Math.max(worst, Math.abs(heightAt(x + 1, y) - heightAt(x, y)));
        worst = Math.max(worst, Math.abs(heightAt(x, y + 1) - heightAt(x, y)));
      }
    }
    // A citizen is about two units tall. A tenth of a unit between tiles is a
    // slope; half a unit is a staircase.
    expect(worst).toBeLessThan(0.12);
  });

  it('still has real relief across the world, not just noise around flat', () => {
    let low = Infinity, high = -Infinity;
    for (let x = 0; x < 256; x += 4) {
      for (let y = 0; y < 256; y += 4) {
        const h = heightAt(x, y);
        low = Math.min(low, h); high = Math.max(high, h);
      }
    }
    // Rolling country close up is worthless if the horizon is still a table.
    expect(high - low).toBeGreaterThan(RELIEF * 0.55);
  });

  it('keeps every height inside the published relief', () => {
    for (let x = 0; x < 300; x += 7) {
      for (let y = 0; y < 300; y += 7) {
        expect(heightAt(x, y)).toBeGreaterThanOrEqual(0);
        expect(heightAt(x, y)).toBeLessThanOrEqual(RELIEF);
      }
    }
  });
});

describe('a building sits flat', () => {
  const plot = { x: 42, y: 42, w: 3, h: 3 };

  it('takes one height for the whole footprint, sampled at its centre', () => {
    expect(siteHeight(plot)).toBe(heightAt(43.5, 43.5));
  });

  it('asks for enough foundation to meet the ground on its lowest side', () => {
    const depth = foundationDepth(plot);
    expect(depth).toBeGreaterThanOrEqual(0);
    // Whatever the corner heights are, the pad plus its skirt must reach them.
    for (const [x, y] of [[42, 42], [45, 42], [42, 45], [45, 45]]) {
      expect(siteHeight(plot) - depth).toBeLessThanOrEqual(heightAt(x, y) + 1e-9);
    }
  });

  it('needs no foundation worth drawing on ground this gentle', () => {
    // The whole point of a long wavelength: a three-tile parcel is nearly level.
    expect(foundationDepth(plot)).toBeLessThan(0.35);
  });
});

describe('which way the land falls', () => {
  it('reports a real gradient rather than zero everywhere', () => {
    let steepest = 0;
    for (let x = 0; x < 200; x += 3) {
      for (let y = 0; y < 200; y += 3) steepest = Math.max(steepest, slopeAt(x, y).grade);
    }
    expect(steepest).toBeGreaterThan(0.01);
  });

  it('agrees with the heights either side of it', () => {
    const { dx } = slopeAt(80, 80);
    const measured = (heightAt(81, 80) - heightAt(79, 80)) / 2;
    expect(dx).toBeCloseTo(measured, 10);
  });

  it('calls most of a settled town gentle', () => {
    let gentle = 0, total = 0;
    for (let x = 20; x < 60; x++) {
      for (let y = 12; y < 50; y++) { total++; if (isGentle(x, y)) gentle++; }
    }
    expect(gentle / total).toBeGreaterThan(0.8);
  });
});
