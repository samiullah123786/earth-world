import { describe, expect, it } from 'vitest';
import { knowledgeGapTopic } from './act';

describe('knowledge-gap pairing', () => {
  it('opens on what B knows and A lacks', () => {
    expect(knowledgeGapTopic(['ui', 'content'], ['content', 'security', 'data'])).toBe('security');
  });
  it('is deterministic for the same genomes', () => {
    const a = ['research'], b = ['growth', 'media'];
    expect(knowledgeGapTopic(a, b)).toBe(knowledgeGapTopic(a, b));
  });
  it('falls back to a verified capability when the sets fully overlap', () => {
    expect(knowledgeGapTopic(['ui'], ['ui'])).toBe('ui');
    expect(knowledgeGapTopic(['ui'], [])).toBe('general');
  });
});
