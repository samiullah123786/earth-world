export type SceneBuild = Readonly<{
  buildId: string;
  plotId: string;
  structure: string;
  state: string;
  blueprint?: Readonly<{ kind?: string; prefabId?: string }>;
}>;

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
