/**
 * Where the Earth Market gets more to sell, and how it decides what is worth
 * recommending.
 *
 * The obvious version of this feature was "index trending GitHub repos". It is
 * a bad idea in three ways at once. Trending is the noisiest signal on the
 * internet and this market's whole claim is that its ranking is not for sale.
 * A repository usually has no install command, so the honest instruction would
 * be `git clone` and run a setup script - exactly the download-and-execute
 * pattern the safety scanner exists to refuse. And a link Earth has not
 * scanned cannot carry the Earth Verified signature, so enough of them
 * standing beside signed listings would make the signature mean nothing.
 *
 * So this indexes registries instead. Every record in the official MCP
 * registry carries either a published npm or PyPI package with an exact
 * version - a real command - or a remote URL, which is a real config block.
 * GitHub is then used the way it should be: as evidence *about* a listing,
 * never as the listing itself.
 *
 * Nothing here calls a model. The whole feature is HTTP and arithmetic.
 */

import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { maintenanceOf } from '../shared/maintenance';
import { mcpCapabilities, validateMcpManifest } from '../shared/mcp';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const REGISTRY_SOURCE = 'registry:modelcontextprotocol';

/**
 * GitHub allows sixty unauthenticated calls an hour, and this spends two per
 * repository. Twelve a run on an hourly cron is two dozen calls, comfortably
 * inside the limit with room for anything else that needs it. A token in the
 * environment lifts the ceiling to five thousand, so the batch grows.
 */
const REPOS_PER_RUN = () => (process.env.GITHUB_TOKEN ? 60 : 12);

const githubHeaders = () => {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'agentsearth-kernel',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
};

/** owner/repo out of a GitHub URL, or null for anything that is not one. */
export function githubSlug(url?: string | null): string | null {
  if (!url) return null;
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i.exec(String(url).trim());
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`;
}

/**
 * Turn one registry record into the manifest shape shared/mcp.ts already
 * validates, so an indexed server and a deposited one are the same kind of
 * thing everywhere downstream.
 */
/**
 * A stable Earth slug for a namespaced registry name.
 *
 * Registry names are reverse-DNS - `ai.adeu/adeu`, `ac.inference.sh/mcp` - and
 * the obvious move of taking the last segment is wrong: across the live
 * registry it collapsed a hundred and forty-eight distinct servers onto fifty
 * eight names, so `ai.adadvisor/mcp-server` and `ai.agenttrust/mcp-server`
 * became one listing and the last one written won.
 *
 * So the publisher stays in the slug. The leading segment is dropped because
 * it is only a TLD and carries no meaning, and a tail that merely repeats the
 * publisher is collapsed so nothing is called `adeu-adeu`. Measured against
 * every name the registry currently serves: 148 names, 148 slugs, no
 * collisions. Identity is worth more than a short name here - a slug that
 * shifts when a similarly-named server appears would break every install
 * command already written down.
 */
export function registrySlug(fullName: string): string {
  const [namespace, name] = String(fullName).split('/');
  if (!name) return '';
  const parts = namespace.split('.').filter(Boolean).slice(1);
  if (parts.length && parts[parts.length - 1] === name) parts.pop();
  return [...parts, name].join('-').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function manifestFromRegistry(record: any): any | null {
  const server = record?.server;
  if (!server?.name || !server?.description) return null;
  const slug = registrySlug(server.name);
  if (!slug) return null;

  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const npm = packages.find((entry: any) => entry.registryType === 'npm');
  const pypi = packages.find((entry: any) => entry.registryType === 'pypi');
  const oci = packages.find((entry: any) => entry.registryType === 'oci');
  const remote = remotes[0];

  // The install command, derived from what the registry actually publishes.
  // Nothing is guessed: a record with neither a package nor a remote is not
  // installable and is skipped rather than listed with a made-up command.
  let transport = 'stdio', runtime = 'node', command: string | undefined, args: string[] | undefined, url: string | undefined;
  if (npm) {
    command = 'npx'; args = ['-y', `${npm.identifier}${npm.version ? `@${npm.version}` : ''}`]; runtime = 'node';
  } else if (pypi) {
    command = 'uvx'; args = [`${pypi.identifier}${pypi.version ? `==${pypi.version}` : ''}`]; runtime = 'python';
  } else if (oci) {
    command = 'docker'; args = ['run', '-i', '--rm', String(oci.identifier)]; runtime = 'docker';
  } else if (remote?.url) {
    transport = remote.type === 'sse' ? 'sse' : 'http'; runtime = 'remote'; url = String(remote.url);
  } else {
    return null;
  }

  const repository = typeof server.repository?.url === 'string' ? server.repository.url : undefined;
  return {
    manifestVersion: '0.3',
    name: slug,
    displayName: server.title ? String(server.title).slice(0, 120) : undefined,
    version: String(server.version ?? '0.0.0'),
    description: String(server.description).slice(0, 1024),
    author: { name: String(server.name).split('/')[0] || 'unknown' },
    transport, runtime, command, args, url,
    license: server.license ? String(server.license) : undefined,
    repository,
    homepage: typeof server.websiteUrl === 'string' ? server.websiteUrl : undefined,
    keywords: undefined,
  };
}

/** Fetch the official registry and hand each page to the writer. */
export const syncOfficialRegistry = internalAction({
  args: { pages: v.optional(v.number()) },
  handler: async (ctx, { pages }): Promise<any> => {
    const maxPages = Math.min(pages ?? 8, 20);
    let cursor: string | undefined;
    let seen = 0;

    // Every page is collected before anything is written. The registry serves
    // one row per published version, and versions of one server can straddle a
    // page boundary - so deduping per page would let an older release on the
    // next page overwrite the newer one that came before it. Deduping across
    // the whole run is the only version of this that is correct.
    const newest = new Map<string, any>();
    for (let page = 0; page < maxPages; page++) {
      const url = `${REGISTRY}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) break;
      const body: any = await response.json().catch(() => null);
      const rows: any[] = body?.servers ?? [];
      if (!rows.length) break;
      seen += rows.length;
      for (const row of rows) {
        const key = row?.server?.name;
        if (!key) continue;
        const held = newest.get(key);
        const newer = !held || String(row.server.version ?? '')
          .localeCompare(String(held.server.version ?? ''), undefined, { numeric: true }) > 0;
        if (newer) newest.set(key, row);
      }
      cursor = body?.metadata?.nextCursor;
      if (!cursor) break;
    }

    const manifests = [...newest.values()].map(manifestFromRegistry).filter(Boolean);
    let added = 0, updated = 0, skipped = seen - manifests.length;
    // Written in batches, because a mutation gets one second.
    for (let at = 0; at < manifests.length; at += 40) {
      const result: any = await ctx.runMutation(internal.registrySync.upsertRegistryPage, {
        manifests: manifests.slice(at, at + 40),
      });
      added += result.added; updated += result.updated; skipped += result.skipped;
    }
    return { ok: true, seen, distinct: newest.size, listed: manifests.length, added, updated, skipped };
  },
});

