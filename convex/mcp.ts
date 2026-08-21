/**
 * The MCP half of the market: listing servers, finding them, installing them.
 *
 * Everything a caller can reach is here, and everything here answers the same
 * three questions a person actually has about an MCP server: what does it do,
 * what will it reach for, and what exactly do I paste into my client.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import {
  MCP_CLIENTS, mcpCapabilities, mcpInstallMatrix, mcpInstallSnippet, validateMcpManifest,
} from '../shared/mcp';
import { MCP_CATALOG_ENTRIES, MCP_CATALOG_SOURCE } from './mcpCatalogSeed';

const LISTABLE = new Set(['listed', 'flagged']);

function manifestOf(row: any) {
  return validateMcpManifest(row.manifest);
}

/** The card shape: enough to decide whether to open the listing, no more. */
function card(row: any) {
  return {
    serverId: row.serverId,
    name: row.name,
    displayName: row.displayName ?? row.name,
    description: row.description,
    version: row.version,
    category: row.category,
    keywords: row.keywords ?? [],
    capabilities: row.capabilities,
    toolCount: row.toolNames.length,
    transport: row.transport,
    runtime: row.runtime,
    authorName: row.authorName,
    license: row.license,
    installCount: row.installCount,
    safety: { verdict: row.safety.verdict, flags: row.safety.flags },
    state: row.state,
    // What Earth knows about the repository behind this, and when it looked.
    // Stars ride along for display; the score never counts them.
    maintenanceScore: row.maintenanceScore ?? null,
    maintenance: row.health
      ? {
        label: row.health.label ?? 'unknown', why: row.health.why ?? '',
        stars: row.health.stars ?? null, contributors: row.health.contributors ?? null,
        pushedAt: row.health.pushedAt ?? null, archived: row.health.archived ?? false,
        checkedAt: row.health.checkedAt,
      }
      : null,
    repository: row.repository ?? null,
    updatedAt: row.updatedAt,
  };
}

/**
 * Everything a detail page renders, in one read.
 *
 * The install snippets are generated here rather than stored, so a server that
 * changes its command cannot leave a stale snippet behind telling people to
 * run the old one.
 */
export const detail = query({
  args: { serverId: v.string() },
  handler: async (ctx, { serverId }) => {
    const row = await ctx.db.query('bankMcpServers')
      .withIndex('serverId', (q) => q.eq('serverId', serverId)).first();
    if (!row) return null;
    const manifest = manifestOf(row);
    return {
      ...card(row),
      manifest,
      tools: manifest.tools ?? [],
      userConfig: manifest.userConfig ?? [],
      homepage: row.homepage,
      repository: row.repository,
      safetyNote: row.safety.note,
      install: mcpInstallMatrix(manifest),
      // Two ways in, because people arrive differently. The one-liner is for
      // anyone who wants it done; the manual block is for anyone who would
      // rather see exactly what lands in their config first, and for clients
      // this installer cannot write a file for.
      // A plain string, not a helper: a query result is serialised, and a
      // function here would arrive at the caller as nothing at all.
      oneLiner: `npx agentsearth install ${manifest.name}`,
      createdAt: row.createdAt,
    };
  },
});

/** One client's snippet, for a copy button that does not ship the whole matrix. */
export const installFor = query({
  args: { serverId: v.string(), clientId: v.string() },
  handler: async (ctx, { serverId, clientId }) => {
    const row = await ctx.db.query('bankMcpServers')
      .withIndex('serverId', (q) => q.eq('serverId', serverId)).first();
    if (!row) return null;
    return mcpInstallSnippet(manifestOf(row), clientId);
  },
});

/** The clients Earth can write config for, for the client picker to render. */
export const clients = query({
  args: {},
  handler: async () => MCP_CLIENTS.map((client) => ({ ...client, supports: [...client.supports] })),
});

/**
 * Browse, with the facets a person actually filters on.
 *
 * Retired servers are the only real exclusion. A flagged one still appears,
 * carrying its flags, for the same reason a skill does: a catalogue that hides
 * what it holds reads as an empty catalogue.
 */
