/**
 * ULID generator (design/agile-agents-design.md §5 "Comms bus" → "Message":
 * "id: 01J9...  # ulid"). CLAUDE.md standing rule for this ticket: no
 * library — implement a small monotonic-within-a-ms Crockford base32
 * generator locally; `packages/shared`'s `UlidSchema`
 * (`/^[0-9A-HJKMNP-TV-Z]{26}$/`) validates the format this produces.
 *
 * Layout: 10 chars of millisecond timestamp + 16 chars of randomness, both
 * base32-encoded (5 bits/char × 26 chars = 130 bits ⊇ 48-bit time + 80-bit
 * random, the standard ULID split: https://github.com/ulid/spec). Two
 * ulid() calls in the same millisecond increment the random part by one
 * instead of drawing fresh randomness, so ids stay strictly increasing and
 * therefore sortable within one ms, not just across ms boundaries — "ULIDs
 * order per inbox" (§5 "Ordering / failure").
 */

// Crockford base32: 0-9 then A-Z minus I, L, O, U (visually ambiguous /
// easily confused with digits) — exactly `UlidSchema`'s character class.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32 = 2^5
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTimeMs = -1;
let lastRandom: number[] = [];

function randomDigits(len: number): number[] {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  // Modulo bias is negligible for a 26-bit-range Uint8 into 32 buckets and
  // irrelevant for id-uniqueness purposes; a rejection-sampling loop would
  // be needless ceremony here.
  return Array.from(bytes, (b) => b % ENCODING_LEN);
}

function encodeTime(timeMs: number): string {
  let out = '';
  let t = timeMs;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod] + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeDigits(digits: number[]): string {
  return digits.map((d) => ENCODING[d]).join('');
}

/** Increments the random part as a base-32 big-endian counter; overflow wraps to zeros. */
function incrementRandom(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const value = next[i] ?? 0;
    if (value < ENCODING_LEN - 1) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  // 80 bits of overflow inside one millisecond is not reachable in practice;
  // wrapping to all-zero (already done by the loop above) is a harmless
  // fallback rather than throwing and breaking a hot send path.
  return next;
}

/** Generates a new ULID. `now` is injectable for deterministic tests. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTimeMs) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTimeMs = now;
    lastRandom = randomDigits(RANDOM_LEN);
  }
  return encodeTime(now) + encodeDigits(lastRandom);
}
