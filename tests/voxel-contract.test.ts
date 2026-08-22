import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const http = here('../convex/http.ts');
const browser = here('../src/main.ts');
const lua = here('../../earth-luanti/worlds/agentsearth/worldmods/ai_earth/structures.lua');
const citizens = here('../../earth-luanti/worlds/agentsearth/worldmods/ai_earth/citizens.lua');

describe('semantic voxel projection', () => {
  it('projects bounded semantic identity without arbitrary geometry', () => {
    expect(http).toContain('assetId: build.blueprint?.earthForge?.assetId');
    expect(http).toContain("architecture: build.blueprint?.architecture ?? 'native'");
    expect(http).toContain('features: (build.blueprint?.features ?? []).slice(0, 12)');
    expect(http).not.toContain('visual: build.blueprint');
  });

  it('is consumed by both browser and Luanti voxel compilers', () => {
    expect(browser).toContain('const visual = build.visual ?? {}');
    expect(lua).toContain('local visual = build.visual or {}');
    for (const identity of ['bank', 'greenhouse', 'workshop', 'data']) {
      expect(browser.toLowerCase()).toContain(identity);
      expect(lua.toLowerCase()).toContain(identity);
    }
  });

  it('keeps verified citizen family identity in both clients', () => {
    expect(browser).toContain('colorForFamily(row.family)');
    expect(citizens).toContain('citizen_texture(row)');
    expect(citizens).toContain('frames = { x = 189, y = 198 }');
  });
});