export const browse = query({
  args: {
    category: v.optional(v.string()),
    transport: v.optional(v.string()),
    capability: v.optional(v.string()),
    sort: v.optional(v.union(v.literal('recent'), v.literal('installs'), v.literal('name'))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { category, transport, capability, sort, limit }) => {
    const take = Math.min(limit ?? 40, 100);
    const rows = category
      ? await ctx.db.query('bankMcpServers')
        .withIndex('category_created', (q) => q.eq('category', category)).order('desc').take(400)
      : await ctx.db.query('bankMcpServers').order('desc').take(400);
    const filtered = rows.filter((row) => LISTABLE.has(row.state)
      && (!transport || row.transport === transport)
      && (!capability || row.capabilities.includes(capability)));
    const sorted = [...filtered].sort((a, b) => {
      if (sort === 'installs') return b.installCount - a.installCount;
      if (sort === 'name') return a.name.localeCompare(b.name);
      return b.updatedAt - a.updatedAt;
    });
    return { total: filtered.length, servers: sorted.slice(0, take).map(card) };
  },
});

/**
 * Keyword search over MCP servers. Free and always available, for the same
 * reason the Bank's own text search exists: search must not depend on an
 * outside provider's billing account.
 */
export const search = query({
  args: { query: v.string(), category: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { query: text, category, limit }) => {
    const trimmed = text.trim();
    const take = Math.min(limit ?? 20, 50);
    if (!trimmed) return [];
    const rows = await ctx.db.query('bankMcpServers')
      .withSearchIndex('by_text', (q: any) => (category
        ? q.search('description', trimmed).eq('category', category)
        : q.search('description', trimmed)))
      .take(take * 2);
    return rows.filter((row) => LISTABLE.has(row.state)).slice(0, take).map(card);
  },
});

/** The category rail, counted so an empty facet is never offered. */
export const categories = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('bankMcpServers').take(1000);
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!LISTABLE.has(row.state)) continue;
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([slug, count]) => ({ slug, count }))
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  },
});

/** What a citizen has listed, for the manage screen. */
export const listedBy = internalQuery({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    const rows = await ctx.db.query('bankMcpServers')
      .withIndex('depositor', (q) => q.eq('depositorAgentId', agentId)).collect();
    return rows.map(card);
  },
});

/**
 * List a server, or update the one this citizen already listed under that name.
 *
 * Re-listing is an update, never a duplicate: the name is the identity, and
 * only the citizen who first listed it may change it.
 */
export const publish = internalMutation({
  args: {
    depositorAgentId: v.string(),
    manifest: v.any(),
    category: v.string(),
    safety: v.object({
      verdict: v.union(v.literal('inert_safe'), v.literal('needs_review'), v.literal('refused')),
      flags: v.array(v.string()),
      note: v.string(),
      scannerVersion: v.string(),
    }),
  },
  handler: async (ctx, { depositorAgentId, manifest: raw, category, safety }) => {
    const manifest = validateMcpManifest(raw);
    if (safety.verdict === 'refused') throw new Error('the safety scanner refused this server');
    const now = Date.now();
    const existing = await ctx.db.query('bankMcpServers')
      .withIndex('name', (q) => q.eq('name', manifest.name)).first();
    if (existing && existing.depositorAgentId !== depositorAgentId) {
      throw new Error(`the name ${manifest.name} is already listed by another citizen`);
    }
    const fields = {
      name: manifest.name,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      category,
      keywords: manifest.keywords ? [...manifest.keywords] : undefined,
      manifest,
      capabilities: mcpCapabilities(manifest),
      toolNames: (manifest.tools ?? []).map((tool) => tool.name),
      transport: manifest.transport,
      runtime: manifest.runtime,
      authorName: manifest.author.name,
      license: manifest.license,
      homepage: manifest.homepage,
      repository: manifest.repository,
      depositorAgentId,
      safety,
      state: (safety.verdict === 'needs_review' ? 'flagged' : 'listed') as 'listed' | 'flagged',
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { serverId: existing.serverId, updated: true, capabilities: fields.capabilities };
    }
    const serverId = `mcp:${manifest.name}`;
    await ctx.db.insert('bankMcpServers', {
      ...fields, serverId, installCount: 0, createdAt: now,
    });
    return { serverId, updated: false, capabilities: fields.capabilities };
  },
});

