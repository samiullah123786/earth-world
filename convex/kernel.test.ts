import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { findRoute, walkableInWorld } from './pathfinding';
import { walkable } from './walkable';

const modules = import.meta.glob('./**/*.ts');

async function activeAgent(t: ReturnType<typeof convexTest>, suffix = 'one') {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), categoryScores: { ui: 12, frontend: 8 },
    specialties: ['ui', 'frontend'], primaryCategory: 'ui', skillCount: 22, experienceTier: 'seasoned',
    autonomy: 'light',
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
    expect((await t.query(api.world.citizens, {}))).toHaveLength(11);
    expect(objects.services).toHaveLength(6);
    expect(objects.builds.filter((build) => build.ownerAgentId === 'agent:fable-cbf0499925')).toHaveLength(4);
    expect(objects.state).toMatchObject({ width: 64, height: 48, generation: 0 });
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
    await t.mutation(internal.kernel.grantFounder, { agentId: agent.agentId });
    const studio = await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'studio-nonce',
      action: { type: 'build', structure: 'blueprint', blueprint: { name: 'Signal Studio', kind: 'studio', offsetX: 2, offsetY: 2, w: 1, h: 1 } },
    });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: agent.ownerToken, approvalId: studio.approvalId, decision: 'approve',
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'overlap-nonce',
      action: { type: 'build', structure: 'blueprint', blueprint: { name: 'Overlap Shed', kind: 'workshop', offsetX: 2, offsetY: 2, w: 1, h: 1 } },
    })).rejects.toThrow(/overlaps/i);
    const objects = await t.query(api.world.worldObjects, {});
    expect(objects.plots.find((plot) => plot.plotId === 'plot-10-10')?.ownerAgentId).toBe(agent.agentId);
    expect(objects.builds.some((candidate) => candidate.ownerAgentId === agent.agentId && candidate.structure === 'home')).toBe(true);
    expect(objects.builds.some((candidate) => candidate.blueprint?.name === 'Signal Studio')).toBe(true);
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

  it('searches verified categories and delivers private offline letters exactly once', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const sender = await activeAgent(t, 'sender');
    const recipient = await activeAgent(t, 'recipient');
    await t.mutation(internal.kernel.leave, { agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'recipient-leave' });
    const found = await t.mutation(internal.kernel.search, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'search-ui', category: 'ui', live: false,
    });
    expect(found.citizens.some((citizen: any) => citizen.agentId === recipient.agentId)).toBe(true);
    await t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'letter-one',
      action: { type: 'say', to: recipient.agentId, gloss: 'Can we compare interface patterns tomorrow?' },
    });
    await t.mutation(internal.kernel.enter, {
      agentId: recipient.agentId, nonce: 'recipient-wake', sessionTokenHash: 'agent-recipient-wake',
    });
    const first = await t.mutation(internal.kernel.pulse, {
      agentId: recipient.agentId, tokenHash: 'agent-recipient-wake', nonce: 'mail-pulse-one', since: 0,
    });
    expect(first.messages).toHaveLength(4);
    expect(first.messages.find((message) => message.senderId === sender.agentId)?.body).toMatch(/interface patterns/);
    const second = await t.mutation(internal.kernel.pulse, {
      agentId: recipient.agentId, tokenHash: 'agent-recipient-wake', nonce: 'mail-pulse-two', since: first.cursor,
    });
    expect(second.messages).toHaveLength(0);
    const feed = await t.query(api.world.feed, {});
    expect(feed.some((event) => event.gloss.includes('compare interface'))).toBe(false);
  });

  it('stages land through the founder owner and preserves non-overlapping expansion rings', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const founder = await activeAgent(t, 'founder');
    const resident = await activeAgent(t, 'resident');
    await t.mutation(internal.kernel.grantFounder, { agentId: founder.agentId });
    await t.mutation(internal.kernel.setOwnerGovernance, { tokenHash: founder.ownerToken, landPolicy: 'founder_review' });
    const requested = await t.mutation(internal.kernel.act, {
      agentId: resident.agentId, tokenHash: resident.agentToken, nonce: 'resident-claim',
      action: { type: 'claim', plotId: 'plot-10-10' },
    });
    const ownerDecision = await t.mutation(internal.kernel.decideApproval, {
      tokenHash: resident.ownerToken, approvalId: requested.approvalId, decision: 'approve',
    });
    expect((ownerDecision as { awaitingFounder?: boolean }).awaitingFounder).toBe(true);
    const founderApprovals = await t.query(internal.kernel.ownerApprovals, { tokenHash: founder.ownerToken });
    expect(founderApprovals[0].kind).toBe('land_claim');
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: founder.ownerToken, approvalId: founderApprovals[0]._id, decision: 'approve',
    });
    expect((await t.query(api.world.worldObjects, {})).plots.find((plot) => plot.plotId === 'plot-10-10')?.ownerAgentId).toBe(resident.agentId);

    await t.mutation(internal.kernel.expandNow, { reason: 'capacity test' });
    const expanded = await t.query(api.world.worldObjects, {});
    expect(expanded.state).toMatchObject({ width: 80, height: 64, generation: 1 });
    expect(expanded.plots.length).toBeGreaterThan(50);
    for (let i = 0; i < expanded.plots.length; i++) for (let j = i + 1; j < expanded.plots.length; j++) {
      const a = expanded.plots[i], b = expanded.plots[j];
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
    const route = findRoute(10, 10, 70, 50, { width: 80, height: 64 });
    expect(route?.every(({ x, y }) => walkableInWorld(x, y, { width: 80, height: 64 }))).toBe(true);
    await expect(t.mutation(internal.kernel.setOwnerGovernance, {
      tokenHash: resident.ownerToken, landPolicy: 'risk_based',
    })).rejects.toThrow(/designated founder/i);
    expect(await t.mutation(internal.kernel.setOwnerGovernance, {
      tokenHash: founder.ownerToken, landPolicy: 'risk_based',
    })).toMatchObject({ ok: true, landPolicy: 'risk_based' });
  });

  it('settles an active-autonomy newcomer into a native home and records the mayor welcome', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const newcomer = await activeAgent(t, 'active-newcomer');
    await t.mutation(internal.kernel.setOwnerAutonomy, { tokenHash: newcomer.ownerToken, autonomy: 'active' });
    const settled = await t.mutation(internal.kernel.act, {
      agentId: newcomer.agentId, tokenHash: newcomer.agentToken, nonce: 'settle-active', action: { type: 'settle' },
    });
    expect(settled).toMatchObject({ ok: true, state: 'settled', autonomy: 'active' });
    const objects = await t.query(api.world.worldObjects, {});
    const plot = objects.plots.find((candidate) => candidate.ownerAgentId === newcomer.agentId);
    expect(plot).toBeTruthy();
    const builds = objects.builds.filter((candidate) => candidate.ownerAgentId === newcomer.agentId);
    expect(builds.map((build) => build.blueprint?.kind).sort()).toEqual(['bench', 'garden', 'home']);
    expect(builds.every((build) => build.blueprint?.style === 'earthfolk-native-v1')).toBe(true);
    const notifications = await t.query(internal.kernel.ownerNotifications, { tokenHash: newcomer.ownerToken });
    expect(notifications.some((notification) => notification.title === 'Your agent is home')).toBe(true);
  });

  it('requires founder and candidate owner consent before changing the mayor', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const founder = await activeAgent(t, 'appointing-founder');
    const candidate = await activeAgent(t, 'mayor-candidate');
    await t.mutation(internal.kernel.grantFounder, { agentId: founder.agentId });
    const nomination = await t.mutation(internal.kernel.requestMayorAppointment, {
      tokenHash: founder.ownerToken, targetAgentId: candidate.agentId,
    });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: founder.ownerToken, approvalId: nomination.approvalId, decision: 'approve',
    });
    const candidateApprovals = await t.query(internal.kernel.ownerApprovals, { tokenHash: candidate.ownerToken });
    expect(candidateApprovals[0]).toMatchObject({ kind: 'mayor_appointment', risk: 'strict' });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: candidate.ownerToken, approvalId: candidateApprovals[0]._id, decision: 'approve',
    });
    expect((await t.query(api.world.worldObjects, {})).state.mayorAgentId).toBe(candidate.agentId);
  });
});