/** Write one page. Kept small because a mutation gets one second. */
export const upsertRegistryPage = internalMutation({
  args: { manifests: v.array(v.any()) },
  handler: async (ctx, { manifests }) => {
    const now = Date.now();
    let added = 0, updated = 0, skipped = 0;

    for (const raw of manifests) {
      let manifest;
      try {
        manifest = validateMcpManifest(raw);
      } catch {
        skipped += 1;
        continue;
      }
      const existing = await ctx.db.query('bankMcpServers')
        .withIndex('name', (q) => q.eq('name', manifest.name)).first();
      // A citizen's own listing, and the hand-curated seed, both outrank an
      // automatic index of the same name. Earth never overwrites a row a
      // person is responsible for with one a cron fetched.
      if (existing && existing.depositorAgentId !== REGISTRY_SOURCE) { skipped += 1; continue; }

      const fields = {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        category: 'general',
        manifest,
        capabilities: mcpCapabilities(manifest),
        toolNames: [] as string[],
        transport: manifest.transport,
        runtime: manifest.runtime,
        authorName: manifest.author.name,
        license: manifest.license,
        homepage: manifest.homepage,
        repository: manifest.repository,
        depositorAgentId: REGISTRY_SOURCE,
        safety: {
          verdict: 'needs_review' as const,
          flags: ['indexed_upstream'],
          note: 'Indexed from the official MCP registry. Earth did not scan it and does not vouch for it. '
            + 'The install command is the one its publisher registered.',
          scannerVersion: 'registry-index',
        },
        state: 'flagged' as const,
        updatedAt: now,
      };
      if (existing) { await ctx.db.patch(existing._id, fields); updated += 1; continue; }
      await ctx.db.insert('bankMcpServers', {
        ...fields, serverId: `mcp:${manifest.name}`, installCount: 0, createdAt: now,
      });
      added += 1;
    }
    return { added, updated, skipped };
  },
});

/** The listings whose repository evidence is oldest, so refreshing is fair. */
export const stalestRepos = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query('bankMcpServers').withIndex('state', (q) => q.eq('state', 'flagged')).collect();
    const listed = await ctx.db.query('bankMcpServers').withIndex('state', (q) => q.eq('state', 'listed')).collect();
    return [...rows, ...listed]
      .filter((row) => githubSlug(row.repository))
      .sort((left, right) => (left.health?.checkedAt ?? 0) - (right.health?.checkedAt ?? 0))
      .slice(0, limit)
      .map((row) => ({ serverId: row.serverId, repository: row.repository!, installable: row.transport !== 'stdio' || Boolean(row.manifest?.command) }));
  },
});

