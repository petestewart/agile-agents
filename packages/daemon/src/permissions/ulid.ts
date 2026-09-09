/**
 * Minimal ULID generator (Crockford base32, matching `UlidSchema` in
 * `@agile-agents/shared`'s `ids.ts`). No `ulid` package exists in the repo
 * and CLAUDE.md forbids adding a new dependency for this ticket, so this is
 * a small self-contained generator: 48-bit millisecond timestamp + 80 bits
 * of randomness, both Crockford-base32 encoded — the same layout as the
 * `ulid` npm package, just inlined.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value: bigint, length: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

let lastTime = 0;
let lastRandom = 0n;

/** Generates a new ULID, monotonic within a process (ties on the same millisecond increment the random tail). */
export function generateUlid(now: number = Date.now()): string {
  const time = BigInt(now);
  const timePart = encodeBase32(time, 10);

  let random: bigint;
  if (now === lastTime) {
    random = lastRandom + 1n;
  } else {
    random = 0n;
    for (let i = 0; i < 80; i += 8) {
      random = (random << 8n) | BigInt(Math.floor(Math.random() * 256));
    }
  }
  lastTime = now;
  lastRandom = random;

  return timePart + encodeBase32(random, 16);
}
