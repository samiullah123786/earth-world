/** One route clock for observation, reach checks, and steering transitions. */
export type RoutedBody = {
  tx: number; ty: number; fx?: number; fy?: number; t0?: number; t1?: number;
  route?: Array<{ x: number; y: number; at: number }>;
  recentRoutes?: Array<Array<{ x: number; y: number; at: number }>>;
};

export function currentPosition(body: RoutedBody, now: number): { x: number; y: number } {
  const route = body.route ?? [];
  if (route.length) {
    if (now <= route[0].at) return { x: route[0].x, y: route[0].y };
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      if (now > b.at) continue;
      const fraction = Math.max(0, Math.min(1, (now - a.at) / Math.max(1, b.at - a.at)));
      return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
    }
    const end = route[route.length - 1];
    return { x: end.x, y: end.y };
  }
  const fraction = Math.max(0, Math.min(1,
    (now - (body.t0 ?? now)) / Math.max(1, (body.t1 ?? now) - (body.t0 ?? now))));
  const x = body.fx ?? body.tx, y = body.fy ?? body.ty;
  return { x: x + (body.tx - x) * fraction, y: y + (body.ty - y) * fraction };
}

/** Preserve accepted short walks so polling viewers can replay missed motion.
 * Replaced in-flight routes are clipped at the real handoff position; future
 * waypoints from cancelled intentions must never be shown as completed travel.
 */
export function appendRouteHistory(body: RoutedBody, newRoute: RoutedBody['route'], now: number) {
  const histories = [...(body.recentRoutes ?? [])];
  const previous = body.route ?? [];
  if (previous.length && previous[0].at <= now && previous !== newRoute) {
    const clipped = previous.filter((point) => point.at <= now);
    if (previous[previous.length - 1].at > now) clipped.push({ ...currentPosition(body, now), at: now });
    if (clipped.length > 1) histories.push(clipped);
  }
  const cutoff = now - 20_000;
  return histories.filter((route) => route.length > 1 && route[route.length - 1].at >= cutoff)
    .slice(-8).map((route) => {
      const first = route.findIndex((point) => point.at >= cutoff);
      if (first <= 0) return route.slice(-128);
      const end = route[route.length - 1];
      const atCutoff = currentPosition({ tx: end.x, ty: end.y, route }, cutoff);
      return [{ ...atCutoff, at: cutoff }, ...route.slice(first)].slice(-128);
    });
}
