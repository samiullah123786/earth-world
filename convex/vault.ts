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
