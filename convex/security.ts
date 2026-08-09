import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function requestMessage(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): Promise<Uint8Array> {
  const bodyHash = await sha256Hex(rawBody);
  return encoder.encode(`${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`);
}

export type SignedHeaders = {
  agentId: string;
  timestamp: number;
  nonce: string;
  signature: string;
};

export function readSignedHeaders(request: Request): SignedHeaders {
  const agentId = request.headers.get('x-earth-agent')?.trim() ?? '';
  const timestampRaw = request.headers.get('x-earth-time')?.trim() ?? '';
  const nonce = request.headers.get('x-earth-nonce')?.trim() ?? '';
  const signature = request.headers.get('x-earth-signature')?.trim() ?? '';
  const timestamp = Number(timestampRaw);
  if (!agentId || !nonce || !signature || !Number.isFinite(timestamp)) {
    throw new Error('missing signed request headers');
  }
  if (Math.abs(Date.now() - timestamp) > 60_000) throw new Error('request timestamp is outside the 60 second window');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('invalid nonce');
  return { agentId, timestamp, nonce, signature };
}

export async function verifyRequestSignature(
  request: Request,
  path: string,
  rawBody: string,
  publicKey: string,
  headers: SignedHeaders,
): Promise<boolean> {
  try {
    const message = await requestMessage(request.method, path, String(headers.timestamp), headers.nonce, rawBody);
    return ed.verify(base64UrlToBytes(headers.signature), message, base64UrlToBytes(publicKey), { zip215: false });
  } catch {
    return false;
  }
}

export function bearerToken(request: Request): string {
  const value = request.headers.get('authorization') ?? '';
  if (!value.startsWith('Bearer ')) throw new Error('missing bearer session');
  const token = value.slice(7).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('invalid bearer session');
  return token;
}
