import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

describe('Live chat interaction contract', () => {
  it('uses the same accessible plus and minus language as the community directory', () => {
    expect(html).toContain('aria-expanded="false" aria-label="Expand live chat">+</button>');
    expect(source).toContain("this.conversationMinimized ? '+' : '−'");
    expect(source).toContain("this.conversationMinimized ? 'Expand live chat' : 'Minimize live chat'");
    expect(source).not.toContain("this.conversationMinimized ? '□'");
  });

  it('makes browsing, selection, and transcript speakers explicit', () => {
    expect(source).toContain("`${active.length} LIVE`");
    expect(source).toContain("'← ALL'");
    expect(source).toContain("'LISTEN'");
    expect(source).toContain('this.conversationSpeaker(selected, line.speaker)');
    expect(source).toContain('Nothing opens automatically.');
  });
});
