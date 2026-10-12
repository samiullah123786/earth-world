import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { owner } from '../testHelpers/modularOwner';

it('streams a public snapshot followed by deltas and supports viewer cancellation', async () => {
  const t = convexTest(schema, import.meta.glob('./**/*.ts'));
  await owner(t);
  await t.action(async () => {
  const response = await t.fetch('/v1/world/events');
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  expect(first).toContain('event: snapshot');
  expect(first).not.toContain('test-owner');
  expect(first).not.toContain('test-agent');
  const second = decoder.decode((await reader.read()).value);
  expect(second).toContain('event: delta');
  await reader.cancel();
  });
});
