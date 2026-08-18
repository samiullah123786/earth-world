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

    // Words first, because words always work. The text index needs nothing
    // from anybody and answers even when the embedding provider is down, out
    // of credits, or slow.
    const byText: any[] = await ctx.runQuery(internal.bankSearch.textSearch, {
      query, category, limit: maxResults,
    });

    let embedding: number[] | null = null;
    try {
      embedding = await generateEmbeddingVector(query);
    } catch (error) {
      // Degrade, never fail. A search that returns the keyword matches is a
      // working search; a search that throws is a broken Bank.
      console.warn('semantic search unavailable, answering from the text index:', error);
      return byText.slice(0, maxResults);
    }

    // Search used to return only `evaluated` skills. Evaluation is a budgeted
    // background job, so everything waiting on it - two thirds of the vault at
    // one count, none of it ever refused - was simply invisible, and the Bank
    // read as empty to anyone looking for something in it. A catalogue that
    // hides what it holds is worse than one that shows it honestly labelled:
    // npm and PyPI both list a package the moment it exists and let the badges
    // do the talking. Retired skills are the one real exclusion, because those
    // were withdrawn on purpose.
    const results = await ctx.vectorSearch('bankSkills', 'by_embedding', {
      vector: embedding,
      // Over-fetch, because the state filter now happens after ranking.
      limit: Math.min(maxResults * 3, 96),
      filter: category ? (q: any) => q.eq('category', category) : undefined,
    });

    // Hydrate the results with full document data (minus master content and embedding)
    const skills = await Promise.all(
      results.map(async (result) => {
        const doc = await ctx.runQuery(internal.bankSearch.skillManifest, { id: result._id });
        return doc ? { ...doc, _score: result._score } : null;
      }),
    );

    const semantic = skills
      .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill) && skill!.state !== 'retired');

    // Merge, keeping whichever rank found a skill first and never listing one
    // twice. Meaning leads because it understands a question the searcher did
    // not know how to word; the keyword hits follow so an exact name is never
    // buried under something merely similar.
    const merged: any[] = [];
    const seen = new Set<string>();
    for (const skill of [...semantic, ...byText]) {
      if (seen.has(skill.skillId)) continue;
      seen.add(skill.skillId);
      merged.push(skill);
    }
    return merged.slice(0, maxResults);
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
 * The listing detail a depositing agent supplied, in the shape a reader wants.
 *
 * Both projections below spread this so a field added at deposit time cannot
 * appear in search results and go missing from the manifest, or the reverse.
 * Everything here is optional - skills banked before the connector started
 * asking for it simply do not have it, and a listing must render either way.
 */
function detailView(doc: any) {
  return {
    compatibility: doc.compatibility ?? null,
    allowedTools: doc.allowedTools ?? null,
    homepage: doc.homepage ?? null,
    repository: doc.repository ?? null,
    capabilities: doc.capabilities ?? [],
    packageFiles: doc.packageFiles ?? null,
    packageBytes: doc.packageBytes ?? null,
  };
}

/**
 * Internal query to hydrate a bankSkills document as a public manifest.
 * Strips markdownBody and embedding — manifests only cross the boundary.
 */
/**
 * Keyword search over skill descriptions. Free, instant, and always available.
 */
export const textSearch = internalQuery({
  args: { query: v.string(), category: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { query, category, limit }) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const rows = await ctx.db
      .query('bankSkills')
      .withSearchIndex('by_text', (q: any) => (category
        ? q.search('description', trimmed).eq('category', category)
        : q.search('description', trimmed)))
      .take(Math.min(limit ?? 16, 32) * 2);
    return rows
      .filter((row) => row.state !== 'retired')
      .slice(0, Math.min(limit ?? 16, 32))
      .map((doc) => ({
        skillId: doc.skillId, name: doc.name, description: doc.description,
        version: doc.version, author: doc.author, category: doc.category, tags: doc.tags,
        contentDigest: doc.contentDigest, depositorAgentId: doc.depositorAgentId,
        alsoDepositedBy: doc.alsoDepositedBy.length, sourceKind: doc.sourceKind,
        sizeBytes: doc.sizeBytes, license: doc.license, priceTokens: doc.priceTokens,
        safety: { verdict: doc.safety.verdict, flags: doc.safety.flags },
        state: doc.state, valueRank: doc.valueRank, valueNote: doc.valueNote?.slice(0, 200),
        llmCategories: doc.llmCategories, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
        ...detailView(doc),
        _match: 'text' as const,
      }));
  },
});

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
      ...detailView(doc),
    };
  },
});
