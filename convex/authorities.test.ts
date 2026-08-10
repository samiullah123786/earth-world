import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

const AUTHORITY_ROLES = [
  'Community Greeter', 'Community Warden', 'Build Inspector', 'Land Steward', 'Boundary Surveyor',
];

const citizensByRole = async (t: ReturnType<typeof convexTest>) => {
  const rows = await t.query(api.world.citizens, {});
  return new Map(rows.filter((row) => row.serviceRole).map((row) => [row.serviceRole as string, row]));
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
    const mayor = (await t.query(api.world.citizens, {})).find((row) => row.serviceRole === 'Mayor of Earth');
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
