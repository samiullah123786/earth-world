import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { planExpansion, saveExpansionChunk, finishExpansion } from './planning';
import { grassBoundary } from '../shared/wfc';

it('rejects stale worker writes and never publishes an incomplete ring', async () => {
  const t = convexTest(schema, import.meta.glob('./**/*.ts'));
  await t.mutation(internal.seed.init, {});
  await t.run(ctx => planExpansion(ctx, 'storage recovery trial', true));
  const work: any = await t.query(internal.kernel.expansionWork, {});
  const chunk = { chunkId: `chunk:${work.coordinate.chunkX}:${work.coordinate.chunkY}`,
    ...work.coordinate, size: 16, generation: work.generation, biome: work.biome,
    seed: work.seed, tiles: Array(256).fill('grass'), edges: grassBoundary(16) };
  expect(await t.run(ctx => saveExpansionChunk(ctx, { ...chunk, generation: work.generation - 1 }))).toEqual({ stored: false });
  expect(await t.run(ctx => finishExpansion(ctx))).toEqual({ done: false, committed: false });
  expect(await t.run(ctx => saveExpansionChunk(ctx, chunk))).toEqual({ stored: true });
  expect(await t.run(ctx => saveExpansionChunk(ctx, { ...chunk, seed: 42 }))).toEqual({ stored: false });
  const stored: any = await t.run(ctx => ctx.db.query('worldChunks').withIndex('coordinates', q =>
    q.eq('chunkX', chunk.chunkX).eq('chunkY', chunk.chunkY)).first());
  expect(stored.seed).toBe(work.seed);
});
