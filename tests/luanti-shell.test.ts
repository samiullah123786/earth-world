/**
 * The Luanti shell, verified from here.
 *
 * The mod runs in a game engine this test runner cannot start, but its two
 * failure modes that matter are checkable headlessly: Lua that does not parse
 * (the server refuses the whole mod at load), and terrain data that drifted
 * from the map (the two worlds silently disagree). Both are pinned.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - luaparse ships no types; a parse error is all we ask of it
import luaparse from 'luaparse';
import { terrainLetter } from '../shared/voxel';

const MOD = join(__dirname, '..', '..', 'earth-luanti', 'worlds', 'agentsearth', 'worldmods', 'ai_earth');

describe('the mod parses as LuaJIT would read it', () => {
  const sources = readdirSync(MOD).filter((name) => name.endsWith('.lua'));

  it('has all five modules present', () => {
    expect(sources.sort()).toEqual(['bridge.lua', 'citizens.lua', 'gate.lua', 'init.lua', 'structures.lua', 'terrain.lua'].sort());
  });

  for (const name of ['init.lua', 'terrain.lua', 'structures.lua', 'gate.lua', 'citizens.lua', 'bridge.lua']) {
    it(`${name} is valid Lua 5.1`, () => {
      const code = readFileSync(join(MOD, name), 'utf8');
      // Luanti embeds LuaJIT, which speaks 5.1. A file that fails here fails
      // the entire mod at server start, taking the world down with it.
      expect(() => luaparse.parse(code, { luaVersion: '5.1' })).not.toThrow();
    });
  }
});

describe('the exported terrain matches the map', () => {
  it('every cell agrees with the shared classifier', () => {
    const map = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'assets', 'maps', 'agentsearth-v5.tmj'), 'utf8'));
    const exported = JSON.parse(readFileSync(join(MOD, 'data', 'earth_map.json'), 'utf8'));
    expect(exported.width).toBe(map.width);
    expect(exported.height).toBe(map.height);

    const layer = (name: string) => map.layers.find((entry: any) => entry.name === name).data;
    const ground = layer('GroundLayer'), collision = layer('CollisionLayer'), overhead = layer('OverheadLayer');
    for (let y = 0; y < map.height; y++) {
      let expected = '';
      for (let x = 0; x < map.width; x++) {
        const index = y * map.width + x;
        expected += terrainLetter(ground[index], collision[index], overhead[index]);
      }
      // Row-level compare keeps a failure readable: it names the row, not
      // sixty-five thousand characters of diff.
      expect(exported.rows[y], `row ${y}`).toBe(expected);
    }
  });
});
