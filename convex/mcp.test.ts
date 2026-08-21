import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

const SAFE = { verdict: 'inert_safe' as const, flags: [], note: 'inert', scannerVersion: 'test' };

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'weather-lookup', version: '1.0.0',
    description: 'Looks up forecasts. Use when the user asks about weather or rain.',
    author: { name: 'Aiden' }, transport: 'stdio', runtime: 'node',
    command: 'npx', args: ['-y', 'weather-mcp'],
    tools: [{ name: 'forecast', readOnly: true }],
    ...overrides,
  };
}

async function publish(t: ReturnType<typeof convexTest>, agentId: string, overrides = {}, category = 'data') {
  return await t.mutation(internal.mcp.publish, {
    depositorAgentId: agentId, manifest: manifest(overrides), category, safety: SAFE,
  });
}

describe('listing an MCP server', () => {
  it('lists it, and reads its capabilities off the manifest', async () => {
    const t = convexTest(schema, modules);
    const result: any = await publish(t, 'agent:aiden', {
      userConfig: [{ key: 'api_key', type: 'string', title: 'API key', sensitive: true }],
    });
    expect(result.serverId).toBe('mcp:weather-lookup');
    expect(result.updated).toBe(false);
    expect(result.capabilities).toContain('credentials');
    expect(result.capabilities).toContain('subprocess');
  });

  it('treats a second listing of the same name as an update, not a duplicate', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden');
    const again: any = await publish(t, 'agent:aiden', { version: '2.0.0' });
    expect(again.updated).toBe(true);
    const browsed: any = await t.query(api.mcp.browse, {});
    expect(browsed.total).toBe(1);
    expect(browsed.servers[0].version).toBe('2.0.0');
  });

  it('will not let one citizen overwrite another citizen\'s name', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden');
    await expect(publish(t, 'agent:nova')).rejects.toThrow(/already listed/);
  });

  it('refuses a server the scanner refused', async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.mcp.publish, {
      depositorAgentId: 'agent:aiden', manifest: manifest(), category: 'data',
      safety: { verdict: 'refused' as const, flags: ['exfiltration'], note: 'no', scannerVersion: 'test' },
    })).rejects.toThrow(/refused/);
  });

  it('still lists a flagged server, because a hidden catalogue reads as empty', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.mcp.publish, {
      depositorAgentId: 'agent:aiden', manifest: manifest(), category: 'data',
      safety: { verdict: 'needs_review' as const, flags: ['executable_file'], note: 'review', scannerVersion: 'test' },
    });
    const browsed: any = await t.query(api.mcp.browse, {});
    expect(browsed.total).toBe(1);
    expect(browsed.servers[0].state).toBe('flagged');
    expect(browsed.servers[0].safety.flags).toContain('executable_file');
  });
});

describe('finding an MCP server', () => {
  it('finds one by what it does, with no embedding provider involved', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden');
    const hits: any = await t.query(api.mcp.search, { query: 'weather forecasts' });
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe('weather-lookup');
  });

  it('filters by transport and by capability', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden');
    await publish(t, 'agent:nova', {
      name: 'earth-registry', transport: 'http', runtime: 'remote',
      url: 'https://example.test/mcp', command: undefined, args: undefined,
    });
    expect((await t.query(api.mcp.browse, { transport: 'http' }) as any).total).toBe(1);
    expect((await t.query(api.mcp.browse, { capability: 'network' }) as any).total).toBe(1);
    expect((await t.query(api.mcp.browse, {}) as any).total).toBe(2);
  });

  it('counts categories and never offers an empty one', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden', {}, 'data');
    await publish(t, 'agent:nova', { name: 'design-tools' }, 'design');
    const cats: any = await t.query(api.mcp.categories, {});
    expect(cats.map((c: any) => c.slug).sort()).toEqual(['data', 'design']);
    expect(cats.every((c: any) => c.count > 0)).toBe(true);
  });
});

describe('the detail page', () => {
  it('hands back real config for every client, generated from the manifest', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden');
    const page: any = await t.query(api.mcp.detail, { serverId: 'mcp:weather-lookup' });
    expect(page.tools).toHaveLength(1);
    expect(page.install.length).toBeGreaterThan(4);
    for (const entry of page.install) {
      // Codex reads TOML; everyone else reads JSON. Both must be valid in the
      // dialect the client actually parses.
      if (entry.client.format === 'toml') expect(entry.snippet).toMatch(/^\[mcp_servers\./);
      else expect(() => JSON.parse(entry.snippet)).not.toThrow();
    }
    const cursor = page.install.find((entry: any) => entry.client.id === 'cursor');
    expect(JSON.parse(cursor.snippet).mcpServers['weather-lookup'].command).toBe('npx');
  });

  it('is null for a server nobody listed', async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.mcp.detail, { serverId: 'mcp:nope' })).toBeNull();
  });
});

describe('withdrawing a listing', () => {
  it('retires it rather than deleting it, and only for the citizen who listed it', async () => {
    const t = convexTest(schema, modules);
    await publish(t, 'agent:aiden');
    await expect(t.mutation(internal.mcp.retire, { serverId: 'mcp:weather-lookup', agentId: 'agent:nova' }))
      .rejects.toThrow(/only the citizen/);
    await t.mutation(internal.mcp.retire, { serverId: 'mcp:weather-lookup', agentId: 'agent:aiden' });
    expect((await t.query(api.mcp.browse, {}) as any).total).toBe(0);
    // The name stays claimed, so nobody can publish something else under it.
    await expect(publish(t, 'agent:nova')).rejects.toThrow(/already listed/);
  });
});
