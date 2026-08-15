import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

/**
 * A bank hold has two forms and every reader has to know both.
 *
 * Holds are raised over a vault asset (payload.assetId) or over a structured
 * skill (payload.skillId), by two different code paths. The approve path once
 * read only the asset shape, so every hold raised over a skill looked up an
 * empty id and told the Mayor "that vault case is no longer open" - with
 * sixty-five of sixty-five pending holds being skills, the entire queue was
 * undecidable and could only grow.
 */

const SAFE = { verdict: 'inert_safe' as const, flags: [], note: 'inert', scannerVersion: 'test' };

async function mayorSession(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.seed.init, {});
  return await t.run(async (ctx: any) => {
    const world = await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', 'earth')).first();
    const mayorId = world.mayorAgentId as string;
    await ctx.db.insert('sessions', {
      tokenHash: 'owner-mayor', agentId: mayorId, kind: 'owner',
      createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, lastSeenAt: Date.now(),
    });
    return mayorId;
  });
}

async function flaggedSkill(t: ReturnType<typeof convexTest>, name: string) {
  return await t.run(async (ctx: any) => {
    const skillId = `skill:${name}`;
    await ctx.db.insert('bankSkills', {
      skillId, name, description: `${name} does a thing`, category: 'content',
      markdownBody: '# body', contentDigest: `d-${name}`, depositorAgentId: 'agent:aiden-0001',
      alsoDepositedBy: [], sourceKind: 'local', embedding: [], sizeBytes: 10,
      license: 'MIT', priceTokens: 0, safety: { ...SAFE, verdict: 'needs_review', flags: ['executable_file'] },
      state: 'flagged', createdAt: Date.now(), updatedAt: Date.now(),
    });
    return skillId;
  });
}

async function holdFor(t: ReturnType<typeof convexTest>, mayorId: string, payload: any) {
  return await t.run(async (ctx: any) => await ctx.db.insert('approvals', {
    agentId: mayorId, kind: 'bank_flag', summary: 'Bank hold', detail: 'raised for the test',
    payload, state: 'pending', createdAt: Date.now(), risk: 'strict',
  }));
}

describe('a bank hold raised over a skill', () => {
  it('can be approved, which is what the whole queue could not do', async () => {
    const t = convexTest(schema, modules);
    const mayorId = await mayorSession(t);
    const skillId = await flaggedSkill(t, 'scriptwriting');
    const approvalId = await holdFor(t, mayorId, { skillId, title: 'scriptwriting', flags: ['executable_file'] });

    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: 'owner-mayor', approvalId, decision: 'approve',
    });

    await t.run(async (ctx: any) => {
      const skill = await ctx.db.query('bankSkills').withIndex('skillId', (q: any) => q.eq('skillId', skillId)).first();
      expect(skill.state, 'approving a hold releases the skill').toBe('evaluated');
      const approval = await ctx.db.get(approvalId);
      expect(approval.state, 'and the item leaves the queue').not.toBe('pending');
    });
  });

  it('can be declined, which used to succeed while doing nothing at all', async () => {
    const t = convexTest(schema, modules);
    const mayorId = await mayorSession(t);
    const skillId = await flaggedSkill(t, 'risky-thing');
    const approvalId = await holdFor(t, mayorId, { skillId, title: 'risky-thing', flags: ['exfiltration'] });

    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: 'owner-mayor', approvalId, decision: 'decline',
    });

    await t.run(async (ctx: any) => {
      const skill = await ctx.db.query('bankSkills').withIndex('skillId', (q: any) => q.eq('skillId', skillId)).first();
      expect(skill.state, 'declining a hold retires the skill').toBe('retired');
    });
  });

  it('still refuses honestly when the case really has closed', async () => {
    const t = convexTest(schema, modules);
    const mayorId = await mayorSession(t);
    const approvalId = await holdFor(t, mayorId, { skillId: 'skill:never-existed', title: 'ghost', flags: [] });
    await expect(t.mutation(internal.kernel.decideApproval, {
      tokenHash: 'owner-mayor', approvalId, decision: 'approve',
    })).rejects.toThrow(/no longer open/);
  });
});
