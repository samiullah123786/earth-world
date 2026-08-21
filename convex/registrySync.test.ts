import { describe, expect, it } from 'vitest';
import { githubSlug, manifestFromRegistry, registrySlug } from './registrySync';

describe('naming a registry server', () => {
  it('keeps the publisher, because the last segment alone collides', () => {
    // Measured against the live registry: taking only the last segment
    // collapsed 148 distinct servers onto 58 names. These two are real.
    expect(registrySlug('ai.adadvisor/mcp-server')).toBe('adadvisor-mcp-server');
    expect(registrySlug('ai.agenttrust/mcp-server')).toBe('agenttrust-mcp-server');
    expect(registrySlug('ai.adadvisor/mcp-server')).not.toBe(registrySlug('ai.agenttrust/mcp-server'));
  });

  it('drops the leading TLD segment, which carries no meaning', () => {
    expect(registrySlug('ai.aqta/seal')).toBe('aqta-seal');
    expect(registrySlug('ac.inference.sh/mcp')).toBe('inference-sh-mcp');
  });

  it('does not stutter when the publisher and the name are the same word', () => {
    expect(registrySlug('ai.adeu/adeu')).toBe('adeu');
    expect(registrySlug('agency.goji/goji')).toBe('goji');
  });

  it('is stable, so an install command written down today still works', () => {
    // The slug must not depend on what else is in the registry. A name that
    // shifts when a similar server appears breaks every command already
    // printed on a card or pasted into a config.
    expect(registrySlug('ai.aqta/seal')).toBe(registrySlug('ai.aqta/seal'));
  });

  it('refuses a name it cannot make an id out of', () => {
    expect(registrySlug('no-slash-here')).toBe('');
    expect(registrySlug('')).toBe('');
  });
});

describe('turning a registry record into a listing', () => {
  const base = { name: 'ai.example/thing', description: 'Does a thing.', version: '1.2.3' };

  it('builds a real npx command from a published npm package', () => {
    const manifest = manifestFromRegistry({
      server: { ...base, packages: [{ registryType: 'npm', identifier: 'thing-mcp', version: '2.0.0' }] },
    });
    expect(manifest.command).toBe('npx');
    expect(manifest.args).toEqual(['-y', 'thing-mcp@2.0.0']);
    expect(manifest.runtime).toBe('node');
  });

  it('builds a uvx command from a PyPI package', () => {
    const manifest = manifestFromRegistry({
      server: { ...base, packages: [{ registryType: 'pypi', identifier: 'thing', version: '0.4.1' }] },
    });
    expect(manifest.command).toBe('uvx');
    expect(manifest.args).toEqual(['thing==0.4.1']);
  });

  it('configures a remote server by url rather than by command', () => {
    const manifest = manifestFromRegistry({
      server: { ...base, remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }] },
    });
    expect(manifest.transport).toBe('http');
    expect(manifest.url).toBe('https://example.test/mcp');
    expect(manifest.command).toBeUndefined();
  });

  it('refuses a record with nothing installable in it', () => {
    // The whole reason this indexes a registry rather than GitHub. A record
    // with no package and no remote has no honest install instruction, so it
    // is not listed with an invented one.
    expect(manifestFromRegistry({ server: base })).toBeNull();
    expect(manifestFromRegistry({ server: { ...base, packages: [], remotes: [] } })).toBeNull();
  });

  it('refuses a record missing the fields a listing needs', () => {
    expect(manifestFromRegistry({ server: { name: 'ai.x/y' } })).toBeNull();
    expect(manifestFromRegistry({})).toBeNull();
    expect(manifestFromRegistry(null)).toBeNull();
  });

  it('carries the repository through, which is what health is measured from', () => {
    const manifest = manifestFromRegistry({
      server: {
        ...base, repository: { url: 'https://github.com/acme/thing' },
        packages: [{ registryType: 'npm', identifier: 'thing' }],
      },
    });
    expect(manifest.repository).toBe('https://github.com/acme/thing');
  });
});

describe('reading a GitHub slug', () => {
  it('takes owner and repo out of the usual shapes', () => {
    expect(githubSlug('https://github.com/acme/thing')).toBe('acme/thing');
    expect(githubSlug('https://github.com/acme/thing.git')).toBe('acme/thing');
    expect(githubSlug('https://github.com/acme/thing/tree/abc123/sub')).toBe('acme/thing');
    expect(githubSlug('http://www.github.com/acme/thing')).toBe('acme/thing');
  });

  it('is null for anything that is not a GitHub repository', () => {
    for (const value of [undefined, null, '', 'https://gitlab.com/a/b', 'https://github.com/acme', 'not a url']) {
      expect(githubSlug(value as any)).toBeNull();
    }
  });
});
