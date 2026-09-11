/**
 * ID formats for every entity in the state model.
 *
 * Design doc refs: design/agile-agents-design.md §4 "State model" (layout tree
 * + per-entity examples: DEC-0042, KB-0117, TKT-0231, H-12, S-07, RULE-012)
 * and §5 "Comms bus" (message `id` is a ULID).
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
 * DEC-0042 / SPEC-auth-003 — oracle entry ids (§4 "Oracle").
 * DESIGN-GAP: the design only shows a numeric decision id (`DEC-0042`) and a
 * slugged spec id (`SPEC-auth-003`); no format grammar is given, so the slug
 * segment is read permissively as `[a-z0-9-]+` ending in a numeric suffix.
 */
export const DecisionIdSchema = z.string().regex(/^DEC-\d{4,}$/, 'must look like DEC-0042');
export type DecisionId = z.infer<typeof DecisionIdSchema>;

export const SpecIdSchema = z
  .string()
  .regex(/^SPEC-[a-z0-9]+(?:-[a-z0-9]+)*-\d{3,}$/, 'must look like SPEC-auth-003');
export type SpecId = z.infer<typeof SpecIdSchema>;

/** Either half of the oracle (decisions/specs share a header, §4 "Oracle"). */
export const OracleIdSchema = z.union([DecisionIdSchema, SpecIdSchema]);
export type OracleId = z.infer<typeof OracleIdSchema>;

/** KB-0117 — knowledge store fact id (§4 "Knowledge store"). */
export const KbIdSchema = z.string().regex(/^KB-\d{4,}$/, 'must look like KB-0117');
export type KbId = z.infer<typeof KbIdSchema>;

/** TKT-0231 — ticket id (§4 "Ticket"). */
export const TicketIdSchema = z.string().regex(/^TKT-\d{4,}$/, 'must look like TKT-0231');
export type TicketId = z.infer<typeof TicketIdSchema>;

/**
 * EPIC-0009 — parent epic id, referenced by `Ticket.parent` (§4 "Ticket"
 * example: `parent: EPIC-0009`). Not otherwise specified.
 * DESIGN-GAP: treated as a sibling id format to TKT-.
 */
export const EpicIdSchema = z.string().regex(/^EPIC-\d{4,}$/, 'must look like EPIC-0009');
export type EpicId = z.infer<typeof EpicIdSchema>;

/** H-12 — halt id (§4 "Halts": `board/halts/<id>.yaml`). */
export const HaltIdSchema = z.string().regex(/^H-\d+$/, 'must look like H-12');
export type HaltId = z.infer<typeof HaltIdSchema>;

/** S-07 — sprint id (§4 "Sprint"). */
export const SprintIdSchema = z.string().regex(/^S-\d+$/, 'must look like S-07');
export type SprintId = z.infer<typeof SprintIdSchema>;

/** RULE-012 — coding-standard rule id (§4 layout, §12 "Review protocol"). */
export const RuleIdSchema = z.string().regex(/^RULE-\d{3,}$/, 'must look like RULE-012');
export type RuleId = z.infer<typeof RuleIdSchema>;

/**
 * Bus agent identity: `em | architect | eng-N | reviewer-N | reviewer-sec-N |
 * qa-N | human | daemon` (§5 "Message" — the `from` field enumeration).
 * `reviewer-sec-N` is the §12 security-pass reviewer the daemon mints
 * itself (`securityReviewerIdFor`); the pattern used to reject it, so the
 * EM's standup_call to a global halt's affected set threw
 * "to.1: must be a valid agent id" and aborted the twenty-fifth live run.
 */
export const AGENT_ID_PATTERN =
  /^(em|architect|human|daemon|eng-\d+|reviewer-(?:sec-)?\d+|qa-\d+)$/;
export const AgentIdSchema = z.string().regex(AGENT_ID_PATTERN, 'must be a valid agent id');
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Formats a zod validation failure into a single readable line. */
export function formatZodError(entity: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return `invalid ${entity}: ${issues}`;
}
