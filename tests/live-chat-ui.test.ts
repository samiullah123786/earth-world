import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

describe('full-screen voxel world interface contract', () => {
  it('keeps the old world navigation and owner surfaces over the 3D scene', () => {
    expect(html).toContain('RETURN TO</span> DASHBOARD');
    expect(html).toContain('Community directory');
    expect(html).toContain('Live chat');
    expect(html).toContain('World talk');
    expect(html).toContain('EARTH MARKET');
    expect(html).toContain('FIND ME');
    expect(html).toContain('EARTH TOKENS');
  });

  it('uses accessible plus/minus controls and keeps chat opt-in', () => {
    expect(html).toContain('aria-expanded="false" aria-label="Expand live chat">+</button>');
    expect(source).toContain("minimized ? '+' : '−'");
    expect(source).toContain("minimized ? 'Expand live chat' : 'Minimize live chat'");
    expect(source).toContain('Nothing opens automatically.');
  });

  it('renders a live WebGL voxel world instead of a flat 2D canvas map', () => {
    expect(source).toContain('new THREE.WebGLRenderer');
    expect(source).toContain("renderer: 'three-webgl-voxel-v1'");
    expect(source).toContain('new PointerLockControls');
    expect(source).toContain('buildStructures(next.builds, next.venues, next.gate)');
    // Text labels may use a tiny 2D canvas as a texture; the world renderer must not.
    expect(source).not.toContain("getElementById('game') as HTMLCanvasElement");
    expect(source).not.toContain('requestAnimationFrame(drawWorld)');
  });

  it('preserves the trusted dashboard embed and focus messages', () => {
    expect(source).toContain("event.data.type === 'earth-owner-agent'");
    expect(source).toContain("event.data.type === 'earth-focus-agent'");
    expect(source).toContain("event.data.type === 'earth-wallet'");
    expect(source).toContain("type: 'earth-profile'");
  });
});
