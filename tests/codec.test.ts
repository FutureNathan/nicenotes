import { describe, expect, it } from 'vitest';
import {
  decodeFragment,
  encodeLockedNote,
  encodeNote,
  fromBase64Url,
  isExpired,
  toBase64Url,
  type Note,
} from '../src/note/codec';

const note: Note = {
  message: 'dear you,\nthank you for the soup 🍲 and for being you ♡',
  from: 'Nathan',
  to: 'Sam',
  style: 2,
  expiresAt: 1_900_000_000,
};

describe('codec', () => {
  it('round-trips base64url', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
  });

  it('round-trips a plain note', () => {
    const frag = encodeNote(note);
    const d = decodeFragment(`#${frag}`);
    expect(d.kind).toBe('plain');
    if (d.kind === 'plain') expect(d.note).toEqual(note);
  });

  it('keeps links short enough to share', () => {
    const long = { ...note, message: 'x'.repeat(280) };
    expect(encodeNote(long).length).toBeLessThan(500);
  });

  it('round-trips a locked note and rejects the wrong word', async () => {
    const frag = await encodeLockedNote(note, '  Pancakes ', 'what we had on our first morning');
    const d = decodeFragment(frag);
    expect(d.kind).toBe('locked');
    if (d.kind !== 'locked') return;
    expect(d.hint).toBe('what we had on our first morning');
    expect(await d.unlock('waffles')).toBeNull();
    expect(await d.unlock('pancakes')).toEqual(note);
  });

  it('does not leak the message in a locked link', async () => {
    const frag = await encodeLockedNote(note, 'pancakes', '');
    const bytes = new TextDecoder().decode(fromBase64Url(frag));
    expect(bytes).not.toContain('soup');
  });

  it('rejects junk', () => {
    for (const junk of ['', '#', '#!!!', '#AAAA', '#' + 'A'.repeat(9000), '#eyJ']) {
      expect(decodeFragment(junk).kind).toBe('invalid');
    }
  });

  it('sanitises fields', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ m: 'hi', s: 99, f: 7, x: 'soon' }));
    const frag = toBase64Url(new Uint8Array([1, ...bytes]));
    const d = decodeFragment(frag);
    expect(d.kind).toBe('plain');
    if (d.kind === 'plain') {
      expect(d.note.style).toBe(4);
      expect(d.note.from).toBe('');
      expect(d.note.expiresAt).toBeNull();
    }
  });

  it('knows when a note has faded', () => {
    expect(isExpired({ ...note, expiresAt: 100 }, 101_000)).toBe(true);
    expect(isExpired({ ...note, expiresAt: 100 }, 99_000)).toBe(false);
    expect(isExpired({ ...note, expiresAt: null })).toBe(false);
  });
});
