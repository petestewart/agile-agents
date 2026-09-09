/**
 * Duration parsing for `human_timeout:<d>` owners (§16). DESIGN-GAP: the
 * design never specifies a duration grammar; `<d>` is read as `<n><unit>`
 * with `ms | s | m | h | d | w`, the smallest thing that covers CLAUDE.md's
 * own tunables ("liveness timeout 5 min", "quorum timeout 10 min") and the
 * example in the ticket text (`human_timeout: <d>`, e.g. `2h`).
 */

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d|w)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export class InvalidDurationError extends Error {
  constructor(input: string) {
    super(`invalid duration "${input}": expected <n><ms|s|m|h|d|w>, e.g. "2h"`);
    this.name = 'InvalidDurationError';
  }
}

export function parseDurationMs(input: string): number {
  const match = DURATION_PATTERN.exec(input);
  if (!match) throw new InvalidDurationError(input);
  const amount = match[1];
  const unit = match[2];
  const unitMs = unit !== undefined ? UNIT_MS[unit] : undefined;
  if (amount === undefined || unitMs === undefined) throw new InvalidDurationError(input);
  return Number(amount) * unitMs;
}
