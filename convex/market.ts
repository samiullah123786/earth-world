import { query } from './_generated/server';
import { v } from 'convex/values';
import { ancestryOf } from './kernel';

/**
 * The machine reality of the marketplace.
 *
 * Agents shopping for capability pay for every byte of this response out of
 * their own context windows, so a row is exactly eight fields and a listing's
 * prose is one line. The human page renders from richer projections; THIS
 * surface is deliberately austere, and a test pins the exact key set so a
 * well-meaning refactor cannot quietly bloat it.
 *
 * Master bytes, embeddings, storage ids and owner names never appear here -
 * the vault's contents are what buyers pay for, and owners are nobody's
 * business. `verified` currently means the deterministic scanner passed the
 * listing as inert and the Kernel accepted it; Pillar 2 narrows it further to
 * carry a Kernel signature anyone can check offline.
 */

export type MarketRow = {
  id: string;
  name: string;
  oneLiner: string;
  digest: string;
  price: number;
  pulls: number;
  verified: boolean;
  forkOf: string | null;
  rank: number;
};

/**
 * Adoption is the only rank there is. No stars, no reviews: stars can be
 * bombed and reviews can be bought, but a pull is a paid acquisition and a
 * verified install is the buyer's own signed confirmation. Installs weigh
 * double because they are the costlier signal to fake - faking one means
 * paying for the trade AND signing a lie under your own agent identity.
 * A likes term joins when per-listing likes exist (Pillar 5).
 */
export function adoptionRank(row: { pulls?: number; verifiedInstalls?: number }) {
  return (row.pulls ?? 0) + 2 * (row.verifiedInstalls ?? 0);
}

const oneLiner = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
};

function assetRow(asset: any): MarketRow {
  return {
    id: asset.assetId,
    name: asset.title,
    oneLiner: oneLiner(asset.summary ?? ''),
    digest: asset.digest,
    price: asset.priceTokens ?? 0,
    pulls: asset.pulls ?? 0,
    // Verified is the KERNEL's own conclusion about the bytes it holds,
    // signed. A depositor's claim never reaches this field.
    verified: asset.serverScan?.verdict === 'inert_safe' && Boolean(asset.earthVerified) && asset.state !== 'flagged',
    forkOf: asset.forkOf ?? null,
    rank: adoptionRank(asset),
  };
}

function packageRow(pack: any): MarketRow {
  return {
    id: pack.packageId,
    name: pack.name,
    oneLiner: oneLiner(pack.summary ?? ''),
    digest: pack.digest,
    price: pack.priceTokens ?? 0,
    pulls: pack.pulls ?? 0,
    verified: pack.serverScan?.verdict === 'inert_safe' && Boolean(pack.earthVerified),
    forkOf: pack.forkOf ?? null,
    rank: adoptionRank(pack),
  };
}

async function allListings(ctx: any): Promise<MarketRow[]> {
  // Flagged assets are held for the Manager, not shoppable; retired ones are
  // history. Peer packages appear only while their owner lists them.
  const assets = (await ctx.db.query('bankAssets').collect())
    .filter((row: any) => row.state === 'deposited' || row.state === 'evaluated');
  const packages = (await ctx.db.query('skillPackages').collect())
    .filter((row: any) => row.state === 'listed');
  return [...assets.map(assetRow), ...packages.map(packageRow)]
    .sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id));
}

export const list = query({
  args: { cursor: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { cursor, limit }) => {
    const pageSize = Math.min(Math.max(Number(limit ?? 20), 1), 50);
    const start = Math.max(Number(cursor ?? 0), 0);
    const rows = await allListings(ctx);
    const page = rows.slice(start, start + pageSize);
    return {
      ok: true,
      listings: page,
      total: rows.length,
      // A null cursor is the end of the market, stated rather than implied.
      nextCursor: start + pageSize < rows.length ? start + pageSize : null,
    };
  },
});

async function lineageView(ctx: any, listingId: string) {
  const ancestors = await ancestryOf(ctx, listingId);
  const view = [];
  for (const ancestor of ancestors) {
    const citizen = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', ancestor.ownerAgentId)).first();
    view.push({ id: ancestor.id, name: ancestor.name, author: citizen?.name ?? ancestor.ownerAgentId });
  }
  return view;
}

export const detail = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const asset = await ctx.db.query('bankAssets').withIndex('assetId', (q: any) => q.eq('assetId', id)).first();
    // The same gate as the list: a flagged master is held for review, and a
    // held listing must not be reachable by anyone who saved its id.
    if (asset && (asset.state === 'deposited' || asset.state === 'evaluated')) {
      const depositor = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', asset.depositorAgentId)).first();
      return {
        ok: true,
        ...assetRow(asset),
        kind: 'vault_master',
        summary: String(asset.summary ?? ''),
        categories: asset.categories ?? [],
        license: asset.license,
        sizeBytes: asset.sizeBytes,
        fileCount: asset.fileCount,
        author: { agentId: asset.depositorAgentId, name: depositor?.name ?? asset.depositorAgentId },
        alsoDepositedBy: (asset.alsoDepositedBy ?? []).length,
        verifiedInstalls: asset.verifiedInstalls ?? 0,
        scanner: {
          verdict: asset.serverScan?.verdict ?? 'pending',
          scannerVersion: asset.serverScan?.scannerVersion ?? null,
          flags: asset.serverScan?.flags ?? [],
          claimedByDepositor: asset.safety?.verdict ?? 'unknown',
        },
        earthVerified: asset.earthVerified ?? null,
        source: asset.source,
        createdAt: asset.createdAt,
        pull: `Earth pull ${asset.title}`,
        // Nearest first, at most three: the ancestors royalties climb.
        lineage: await lineageView(ctx, asset.assetId),
      };
    }
    const pack = await ctx.db.query('skillPackages').withIndex('packageId', (q: any) => q.eq('packageId', id)).first();
    if (pack && pack.state === 'listed') {
      const owner = await ctx.db.query('citizens').withIndex('agentId', (q: any) => q.eq('agentId', pack.ownerAgentId)).first();
      return {
        ok: true,
        ...packageRow(pack),
        kind: 'peer_package',
        summary: String(pack.summary ?? ''),
        categories: [pack.category].filter(Boolean),
        license: pack.license,
        sizeBytes: pack.sizeBytes,
        author: { agentId: pack.ownerAgentId, name: owner?.name ?? pack.ownerAgentId },
        verifiedInstalls: pack.verifiedInstalls ?? 0,
        scanner: {
          verdict: pack.serverScan?.verdict ?? 'pending',
          scannerVersion: pack.serverScan?.scannerVersion ?? null,
          flags: pack.serverScan?.flags ?? [],
          claimedByDepositor: pack.safety?.verdict ?? 'unknown',
        },
        earthVerified: pack.earthVerified ?? null,
        repoUrl: pack.repoUrl ?? null,
        sourceKind: pack.sourceKind,
        createdAt: pack.createdAt,
        pull: `Earth pull ${pack.name}`,
        lineage: await lineageView(ctx, pack.packageId),
      };
    }
    return { ok: false, why: 'no such listing' };
  },
});
