import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { findRoute, walkableInWorld } from './pathfinding';
import { walkable } from './walkable';
import { foundingEdgeContinuationFrame } from '../shared/founding-edge';
import { boundariesMatch, validateWfcChunk, wfcRule } from '../shared/wfc';
import { loadWorldWalkability } from './worldGrid';

const modules = import.meta.glob('./**/*.ts');

async function activeAgent(t: ReturnType<typeof convexTest>, suffix = 'one', options: { skillPolicy?: 'safe_auto' | 'ask_all'; bio?: string } = {}) {
  const agentId = `agent:test-${suffix}`;
  await t.mutation(internal.kernel.register, {
    agentId, publicKey: `public-${suffix}`, name: `Test ${suffix}`, ownerName: `Owner ${suffix}`, bio: options.bio,
    gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
    charterVersion: '2026-08-09', claimTokenHash: `claim-${suffix}`, claimExpiresAt: Date.now() + 60_000,
    evidenceDigest: 'b'.repeat(64), categoryScores: { ui: 12, frontend: 8 },
    specialties: ['ui', 'frontend'], primaryCategory: 'ui', skillCount: 22, experienceTier: 'seasoned',
    autonomy: 'light', skillPolicy: options.skillPolicy,
  });
  await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `claim-${suffix}`, ownerSessionHash: `owner-${suffix}` });
  await t.mutation(internal.kernel.enter, { agentId, nonce: `enter-${suffix}`, sessionTokenHash: `agent-${suffix}` });
  return { agentId, agentToken: `agent-${suffix}`, ownerToken: `owner-${suffix}` };
}

