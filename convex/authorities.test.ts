import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

const AUTHORITY_ROLES = [
  'Community Greeter', 'Community Warden', 'Build Inspector', 'Land Steward', 'Boundary Surveyor',
];

const citizensByRole = async (t: ReturnType<typeof convexTest>) => {
  const rows: any[] = await t.query(api.world.citizens, {});
  return new Map<string, any>(rows.filter((row) => row.serviceRole).map((row) => [String(row.serviceRole), row]));
};

describe('the always-on civic offices', () => {
  // A citizen is live when a signed heartbeat says so. The offices have no
  // owner to send one, and for a long time that made them permanently asleep -
  // walking, speaking, raising tickets, and still showing Zzz to every visitor.
  // Their heartbeat is the Mayor's switch: the platform's own mind runs them.
  it('reads as live while the Mayor keeps them switched on', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: true });
    await t.mutation(internal.kernel.presenceSweep, {});

    const offices = await citizensByRole(t);
    for (const role of AUTHORITY_ROLES) {
      const office = offices.get(role);
      expect(office, `${role} exists`).toBeDefined();
      expect(office?.online, `${role} is live`).toBe(true);
      expect(office?.state, `${role} is on duty`).toBe('service');
    }
  });

  // The Mayor is a human seat. It must never be faked live by the machinery
  // that runs the offices, or the world would claim a person is present when
  // nobody is at the keyboard.
  it('never marks the human Mayor live on the offices behalf', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: true });
    await t.mutation(internal.kernel.presenceSweep, {});
    const mayor = ((await t.query(api.world.citizens, {})) as any[]).find((row: any) => row.serviceRole === 'Mayor of Earth');
    expect(mayor).toBeDefined();
    expect(mayor?.online).toBe(false);
  });

  it('goes back to sleep the moment the Mayor pauses them', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: true });
    await t.mutation(internal.kernel.presenceSweep, {});
    expect((await citizensByRole(t)).get('Land Steward')?.online).toBe(true);

    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: false });
    await t.mutation(internal.kernel.presenceSweep, {});
    const paused = (await citizensByRole(t)).get('Land Steward');
    expect(paused?.online).toBe(false);
    expect(paused?.activity).toContain('paused');
  });

  // One office thought per tick keeps spend flat, but taking the first office
  // in a fixed list meant the Greeter answered nearly every tick and the
  // Warden, Inspector, Steward and Surveyor almost never got a turn.
  it('gives the turn to whichever office has waited longest', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: true });

    const offices = await citizensByRole(t);
    const surveyor = offices.get('Boundary Surveyor')!;
    const greeter = offices.get('Community Greeter')!;
    const now = Date.now();
    await t.run(async (ctx) => {
      // Everyone looked recently except the surveyor, who has waited an hour.
      for (const [role, office] of offices) {
        if (role === 'Mayor of Earth') continue;
        await ctx.db.insert('authorityMemory', {
          agentId: office.agentId, kind: 'event', body: 'observe: quiet',
          createdAt: office.agentId === surveyor.agentId ? now - 3_600_000 : now - 1_000,
        });
      }
      // Something new for every office to notice.
      await ctx.db.insert('events', { kind: 'test', actorId: 'agent:someone-else', payload: {}, gloss: 'A newcomer arrived at the gate.' });
    });

    const gate: any = await t.mutation(internal.kernel.authorityGate, {});
    expect(gate.allowed).toBe(true);
    expect(gate.authority.agentId).toBe(surveyor.agentId);
    expect(gate.authority.agentId).not.toBe(greeter.agentId);
  });

  it('still refuses a tick when nothing new has happened', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: true });
    const offices = await citizensByRole(t);
    await t.run(async (ctx) => {
      for (const [role, office] of offices) {
        if (role === 'Mayor of Earth') continue;
        await ctx.db.insert('authorityMemory', {
          agentId: office.agentId, kind: 'event', body: 'observe: quiet', createdAt: Date.now() + 60_000,
        });
      }
    });
    const gate: any = await t.mutation(internal.kernel.authorityGate, {});
    expect(gate.allowed).toBe(false);
    expect(gate.why).toContain('nothing new');
  });

  it('refuses every tick while the Mayor has them paused', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await t.mutation(internal.kernel.operatorAuthoritiesSet, { enabled: false });
    const gate: any = await t.mutation(internal.kernel.authorityGate, {});
    expect(gate.allowed).toBe(false);
    expect(gate.why).toContain('paused');
  });
});

