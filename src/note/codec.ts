/**
 * Notes live entirely in the link's #fragment. Browsers never send the
 * fragment to a server, so the note is never uploaded anywhere: not to us,
 * not to the host.
 *
 *   plain:  [1][utf-8 JSON]
 *   locked: [2][salt x16][iv x12][hint length][hint utf-8][AES-GCM ciphertext]
 *
 * A locked note is encrypted with a key derived from a secret word
 * (PBKDF2-SHA256 -> AES-256-GCM); the hint is authenticated as associated data.
 */

import { MAX_MESSAGE, MAX_NAME, STYLES } from './paper-art';

export interface Note {
  message: string;
  from: string;
  to: string;
  style: number;
  /** Unix seconds after which the note has "faded", or null to keep it. */
  expiresAt: number | null;
}

export type Decoded =
  | { kind: 'plain'; note: Note }
  | { kind: 'locked'; hint: string; unlock: (secret: string) => Promise<Note | null> }
  | { kind: 'invalid' };

const PLAIN = 1;
const LOCKED = 2;
const KDF_ITERATIONS = 210_000;
const HINT_MAX = 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function noteToJson(note: Note): Uint8Array<ArrayBuffer> {
  const o: Record<string, unknown> = { m: note.message, s: note.style };
  if (note.from) o.f = note.from;
  if (note.to) o.t = note.to;
  if (note.expiresAt) o.x = note.expiresAt;
  return enc.encode(JSON.stringify(o));
}

function clampText(v: unknown, max: number): string {
  return typeof v === 'string' ? Array.from(v).slice(0, max).join('') : '';
}

function noteFromJson(bytes: Uint8Array): Note | null {
  try {
    const o = JSON.parse(dec.decode(bytes)) as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || typeof o.m !== 'string') return null;
    const style = typeof o.s === 'number' && Number.isInteger(o.s) ? o.s : 0;
    return {
      message: clampText(o.m, MAX_MESSAGE * 2),
      from: clampText(o.f, MAX_NAME),
      to: clampText(o.t, MAX_NAME),
      style: Math.min(STYLES.length - 1, Math.max(0, style)),
      expiresAt: typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : null,
    };
  } catch {
    return null;
  }
}

/** Secret words are forgiving: case, accents form and outer spaces don't matter. */
export function normalizeSecret(secret: string): string {
  return secret.normalize('NFKC').trim().toLowerCase();
}

async function deriveKey(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizeSecret(secret)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function encodeNote(note: Note): string {
  const body = noteToJson(note);
  const out = new Uint8Array(1 + body.length);
  out[0] = PLAIN;
  out.set(body, 1);
  return toBase64Url(out);
}

export function canLock(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export async function encodeLockedNote(note: Note, secret: string, hint: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let hintBytes = enc.encode(clampText(hint.trim(), HINT_MAX));
  if (hintBytes.length > 255) hintBytes = hintBytes.subarray(0, 255);
  const key = await deriveKey(secret, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: hintBytes }, key, noteToJson(note)),
  );
  const out = new Uint8Array(1 + 16 + 12 + 1 + hintBytes.length + ct.length);
  let o = 0;
  out[o++] = LOCKED;
  out.set(salt, o);
  o += 16;
  out.set(iv, o);
  o += 12;
  out[o++] = hintBytes.length;
  out.set(hintBytes, o);
  o += hintBytes.length;
  out.set(ct, o);
  return toBase64Url(out);
}

export function decodeFragment(fragment: string): Decoded {
  const text = fragment.replace(/^#/, '').trim();
  if (!text || text.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(text)) return { kind: 'invalid' };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (bytes[0] === PLAIN) {
    const note = noteFromJson(bytes.subarray(1));
    return note ? { kind: 'plain', note } : { kind: 'invalid' };
  }
  if (bytes[0] === LOCKED && bytes.length > 1 + 16 + 12 + 1 + 16) {
    const salt = bytes.slice(1, 17);
    const iv = bytes.slice(17, 29);
    const hintLen = bytes[29];
    const hintBytes = bytes.slice(30, 30 + hintLen);
    const ct = bytes.slice(30 + hintLen);
    if (ct.length < 16) return { kind: 'invalid' };
    return {
      kind: 'locked',
      hint: dec.decode(hintBytes),
      unlock: async (secret: string) => {
        try {
          const key = await deriveKey(secret, salt);
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: hintBytes }, key, ct);
          return noteFromJson(new Uint8Array(pt));
        } catch {
          return null;
        }
      },
    };
  }
  return { kind: 'invalid' };
}

export function isExpired(note: Note, now = Date.now()): boolean {
  return note.expiresAt !== null && now / 1000 > note.expiresAt;
}
