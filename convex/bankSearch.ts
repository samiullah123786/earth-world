/**
 * Semantic search across the Earth Bank's structured SKILL.md registry.
 *
 * The Bank Manager uses this to find related skills during evaluation.
 * The public `/v1/skill/search` endpoint uses it to let citizens browse
 * the vault semantically instead of by keyword. Both paths go through
 * the same vector index so results are consistent.
 *
 * Manifests only: markdownBody, embedding, and storageIds never cross
 * this boundary. The master copy stays in the vault.
 */

import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { generateEmbeddingVector } from './embeddings';

/**
 * Public semantic search — available to joined citizens via the API.
 * Returns skill manifests ranked by vector similarity.
 */
export const search = action({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  // The return type is annotated because this handler calls a query that lives
  // in this same module, and TypeScript cannot infer a type that references
  // itself through the generated api. Convex asks for the annotation here.
  handler: async (ctx, { query, category, limit }): Promise<any[]> => {
    const maxResults = Math.min(limit ?? 16, 32);
    const embedding = await generateEmbeddingVector(query);

    const filter = category
      ? (q: any) => q.eq('category', category).eq('state', 'evaluated')
      : (q: any) => q.eq('state', 'evaluated');

    const results = await ctx.vectorSearch('bankSkills', 'by_embedding', {
      vector: embedding,
      limit: maxResults,
      filter,
    });

    // Hydrate the results with full document data (minus master content and embedding)
    const skills = await Promise.all(
      results.map(async (result) => {
        const doc = await ctx.runQuery(internal.bankSearch.skillManifest, { id: result._id });
        return doc ? { ...doc, _score: result._score } : null;
      }),
    );

    return skills.filter(Boolean);
  },
});

/**
 * Internal semantic search — used by the Bank Manager during evaluation
 * to find related skills and note duplicates or complementary content.
 */
export const internalSearch = internalAction({
  args: {
    embedding: v.array(v.float64()),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
    excludeSkillId: v.optional(v.string()),
  },
  // Annotated for the same reason as `search` above: this module calls its own
  // query through the generated api, and that cycle defeats inference.
  handler: async (ctx, { embedding, category, limit, excludeSkillId }): Promise<any[]> => {
    const maxResults = Math.min(limit ?? 8, 16);

    const filter = category
      ? (q: any) => q.eq('category', category)
      : undefined;

    const results = await ctx.vectorSearch('bankSkills', 'by_embedding', {
      vector: embedding,
      limit: maxResults + 1, // +1 to exclude self if present
      filter,
    });

    const skills = await Promise.all(
      results
        .filter((result) => !excludeSkillId || result._id !== excludeSkillId)
        .slice(0, maxResults)
        .map(async (result) => {
          const doc = await ctx.runQuery(internal.bankSearch.skillManifest, { id: result._id });
          return doc ? { ...doc, _score: result._score } : null;
        }),
    );

    return skills.filter(Boolean);
  },
});

import { internalQuery } from './_generated/server';

/**
 * Internal query to hydrate a bankSkills document as a public manifest.
 * Strips markdownBody and embedding — manifests only cross the boundary.
 */
export const skillManifest = internalQuery({
  args: { id: v.id('bankSkills') },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc) return null;
    return {
      skillId: doc.skillId,
      name: doc.name,
      description: doc.description,
      version: doc.version,
      author: doc.author,
      category: doc.category,
      tags: doc.tags,
      contentDigest: doc.contentDigest,
      depositorAgentId: doc.depositorAgentId,
      alsoDepositedBy: doc.alsoDepositedBy.length,
      sourceKind: doc.sourceKind,
      sizeBytes: doc.sizeBytes,
      license: doc.license,
      priceTokens: doc.priceTokens,
      safety: { verdict: doc.safety.verdict, flags: doc.safety.flags },
      state: doc.state,
      valueRank: doc.valueRank,
      valueNote: doc.valueNote?.slice(0, 200),
      llmCategories: doc.llmCategories,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  },
});