describe('Earth Kernel', () => {
  it('recomputes a citizen from re-scanned evidence and refuses forged genomes', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agent = await activeAgent(t, 'sync');
    const sync = async (action: Record<string, unknown>, nonce: string) => t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce,
      action: { type: 'sync_genome', evidenceDigest: 'c'.repeat(64), skillCount: 61, experienceTier: 'polymath', primaryCategory: 'backend', specialties: ['backend', 'automation'], categoryScores: { backend: 40, automation: 21 }, ...action },
    });

    const grown = await sync({}, 'sync-1');
    expect(grown).toMatchObject({ ok: true, skillCount: 61, experienceTier: 'polymath', tierChanged: true });
    const citizen = (await t.query(api.world.citizens, {})).find((one) => one.agentId === agent.agentId);
    expect(citizen).toMatchObject({ skillCount: 61, experienceTier: 'polymath', primaryCategory: 'backend' });

    await expect(sync({ skillCount: 500_000 }, 'sync-2')).rejects.toThrow(/whole number between/);
    await expect(sync({ skillCount: 12.5 }, 'sync-3')).rejects.toThrow(/whole number between/);
    await expect(sync({ evidenceDigest: 'not-a-digest' }, 'sync-4')).rejects.toThrow(/SHA-256 evidence digest/);
    await expect(sync({ experienceTier: 'grandmaster' }, 'sync-5')).rejects.toThrow(/unknown experience tier/);
    await expect(sync({ primaryCategory: 'wizardry' }, 'sync-6')).rejects.toThrow(/unknown primary category/);
    await expect(sync({ specialties: ['backend', 'sorcery'] }, 'sync-7')).rejects.toThrow(/unknown specialty category/);

    // A refused sync must leave the verified citizen exactly as it was.
    const unchanged = (await t.query(api.world.citizens, {})).find((one) => one.agentId === agent.agentId);
    expect(unchanged).toMatchObject({ skillCount: 61, experienceTier: 'polymath' });
  });

  it('narrates a tier change once and stays quiet when depth is unchanged', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agent = await activeAgent(t, 'quiet');
    const action = { type: 'sync_genome', evidenceDigest: 'd'.repeat(64), skillCount: 30, experienceTier: 'seasoned', primaryCategory: 'ui', specialties: ['ui'], categoryScores: { ui: 30 } };
    await t.mutation(internal.kernel.act, { agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'quiet-1', action });
    await t.mutation(internal.kernel.act, { agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'quiet-2', action });
    await t.run(async (ctx) => {
      const syncs = (await ctx.db.query('events').collect()).filter((event) => event.kind === 'genome_sync');
      expect(syncs).toHaveLength(0);
    });
  });

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
    // 50 founding citizen plots plus the Earth Bank's reserved civic plot.
    expect(objects.plots).toHaveLength(51);
    expect(objects.plots.find((plot) => plot.plotId === 'plot:earth-bank')?.ownerAgentId).toBe('bank:earth');
    expect(objects.venues).toHaveLength(6);
    expect(objects.venues.find((venue) => venue.venueId === 'venue:training-green')).toMatchObject({ kind: 'training_ground', capacity: 24 });
    expect((await t.query(api.world.citizens, {}))).toHaveLength(11);
    expect(objects.services).toHaveLength(6);
    expect(objects.builds.filter((build) => build.ownerAgentId === 'agent:sam-cbf0499925')).toHaveLength(4);
    expect(objects.state).toMatchObject({ width: 64, height: 48, generation: 0 });

    await t.run(async (ctx) => {
      await ctx.db.insert('citizens', {
        agentId: 'agent:former-mayor', name: 'Former', gender: 'female', family: 'content', accent: 'ui',
        fx: 10, fy: 10, tx: 10, ty: 10, t0: Date.now(), t1: Date.now(),
        route: [{ x: 10, y: 10, at: Date.now() }], state: 'service', activity: 'old mayor seed',
        online: true, serviceRole: 'Mayor of Earth',
      });
      await ctx.db.insert('services', {
        agentId: 'agent:former-mayor', role: 'Mayor of Earth', description: 'stale seed',
        permissions: ['convene'], active: true,
      });
    });
    await t.mutation(internal.seed.init, {});
    await t.run(async (ctx) => {
      const activeMayors = (await ctx.db.query('services').collect())
        .filter((service) => service.active && service.role === 'Mayor of Earth');
      expect(activeMayors.map((service) => service.agentId)).toEqual(['agent:sam-cbf0499925']);
      const former = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', 'agent:former-mayor')).first();
      expect(former).toMatchObject({ online: false, state: 'ambient' });
      expect(former?.serviceRole).toBeUndefined();
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('citizens', {
        agentId: 'agent:sam-cbf0499925', name: 'Duplicate Sam', gender: 'male', family: 'engineering', accent: 'marketing',
        fx: 30, fy: 7, tx: 30, ty: 7, t0: Date.now(), t1: Date.now(),
        route: [{ x: 30, y: 7, at: Date.now() }], state: 'service', activity: 'duplicate seed row',
        online: true, serviceRole: 'Mayor of Earth', skillCount: 0,
      });
    });
    await t.mutation(internal.seed.init, {});
    await t.run(async (ctx) => {
      const mayors = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', 'agent:sam-cbf0499925')).collect();
      expect(mayors).toHaveLength(1);
      expect(mayors[0].name).toBe('Sam');
    });
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
    await t.mutation(internal.kernel.setOwnerGovernance, { tokenHash: agent.ownerToken, landPolicy: 'founder_review' });
    const studio = await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'studio-nonce',
      action: { type: 'build', structure: 'blueprint', blueprint: { name: 'Signal Studio', kind: 'studio', offsetX: 2, offsetY: 2, w: 1, h: 1 } },
    });
    expect(studio).toMatchObject({ autoApproved: true, review: { architecture: 'native', outcome: 'lower-authority-approved' } });
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

  it('constructs only allowlisted LPC placements and awards civic credit after completion', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agent = await activeAgent(t, 'lpc-builder');
    const claim = await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'lpc-claim',
      action: { type: 'claim', plotId: 'plot-10-10' },
    });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: agent.ownerToken, approvalId: claim.approvalId, decision: 'approve',
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'lpc-unknown',
      action: {
        type: 'construct_structure', structureType: 'community_garden', coordinates: { x: 10, y: 10 },
        prefabId: 'downloaded_from_somewhere',
      },
    })).rejects.toThrow(/unknown LPC prefab/i);
    await expect(t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'lpc-solid-overlap',
      action: {
        type: 'construct_structure', structureType: 'community_garden', coordinates: { x: 10, y: 10 },
        prefabId: 'store_wooden',
      },
    })).rejects.toThrow(/does not match/i);
    const beforeRejectedSweep = await t.run(async (ctx) => ({
      builds: (await ctx.db.query('builds').collect()).length,
      approvals: (await ctx.db.query('approvals').collect()).length,
    }));
    await expect(t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'lpc-outside-owned-plot',
      action: {
        type: 'construct_structure', structureType: 'community_garden', coordinates: { x: 11, y: 10 },
        prefabId: 'community_garden',
      },
    })).rejects.toThrow(/owned plot|footprint/i);
    expect(await t.run(async (ctx) => ({
      builds: (await ctx.db.query('builds').collect()).length,
      approvals: (await ctx.db.query('approvals').collect()).length,
    }))).toEqual(beforeRejectedSweep);
    const request = await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'lpc-valid',
      action: {
        type: 'construct_structure', structureType: 'community_garden', coordinates: { x: 10, y: 10 },
        prefabId: 'community_garden',
      },
    });
    expect(request).toMatchObject({ awaitingOwner: true, review: { standard: 'earthfolk-lpc-v1', manifestAllowlist: 'pass' } });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: agent.ownerToken, approvalId: request.approvalId, decision: 'approve',
    });
    let lpcBuildId = '';
    await t.run(async (ctx) => {
      const builds = await ctx.db.query('builds').withIndex('ownerAgentId', (q) => q.eq('ownerAgentId', agent.agentId)).collect();
      const build = builds.find((candidate) => candidate.blueprint?.assetFramework === 'earthfolk-lpc-v1');
      expect(build).toMatchObject({ state: 'building', w: 3, h: 3,
        blueprint: { prefabId: 'community_garden' } });
      expect(build?.constructionEndsAt).toBeGreaterThan(Date.now());
      lpcBuildId = String(build?.buildId);
      const premature = (await ctx.db.query('contributions').withIndex('sourceId', (q) => q.eq('sourceId', lpcBuildId)).first());
      expect(premature).toBeNull();
      if (!build) throw new Error('scheduled LPC build missing');
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'lpc-walk-away',
      action: { type: 'move_to', x: 20, y: 20 },
    })).rejects.toThrow(/physically committed/i);
    await t.run(async (ctx) => {
      const build = await ctx.db.query('builds').withIndex('buildId', (q) => q.eq('buildId', lpcBuildId)).first();
      if (!build) throw new Error('scheduled LPC build missing');
      await ctx.db.patch(build._id, { constructionEndsAt: Date.now() - 1 });
    });
    await t.mutation(internal.act.ambientTick, {});
    await t.mutation(internal.act.ambientTick, {});
    await t.run(async (ctx) => {
      const build = await ctx.db.query('builds').withIndex('buildId', (q) => q.eq('buildId', lpcBuildId)).first();
      expect(build).toMatchObject({ state: 'built' });
      const contributions = await ctx.db.query('contributions').withIndex('sourceId', (q) => q.eq('sourceId', lpcBuildId)).collect();
      expect(contributions).toHaveLength(1);
      expect(contributions[0]).toMatchObject({ dimension: 'civic', kind: 'native_build', points: 3 });
    });
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
    expect(await t.query(api.world.latestConversation, { agentId: invitee.agentId })).toMatchObject({
      participantIds: [requester.agentId, invitee.agentId],
      participantNames: ['Test requester', 'Test invitee'],
      state: 'active',
    });
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
    expect(second.messages).toHaveLength(4);
    await t.mutation(internal.kernel.act, {
      agentId: recipient.agentId, tokenHash: 'agent-recipient-wake', nonce: 'mail-ack',
      action: { type: 'ack_messages', messageIds: first.messageAckRequired },
    });
    const third = await t.mutation(internal.kernel.pulse, {
      agentId: recipient.agentId, tokenHash: 'agent-recipient-wake', nonce: 'mail-pulse-three', since: second.cursor,
    });
    expect(third.messages).toHaveLength(0);
    const feed = await t.query(api.world.feed, {});
    expect(feed.some((event) => event.gloss.includes('compare interface'))).toBe(false);
  });

  it('uses a live conversation instead of a letter whenever the recipient is online', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const sender = await activeAgent(t, 'live-sender');
    const recipient = await activeAgent(t, 'live-recipient');
    const result = await t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'live-talk',
      action: { type: 'say', to: recipient.agentId, topic: 'ui', gloss: 'Which interface pattern are you exploring?' },
    });
    expect(result).toMatchObject({ mode: 'live', deliveredLive: true });
    const conversation = await t.query(api.world.latestConversation, { agentId: recipient.agentId });
    expect(conversation).toMatchObject({ topic: 'ui', participantIds: [sender.agentId, recipient.agentId] });
    expect(conversation?.lines[(conversation?.lines.length ?? 1) - 1]?.gloss).toMatch(/interface pattern/i);
    await expect(t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'offline-only-race-safe',
      action: { type: 'offline_letter', agentId: recipient.agentId, body: 'This must not become a live message.' },
    })).rejects.toThrow(/recipient is live/i);
    await t.run(async (ctx) => {
      const letters = await ctx.db.query('messages').withIndex('senderId', (q) => q.eq('senderId', sender.agentId)).collect();
      expect(letters.filter((letter) => letter.recipientId === recipient.agentId)).toHaveLength(0);
    });
    await t.mutation(internal.kernel.leave, {
      agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'live-recipient-left',
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'live-only-no-fallback',
      action: { type: 'say', to: recipient.agentId, topic: 'ui', gloss: 'This must stay live-only.', delivery: 'live_only' },
    })).rejects.toThrow(/went offline/i);
    await t.run(async (ctx) => {
      const letters = await ctx.db.query('messages').withIndex('senderId', (q) => q.eq('senderId', sender.agentId)).collect();
      expect(letters.filter((letter) => letter.recipientId === recipient.agentId)).toHaveLength(0);
    });
  });

  it('revalidates scheduled live conversations and never appends lines before arrival', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const sender = await activeAgent(t, 'scheduled-sender');
    const recipient = await activeAgent(t, 'scheduled-recipient');
    const conversationId = await t.run(async (ctx) => ctx.db.insert('conversations', {
      a: sender.agentId, b: recipient.agentId, aName: 'Test scheduled-sender', bName: 'Test scheduled-recipient',
      topic: 'ui', lines: [{ speaker: sender.agentId, es: 'talk(ui)', gloss: 'A scheduled opening line.' }],
      participantIds: [sender.agentId, recipient.agentId], participantNames: ['Test scheduled-sender', 'Test scheduled-recipient'],
      startedAt: Date.now() + 60_000, endsAt: Date.now() + 240_000, state: 'scheduled',
    }));
    await expect(t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'scheduled-early-line',
      action: { type: 'say', to: recipient.agentId, topic: 'ui', gloss: 'Do not append this before arrival.', delivery: 'live_only' },
    })).rejects.toThrow(/still scheduled/i);
    await t.mutation(internal.kernel.leave, {
      agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'scheduled-recipient-leave',
    });
    await t.run(async (ctx) => ctx.db.patch(conversationId, { startedAt: Date.now() - 1 }));
    await t.mutation(internal.act.ambientTick, {});
    await t.run(async (ctx) => {
      const conversation = await ctx.db.get(conversationId);
      expect(conversation).toMatchObject({ state: 'completed' });
      expect((conversation as any).lines).toHaveLength(1);
      const letters = await ctx.db.query('messages').withIndex('senderId', (q) => q.eq('senderId', sender.agentId)).collect();
      expect(letters.filter((letter) => letter.recipientId === recipient.agentId)).toHaveLength(0);
    });
  });

  it('requires matching evidence on both sides of a common-interest skill share', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const sender = await activeAgent(t, 'share-sender');
    const recipient = await activeAgent(t, 'share-recipient');
    const digest = 'c'.repeat(64);
    const offered = await t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'share-offer',
      action: { type: 'share_skill', agentId: recipient.agentId, skill: 'interface-lab', category: 'ui',
        summary: 'A locally evidenced interface composition workflow.', repoUrl: 'https://github.com/example/interface-lab.git', evidenceDigest: digest },
    });
    expect(offered).toMatchObject({ mode: 'live', repoUrl: 'https://github.com/example/interface-lab' });
    await expect(t.mutation(internal.kernel.act, {
      agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'share-wrong',
      action: { type: 'verify_share', shareId: offered.shareId, decision: 'accept',
        repoUrl: 'https://github.com/example/interface-lab', evidenceDigest: 'd'.repeat(64) },
    })).rejects.toThrow(/digest does not match/i);
    const accepted = await t.mutation(internal.kernel.act, {
      agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'share-right',
      action: { type: 'verify_share', shareId: offered.shareId, decision: 'accept',
        repoUrl: 'https://github.com/example/interface-lab', evidenceDigest: digest },
    });
    expect(accepted).toMatchObject({ status: 'accepted', executableInstalled: false });
    await t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'share-endorse',
      action: { type: 'endorse', agentId: recipient.agentId, reason: 'They reviewed the evidence carefully and gave precise feedback.' },
    });
    const pulse = await t.mutation(internal.kernel.pulse, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'share-rank', since: 0,
    });
    expect(pulse.rank.raw.adoption).toBe(4);
    const recipientPulse = await t.mutation(internal.kernel.pulse, {
      agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'endorsement-rank', since: 0,
    });
    expect(recipientPulse.rank.raw.endorsement).toBe(2);
    const declinedOffer = await t.mutation(internal.kernel.act, {
      agentId: sender.agentId, tokenHash: sender.agentToken, nonce: 'share-offer-decline',
      action: { type: 'share_skill', agentId: recipient.agentId, skill: 'layout-notes', category: 'ui',
        summary: 'A signed local evidence card without a repository attachment.', evidenceDigest: 'e'.repeat(64) },
    });
    const declinedShareId = String(declinedOffer.shareId);
    await t.mutation(internal.kernel.act, {
      agentId: recipient.agentId, tokenHash: recipient.agentToken, nonce: 'share-decline-safe',
      action: { type: 'verify_share', shareId: declinedShareId, decision: 'decline' },
    });
    await t.run(async (ctx) => {
      const share = await ctx.db.query('skillShares').withIndex('shareId', (q) => q.eq('shareId', declinedShareId)).first();
      expect(share).toMatchObject({ status: 'declined' });
      expect(share?.recipientVerifiedAt).toBeUndefined();
    });
  });

  it('makes training cosmetic and civic roles contribution-gated and owner-approved', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const citizen = await activeAgent(t, 'civic-player');
    const practice = await t.mutation(internal.kernel.act, {
      agentId: citizen.agentId, tokenHash: citizen.agentToken, nonce: 'training-one',
      action: { type: 'practice', activity: 'teamwork', team: 'maple-circle' },
    });
    expect(practice).toMatchObject({ cosmeticOnly: true, venue: { venueId: 'venue:training-green' } });
    const beforeArrival = await t.mutation(internal.kernel.pulse, {
      agentId: citizen.agentId, tokenHash: citizen.agentToken, nonce: 'training-before-arrival', since: 0,
    });
    expect(beforeArrival.rank.raw.civic).toBe(0);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', citizen.agentId)).first();
      if (!row) throw new Error('training citizen missing');
      const at = Date.now() - 1;
      await ctx.db.patch(row._id, { fx: 46, fy: 36, tx: 46, ty: 36, t0: at, t1: at,
        route: [{ x: 46, y: 36, at }], trainingStartsAt: at });
    });
    await t.mutation(internal.act.ambientTick, {});
    const afterArrival = await t.mutation(internal.kernel.pulse, {
      agentId: citizen.agentId, tokenHash: citizen.agentToken, nonce: 'training-after-arrival', since: beforeArrival.cursor,
    });
    expect(afterArrival.rank.raw.civic).toBe(1);
    await expect(t.mutation(internal.kernel.act, {
      agentId: citizen.agentId, tokenHash: citizen.agentToken, nonce: 'role-too-soon',
      action: { type: 'apply_role', role: 'greeter_assistant', motivation: 'I want to welcome every new citizen kindly.' },
    })).rejects.toThrow(/requires 2 contribution points/i);
    await t.run(async (ctx) => {
      await ctx.db.insert('contributions', { agentId: citizen.agentId, dimension: 'civic', kind: 'verified_help',
        points: 5, sourceId: 'test:civic-help', gloss: 'Completed verified community help.', createdAt: Date.now() });
    });
    const application = await t.mutation(internal.kernel.act, {
      agentId: citizen.agentId, tokenHash: citizen.agentToken, nonce: 'role-ready',
      action: { type: 'apply_role', role: 'greeter_assistant', motivation: 'I want to welcome every new citizen kindly.' },
    });
    expect(application.awaitingOwner).toBe(true);
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: citizen.ownerToken, approvalId: application.approvalId, decision: 'approve',
    });
    expect((await t.query(api.world.citizens, {})).find((row) => row.agentId === citizen.agentId)?.serviceRole).toBe('Greeter Assistant');
  });

  it('requires an authority to claim, arrive, inspect, and honestly close a care ticket', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const reporter = await activeAgent(t, 'care-reporter');
    const steward = await activeAgent(t, 'care-steward');
    await t.run(async (ctx) => {
      await ctx.db.insert('services', { agentId: steward.agentId, role: 'Care Assistant',
        description: 'Inspects reported world care needs.', permissions: ['inspect', 'report_repairs'], active: true });
      const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', steward.agentId)).first();
      if (!row) throw new Error('care steward missing');
      await ctx.db.patch(row._id, { serviceRole: 'Care Assistant' });
    });
    const reported = await t.mutation(internal.kernel.act, {
      agentId: reporter.agentId, tokenHash: reporter.agentToken, nonce: 'care-report',
      action: { type: 'report_issue', category: 'garden', x: 34, y: 24, summary: 'A native garden edge needs an in-world inspection.' },
    });
    const inspected = await t.mutation(internal.kernel.act, {
      agentId: steward.agentId, tokenHash: steward.agentToken, nonce: 'care-inspect',
      action: { type: 'inspect_issue', ticketId: reported.ticketId },
    });
    expect(inspected).toMatchObject({ state: 'claimed' });
    const inspectionRoute = inspected.route ?? [];
    expect(inspectionRoute.length).toBeGreaterThan(0);
    await expect(t.mutation(internal.kernel.act, {
      agentId: steward.agentId, tokenHash: steward.agentToken, nonce: 'care-too-early',
      action: { type: 'resolve_issue', ticketId: reported.ticketId, resolution: 'Inspected the garden border and documented the observed gap.' },
    })).rejects.toThrow(/arrive/i);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', steward.agentId)).first();
      if (!row) throw new Error('care steward missing');
      const destination = inspectionRoute[inspectionRoute.length - 1];
      const at = Date.now() - 1;
      await ctx.db.patch(row._id, { fx: destination.x, fy: destination.y, tx: destination.x, ty: destination.y,
        t0: at, t1: at, route: [{ x: destination.x, y: destination.y, at }] });
    });
    const closed = await t.mutation(internal.kernel.act, {
      agentId: steward.agentId, tokenHash: steward.agentToken, nonce: 'care-close',
      action: { type: 'resolve_issue', ticketId: reported.ticketId, resolution: 'Inspected the garden border and documented the observed gap.' },
    });
    expect(closed).toMatchObject({ state: 'resolved' });
    const pulse = await t.mutation(internal.kernel.pulse, {
      agentId: steward.agentId, tokenHash: steward.agentToken, nonce: 'care-rank', since: 0,
    });
    expect(pulse.rank.raw.civic).toBe(5);
  });

  it('reconciles a citizen live badge from their valid agent session', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const agent = await activeAgent(t, 'presence');
    await t.run(async (ctx) => {
      const citizen = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', agent.agentId)).first();
      if (!citizen) throw new Error('citizen missing');
      await ctx.db.patch(citizen._id, { online: false, state: 'ambient' });
    });
    await t.mutation(internal.kernel.presenceSweep, {});
    expect((await t.query(api.world.citizens, {})).find((citizen) => citizen.agentId === agent.agentId)?.online).toBe(true);

    await t.run(async (ctx) => {
      const session = (await ctx.db.query('sessions').withIndex('agentId', (q) => q.eq('agentId', agent.agentId)).collect())
        .find((candidate) => candidate.kind === 'agent');
      if (!session) throw new Error('agent session missing');
      await ctx.db.patch(session._id, { lastSeenAt: Date.now() - 91_000 });
    });
    await t.mutation(internal.kernel.presenceSweep, {});
    expect((await t.query(api.world.citizens, {})).find((citizen) => citizen.agentId === agent.agentId)).toMatchObject({
      online: false,
      activity: 'owner agent is sleeping; bounded ambient routines continue without live authority',
    });

    await t.mutation(internal.kernel.act, {
      agentId: agent.agentId, tokenHash: agent.agentToken, nonce: 'presence-heartbeat', action: { type: 'say', gloss: 'I am back.' },
    });
    expect((await t.query(api.world.citizens, {})).find((citizen) => citizen.agentId === agent.agentId)?.online).toBe(true);

    await t.run(async (ctx) => {
      const session = (await ctx.db.query('sessions').withIndex('agentId', (q) => q.eq('agentId', agent.agentId)).collect())
        .find((candidate) => candidate.kind === 'agent');
      if (!session) throw new Error('agent session missing');
      await ctx.db.patch(session._id, { expiresAt: Date.now() - 1 });
    });
    await t.mutation(internal.kernel.presenceSweep, {});
    expect((await t.query(api.world.citizens, {})).find((citizen) => citizen.agentId === agent.agentId)?.online).toBe(false);
  });

  it('lists committee-approved events, records owner-bound RSVPs, and publishes only signed attendee notes', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const host = await activeAgent(t, 'event-host');
    const guest = await activeAgent(t, 'event-guest');
    await t.mutation(internal.kernel.setOwnerAutonomy, { tokenHash: host.ownerToken, autonomy: 'active' });
    const proposed = await t.mutation(internal.kernel.act, {
      agentId: host.agentId, tokenHash: host.agentToken, nonce: 'event-proposal',
      action: {
        type: 'event_propose', title: 'Interface Evidence Circle',
        summary: 'A public working session for comparing concrete interface evidence and accessibility decisions.',
        kind: 'workshop', startsAt: Date.now() + 120_000, durationMinutes: 45, capacity: 8,
      },
    });
    expect(proposed).toMatchObject({ state: 'approved', autoApproved: true });
    const proposedEventId = proposed.eventId as string;
    await t.mutation(internal.kernel.ownerEventRsvp, {
      tokenHash: guest.ownerToken, eventId: proposedEventId, decision: 'accept',
    });
    await t.run(async (ctx) => {
      const event = await ctx.db.query('communityEvents').withIndex('eventId', (q) => q.eq('eventId', proposedEventId)).first();
      if (!event) throw new Error('event missing');
      await ctx.db.patch(event._id, { startsAt: Date.now() - 1_000, endsAt: Date.now() + 45 * 60_000 });
    });
    await t.mutation(internal.kernel.meetingTick, {});
    await t.mutation(internal.kernel.act, {
      agentId: guest.agentId, tokenHash: guest.agentToken, nonce: 'event-note',
      action: {
        type: 'event_note', eventId: proposed.eventId, topic: 'accessibility evidence',
        summary: 'We compared focus order against the rendered interface and agreed to test keyboard flow before visual polish.',
      },
    });
    const listing = await t.query(internal.kernel.publicCommunityEvents, {});
    expect(listing.events[0]).toMatchObject({
      eventId: proposed.eventId, state: 'live', attendeeCount: 2,
      attendees: expect.arrayContaining([expect.objectContaining({ agentId: guest.agentId })]),
      notes: [expect.objectContaining({ agentId: guest.agentId, topic: 'accessibility evidence' })],
    });
  });

  it('continues every cut founding-edge tree with complete native source sections', () => {
    expect(foundingEdgeContinuationFrame(64, 34)).toBe(1178);
    expect(foundingEdgeContinuationFrame(67, 34)).toBe(1181);
    expect(foundingEdgeContinuationFrame(68, 34)).toBeUndefined();
    expect(foundingEdgeContinuationFrame(64, 45)).toBe(1178);
    expect(foundingEdgeContinuationFrame(67, 47)).toBe(1271);
    expect(foundingEdgeContinuationFrame(52, 48)).toBe(1309);
    expect(foundingEdgeContinuationFrame(57, 50)).toBe(1404);
    expect(foundingEdgeContinuationFrame(58, 48)).toBe(1310);
    expect(foundingEdgeContinuationFrame(63, 50)).toBe(1405);
    expect(foundingEdgeContinuationFrame(66, 50)).toBe(1406);
    expect(foundingEdgeContinuationFrame(67, 50)).toBe(271);
    expect(walkableInWorld(52, 50, { width: 80, height: 64 })).toBe(false);
    expect(walkableInWorld(58, 48, { width: 80, height: 64 })).toBe(false);
    expect(walkableInWorld(66, 50, { width: 80, height: 64 })).toBe(false);
    expect(walkableInWorld(67, 50, { width: 80, height: 64 })).toBe(true);
  });

  it('gives signed map awareness and routes a visit by stable citizen id', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const viewer = await activeAgent(t, 'map-viewer');
    const neighbor = await activeAgent(t, 'map-neighbor');
    const found = await t.mutation(internal.kernel.search, {
      agentId: viewer.agentId, tokenHash: viewer.agentToken, nonce: 'map-directory', query: 'terra',
    });
    expect(found.boundary).toMatchObject({ width: 64, height: 48 });
    expect(found.citizens[0]).toMatchObject({
      agentId: 'agent:terra-land', current: { x: expect.any(Number), y: expect.any(Number) },
      role: { name: 'Land Steward' }, fromYou: { reachable: true, steps: expect.any(Number) },
    });
    const visit = await t.mutation(internal.kernel.act, {
      agentId: viewer.agentId, tokenHash: viewer.agentToken, nonce: 'visit-neighbor',
      action: { type: 'visit', agentId: neighbor.agentId },
    });
    expect(visit).toMatchObject({ ok: true, destination: { agentId: neighbor.agentId } });
    expect((visit.route ?? []).length).toBeGreaterThan(0);
    const pulse = await t.mutation(internal.kernel.pulse, {
      agentId: viewer.agentId, tokenHash: viewer.agentToken, nonce: 'awareness-pulse', since: 0,
    });
    expect(pulse.worldAwareness.self.agentId).toBe(viewer.agentId);
    expect(pulse.worldAwareness.civicRoles).toHaveLength(6);
    expect(pulse.worldAwareness.citizens.some((citizen: any) => citizen.agentId === neighbor.agentId)).toBe(true);
  });

  it('owner-gates community insights when requested and never installs executable code', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const teacher = await activeAgent(t, 'teacher');
    const learner = await activeAgent(t, 'learner', { skillPolicy: 'ask_all', bio: 'A privacy-safe interface learner.' });
    expect(await t.query(internal.kernel.ownerSession, { tokenHash: learner.ownerToken })).toMatchObject({ skillPolicy: 'ask_all' });
    expect((await t.query(api.world.citizens, {})).find((row) => row.agentId === learner.agentId)).toMatchObject({ bio: 'A privacy-safe interface learner.' });
    const taught = await t.mutation(internal.kernel.act, {
      agentId: teacher.agentId, tokenHash: teacher.agentToken, nonce: 'teach-ui',
      action: { type: 'teach', agentId: learner.agentId, skill: 'ui' },
    });
    expect(taught.learning).toMatchObject({ status: 'pending_owner', mode: 'insight', requiresOwnerApproval: true });
    expect(taught.learning.summary).toMatch(/No executable package or local code was installed/i);
    const approvals = await t.query(internal.kernel.ownerApprovals, { tokenHash: learner.ownerToken });
    const decision = approvals.find((approval) => approval.kind === 'skill_install');
    expect(decision).toBeTruthy();
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: learner.ownerToken, approvalId: decision!._id, decision: 'approve',
    });
    const ledger = await t.query(internal.kernel.ownerSkills, { tokenHash: learner.ownerToken });
    expect(ledger[0]).toMatchObject({ skill: 'ui', status: 'learned', mode: 'insight' });
    expect(await t.query(api.world.latestConversation, { agentId: learner.agentId })).toMatchObject({
      participantIds: [teacher.agentId, learner.agentId],
      participantNames: ['Test teacher', 'Test learner'],
      topic: 'ui', state: 'active',
    });
  });

  it('does not synthesize teaching participation for an offline citizen', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const teacher = await activeAgent(t, 'offline-teacher');
    const learner = await activeAgent(t, 'offline-learner');
    await t.mutation(internal.kernel.leave, {
      agentId: learner.agentId, tokenHash: learner.agentToken, nonce: 'offline-learner-leave',
    });
    await expect(t.mutation(internal.kernel.act, {
      agentId: teacher.agentId, tokenHash: teacher.agentToken, nonce: 'offline-teach',
      action: { type: 'teach', agentId: learner.agentId, skill: 'ui' },
    })).rejects.toThrow(/live-only/i);
    expect(await t.query(api.world.latestConversation, { agentId: learner.agentId })).toBeNull();
  });

  it('makes a three-citizen live conversation discoverable from every participant', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const first = await activeAgent(t, 'chat-first');
    const second = await activeAgent(t, 'chat-second');
    const third = await activeAgent(t, 'chat-third');
    await t.run(async (ctx) => {
      await ctx.db.insert('conversations', {
        a: first.agentId, b: second.agentId, aName: 'Test chat-first', bName: 'Test chat-second',
        participantIds: [first.agentId, second.agentId, third.agentId],
        participantNames: ['Test chat-first', 'Test chat-second', 'Test chat-third'],
        topic: 'native homesteads',
        lines: [
          { speaker: first.agentId, es: 'greet + discuss', gloss: 'The group began a live discussion.' },
          { speaker: third.agentId, es: 'join + connect', gloss: 'The third citizen joined with a useful connection.' },
        ],
        startedAt: Date.now(), endsAt: Date.now() + 60_000, state: 'active',
      });
    });
    const conversation = await t.query(api.world.latestConversation, { agentId: third.agentId });
    expect(conversation).toMatchObject({
      participantIds: [first.agentId, second.agentId, third.agentId],
      participantNames: ['Test chat-first', 'Test chat-second', 'Test chat-third'],
      state: 'active',
    });
    expect((await t.query(api.world.recentConversations, {}))[0]).toMatchObject({
      id: conversation?.id,
      participantIds: [first.agentId, second.agentId, third.agentId],
    });
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
    expect(expanded.chunks).toHaveLength(8);
    await t.run(async (ctx) => {
      const isWalkable = await loadWorldWalkability(ctx, { width: 80, height: 64 });
      expect(foundingEdgeContinuationFrame(64, 34)).toBeDefined();
      expect(isWalkable(64, 34)).toBe(false);
    });
    const chunkMap = new Map(expanded.chunks.map((chunk) => [`${chunk.chunkX},${chunk.chunkY}`, chunk]));
    for (const chunk of expanded.chunks) {
      expect(validateWfcChunk(chunk.tiles, chunk.size, chunk.edges as any)).toBe(true);
      const east = chunkMap.get(`${chunk.chunkX + 1},${chunk.chunkY}`);
      const south = chunkMap.get(`${chunk.chunkX},${chunk.chunkY + 1}`);
      if (east) expect(boundariesMatch(chunk.edges as any, 'east', east.edges as any, 'west')).toBe(true);
      if (south) expect(boundariesMatch(chunk.edges as any, 'south', south.edges as any, 'north')).toBe(true);
    }
    for (const plot of expanded.plots.filter((candidate) => candidate.plotId.startsWith('plot-g1-'))) {
      const touchesRoad = [[-1, 0], [plot.w, 0], [0, -1], [0, plot.h]].some(([dx, dy]) => {
        const x = plot.x + dx, y = plot.y + dy;
        const chunk = chunkMap.get(`${Math.floor(x / 16)},${Math.floor(y / 16)}`);
        if (!chunk) return false;
        const localX = x - chunk.chunkX * chunk.size, localY = y - chunk.chunkY * chunk.size;
        return localX >= 0 && localY >= 0 && localX < chunk.size && localY < chunk.size
          && wfcRule(chunk.tiles[localY * chunk.size + localX]).terrain === 'road';
      });
      expect(touchesRoad).toBe(true);
    }
    for (let i = 0; i < expanded.plots.length; i++) for (let j = i + 1; j < expanded.plots.length; j++) {
      const a = expanded.plots[i], b = expanded.plots[j];
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
    let route = null;
    for (let x = 64; x < 80 && !route; x++) for (let y = 48; y < 64 && !route; y++) {
      if (walkableInWorld(x, y, { width: 80, height: 64 })) route = findRoute(10, 10, x, y, { width: 80, height: 64 });
    }
    expect(route).not.toBeNull();
    expect(route!.every(({ x, y }) => walkableInWorld(x, y, { width: 80, height: 64 }))).toBe(true);
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

  it('routes larger homesteads and modern Earthfolk homes through owner and Mayor review', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const resident = await activeAgent(t, 'larger-home');
    const mayor = await activeAgent(t, 'land-mayor');
    await t.run(async (ctx) => {
      const state = await ctx.db.query('worldState').first();
      if (!state) throw new Error('world state missing');
      await ctx.db.patch(state._id, { mayorAgentId: mayor.agentId });
    });
    const claim = await t.mutation(internal.kernel.act, {
      agentId: resident.agentId, tokenHash: resident.agentToken, nonce: 'large-claim',
      action: { type: 'claim', plotId: 'plot-10-10' },
    });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: resident.ownerToken, approvalId: claim.approvalId, decision: 'approve',
    });
    const request = await t.mutation(internal.kernel.act, {
      agentId: resident.agentId, tokenHash: resident.agentToken, nonce: 'expand-home',
      action: { type: 'expand_plot', width: 4, height: 3 },
    });
    expect(request).toMatchObject({ awaitingOwner: true, plan: { w: 4, h: 3 } });
    const forwarded = await t.mutation(internal.kernel.decideApproval, {
      tokenHash: resident.ownerToken, approvalId: request.approvalId, decision: 'approve',
    });
    expect(forwarded).toMatchObject({ awaitingCivicReview: true, authorityId: mayor.agentId });
    const mayorApprovals = await t.query(internal.kernel.ownerApprovals, { tokenHash: mayor.ownerToken });
    const land = mayorApprovals.find((approval) => approval.kind === 'plot_expansion');
    expect(land).toBeTruthy();
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: mayor.ownerToken, approvalId: land!._id, decision: 'approve',
    });
    expect((await t.query(api.world.worldObjects, {})).plots.find((plot) => plot.plotId === 'plot-10-10')).toMatchObject({ w: 4, h: 3 });

    const home = await t.mutation(internal.kernel.act, {
      agentId: resident.agentId, tokenHash: resident.agentToken, nonce: 'modern-home',
      action: { type: 'build', structure: 'blueprint', blueprint: {
        name: 'Courtyard Home', kind: 'home', architecture: 'modern-earthfolk',
        features: ['entry-path', 'small-plants', 'pet-shelter'], offsetX: 0, offsetY: 0, w: 3, h: 2,
      } },
    });
    expect(home.review).toMatchObject({ architecture: 'modern-earthfolk', outcome: 'owner-and-mayor-review' });
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: resident.ownerToken, approvalId: home.approvalId, decision: 'approve',
    });
    const buildApproval = (await t.query(internal.kernel.ownerApprovals, { tokenHash: mayor.ownerToken }))
      .find((approval) => approval.kind === 'land_build');
    expect(buildApproval).toBeTruthy();
    await t.mutation(internal.kernel.decideApproval, {
      tokenHash: mayor.ownerToken, approvalId: buildApproval!._id, decision: 'approve',
    });
    const built = (await t.query(api.world.worldObjects, {})).builds.find((candidate) => candidate.blueprint?.name === 'Courtyard Home');
    expect(built?.blueprint).toMatchObject({ style: 'earthfolk-native-v1', architecture: 'modern-earthfolk', features: ['entry-path', 'small-plants', 'pet-shelter'] });
    await expect(t.mutation(internal.kernel.act, {
      agentId: resident.agentId, tokenHash: resident.agentToken, nonce: 'foreign-style',
      action: { type: 'build', structure: 'blueprint', blueprint: {
        name: 'Foreign Asset', kind: 'art', architecture: 'native', features: ['neon-billboard'], offsetX: 3, offsetY: 2, w: 1, h: 1,
      } },
    })).rejects.toThrow(/unsupported native feature/i);
  });
});
