import { describe, expect, it } from 'vitest';
import { selectRenderableBuilds } from './scene-layout';

describe('world scene composition', () => {
  it('renders a legacy homestead as one property instead of stacked cottages', () => {
    const selected = selectRenderableBuilds([
      { buildId: 'home', plotId: 'plot:a', structure: 'home', state: 'built' },
      { buildId: 'extension', plotId: 'plot:a', structure: 'extension', state: 'built' },
      { buildId: 'garden', plotId: 'plot:a', structure: 'garden', state: 'built' },
      { buildId: 'bench', plotId: 'plot:a', structure: 'bench', state: 'built' },
    ]);
    expect(selected.map((build) => build.buildId)).toEqual(['home']);
  });

  it('keeps the bank facade and forecourt as an intentional civic campus', () => {
    const selected = selectRenderableBuilds([
      { buildId: 'build:earth-bank-forecourt', plotId: 'plot:earth-bank', structure: 'blueprint', state: 'built' },
      { buildId: 'build:earth-bank', plotId: 'plot:earth-bank', structure: 'blueprint', state: 'built' },
    ]);
    expect(selected.map((build) => build.buildId)).toEqual(['build:earth-bank', 'build:earth-bank-forecourt']);
  });

  it('never renders razed or merely planned records', () => {
    expect(selectRenderableBuilds([
      { buildId: 'old', plotId: 'plot:a', structure: 'home', state: 'razed' },
      { buildId: 'future', plotId: 'plot:b', structure: 'home', state: 'planned' },
    ])).toEqual([]);
  });
});
