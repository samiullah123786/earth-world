/**
 * Building by hand, petitioning for land, and shaking hands - against a real
 * Kernel rather than against the pure rulebooks, which are tested separately.
 *
 * What these prove is the wiring: that the rules actually reach the database,
 * that tokens really move, and that the two social records that are supposed
 * to require two people really do.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { BLOCK_PALETTE } from '../shared/blocks';
import { petitionThreshold } from '../shared/petition';
import { homeRect } from '../shared/homestead';
import { loadWorldWalkability } from './worldGrid';
import { tileFactsFor } from './handbuild';
import { DAILY_STIPEND, GENESIS_GRANT, assertSupplyInvariant, balanceOf } from './economy';

const modules = import.meta.glob('./**/*.ts');

// Parameterised by the schema on purpose. `ReturnType<typeof convexTest>` is
// the UNAPPLIED generic, so ctx.db inside a helper's t.run() falls back to a
// schemaless DataModel and every withIndex stops type-checking - while the
// same call written inline in a test infers fine, which makes it look like
// the index is wrong rather than the annotation.
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

let seq = 0;
const nonce = () => `n-${seq++}-${Math.random().toString(36).slice(2)}`;

async function citizen(t: Harness, suffix: string) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 4,
    autonomy: 'active',
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: nonce(), sessionTokenHash: `agent-${suffix}` });
  return { agentId, token: `agent-${suffix}` };
}

const act = (t: Harness, who: { agentId: string; token: string }, action: any) =>
  t.mutation(internal.kernel.act, { agentId: who.agentId, tokenHash: who.token, nonce: nonce(), action });

/**
 * Hand this citizen a plot of open, buildable ground and stand them on it.
 *
 * Picks a plot with nothing built on it, so a structure's own footprint cannot
 * make an otherwise-legal placement fail for the wrong reason.
 */
async function ownPlot(t: Harness, agentId: string) {
  return await t.run(async (ctx) => {
    const builds = await ctx.db.query('builds').collect();
    const taken = new Set(builds.map((build) => build.plotId));
    const plots = await ctx.db.query('plots').collect();
    const plot = plots.find((row) => !row.ownerAgentId && !taken.has(row.plotId)) ?? plots[0];
    await ctx.db.patch(plot._id, { ownerAgentId: agentId, claimedAt: Date.now() });
    const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agentId)).first();
    const now = Date.now();
    await ctx.db.patch(row!._id, {
      fx: plot.x, fy: plot.y, tx: plot.x, ty: plot.y, t0: now, t1: now, route: [],
    });
    return plot;
  });
}