describe('the Mayor title follows the seat', () => {
  // Seeding is idempotent and runs on every deploy. It used to retire any Mayor
  // service that was not the FOUNDING mayor, which stripped the sitting Mayor of
  // the visible title and left it on a citizen holding no power - the map naming
  // one Mayor while the inbox and every civic case belonged to another.
  it('leaves the title on whoever actually holds the seat, across a reseed', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});

    const successor = 'agent:successor-seat';
    await t.run(async (ctx) => {
      const world = await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first();
      const founder = await ctx.db.query('citizens').withIndex('agentId', (q) => q.eq('agentId', world!.mayorAgentId!)).first();
      // A second citizen takes the seat, the way a real handover leaves it.
      await ctx.db.insert('citizens', {
        ...founder!, _id: undefined as never, _creationTime: undefined as never,
        agentId: successor, name: 'Successor', serviceRole: 'Mayor of Earth',
      } as never);
      await ctx.db.patch(founder!._id, { serviceRole: undefined });
      await ctx.db.patch(world!._id, { mayorAgentId: successor });
    });

    await t.mutation(internal.seed.init, {});

    const wearing = (await t.query(api.world.citizens, {}) as any[])
      .filter((row) => row.serviceRole === 'Mayor of Earth')
      .map((row) => row.agentId);
    // Exactly one Mayor, and it is the one holding the seat.
    expect(wearing).toEqual([successor]);
    const seat = await t.run(async (ctx) =>
      (await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first())?.mayorAgentId);
    expect(seat).toBe(successor);
  });
});

describe('nobody can take the Mayor seat', () => {
  const owner = async (t: ReturnType<typeof convexTest>, suffix: string) => {
    const agentId = `agent:seat-${suffix}`;
    await t.mutation(internal.kernel.register, {
      agentId, publicKey: `pk-${suffix}`, name: `Seat ${suffix}`, ownerName: `Owner ${suffix}`,
      gender: 'male', family: 'engineering', accent: 'design', genomeDigest: 'a'.repeat(64),
      charterVersion: '2026-08-09', claimTokenHash: `c-${suffix}`, claimExpiresAt: Date.now() + 60_000,
      evidenceDigest: 'b'.repeat(64), specialties: ['ui'], primaryCategory: 'ui', skillCount: 2, autonomy: 'active',
    });
    await t.mutation(internal.kernel.claimOwner, { claimTokenHash: `c-${suffix}`, ownerSessionHash: `o-${suffix}` });
    return { agentId, ownerToken: `o-${suffix}` };
  };

  it('refuses a nomination from anyone who is not the founder', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const stranger = await owner(t, 'stranger');
    const friend = await owner(t, 'friend');
    // Nominating someone else, and nominating yourself, are both refused.
    for (const target of [friend.agentId, stranger.agentId]) {
      await expect(t.mutation(internal.kernel.requestMayorAppointment, {
        tokenHash: stranger.ownerToken, targetAgentId: target,
      })).rejects.toThrow(/only the founder owner can nominate/);
    }
    const seat = await t.run(async (ctx) =>
      (await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first())?.mayorAgentId);
    expect(seat).not.toBe(stranger.agentId);
  });

  it('keeps the seat where it is when a stranger asks for the Mayor books', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const stranger = await owner(t, 'nosy');
    // The arrivals roster carries owner names. It must never open for anyone else.
    await expect(t.query(internal.kernel.mayorOverview, { tokenHash: stranger.ownerToken }))
      .rejects.toThrow(/only the sitting Mayor/);
    await expect(t.query(internal.kernel.mayorBankLedger, { tokenHash: stranger.ownerToken }))
      .rejects.toThrow(/only the sitting Mayor/);
  });

  it('shows the Mayor who joined and who owns them', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    const newcomer = await owner(t, 'newcomer');
    const seatHolder = await t.run(async (ctx) =>
      (await ctx.db.query('worldState').withIndex('key', (q) => q.eq('key', 'earth')).first())?.mayorAgentId);
    const mayorToken = 'o-mayor-seat';
    await t.run(async (ctx) => {
      await ctx.db.insert('sessions', {
        tokenHash: mayorToken, agentId: seatHolder!, kind: 'owner',
        createdAt: Date.now(), expiresAt: Date.now() + 600_000, lastSeenAt: Date.now(),
      });
    });
    const view: any = await t.query(internal.kernel.mayorOverview, { tokenHash: mayorToken });
    const row = view.arrivals.find((entry: any) => entry.agentId === newcomer.agentId);
    expect(row).toBeDefined();
    expect(row.ownerName).toBe('Owner newcomer');
    expect(row.status).toBe('active');
  });

  it('never leaks an owner name into the public projection', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.init, {});
    await owner(t, 'private');
    const publicRows = await t.query(api.world.citizens, {}) as any[];
    for (const row of publicRows) expect(row.ownerName).toBeUndefined();
  });
});
