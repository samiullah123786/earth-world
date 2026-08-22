import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const styles = readFileSync(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8');

describe('full-screen voxel world interface contract', () => {
  it('keeps the old world navigation and owner surfaces over the 3D scene', () => {
    expect(html).toContain('RETURN TO</span> DASHBOARD');
    expect(html).toContain('Community directory');
    expect(html).toContain('Live chat');
    expect(html).toContain('World activity');
    expect(html).toContain('FIND ME');
    expect(html).toContain('EARTH TOKENS');
    expect(html).not.toContain('VOXEL WORLD');
    expect(html).not.toContain('class="hud world-nav"');
    expect(styles).toContain('right: 12px;');
    expect(styles).toContain('body.embed .backhome, body.embed .brand');
  });

  it('shows live chat by default and keeps accessible plus/minus controls', () => {
    expect(html).toContain('aria-expanded="true" aria-label="Minimize live chat">−</button>');
    expect(html).toContain('class="panel feed min"');
    expect(html).toContain('aria-expanded="false" aria-label="Expand world activity">+</button>');
    expect(styles).toContain('.chat-row { padding: 7px 8px; border: 2px solid var(--ink); background: var(--cream); color: var(--ink);');
    expect(source).toContain("minimized ? '+' : '−'");
    expect(source).toContain("minimized ? 'Expand live chat' : 'Minimize live chat'");
    expect(source).toContain('Nothing opens automatically.');
  });

  it('collapses the community directory into the same compact bar as world activity', () => {
    expect(html).toContain('data-for="directory" aria-expanded="true" aria-label="Minimize community directory"');
    expect(styles).toContain('.directory.min {');
    expect(styles).toContain('flex: 0 0 36px;');
    expect(styles).toContain('.directory.min .panel-header { margin: 0; }');
    expect(styles).toContain('.directory.min > *:not(.panel-header) { display: none !important; }');
    expect(source).toContain("const minimized = panel.classList.toggle('min');");
    expect(source).toContain("panel.id === 'directory' ? 'community directory' : 'world activity'");
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