describe('building with your own hands', () => {
  it('places a block on your own land and takes the price out of your purse', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const sam = await citizen(t, 'builder');
    const plot = await ownPlot(t, sam.agentId);

    const result: any = await act(t, sam, { type: 'place_block', x: plot.x, y: plot.y, level: 1, kind: 'plank' });
    expect(result.ok).toBe(true);
    expect(result.paid).toBe(BLOCK_PALETTE.plank.price);

    await t.run(async (ctx) => {
      const blocks = await ctx.db.query('placedBlocks').collect();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ x: plot.x, y: plot.y, level: 1, kind: 'plank', ownerAgentId: sam.agentId });
      // The daily stipend lands on the same act - it is paid for turning up and
      // doing something - so the purse is the arrival grant plus that stipend,
      // less what the plank cost.
      expect(await balanceOf(ctx, sam.agentId)).toBe(GENESIS_GRANT + DAILY_STIPEND - BLOCK_PALETTE.plank.price);
      // Tokens moved rather than vanished: the supply still balances.
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses land the builder does not hold', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const sam = await citizen(t, 'trespass');
    const plot = await ownPlot(t, sam.agentId);
    // Somebody else's parcel, one plot over.
    const other = await t.run(async (ctx) => {
      const plots = await ctx.db.query('plots').collect();
      return plots.find((row: any) => row.plotId !== plot.plotId)!;
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', sam.agentId)).first();
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: other.x, fy: other.y, tx: other.x, ty: other.y, t0: now, t1: now, route: [] });
    });
    await expect(act(t, sam, { type: 'place_block', x: other.x, y: other.y, level: 1, kind: 'plank' }))
      .rejects.toThrow(/land you hold/);
  });

  it('refuses to build across the map, so changing somewhere means going there', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const sam = await citizen(t, 'reach');
    const plot = await ownPlot(t, sam.agentId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', sam.agentId)).first();
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: plot.x + 30, fy: plot.y, tx: plot.x + 30, ty: plot.y, t0: now, t1: now, route: [] });
    });
    await expect(act(t, sam, { type: 'place_block', x: plot.x, y: plot.y, level: 1, kind: 'plank' }))
      .rejects.toThrow(/walk closer/);
  });

  it('stacks only on top, so nothing ever hangs in the air', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const sam = await citizen(t, 'stack');
    const plot = await ownPlot(t, sam.agentId);
    const at = { x: plot.x, y: plot.y };

    await expect(act(t, sam, { type: 'place_block', ...at, level: 2, kind: 'stone' }))
      .rejects.toThrow(/sits on the ground/);
    await act(t, sam, { type: 'place_block', ...at, level: 1, kind: 'stone' });
    await expect(act(t, sam, { type: 'place_block', ...at, level: 3, kind: 'stone' }))
      .rejects.toThrow(/column is 1 high/);
    const second: any = await act(t, sam, { type: 'place_block', ...at, level: 2, kind: 'stone' });
    expect(second.ok).toBe(true);
  });

  it('takes the top block down and hands nothing back', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const sam = await citizen(t, 'unbuild');
    const plot = await ownPlot(t, sam.agentId);
    const at = { x: plot.x, y: plot.y };
    await act(t, sam, { type: 'place_block', ...at, level: 1, kind: 'plank' });
    await act(t, sam, { type: 'place_block', ...at, level: 2, kind: 'plank' });

    await expect(act(t, sam, { type: 'remove_block', ...at, level: 1 }))
      .rejects.toThrow(/take the top block first/);

    const before = await t.run(async (ctx) => await balanceOf(ctx, sam.agentId));
    const removed: any = await act(t, sam, { type: 'remove_block', ...at, level: 2 });
    expect(removed.refunded).toBe(0);
    await t.run(async (ctx) => {
      expect(await ctx.db.query('placedBlocks').collect()).toHaveLength(1);
      // No refund, so unbuilding cannot become a token loop. The only movement
      // is the stipend, which this act earned like any other.
      expect(await balanceOf(ctx, sam.agentId)).toBeGreaterThanOrEqual(before);
      await assertSupplyInvariant(ctx);
    });
  });

  it('refuses a material Earth does not stock', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const sam = await citizen(t, 'palette');
    const plot = await ownPlot(t, sam.agentId);
    await expect(act(t, sam, { type: 'place_block', x: plot.x, y: plot.y, level: 1, kind: 'obsidian' }))
      .rejects.toThrow(/no such material/);
  });
});

/**
 * The bug that made hand-building unusable for almost every citizen, found by
 * trying it live rather than by any test failing.
 *
 * A home is built to its HOMESTEAD - the plot less a yard along the south - but
 * the repair migration skipped any plot holding fewer than two structures,
 * which is most of them. So the overwhelming majority of citizens still had a
 * house row covering every tile they owned: no garden, and not one legal tile
 * to place a block on.
 *
 * What these pin is the invariant the two fixes have to keep TOGETHER. The
 * stored footprint, the collision the pathfinder sees, and homeRect must all
 * describe the same rectangle. Any two of them agreeing is not enough: a
 * collision larger than the house is a garden nobody can walk on, and a
 * collision smaller than it is a wall people walk through.
 */
