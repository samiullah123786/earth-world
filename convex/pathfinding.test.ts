import { describe, expect, it } from 'vitest';
import { findRoute } from './pathfinding';

/**
 * The escape rule: a citizen can always step OFF an illegal tile.
 *
 * Found the way the comment in findRoute says: a wall completed on the tile a
 * citizen stood on, and from then on every move and every demolition answered
 * "no safe route" forever, because routing demanded a walkable START. The
 * start is where you already are; walkability is a rule about where you may
 * GO.
 */
describe('routing out of an illegal tile', () => {
  const bounds = { width: 8, height: 8 };
  // A wall column at x=3 with a gap at the bottom row - sealed worlds have
  // no routes to find, which is a fact about geometry, not about the router.
  const walls = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < 8 && y < 8 && (x !== 3 || y === 7);

  it('routes off a blocked start tile to open ground', () => {
    const route = findRoute(3, 4, 5, 4, bounds, walls);
    expect(route).not.toBeNull();
    expect(route![0]).toEqual({ x: 3, y: 4 });
    expect(route![route!.length - 1]).toEqual({ x: 5, y: 4 });
    // The exemption is the start alone: every later step obeys the map.
    for (const step of route!.slice(1)) expect(walls(step.x, step.y)).toBe(true);
  });

  it('still refuses to route ONTO an illegal tile', () => {
    expect(findRoute(1, 1, 3, 4, bounds, walls)).toBeNull();
  });

  it('normal routes between open tiles are unchanged', () => {
    const route = findRoute(1, 1, 6, 6, bounds, walls);
    expect(route).not.toBeNull();
    for (const step of route!) expect(walls(step.x, step.y)).toBe(true);
  });
});
