'use node';

/**
 * The vault's own eyes and its signature.
 *
 * `scanListing` re-reads the exact bytes the vault holds for a listing,
 * un-gzips and walks the tar, and runs the deterministic scanner over every
 * member. The connector's verdict is advisory from here on: what the market
 * calls "verified" is what THIS pass concluded, signed.
 *
 * Signing runs in the Node runtime because the key never leaves the server.
 * KERNEL_SIGNING_KEY is a base64url Ed25519 seed set on the deployment; the
 * public key is served at /v1/verify so anyone - a buyer, a rival market, a
 * suspicious owner - can check a badge offline with no account and no API.
 */

import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { SCANNER_VERSION, scanEntries, verificationMessage, type ScanEntry } from './scanner';

/**
 * Full ustar walk: every member with its typeflag, plus decoded text for the
 * suffixes the scanner reads. The Bank Manager's reader only lifts prose; the
 * vault needs to SEE symlinks and unscannable members to judge them.
 */
export function tarEntries(archive: Uint8Array): ScanEntry[] {
  const out: ScanEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim() || '0', 8);
    const typeflag = decoder.decode(header.subarray(156, 157)).replace(/\0/, '') || '0';
    const body = archive.subarray(offset + 512, offset + 512 + size);
    const entry: ScanEntry = { name, size, typeflag };
    if (/[.](md|markdown|txt|rst|json|ya?ml|csv|py|sh|ps1|js|ts)$/i.test(name)) {
      entry.text = decoder.decode(body);
    }
    out.push(entry);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// An Ed25519 private key in PKCS8 DER is a fixed 16-byte prefix and the raw
// 32-byte seed. Building it by hand spares the deployment a PEM file.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signingKey() {
  const seed = process.env.KERNEL_SIGNING_KEY;
  if (!seed) return null;
  const raw = Buffer.from(seed, 'base64url');
  if (raw.length !== 32) throw new Error('KERNEL_SIGNING_KEY must be a base64url 32-byte Ed25519 seed');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

export function publicKeyBase64Url(): string | null {
  const key = signingKey();
  if (!key) return null;
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  // The raw public key is the last 32 bytes of the SPKI encoding.
  return der.subarray(der.length - 32).toString('base64url');
}

export const scanListing = internalAction({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const listing: any = await ctx.runQuery(internal.kernel.listingForScan, { id });
    if (!listing) return { ok: false, why: 'no such listing' };
    if (!listing.storageId) {
      // Repository-rooted listings carry no bytes the vault can open, so they
      // can never wear the badge. Saying so is the honest outcome.
      await ctx.runMutation(internal.kernel.fileScanVerdict, {
        id, verdict: 'needs_review', flags: ['no_bytes_held'],
        note: 'This listing points at an external repository; the vault holds no bytes to verify.',
        scannerVersion: SCANNER_VERSION, scannedAt: Date.now(),
      });
      return { ok: true, verdict: 'needs_review', reason: 'repo-rooted' };
    }

    const blob = await ctx.storage.get(listing.storageId);
    if (!blob) return { ok: false, why: 'stored bytes are missing' };
    const packed = new Uint8Array(await blob.arrayBuffer());

    let entries: ScanEntry[];
    try {
      entries = tarEntries(gunzipSync(packed));
    } catch {
      // Bytes that do not open as the format they claim are refused outright:
      // an archive nobody can inspect is an archive nobody should install.
      await ctx.runMutation(internal.kernel.fileScanVerdict, {
        id, verdict: 'refused', flags: ['unreadable_archive'],
        note: 'The stored bytes do not open as a gzip tar archive.',
        scannerVersion: SCANNER_VERSION, scannedAt: Date.now(),
      });
      return { ok: true, verdict: 'refused', reason: 'unreadable' };
    }

    const scan = scanEntries(entries);
    const scannedAt = Date.now();

    let signature: string | undefined;
    if (scan.verdict === 'inert_safe') {
      const key = signingKey();
      if (key) {
        const message = Buffer.from(verificationMessage({
          digest: listing.digest, verdict: scan.verdict, scannerVersion: SCANNER_VERSION, signedAt: scannedAt,
        }), 'utf-8');
        signature = edSign(null, message, key).toString('base64url');
      }
    }

    await ctx.runMutation(internal.kernel.fileScanVerdict, {
      id, verdict: scan.verdict, flags: scan.flags,
      note: scan.findings.slice(0, 8).map((finding) =>
        `${finding.where}${finding.line ? `:${finding.line}` : ''} - ${finding.detail}`).join('; ').slice(0, 800),
      scannerVersion: SCANNER_VERSION, scannedAt, signature,
    });
    return { ok: true, verdict: scan.verdict, flags: scan.flags, signed: Boolean(signature) };
  },
});