/**
 * Withdraw a listing.
 *
 * Retiring, never deleting: anyone already running this server keeps a record
 * of where it came from, and the name stays claimed so nobody can publish a
 * different thing under a name people already trust. Only the citizen who
 * listed it may withdraw it.
 */
export const retire = internalMutation({
  args: { serverId: v.string(), agentId: v.string() },
  handler: async (ctx, { serverId, agentId }) => {
    const row = await ctx.db.query('bankMcpServers')
      .withIndex('serverId', (q) => q.eq('serverId', serverId)).first();
    if (!row) throw new Error('no such MCP server');
    if (row.depositorAgentId !== agentId) throw new Error('only the citizen who listed this may withdraw it');
    await ctx.db.patch(row._id, { state: 'retired', updatedAt: Date.now() });
    return { serverId, retired: true };
  },
});

/**
 * Index public MCP servers from an upstream catalogue.
 *
 * A registry with nothing in it teaches nobody anything, and every catalogue
 * in this category begins by indexing the public servers that already exist.
 * These rows are marked as indexed rather than deposited: the author, licence
 * and source repository travel with them, Earth claims none of them, and the
 * citizen who wrote one can claim the name later by listing it themselves.
 */
export const importCatalog = internalMutation({
  // Paged, because a mutation gets one second and there are a few hundred of
  // them. Run it until `remaining` reaches zero.
  args: { offset: v.optional(v.number()), batch: v.optional(v.number()) },
  handler: async (ctx, { offset, batch }) => {
    const source = MCP_CATALOG_SOURCE;
    const start = Math.max(0, offset ?? 0);
    const size = Math.min(batch ?? 40, 80);
    const entries = (MCP_CATALOG_ENTRIES as ReadonlyArray<any>).slice(start, start + size);
    const now = Date.now();
    let added = 0, updated = 0, skipped = 0;
    for (const entry of entries) {
      let manifest;
      try {
        manifest = validateMcpManifest(entry.manifest);
      } catch {
        skipped += 1;
        continue;
      }
      const existing = await ctx.db.query('bankMcpServers')
        .withIndex('name', (q) => q.eq('name', manifest.name)).first();
      // A citizen's own listing always outranks an indexed copy of it.
      if (existing && existing.depositorAgentId !== source) { skipped += 1; continue; }
      const fields = {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        category: String(entry.category ?? 'general'),
        keywords: manifest.keywords ? [...manifest.keywords] : undefined,
        manifest,
        capabilities: mcpCapabilities(manifest),
        toolNames: (manifest.tools ?? []).map((tool) => tool.name),
        transport: manifest.transport,
        runtime: manifest.runtime,
        authorName: manifest.author.name,
        license: manifest.license,
        homepage: manifest.homepage,
        repository: manifest.repository,
        depositorAgentId: source,
        safety: {
          verdict: 'needs_review' as const,
          flags: ['indexed_upstream'],
          // Honest about what this row is and is not.
          note: 'Indexed from a public catalogue, not deposited by a citizen and not scanned by Earth. '
            + 'Read the source repository before running it.',
          scannerVersion: 'upstream-index',
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
    const total = (MCP_CATALOG_ENTRIES as ReadonlyArray<any>).length;
    const done = start + entries.length;
    return { ok: true, added, updated, skipped, done, total, remaining: Math.max(0, total - done) };
  },
});

/** Count an install, so the browse ranking means something. */
export const recordInstall = internalMutation({
  args: { serverId: v.string() },
  handler: async (ctx, { serverId }) => {
    const row = await ctx.db.query('bankMcpServers')
      .withIndex('serverId', (q) => q.eq('serverId', serverId)).first();
    if (!row) return { counted: false };
    await ctx.db.patch(row._id, { installCount: row.installCount + 1 });
    return { counted: true, installCount: row.installCount + 1 };
  },
});
