/**
 * Embedding generation for the Earth Bank's semantic search.
 *
 * Uses OpenAI's text-embedding-3-small (1536 dimensions) — the same API key
 * the Bank Manager already holds. Every SKILL.md deposit is embedded once on
 * ingestion and re-embedded on sync. The Bank Manager and the public search
 * endpoint both generate query embeddings through this same function.
 *
 * Cost: ~$0.02 per million tokens. A typical SKILL.md is 2-8k tokens, so
 * embedding a thousand skills costs roughly $0.10-$0.16 total.
 */

import { internalAction } from './_generated/server';
import { v } from 'convex/values';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const MAX_INPUT_CHARS = 32_000; // ~8k tokens, well within the 8191 token limit

/**
 * Call OpenAI's embedding API and return the vector.
 * Exported as a plain function so both the deposit handler and the search
 * action can call it without going through the scheduler.
 */
export async function generateEmbeddingVector(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured — embeddings require it');

  const input = text.slice(0, MAX_INPUT_CHARS);
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input, dimensions: DIMENSIONS }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`embedding request failed: ${response.status} ${detail}`);
  }

  const body = await response.json();
  const embedding: number[] = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS) {
    throw new Error(`unexpected embedding shape: got ${embedding?.length ?? 'none'}, expected ${DIMENSIONS}`);
  }
  return embedding;
}

/**
 * Scheduled action: generate an embedding for a piece of text.
 * Used by the deposit and sync flows inside Convex actions.
 */
export const embed = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => {
    return { embedding: await generateEmbeddingVector(text) };
  },
});
