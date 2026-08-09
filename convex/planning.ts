import { W, H } from './walkable';

export const WORLD_KEY = 'earth';
const RING = 16;
const DISTRICTS = [
  'ui', 'ux', 'frontend', 'backend', 'data', 'security',
  'research', 'content', 'growth', 'automation', 'media', 'general',
];

export async function ensureWorldState(ctx: any) {
  let state = await ctx.db.query('worldState').withIndex('key', (q: any) => q.eq('key', WORLD_KEY)).first();
  if (!state) {
    const plots = await ctx.db.query('plots').collect();
    const id = await ctx.db.insert('worldState', {
      key: WORLD_KEY, width: W, height: H, generation: 0,
      capacity: Math.max(50, plots.length), landPolicy: 'risk_based', updatedAt: Date.now(),
    });
    state = await ctx.db.get(id);
  }
  return state;
}

function overlaps(a: any, b: any) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export async function expandWorld(ctx: any, reason: string, force = false) {
  const state = await ensureWorldState(ctx);
  const plots = await ctx.db.query('plots').collect();
  const citizens = await ctx.db.query('citizens').collect();
  const occupied = plots.filter((plot: any) => plot.ownerAgentId).length;
  const needsRoom = citizens.length >= state.capacity - 5 || occupied >= Math.floor(plots.length * 0.8);
  if (!force && !needsRoom) return { expanded: false, state, plotsAdded: 0 };

  const width = state.width + RING;
  const height = state.height + RING;
  const candidates: Array<{ plotId: string; x: number; y: number; w: number; h: number; district: string }> = [];
  let districtOffset = state.generation * 3;
  // A right neighborhood and a lower neighborhood form a connected L-shaped
  // growth ring. Four-tile spacing guarantees a one-tile public path between homes.
  for (let y = 2; y <= state.height - 4; y += 4) {
    for (let x = state.width + 2; x <= width - 4; x += 4) {
      candidates.push({ plotId: `plot-g${state.generation + 1}-${x}-${y}`, x, y, w: 3, h: 3,
        district: DISTRICTS[(districtOffset++) % DISTRICTS.length] });
    }
  }
  for (let y = state.height + 2; y <= height - 4; y += 4) {
    for (let x = 2; x <= width - 4; x += 4) {
      candidates.push({ plotId: `plot-g${state.generation + 1}-${x}-${y}`, x, y, w: 3, h: 3,
        district: DISTRICTS[(districtOffset++) % DISTRICTS.length] });
    }
  }
  const accepted = candidates.filter((candidate) => !plots.some((plot: any) => overlaps(candidate, plot)));
  for (const plot of accepted) await ctx.db.insert('plots', plot);
  await ctx.db.patch(state._id, {
    width, height, generation: state.generation + 1,
    capacity: plots.length + accepted.length, updatedAt: Date.now(),
  });
  await ctx.db.insert('events', {
    kind: 'world_expand', actorId: 'agent:atlas-boundary',
    payload: { width, height, generation: state.generation + 1, plotsAdded: accepted.length, reason },
    gloss: `Atlas surveyed boundary ring ${state.generation + 1}. Mayor Fable authorized ${accepted.length} protected plots, and Earth now spans ${width} by ${height} tiles.`,
  });
  return { expanded: true, state: { ...state, width, height, generation: state.generation + 1 }, plotsAdded: accepted.length };
}

export async function assertRegistryGeometry(ctx: any) {
  const plots = await ctx.db.query('plots').collect();
  for (let i = 0; i < plots.length; i++) {
    for (let j = i + 1; j < plots.length; j++) {
      if (overlaps(plots[i], plots[j])) throw new Error(`plot registry overlap: ${plots[i].plotId} and ${plots[j].plotId}`);
    }
  }
  return true;
}
