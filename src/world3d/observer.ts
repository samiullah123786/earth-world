export type RoutePoint = { x: number; y: number; at: number };
export type MovingCitizen = { agentId: string; tx: number; ty: number; route?: RoutePoint[] | null; recentRoutes?: RoutePoint[][] };
/** Bounded server-authored route history. Never invent a straight line through walls. */
export class RouteBuffer {
  private routes = new Map<string, RoutePoint[][]>();
  private received = new Map<string, number>();
  ingest(rows: MovingCitizen[], now: number) {
    const present = new Set(rows.map(row => row.agentId));
    for (const id of this.routes.keys()) if (!present.has(id)) { this.routes.delete(id); this.received.delete(id); }
    for (const row of rows) {
      this.received.set(row.agentId, now);
      const routes = (this.routes.get(row.agentId) ?? []).filter(route => route[route.length-1].at > now - 15000);
      for (const route of [...(row.recentRoutes ?? []), row.route]) {
        if (!route || route.length < 2 || route.some(p => !Number.isFinite(p.x + p.y + p.at))) continue;
        if (!routes.some(old => old[0].at === route[0].at && old[old.length-1].at === route[route.length-1].at)) routes.push(route);
      }
      this.routes.set(row.agentId, routes.sort((a,b) => a[0].at - b[0].at).slice(-12));
    }
  }
  position(row: MovingCitizen, now: number) {
    const routes = this.routes.get(row.agentId) ?? [];
    let route = routes[0];
    for (let i = routes.length - 1; i >= 0; i--) if (routes[i][0].at <= now) { route = routes[i]; break; }
    if (!route) return { x: row.tx, z: row.ty, moving: false };
    if (now < route[0].at) return { x: route[0].x, z: route[0].y, moving: false };
    for (let i = 1; i < route.length; i++) {
      if (now <= route[i].at) {
        const a = route[i-1], b = route[i];
        const t = Math.max(0, Math.min(1, (now-a.at)/Math.max(1,b.at-a.at)));
        return { x: a.x+(b.x-a.x)*t, z: a.y+(b.y-a.y)*t, moving: true };
      }
    }
    // Once the interpolation clock catches the latest server snapshot, its location wins.
    const last = route[route.length-1];
    if (now >= (this.received.get(row.agentId) ?? Infinity)) return { x: row.tx, z: row.ty, moving: false };
    return { x: last.x, z: last.y, moving: false };
  }
}
export function visualIdentityKey(row: { name: string; avatarSpec?: unknown; serviceRole?: string | null; experienceTier?: string; activeTool?: string | null; carriedTool?: string | null }, generation: number) {
  return JSON.stringify([generation,row.name,row.avatarSpec,row.serviceRole,row.experienceTier,row.activeTool ?? row.carriedTool]);
}
export function boundedHeadTurn(targetHeading: number, heading: number) {
  const delta = Math.atan2(Math.sin(targetHeading-heading),Math.cos(targetHeading-heading));
  return Math.max(-.65, Math.min(.65, delta));
}