/**
 * Generate the FAQ and the simulated dry-run for a listing, once per digest.
 *
 * One call produces both, because two calls for the same content is paying
 * twice for one read. Gated by the Bank Manager's switch - enrichment is Bank
 * machinery and pauses with it - and metered into aiSpend like every other
 * model call this world makes. The transcript is a SIMULATION: the Kernel
 * predicts what using the skill looks like, it never executes anything.
 */
export const enrichListing = internalAction({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok: false, why: 'OPENAI_API_KEY is not configured' };
    const gate: any = await ctx.runQuery(internal.kernel.enrichmentGate, { id });
    if (!gate.allowed) return { ok: false, why: gate.why };

    // Read the listing's own words: the markdown inside its archive.
    let text = `${gate.title}\n${gate.summary}`;
    if (gate.storageId) {
      const blob = await ctx.storage.get(gate.storageId);
      if (blob) {
        try {
          const entries = tarEntries(gunzipSync(new Uint8Array(await blob.arrayBuffer())));
          const prose = entries.filter((entry) => /[.](md|markdown)$/i.test(entry.name) && entry.text)
            .map((entry) => entry.text).join('\n\n');
          if (prose) text = prose.slice(0, 16_000);
        } catch { /* unreadable archives were already refused by the scanner */ }
      }
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You document listings for a marketplace of AI agent skills. Reply with strict JSON only: '
              + '{"faq":[{"q":"...","a":"..."}],"dryRun":"..."}. Write exactly 4 FAQ pairs a buyer would actually ask '
              + '(what it does, what it needs, what it will not do, when not to use it), each answer under 220 '
              + 'characters, grounded ONLY in the provided text - if the text does not say, the answer says so. '
              + 'dryRun is a 6-10 line plausible terminal transcript of an agent USING this skill, under 700 '
              + 'characters, honest about being illustrative.',
          },
          { role: 'user', content: `Listing: ${gate.title}\n\n${text}` },
        ],
      }),
    });
    if (!response.ok) return { ok: false, why: `model refused: ${response.status}` };
    const body = await response.json();
    const usage = body.usage ?? {};
    await ctx.runMutation(internal.kernel.recordSpend, {
      agentId: 'bank:enrich', model: String(body.model ?? 'gpt-5.4-mini'),
      promptTokens: Number(usage.prompt_tokens ?? 0),
      cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
    });

    let parsed: any;
    try { parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}'); } catch { parsed = {}; }
    const items = (Array.isArray(parsed.faq) ? parsed.faq : [])
      .slice(0, 6)
      .map((item: any) => ({ q: String(item?.q ?? '').slice(0, 200), a: String(item?.a ?? '').slice(0, 300) }))
      .filter((item: any) => item.q && item.a);
    const transcript = String(parsed.dryRun ?? '').slice(0, 1_000);
    if (!items.length && !transcript) return { ok: false, why: 'the model returned nothing usable' };

    await ctx.runMutation(internal.kernel.fileEnrichment, {
      id, digest: gate.digest, model: String(body.model ?? 'gpt-5.4-mini'),
      faq: items, transcript,
    });
    return { ok: true, faqItems: items.length, simulated: Boolean(transcript) };
  },
});

/** The public half of the badge, for /v1/verify. */
export const verifyInfo = internalAction({
  args: {},
  handler: async () => ({
    ok: true,
    algorithm: 'ed25519' as const,
    publicKey: publicKeyBase64Url(),
    scannerVersion: SCANNER_VERSION,
    message: 'earth-verified-v1\\n<digest>\\n<verdict>\\n<scannerVersion>\\n<signedAt(ms)>',
    note: 'Verify: Ed25519(signature, message bytes, publicKey). All values appear on /v1/market/:id.',
  }),
});