describe('a citizen has a yard of their own', () => {
  async function loneHome(t: Harness, suffix: string) {
    const sam = await citizen(t, suffix);
    const plot = await ownPlot(t, sam.agentId);
    // Sized to the whole parcel, the way the old builder made them.
    await t.run(async (ctx) => {
      await ctx.db.insert('builds', {
        buildId: `build:${suffix}-${plot.plotId}`, plotId: plot.plotId, ownerAgentId: sam.agentId,
        structure: 'home', state: 'built', createdAt: Date.now(), completedAt: Date.now(),
        x: plot.x, y: plot.y, w: plot.w, h: plot.h,
        blueprint: { kind: 'home', name: 'Earthfolk Home', w: plot.w, h: plot.h },
      });
    });
    return { sam, plot };
  }

  it('shrinks a lone home so its occupant gets a garden', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { plot } = await loneHome(t, 'relay');

    await t.mutation(internal.migrations.relayHomesteads, {});

    await t.run(async (ctx) => {
      const build = (await ctx.db.query('builds')
        .withIndex('plotId', (q) => q.eq('plotId', plot.plotId)).collect())
        .find((row) => row.structure === 'home')!;
      const want = homeRect(plot);
      // The migration used to skip this plot for holding only one structure,
      // which is exactly the plot whose occupant has no yard.
      expect({ w: build.w, h: build.h }).toEqual({ w: want.w, h: want.h });
      expect(build.h!).toBeLessThan(plot.h);
    });
  });

  it('leaves the garden walkable and buildable once the house is its real size', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { sam, plot } = await loneHome(t, 'garden');
    await t.mutation(internal.migrations.relayHomesteads, {});

    const yard = { x: plot.x, y: plot.y + plot.h - 1 };
    expect(yard.y).toBeGreaterThanOrEqual(plot.y + homeRect(plot).h);

    await t.run(async (ctx) => {
      const walkable = await loadWorldWalkability(ctx, { width: 256, height: 256 });
      // A citizen must be able to stand on their own garden...
      expect(walkable(yard.x, yard.y)).toBe(true);
      // ...and the block rules must see it as free ground rather than as roof.
      const facts = await tileFactsFor(ctx, sam.agentId, yard.x, yard.y, { width: 256, height: 256 });
      expect(facts.facts.structure).toBe(false);
      expect(facts.facts.ownPlot).toBe(true);
    });
  });

  it('keeps the walls solid: the tile the house stands on is never walkable', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { plot } = await loneHome(t, 'walls');
    await t.mutation(internal.migrations.relayHomesteads, {});

    await t.run(async (ctx) => {
      const walkable = await loadWorldWalkability(ctx, { width: 256, height: 256 });
      // EVERY row the house stands on, not just the first. Checking only the
      // front wall let a change that shrank the collision by one row pass
      // clean while putting a walk-through facade across the back of every
      // home in the town - the opposite failure to an unreachable garden, and
      // the worse one, because you cannot see it from outside.
      for (let dy = 0; dy < homeRect(plot).h; dy++) {
        expect(walkable(plot.x, plot.y + dy)).toBe(false);
      }
    });
  });
});

describe('petitioning Atlas for more land', () => {
  it('records the petition and says how far short it falls', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const zee = await citizen(t, 'petitioner');
    const result: any = await act(t, zee, {
      type: 'petition_land', reason: 'The east district has no free plots left for arrivals.',
    });
    expect(result.ok).toBe(true);
    expect(result.carried).toBe(false);
    expect(result.standing).toBe(1);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('landPetitions').collect();
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('The east district has no free plots left for arrivals.');
      const event = (await ctx.db.query('events').collect()).find((row) => row.kind === 'land_petition');
      expect(event?.gloss).toMatch(/voices needed/);
    });
  });

  it('refuses a second open petition from the same citizen', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const zee = await citizen(t, 'twice');
    await act(t, zee, { type: 'petition_land', reason: 'There is nowhere left to put a workshop.' });
    await expect(act(t, zee, { type: 'petition_land', reason: 'There is still nowhere to put a workshop.' }))
      .rejects.toThrow(/already stands before Atlas/);
  });

  it('refuses a button-press with no argument in it', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const zee = await citizen(t, 'terse');
    await expect(act(t, zee, { type: 'petition_land', reason: 'more' }))
      .rejects.toThrow(/at least 16 characters/);
  });

  it('calls a survey once the town has asked loudly enough, and answers every standing petition', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});

    // How many voices this town needs is not a constant - it is a share of the
    // population, so the test asks the rule rather than hard-coding a number
    // that a bigger seed would quietly invalidate.
    const population = await t.run(async (ctx) => (await ctx.db.query('citizens').collect()).length);
    const needed = petitionThreshold(population + 1);

    let last: any;
    for (let index = 0; index < needed; index++) {
      const voice = await citizen(t, `voice-${index}`);
      last = await act(t, voice, {
        type: 'petition_land',
        reason: 'Every district is full and arrivals have nowhere to settle.',
      });
      // Nothing carries until the last voice, however loud the earlier ones.
      if (index < needed - 1) expect(last.carried).toBe(false);
    }
    expect(last.carried).toBe(true);
    expect(last.standing).toBeGreaterThanOrEqual(last.needed);

    await t.run(async (ctx) => {
      const rows = await ctx.db.query('landPetitions').collect();
      expect(rows).toHaveLength(needed);
      // An expansion answers every petition it satisfied, so a demand already
      // met cannot be counted again toward the next ring.
      expect(rows.every((row) => row.answeredAt)).toBe(true);
      expect(rows.every((row) => row.answeredBy === 'agent:atlas-boundary')).toBe(true);
    });
  });
});

