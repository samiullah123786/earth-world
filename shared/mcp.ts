/**
 * What an MCP server is on Earth, and how each client is told to run one.
 *
 * A skill is knowledge: prose an agent reads. An MCP server is a running
 * program that hands an agent new tools. The Bank had a single `mcpEndpoint`
 * string bolted onto skill listings, which is enough to remember that a URL
 * exists and nothing like enough to install anything - so nothing ever was.
 *
 * The shape below follows the two formats that already exist rather than
 * inventing a third: Anthropic's MCPB manifest (`server.type`, `mcp_config`
 * with command/args/env, `user_config` for the values an installer must
 * supply) and the fields every public catalogue carries anyway (tools, tags,
 * license, source, homepage).
 *
 * The important part is the last function. Every client configures an MCP
 * server differently, and a catalogue that shows one snippet is a catalogue
 * that works for one client. The snippet is generated from the manifest, so
 * it can never drift from what the listing actually declares.
 */

export const MCP_MANIFEST_VERSION = '0.3' as const;

/** How the agent talks to the server. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** What has to exist on the machine before the command will run. */
export type McpRuntime = 'node' | 'python' | 'binary' | 'docker' | 'remote';

export type McpUserConfigField = Readonly<{
  key: string;
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title: string;
  description?: string;
  /** Masked in every UI and never stored in a config file in the clear. */
  sensitive?: boolean;
  required?: boolean;
  default?: string | number | boolean;
}>;

export type McpTool = Readonly<{
  name: string;
  description?: string;
  /** Whether the tool only reads. Drives the capability badges on a listing. */
  readOnly?: boolean;
}>;

export type McpServerManifest = Readonly<{
  manifestVersion: string;
  name: string;
  displayName?: string;
  version: string;
  description: string;
  author: Readonly<{ name: string; url?: string }>;
  transport: McpTransport;
  runtime: McpRuntime;
  /** stdio servers: the program and its arguments. */
  command?: string;
  args?: ReadonlyArray<string>;
  /** http/sse servers: where it lives. */
  url?: string;
  /** Environment the server needs, values may reference ${user_config.key}. */
  env?: Readonly<Record<string, string>>;
  userConfig?: ReadonlyArray<McpUserConfigField>;
  tools?: ReadonlyArray<McpTool>;
  license?: string;
  homepage?: string;
  repository?: string;
  keywords?: ReadonlyArray<string>;
}>;

