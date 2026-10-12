import { describe, expect, it } from 'vitest';
import { currentPosition, appendRouteHistory } from './position';

describe('route clock', () => {
  it('follows bends instead of cutting a straight line to the destination', () => {
    const body = { fx: 0, fy: 0, tx: 10, ty: 10, t0: 0, t1: 2000,
      route: [{ x: 0, y: 0, at: 0 }, { x: 10, y: 0, at: 1000 }, { x: 10, y: 10, at: 2000 }] };
    expect(currentPosition(body, 500)).toEqual({ x: 5, y: 0 });
    expect(currentPosition(body, 1500)).toEqual({ x: 10, y: 5 });
    expect(currentPosition(body, -100)).toEqual({ x: 0, y: 0 });
    expect(currentPosition(body, 2500)).toEqual({ x: 10, y: 10 });
  });
  it('clips interrupted routes and bounds replay history by time and count', () => {
    const body = { tx: 10, ty: 10, route: [{ x: 0, y: 0, at: 0 }, { x: 10, y: 0, at: 1000 }, { x: 10, y: 10, at: 2000 }] };
    expect(appendRouteHistory(body, [], 1500)).toEqual([[{ x: 0, y: 0, at: 0 }, { x: 10, y: 0, at: 1000 }, { x: 10, y: 5, at: 1500 }]]);
    const recentRoutes = Array.from({ length: 12 }, (_, i) => [{ x: i, y: 0, at: 500 }, { x: i, y: 1, at: 1000 }]);
    expect(appendRouteHistory({ tx: 0, ty: 0, recentRoutes }, [], 1500)).toHaveLength(8);
    expect(appendRouteHistory({ tx: 0, ty: 0, recentRoutes }, [], 22000)).toHaveLength(0);
    const long = [{ x: 0, y: 0, at: 0 }, { x: 100, y: 0, at: 100000 }];
    expect(appendRouteHistory({ tx: 100, ty: 0, recentRoutes: [long] }, [], 100000)[0][0]).toEqual({ x: 80, y: 0, at: 80000 });
  });
  it('preserves the legacy timed movement contract without waypoints', () => {
    expect(currentPosition({ fx: 2, fy: 3, tx: 4, ty: 3, t0: 100, t1: 200 }, 150)).toEqual({ x: 3, y: 3 });
    expect(currentPosition({ tx: 4, ty: 3 }, 150)).toEqual({ x: 4, y: 3 });
  });
});
