/**
 * Minimal ULID generator (Crockford base32, matches `@agile-agents/shared`'s
 * `ULID_PATTERN`: `[0-9A-HJKMNP-TV-Z]{26}` — 10 timestamp chars + 16 random
 * chars, no `I`/`L`/`O`/`U`).
 *
 * T018 review fix note: this ticket needs a bus-message id and a HIL-record
 * id at request time, but T006 (which owns `packages/daemon/src/bus/**` and
 * would otherwise own the canonical ULID helper) has not landed on this
 * integration branch yet, so this is a small local implementation rather
 * than a dependency on unlanded code. The manager should dedupe this against
 * T006's own ULID helper at merge time (drop this file, import theirs) —
 * the two must already agree on the character set since both are
 * constrained by the same shared `ULID_PATTERN`.
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < length; i++) {
    const index = remaining % 32;
    out = CROCKFORD_BASE32[index] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += CROCKFORD_BASE32[byte % 32];
  }
  return out;
}

/** A 26-char Crockford-base32 ULID: 10 timestamp chars + 16 random chars. */
export function generateUlid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}