export const storeHealth = internalMutation({
  args: { serverId: v.string(), health: v.any(), maintenanceScore: v.number() },
  handler: async (ctx, { serverId, health, maintenanceScore }) => {
    const row = await ctx.db.query('bankMcpServers')
      .withIndex('serverId', (q) => q.eq('serverId', serverId)).first();
    if (!row) return { ok: false };
    await ctx.db.patch(row._id, { health, maintenanceScore });
    return { ok: true };
  },
});

/**
 * Refresh the repository evidence for a bounded slice of the catalogue.
 *
 * Two calls per repository: the repo itself for freshness, licence and whether
 * it has been archived, and a one-item contributors page whose Link header
 * carries the total. Contributor count is what exposed the listings with tens
 * of thousands of stars and three people behind them, so it is worth the call.
 */
export const refreshMaintenance = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<any> => {
    const batch = Math.min(limit ?? REPOS_PER_RUN(), 100);
    const targets: any[] = await ctx.runQuery(internal.registrySync.stalestRepos, { limit: batch });
    const now = Date.now();
    let checked = 0, failed = 0;
    // Why the run stopped, because "checked: 0" on its own is indistinguishable
    // from "nothing needed checking" and sends you looking in the wrong place.
    // The Kernel calls GitHub from a shared cloud address, so the sixty-an-hour
    // unauthenticated ceiling is spent by whoever else is on that IP long
    // before this gets there. With a token the ceiling is per-account and five
    // thousand, which is the difference between this working and not.
    let stopped: string | null = null;

    for (const target of targets) {
      const slug = githubSlug(target.repository);
      if (!slug) continue;
      try {
        const response = await fetch(`https://api.github.com/repos/${slug}`, { headers: githubHeaders() });
        if (response.status === 403 || response.status === 429) {
          stopped = process.env.GITHUB_TOKEN
            ? 'GitHub rate limit reached for this token; the next run continues where this stopped.'
            : 'GitHub refused: no GITHUB_TOKEN is set, and the unauthenticated ceiling is per-IP and shared. '
              + 'Set one in the Convex environment to make this run properly.';
          break;
        }
        if (!response.ok) { failed += 1; continue; }
        const repo: any = await response.json();

        // The Link header's last page number is the contributor count, which
        // is far cheaper than fetching every contributor to count them.
        let contributors: number | undefined;
        const contribResponse = await fetch(
          `https://api.github.com/repos/${slug}/contributors?per_page=1&anon=false`,
          { headers: githubHeaders() },
        );
        if (contribResponse.ok) {
          const link = contribResponse.headers.get('link') ?? '';
          const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
          contributors = last ? Number(last[1]) : (await contribResponse.json().catch(() => []))?.length ?? undefined;
        }

        const health = {
          checkedAt: now,
          pushedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : undefined,
          archived: Boolean(repo.archived),
          license: repo.license?.spdx_id ?? null,
          stars: repo.stargazers_count ?? undefined,
          openIssues: repo.open_issues_count ?? undefined,
          contributors,
          repository: `https://github.com/${slug}`,
        };
        const verdict = maintenanceOf({ ...health, installable: target.installable }, now);
        // Count what was actually written, not what was fetched. Counting the
        // fetch made a run that stored nothing report twelve successes.
        const stored: any = await ctx.runMutation(internal.registrySync.storeHealth, {
          serverId: target.serverId,
          health: { ...health, label: verdict.label, why: verdict.why },
          maintenanceScore: verdict.score,
        });
        if (stored?.ok) checked += 1; else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { ok: true, checked, failed, considered: targets.length, stopped, authenticated: Boolean(process.env.GITHUB_TOKEN) };
  },
});

/**
 * Drop every row this sync owns.
 *
 * The first run used last-segment slugs and collapsed a hundred and sixty-six
 * servers onto names that already existed, so those rows describe whichever
 * publisher happened to be written last. They cannot be repaired in place -
 * the identity is wrong, not the contents - so they are removed and refetched.
 * Only rows this sync deposited are touched; a citizen's listing is never in
 * scope here.
 */
export const purgeRegistryRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('bankMcpServers')
      .withIndex('depositor', (q) => q.eq('depositorAgentId', REGISTRY_SOURCE)).collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});

/**
 * Forget what Earth thinks it knows about a listing's upkeep.
 *
 * A wrong measurement is worse than none - an unchecked listing says so, while
 * a stale or mistaken score is a claim being made. So there has to be a way to
 * take one back, and the next refresh will measure it properly.
 */
export const clearHealth = internalMutation({
  args: { serverId: v.string() },
  handler: async (ctx, { serverId }) => {
    const row = await ctx.db.query('bankMcpServers')
      .withIndex('serverId', (q) => q.eq('serverId', serverId)).first();
    if (!row) return { ok: false };
    await ctx.db.patch(row._id, { health: undefined, maintenanceScore: undefined });
    return { ok: true };
  },
});