/** Slugs must be safe in a URL, a filename, and a JSON key alike. */
export const MCP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateMcpManifest(raw: unknown): McpServerManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('an MCP manifest must be an object');
  const manifest = raw as Record<string, any>;
  const name = String(manifest.name ?? '').trim();
  if (!MCP_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error('an MCP name is lowercase words joined by single hyphens, at most 64 characters');
  }
  const description = String(manifest.description ?? '').trim();
  if (description.length < 1 || description.length > 1024) {
    throw new Error('an MCP description must be between 1 and 1024 characters');
  }
  const transport = String(manifest.transport ?? 'stdio') as McpTransport;
  if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error(`unknown MCP transport: ${transport}`);
  const runtime = String(manifest.runtime ?? 'node') as McpRuntime;
  if (!['node', 'python', 'binary', 'docker', 'remote'].includes(runtime)) {
    throw new Error(`unknown MCP runtime: ${runtime}`);
  }
  // A server has to be reachable one way or the other, or it is not a server.
  if (transport === 'stdio' && !String(manifest.command ?? '').trim()) {
    throw new Error('a stdio MCP server must declare the command that starts it');
  }
  if (transport !== 'stdio' && !String(manifest.url ?? '').trim()) {
    throw new Error('an http or sse MCP server must declare its url');
  }
  const authorName = String(manifest.author?.name ?? '').trim();
  if (!authorName) throw new Error('an MCP manifest must name its author');
  return {
    manifestVersion: String(manifest.manifestVersion ?? MCP_MANIFEST_VERSION),
    name,
    displayName: manifest.displayName ? String(manifest.displayName).slice(0, 120) : undefined,
    version: String(manifest.version ?? '0.0.0'),
    description,
    author: { name: authorName, url: manifest.author?.url ? String(manifest.author.url) : undefined },
    transport,
    runtime,
    command: manifest.command ? String(manifest.command) : undefined,
    args: Array.isArray(manifest.args) ? manifest.args.map(String).slice(0, 64) : undefined,
    url: manifest.url ? String(manifest.url) : undefined,
    env: manifest.env && typeof manifest.env === 'object' ? { ...manifest.env } : undefined,
    userConfig: Array.isArray(manifest.userConfig)
      ? manifest.userConfig.slice(0, 32).map((field: any) => ({
        key: String(field.key), type: field.type ?? 'string', title: String(field.title ?? field.key),
        description: field.description ? String(field.description) : undefined,
        sensitive: Boolean(field.sensitive), required: Boolean(field.required),
        default: field.default,
      }))
      : undefined,
    tools: Array.isArray(manifest.tools)
      ? manifest.tools.slice(0, 200).map((tool: any) => ({
        name: String(tool.name), description: tool.description ? String(tool.description) : undefined,
        readOnly: Boolean(tool.readOnly),
      }))
      : undefined,
    license: manifest.license ? String(manifest.license) : undefined,
    homepage: manifest.homepage ? String(manifest.homepage) : undefined,
    repository: manifest.repository ? String(manifest.repository) : undefined,
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords.map(String).slice(0, 24) : undefined,
  };
}

/**
 * What a listing reaches for, stated plainly.
 *
 * Anthropic's own guidance is that a server can be given far more access than
 * its description suggests, and no catalogue in this category shows a reader
 * what they are about to hand over. These are read off the manifest, so they
 * cannot flatter it.
 */
export function mcpCapabilities(manifest: McpServerManifest): string[] {
  const badges = new Set<string>();
  if (manifest.transport !== 'stdio' || manifest.runtime === 'remote') badges.add('network');
  if (manifest.runtime === 'docker') badges.add('container');
  if (manifest.runtime !== 'remote') badges.add('subprocess');
  for (const field of manifest.userConfig ?? []) {
    if (field.sensitive) badges.add('credentials');
    if (field.type === 'directory' || field.type === 'file') badges.add('filesystem');
  }
  for (const [, value] of Object.entries(manifest.env ?? {})) {
    if (/(?:key|token|secret|password)/i.test(String(value))) badges.add('credentials');
  }
  const tools = manifest.tools ?? [];
  if (tools.length && tools.every((tool) => tool.readOnly)) badges.add('read-only');
  return [...badges].sort();
}

/** The clients Earth knows how to write a config for. */
export type McpClient = Readonly<{
  id: string;
  name: string;
  /** Where the human has to put it, shown above the snippet. */
  configPath: string;
  /** Whether this client can host stdio servers, remote servers, or both. */
  supports: ReadonlyArray<McpTransport>;
  /** Config dialect. JSON unless the client insists otherwise. */
  format?: 'json' | 'toml';
  note?: string;
}>;

