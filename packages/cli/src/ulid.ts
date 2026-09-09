/**
 * Minimal ULID generator (Crockford base32, matches `@agile-agents/shared`'s
 * `ULID_PATTERN`: `[0-9A-HJKMNP-TV-Z]{26}` — 10 timestamp chars + 16 random
 * chars, no `I`/`L`/`O`/`U`).
 *
 * `agile send` mints a message id client-side (`bus.send` validates a full
 * `Message`, id included, before writing it — see `packages/daemon/src/bus/
 * bus.ts`'s `send`). No shared/daemon export exists for this yet: T018 hit
 * the same gap and left an identical local copy at
 * `packages/daemon/src/gates/ulid.ts` with a note for the manager to dedupe
 * the two into one `@agile-agents/shared` helper at merge time — this file
 * is that same situation one ticket later, kept local because
 * `packages/cli` may not reach into `packages/daemon/src/gates/**`
 * (unexported internal) and `packages/shared` is off-limits to this ticket's
 * file ownership.
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
