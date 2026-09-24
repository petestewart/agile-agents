/**
 * ID formats: ULIDs (message, session and record ids) and bus agent ids.
 */

import { z } from 'zod';

/** Crockford base32, 26 chars — used for message/bus-file ids (design §5). */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const UlidSchema = z
  .string()
  .regex(ULID_PATTERN, 'must be a 26-character Crockford-base32 ULID');
export type Ulid = z.infer<typeof UlidSchema>;

/**
 * ULID generator (design §5 "Comms bus" → "Message": "id: 01J9...  # ulid").
 * No `ulid` library dependency — a small monotonic-within-a-ms Crockford
 * base32 generator, matching `UlidSchema` above.
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
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_ENCODING_LEN = ULID_ENCODING.length; // 32 = 2^5
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;

let lastUlidTimeMs = -1;
let lastUlidRandom: number[] = [];

function ulidRandomDigits(len: number): number[] {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  // Modulo bias is negligible for a 26-bit-range Uint8 into 32 buckets and
  // irrelevant for id-uniqueness purposes; a rejection-sampling loop would
  // be needless ceremony here.
  return Array.from(bytes, (b) => b % ULID_ENCODING_LEN);
}

function ulidEncodeTime(timeMs: number): string {
  let out = '';
  let t = timeMs;
  for (let i = 0; i < ULID_TIME_LEN; i++) {
    const mod = t % ULID_ENCODING_LEN;
    out = ULID_ENCODING[mod] + out;
    t = (t - mod) / ULID_ENCODING_LEN;
  }
  return out;
}

function ulidEncodeDigits(digits: number[]): string {
  return digits.map((d) => ULID_ENCODING[d]).join('');
}

/** Increments the random part as a base-32 big-endian counter; overflow wraps to zeros. */
function ulidIncrementRandom(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const value = next[i] ?? 0;
    if (value < ULID_ENCODING_LEN - 1) {
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
  if (now === lastUlidTimeMs) {
    lastUlidRandom = ulidIncrementRandom(lastUlidRandom);
  } else {
    lastUlidTimeMs = now;
    lastUlidRandom = ulidRandomDigits(ULID_RANDOM_LEN);
  }
  return ulidEncodeTime(now) + ulidEncodeDigits(lastUlidRandom);
}

/**
 * A bus identity (T130, narrowed by T168): one of the two named principals,
 * `human` and `daemon`, or **a session's own ULID**. An attached session is
 * the routable identity (cockpit design §4: "an agent is not a member of a
 * team; it is a session attached to a stream"); it is what a gate note is
 * delivered to and what the hook's agent registry is keyed by. Worker and
 * reviewer are session *roles*, not ids.
 */
export const AGENT_ID_PATTERN = /^(human|daemon|[0-9A-HJKMNP-TV-Z]{26})$/;
export const AgentIdSchema = z.string().regex(AGENT_ID_PATTERN, 'must be a valid agent id');
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Formats a zod validation failure into a single readable line. */
export function formatZodError(entity: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return `invalid ${entity}: ${issues}`;
}