export const MCP_CLIENTS: ReadonlyArray<McpClient> = [
  { id: 'claude-code', name: 'Claude Code', configPath: '.mcp.json in the project root, or ~/.claude.json',
    supports: ['stdio', 'http', 'sse'] },
  { id: 'claude-desktop', name: 'Claude Desktop', configPath: 'claude_desktop_config.json',
    supports: ['stdio'], note: 'Desktop runs servers locally; a remote server needs a bridge.' },
  { id: 'cursor', name: 'Cursor', configPath: '.cursor/mcp.json, or ~/.cursor/mcp.json',
    supports: ['stdio', 'http', 'sse'] },
  { id: 'vscode', name: 'VS Code', configPath: '.vscode/mcp.json', supports: ['stdio', 'http', 'sse'] },
  { id: 'windsurf', name: 'Windsurf', configPath: '~/.codeium/windsurf/mcp_config.json', supports: ['stdio'] },
  { id: 'cline', name: 'Cline', configPath: 'cline_mcp_settings.json', supports: ['stdio', 'http', 'sse'] },
  // Codex keeps its config in TOML rather than JSON, which the snippet builder
  // below has to honour - handing someone a JSON block for a TOML file is
  // worse than handing them nothing, because it looks right until it fails.
  { id: 'codex', name: 'Codex CLI', configPath: '~/.codex/config.toml', supports: ['stdio'], format: 'toml' },
  { id: 'gemini', name: 'Gemini CLI', configPath: '~/.gemini/settings.json', supports: ['stdio', 'http', 'sse'] },
];

export function mcpClient(clientId: string): McpClient {
  const client = MCP_CLIENTS.find((candidate) => candidate.id === clientId);
  if (!client) throw new Error(`unknown MCP client: ${clientId}`);
  return client;
}

/**
 * The exact JSON a person pastes into a given client to run a given server.
 *
 * Generated from the manifest every time rather than stored, so a listing that
 * changes its command cannot leave a stale snippet behind telling people to
 * run the old one. Secrets are never inlined: a value the installer must
 * provide appears as a named placeholder they can see and replace.
 */
export function mcpInstallSnippet(manifest: McpServerManifest, clientId: string): {
  client: McpClient; configPath: string; snippet: string; unsupported?: string;
} {
  const client = mcpClient(clientId);
  const unsupported = client.supports.includes(manifest.transport)
    ? undefined
    : `${client.name} cannot host a ${manifest.transport} server directly.`;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.env ?? {})) env[key] = value;
  for (const field of manifest.userConfig ?? []) {
    // Never a real secret, always a visible blank the installer fills in.
    if (field.sensitive && !Object.values(env).some((value) => value.includes(field.key))) {
      env[field.key.toUpperCase()] = `<your ${field.title.toLowerCase()}>`;
    }
  }

  const entry: Record<string, unknown> = manifest.transport === 'stdio'
    ? { command: manifest.command, ...(manifest.args?.length ? { args: [...manifest.args] } : {}) }
    : { type: manifest.transport, url: manifest.url };
  if (Object.keys(env).length) entry.env = env;

  if (client.format === 'toml') {
    return { client, configPath: client.configPath, unsupported, snippet: tomlEntry(manifest.name, entry) };
  }

  const body = client.id === 'vscode'
    ? { servers: { [manifest.name]: entry } }
    : { mcpServers: { [manifest.name]: entry } };

  return { client, configPath: client.configPath, snippet: JSON.stringify(body, null, 2), unsupported };
}

/**
 * The same entry, written as a TOML table.
 *
 * Only the shapes this builder actually produces are handled - strings, an
 * array of strings, and a flat env table - because that is everything an MCP
 * entry contains. Anything else would be a silent mis-encoding, so it throws.
 */
function tomlEntry(name: string, entry: Record<string, unknown>): string {
  const scalar = (value: unknown): string => {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw new Error(`cannot write ${typeof value} into TOML`);
  };
  const lines = [`[mcp_servers.${name}]`];
  for (const [key, value] of Object.entries(entry)) {
    if (Array.isArray(value)) lines.push(`${key} = [${value.map(scalar).join(', ')}]`);
    else if (value && typeof value === 'object') {
      lines.push(`${key} = { ${Object.entries(value as Record<string, unknown>)
        .map(([inner, held]) => `${inner} = ${scalar(held)}`).join(', ')} }`);
    } else lines.push(`${key} = ${scalar(value)}`);
  }
  return lines.join('\n');
}

/** Every client's snippet at once, for a listing page to render as tabs. */
export function mcpInstallMatrix(manifest: McpServerManifest) {
  return MCP_CLIENTS.map((client) => mcpInstallSnippet(manifest, client.id));
}
