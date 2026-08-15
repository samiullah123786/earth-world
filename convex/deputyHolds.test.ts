import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { bankHoldNeedsTheMayor } from './kernel';

const modules = import.meta.glob('./**/*.ts');
const FOUNDING_MAYOR = 'agent:sam-cbf0499925';

/**
 * Which bank holds reach a human.
 *
 * Every hold is raised at 'strict', so under the old rule all of them went to
 * the Mayor: sixty-five items, none decidable, growing. But "the scanner
 * noticed something" is not "this is dangerous" - a skill shipping a .py file
 * is flagged, and so is one trying to talk its reader into leaking a key.
 */
describe('what counts as a red light', () => {
  it('sends anything that acts on the reader, or reaches for secrets, to the Mayor', () => {
    for (const flag of ['exfiltration', 'instruction_override', 'prompt_extraction', 'concealment',
      'tool_shadowing', 'bidi_override', 'encoded_payload', 'credential_access',
      'environment_mutation', 'hidden_text', 'symlink', 'path_traversal', 'manager_high_risk']) {
      expect(bankHoldNeedsTheMayor([flag]), flag).toBe(true);
    }
  });

  it('lets the Deputy handle ordinary housekeeping', () => {
    for (const flag of ['executable_file', 'unknown_file_type', 'needs_api_key',
      'dynamic_execution', 'shell_execution', 'no_documentation']) {
      expect(bankHoldNeedsTheMayor([flag]), flag).toBe(false);
    }
    expect(bankHoldNeedsTheMayor([])).toBe(false);
    expect(bankHoldNeedsTheMayor(undefined)).toBe(false);
  });

  it('one red flag among many is still red', () => {
    expect(bankHoldNeedsTheMayor(['executable_file', 'needs_api_key', 'exfiltration'])).toBe(true);
  });
});

const SAFE = { verdict: 'needs_review' as const, note: 'held', scannerVersion: 'test' };

async function town(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.seed.init, {});
  const mayor = 'agent:zee-mayor';
  await t.run(async (ctx: any) => {
    await ctx.db.insert('citizens', {
      agentId: mayor, name: 'Zee', gender: 'female', family: 'data', accent: 'research',
      activity: 'holding the seat', state: 'ambient', online: true,
      fx: 1, fy: 1, tx: 1, ty: 1, t0: Date.now(), t1: Date.now(),
    });
    const world = await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
    await ctx.db.patch(world._id, { mayorAgentId: mayor });
  });
  await t.mutation(internal.seed.init, {});
  await t.mutation(internal.kernel.deputyTick, {});
  await t.run(async (ctx: any) => {
    const config = await ctx.db.query('governanceConfig').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
    await ctx.db.patch(config._id, { authoritiesEnabled: true });
  });
  return mayor;
}

async function heldSkill(t: ReturnType<typeof convexTest>, mayor: string, name: string, flags: string[]) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert('bankSkills', {
      skillId: `skill:${name}`, name, description: `${name} does a thing`, category: 'content',
      markdownBody: '# body', contentDigest: `d-${name}`, depositorAgentId: 'agent:aiden-0001',
      alsoDepositedBy: [], sourceKind: 'local', embedding: [], sizeBytes: 10, license: 'MIT',
      priceTokens: 0, safety: { ...SAFE, flags }, state: 'flagged',
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.db.insert('approvals', {
      agentId: mayor, kind: 'bank_flag', summary: `Bank hold: ${name}`, detail: 'for the test',
      payload: { skillId: `skill:${name}`, title: name, flags },
      state: 'pending', createdAt: Date.now(), risk: 'strict',
    });
  });
}

describe('the Deputy clears the ordinary and leaves the rest', () => {
  it('releases housekeeping holds and never touches a red one', async () => {
    const t = convexTest(schema, modules);
    const mayor = await town(t);
    await heldSkill(t, mayor, 'ordinary-one', ['executable_file']);
    await heldSkill(t, mayor, 'ordinary-two', ['needs_api_key', 'unknown_file_type']);
    await heldSkill(t, mayor, 'dangerous-one', ['exfiltration']);

    const result: any = await t.mutation(internal.kernel.deputyTick, {});
    expect(result.decided).toBe(2);

    await t.run(async (ctx: any) => {
      const state = async (n: string) => (await ctx.db.query('bankSkills')
        .withIndex('skillId', (q: any) => q.eq('skillId', `skill:${n}`)).first()).state;
      expect(await state('ordinary-one')).toBe('evaluated');
      expect(await state('ordinary-two')).toBe('evaluated');
      expect(await state('dangerous-one'), 'a red hold waits for the Mayor').toBe('flagged');
    });
  });

  it('finds ordinary work queued behind a wall of red ones', async () => {
    const t = convexTest(schema, modules);
    const mayor = await town(t);
    // The bug this pins: the Deputy read only the first twenty rows, so once
    // twenty red holds sat at the front it reported "escalated" for ever while
    // work it could clear waited just out of view.
    for (let index = 0; index < 25; index++) await heldSkill(t, mayor, `red-${index}`, ['exfiltration']);
    await heldSkill(t, mayor, 'buried-ordinary', ['executable_file']);

    const result: any = await t.mutation(internal.kernel.deputyTick, {});
    expect(result.decided, 'the buried item must be reachable').toBe(1);
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query('bankSkills')
        .withIndex('skillId', (q: any) => q.eq('skillId', 'skill:buried-ordinary')).first();
      expect(row.state).toBe('evaluated');
    });
  });
});

describe('reconciliation', () => {
  it('withdraws a hold whose case closed by another route', async () => {
    const t = convexTest(schema, modules);
    const mayor = await town(t);
    await heldSkill(t, mayor, 'gone-skill', ['exfiltration']);
    // Something else retires the skill; the approval is now unanswerable.
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query('bankSkills')
        .withIndex('skillId', (q: any) => q.eq('skillId', 'skill:gone-skill')).first();
      await ctx.db.patch(row._id, { state: 'retired' });
    });

    const result: any = await t.mutation(internal.kernel.reconcileApprovals, {});
    expect(result.withdrawn).toBe(1);
    await t.run(async (ctx: any) => {
      const open = (await ctx.db.query('approvals').collect()).filter((row: any) => row.state === 'pending');
      expect(open, 'an unanswerable item must not sit on the desk').toHaveLength(0);
    });
  });
});
