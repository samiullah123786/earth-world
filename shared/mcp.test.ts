import { describe, expect, it } from 'vitest';
import {
  MCP_CLIENTS, mcpCapabilities, mcpInstallMatrix, mcpInstallSnippet, validateMcpManifest,
} from './mcp';

const STDIO = {
  name: 'weather-lookup',
  version: '1.2.0',
  description: 'Looks up forecasts. Use when the user asks about weather.',
  author: { name: 'Aiden' },
  transport: 'stdio',
  runtime: 'node',
  command: 'npx',
  args: ['-y', 'weather-mcp'],
  userConfig: [{ key: 'api_key', type: 'string', title: 'Weather API key', sensitive: true, required: true }],
  tools: [{ name: 'forecast', readOnly: true }, { name: 'alerts', readOnly: true }],
};

const REMOTE = {
  name: 'earth-registry',
  version: '0.1.0',
  description: 'Reads the Earth Bank over HTTP.',
  author: { name: 'Terra' },
  transport: 'http',
  runtime: 'remote',
  url: 'https://kernel.agentsearth.com/v1/mcp',
};

describe('the MCP manifest', () => {
  it('accepts a well-formed stdio server', () => {
    const manifest = validateMcpManifest(STDIO);
    expect(manifest.name).toBe('weather-lookup');
    expect(manifest.command).toBe('npx');
    expect(manifest.tools).toHaveLength(2);
  });

  it('refuses a server nobody could actually start', () => {
    expect(() => validateMcpManifest({ ...STDIO, command: '' })).toThrow(/command/);
    expect(() => validateMcpManifest({ ...REMOTE, url: '' })).toThrow(/url/);
  });

  it('holds names to one shape, so a name is safe in a path and a JSON key', () => {
    for (const name of ['Weather', 'weather_lookup', '-weather', 'weather--lookup', 'weather lookup']) {
      expect(() => validateMcpManifest({ ...STDIO, name }), name).toThrow();
    }
    expect(validateMcpManifest({ ...STDIO, name: 'a-b-c' }).name).toBe('a-b-c');
    // Surrounding whitespace is a typo, not a different name.
    expect(validateMcpManifest({ ...STDIO, name: '  weather-lookup  ' }).name).toBe('weather-lookup');
  });

  it('insists a listing says who wrote it', () => {
    expect(() => validateMcpManifest({ ...STDIO, author: {} })).toThrow(/author/);
  });
});

describe('what a listing admits it reaches for', () => {
  it('reads capabilities off the manifest, not off the description', () => {
    const badges = mcpCapabilities(validateMcpManifest(STDIO));
    expect(badges).toContain('credentials');   // the api key is sensitive
    expect(badges).toContain('subprocess');    // it runs a local program
    expect(badges).toContain('read-only');     // every tool only reads
  });

  it('marks a remote server as reaching the network', () => {
    const badges = mcpCapabilities(validateMcpManifest(REMOTE));
    expect(badges).toContain('network');
    expect(badges).not.toContain('subprocess');
  });

  it('does not call a server read-only when any tool writes', () => {
    const manifest = validateMcpManifest({
      ...STDIO, tools: [{ name: 'forecast', readOnly: true }, { name: 'post', readOnly: false }],
    });
    expect(mcpCapabilities(manifest)).not.toContain('read-only');
  });
});

describe('install snippets', () => {
  it('writes real config for every client Earth knows', () => {
    const manifest = validateMcpManifest(STDIO);
    const matrix = mcpInstallMatrix(manifest);
    expect(matrix).toHaveLength(MCP_CLIENTS.length);
    for (const entry of matrix) {
      expect(() => JSON.parse(entry.snippet), entry.client.id).not.toThrow();
      expect(entry.configPath).toBeTruthy();
    }
  });

  it('uses each client\'s own key, because they genuinely differ', () => {
    const manifest = validateMcpManifest(STDIO);
    expect(JSON.parse(mcpInstallSnippet(manifest, 'vscode').snippet)).toHaveProperty('servers');
    expect(JSON.parse(mcpInstallSnippet(manifest, 'cursor').snippet)).toHaveProperty('mcpServers');
  });

  it('never inlines a secret, and leaves a blank the installer can see', () => {
    const snippet = mcpInstallSnippet(validateMcpManifest(STDIO), 'claude-code').snippet;
    expect(snippet).not.toMatch(/sk-|ghp_/);
    expect(snippet).toContain('<your weather api key>');
  });

  it('says so plainly when a client cannot host this transport', () => {
    const remote = validateMcpManifest(REMOTE);
    expect(mcpInstallSnippet(remote, 'windsurf').unsupported).toMatch(/cannot host/);
    expect(mcpInstallSnippet(remote, 'claude-code').unsupported).toBeUndefined();
  });

  it('carries the command through exactly as declared', () => {
    const parsed = JSON.parse(mcpInstallSnippet(validateMcpManifest(STDIO), 'cursor').snippet);
    expect(parsed.mcpServers['weather-lookup'].command).toBe('npx');
    expect(parsed.mcpServers['weather-lookup'].args).toEqual(['-y', 'weather-mcp']);
  });
});
