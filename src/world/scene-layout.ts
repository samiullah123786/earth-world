export type SceneBuild = Readonly<{
  buildId: string;
  plotId: string;
  structure: string;
  state: string;
  blueprint?: Readonly<{ kind?: string; prefabId?: string }>;
}>;

export type ScenePlot = Readonly<{ x: number; y: number; w: number; h: number }>;

const CIVIC_MULTI_BUILD_PLOTS = new Set(['plot:earth-bank']);
const PRIMARY_PRIORITY = ['home', 'cottage', 'workshop', 'hall', 'extension', 'garden', 'bench'];

function buildKind(build: SceneBuild) {
  return String(build.blueprint?.kind ?? build.structure);
}

/**
 * Convert storage records into visual sites.
 *
 * Early Earth stored a homestead as four records (home, extension, garden and
 * bench) inside one 3x3 plot. Rendering every row as a full V5 prefab stacked
 * several cottages on the same land. A plot is now one composed visual site;
 * civic campuses are the only intentional multi-prefab exception.
 */
export function selectRenderableBuilds<T extends SceneBuild>(builds: ReadonlyArray<T>): T[] {
  const active = builds.filter((build) => build.state === 'built' || build.state === 'building');
  const byPlot = new Map<string, T[]>();
  for (const build of active) {
    const rows = byPlot.get(build.plotId) ?? [];
    rows.push(build);
    byPlot.set(build.plotId, rows);
  }
  const selected: T[] = [];
  for (const [plotId, rows] of byPlot) {
    if (CIVIC_MULTI_BUILD_PLOTS.has(plotId)) {
      selected.push(...rows.sort((a, b) => a.buildId.localeCompare(b.buildId)));
      continue;
    }
    rows.sort((a, b) => {
      const aPriority = PRIMARY_PRIORITY.indexOf(buildKind(a));
      const bPriority = PRIMARY_PRIORITY.indexOf(buildKind(b));
      const normalizedA = aPriority < 0 ? PRIMARY_PRIORITY.length : aPriority;
      const normalizedB = bPriority < 0 ? PRIMARY_PRIORITY.length : bPriority;
      return normalizedA - normalizedB || a.buildId.localeCompare(b.buildId);
    });
    if (rows[0]) selected.push(rows[0]);
  }
  return selected;
}

/** Move a visual facade off a legacy road cell while preserving integer grid alignment. */
export function siteOriginAwayFromRoad(
  plot: ScenePlot,
  footprint: Readonly<{ width: number; height: number }>,
  isRoad: (x: number, y: number) => boolean,
) {
  let x = plot.x;
  let y = plot.y;
  const columnRoads = (column: number) => Array.from({ length: plot.h }, (_unused, offset) => isRoad(column, plot.y + offset))
    .filter(Boolean).length;
  const rowRoads = (row: number) => Array.from({ length: plot.w }, (_unused, offset) => isRoad(plot.x + offset, row))
    .filter(Boolean).length;
  const left = columnRoads(plot.x), right = columnRoads(plot.x + plot.w - 1);
  const top = rowRoads(plot.y), bottom = rowRoads(plot.y + plot.h - 1);
  if (footprint.width >= plot.w && right > left) x -= 1;
  else if (footprint.width >= plot.w && left > right) x += 1;
  if (footprint.height >= plot.h && bottom > top) y -= 1;
  else if (footprint.height >= plot.h && top > bottom) y += 1;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}
