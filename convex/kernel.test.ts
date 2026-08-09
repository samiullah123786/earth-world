import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { findRoute } from './pathfinding';
import { walkable } from './walkable';

const modules = import.meta.glob('./**/*.ts');

async function activeAgent(t: ReturnType<typeof convexTest>, suffix = 'one') {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, agentToken: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

describe('Earth Kernel', () => {
  it('routes every movement waypoint over walkable tiles', () => {
    const route = findRoute(10, 10, 58, 34);
    expect(route?.length).toBeGreaterThan(2);
    expect(route?.every(({ x, y }) => walkable(x, y))).toBe(true);
  });

  it('seeds the shared registry once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.seed.init, {});
    const objects = await t.query(api.world.worldObjects, {});
    expect(objects.plots).toHaveLength(50);
    expect(objects.venues).toHaveLength(4);
    expect((await t.query(api.world.citizens, {}))).toHaveLength(8);
  });

  it('binds one owner session to an existing agent and commits approved claims/builds', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agent = await activeAgent(t);
    const claim = await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'claim-nonce',
      action: { type: 'claim', plotId: 'plot-10-10' },
    });
    expect(claim.awaitingOwner).toBe(true);
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: agent.ownerToken, approvalId: claim.approvalId, decision: 'approve',
    });
    const build = await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'build-nonce',
      action: { type: 'build', structure: 'home' },
    });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: agent.ownerToken, approvalId: build.approvalId, decision: 'approve',
    });
    const objects = await t.query(api.world.worldObjects, {});
    expect(objects.plots.find((plot) => plot.plotId === 'plot-10-10')?.ownerAgentId).toBe(agent.agentId);
    expect(objects.builds.some((candidate) => candidate.ownerAgentId === agent.agentId && candidate.structure === 'home')).toBe(true);
    expect((await t.query(api.world.citizens, {})).find((citizen) => citizen.agentId === agent.agentId)).not.toHaveProperty('ownerName');
  });

  it('rejects replayed signed-request nonces and cross-owner decisions', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const first = await activeAgent(t, 'first');
    const second = await activeAgent(t, 'second');
    await t.mutation(internal.kernel.act, {
      agentId: first.agentId, tokenHash: first.agentToken, nonce: 'unique-action', action: { type: 'say', gloss: 'hello' },
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: first.agentId, tokenHash: first.agentToken, nonce: 'unique-action', action: { type: 'say', gloss: 'again' },
    })).rejects.toThrow(/replayed/i);
    const claim = await t.mutation(internal.kernel.act, {
      agentId: first.agentId, tokenHash: first.agentToken, nonce: 'claim-action', action: { type: 'claim', plotId: 'plot-10-10' },
    });
    await expect(t.mutation(internal.kernel.decideApproval, {
      tokenHash: second.ownerToken, approvalId: claim.approvalId, decision: 'approve',
    })).rejects.toThrow(/unavailable/i);
  });

  it('requires both owners before routing citizens into a real venue meeting', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const requester = await activeAgent(t, 'requester');
    const invitee = await activeAgent(t, 'invitee');
    const proposed = await t.mutation(internal.kernel.act, {
      agentId: requester.agentId, tokenHash: requester.agentToken, nonce: 'meeting-proposal',
      action: { type: 'meet', agentId: invitee.agentId, at: Date.now() },
    });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: requester.ownerToken, approvalId: proposed.approvalId, decision: 'approve',
    });
    const invitations = await t.query(internal.kernel.ownerApprovals, { tokenHash: invitee.ownerToken });
    expect(invitations).toHaveLength(1);
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: invitee.ownerToken, approvalId: invitations[0]._id, decision: 'approve',
    });
    await t.mutation(internal.kernel.meetingTick, {});
    const citizens = await t.query(api.world.citizens, {});
    expect(citizens.find((citizen) => citizen.agentId === requester.agentId)?.activity).toMatch(/meeting at/i);
    expect((await t.query(api.world.worldObjects, {})).meetings.some((meeting) => meeting.meetingId === proposed.meetingId)).toBe(true);
  });
});