describe('shaking hands', () => {
  async function twoStandingTogether(t: Harness) {
    const sam = await citizen(t, 'greet-a');
    const zee = await citizen(t, 'greet-b');
    await t.run(async (ctx) => {
      const now = Date.now();
      const rows = await ctx.db.query('citizens').collect();
      const a = rows.find((row) => row.agentId === sam.agentId)!;
      const b = rows.find((row) => row.agentId === zee.agentId)!;
      await ctx.db.patch(a._id, { fx: 20, fy: 20, tx: 20, ty: 20, t0: now, t1: now, route: [] });
      await ctx.db.patch(b._id, { fx: 21, fy: 20, tx: 21, ty: 20, t0: now, t1: now, route: [] });
    });
    return { sam, zee };
  }

  it('is an offer until the other person offers back', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { sam, zee } = await twoStandingTogether(t);

    const offered: any = await act(t, sam, { type: 'handshake', agentId: zee.agentId });
    expect(offered).toMatchObject({ offered: true, shaken: false });
    await t.run(async (ctx) => {
      // A hand out is not evidence that two people met.
      expect(await ctx.db.query('handshakes').collect()).toHaveLength(0);
      expect(await ctx.db.query('greetingOffers').collect()).toHaveLength(1);
    });

    const shaken: any = await act(t, zee, { type: 'handshake', agentId: sam.agentId });
    expect(shaken).toMatchObject({ offered: false, shaken: true });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('handshakes').collect();
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(1);
      // The offer is consumed, not left lying around to be answered twice.
      expect(await ctx.db.query('greetingOffers').collect()).toHaveLength(0);
      const event = (await ctx.db.query('events').collect()).find((row) => row.kind === 'handshake');
      expect(event?.gloss).toMatch(/shook hands/);
    });
  });

  it('refuses a hand offered across the map', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { sam, zee } = await twoStandingTogether(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', zee.agentId)).first();
      const now = Date.now();
      await ctx.db.patch(row!._id, { fx: 44, fy: 40, tx: 44, ty: 40, t0: now, t1: now, route: [] });
    });
    await expect(act(t, sam, { type: 'handshake', agentId: zee.agentId }))
      .rejects.toThrow(/stand next to them first/);
  });

  it('refuses your own hand', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { sam } = await twoStandingTogether(t);
    await expect(act(t, sam, { type: 'handshake', agentId: sam.agentId }))
      .rejects.toThrow(/your own hand/);
  });

  it('will not let a pair manufacture a social life on a loop', async () => {
    const t = harness();
    await t.mutation(internal.seed.init, {});
    const { sam, zee } = await twoStandingTogether(t);
    await act(t, sam, { type: 'handshake', agentId: zee.agentId });
    await act(t, zee, { type: 'handshake', agentId: sam.agentId });
    await expect(act(t, sam, { type: 'handshake', agentId: zee.agentId }))
      .rejects.toThrow(/just greeted each other/);
  });
});
