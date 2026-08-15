import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

/**
 * What the world is allowed to write down about itself.
 *
 * Movement rows were ninety-four percent of the public record - eleven and a
 * half thousand a day against a retention pass that could clear fourteen - so
 * the table carried a permanent backlog and every reader of the feed paid to
 * download the same sentence hundreds of times. The cause was narrating one
 * purposeful walk in five at random, while a citizen keeps the same aspiration
 * for a long stretch: the sample was of the same sentence over and over.
 *
 * These lock the shape of the fix rather than a number, because the number
 * depends on how many citizens live here.
 */
describe('the public record earns its size', () => {
  it('writes a line when a citizen starts doing something new, not while they carry on', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});

    // Let the town settle into whatever it is doing.
    for (let tick = 0; tick < 3; tick++) await t.mutation(internal.act.ambientTick, {});
    const settled = await t.run(async (ctx: any) => (await ctx.db.query('events').collect()).length);

    // Now run it hard. Nobody's aspiration changes on this timescale, so the
    // record should stay almost still while the citizens keep walking.
    for (let tick = 0; tick < 12; tick++) await t.mutation(internal.act.ambientTick, {});
    const after = await t.run(async (ctx: any) => (await ctx.db.query('events').collect()).length);

    const citizens = await t.run(async (ctx: any) => (await ctx.db.query('citizens').collect()).length);
    const written = after - settled;
    // Twelve ticks of an unchanged town must not cost a row per citizen per
    // tick. The old sampling rule would have written roughly a fifth of that.
    expect(written, `${written} rows from 12 quiet ticks with ${citizens} citizens`)
      .toBeLessThan(citizens * 2);
  });

  it('still records a walk the first time a citizen takes it up', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    for (let tick = 0; tick < 4; tick++) await t.mutation(internal.act.ambientTick, {});
    const moves = await t.run(async (ctx: any) =>
      (await ctx.db.query('events').collect()).filter((row: any) => row.kind === 'move'));
    // Silence is not the goal; a town where nobody is ever seen to do anything
    // is as broken as one that narrates every step.
    expect(moves.length).toBeGreaterThan(0);
    for (const row of moves) expect(row.gloss).toMatch(/ is .+\.$/);
  });

  it('never writes the same sentence twice in a row for one citizen', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    for (let tick = 0; tick < 15; tick++) await t.mutation(internal.act.ambientTick, {});
    const byActor = new Map<string, string[]>();
    await t.run(async (ctx: any) => {
      for (const row of await ctx.db.query('events').collect()) {
        if (row.kind !== 'move') continue;
        const list = byActor.get(row.actorId) ?? [];
        list.push(row.gloss);
        byActor.set(row.actorId, list);
      }
    });
    for (const [actor, glosses] of byActor) {
      for (let index = 1; index < glosses.length; index++) {
        expect(glosses[index], `${actor} repeated itself`).not.toBe(glosses[index - 1]);
      }
    }
  });
});
