/**
 * JSONL framing for an ACP agent subprocess's stdout.
 *
 * Ported from Terma's `acp-session.ts` (`pushStdout`), extracted so the split
 * rule is unit-testable on its own: split strictly on `"\n"` only. Node's
 * `readline` is not a substitute here (design/spike-findings.md §C4, on Pi's
 * RPC framing, notes the same requirement) — some harnesses do not emit
 * `"\r\n"`, and `readline` module resolution / backpressure semantics are the
 * wrong tool for a hand-rolled protocol anyway.
 */

/** Bytes an unterminated line may accumulate before the framer refuses to buffer more. */
export const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export class FramingOverflowError extends Error {
  constructor(readonly maxBufferBytes: number) {
    super(`ACP stdout buffer exceeded ${maxBufferBytes} bytes`);
    this.name = 'FramingOverflowError';
  }
}

/**
 * Accumulates raw stdout chunks and yields complete JSONL lines.
 *
 * Splits on `"\n"` only; a trailing `"\r"` (a `"\r\n"`-terminated agent) is
 * trimmed away along with any other surrounding whitespace before a line is
 * handed back, so callers can `JSON.parse` it directly. Blank lines are
 * dropped rather than yielded as empty strings.
 */
export class LineFramer {
  private buffer = '';

  constructor(private readonly maxBufferBytes: number = DEFAULT_MAX_BUFFER_BYTES) {}

  /**
   * Feed one chunk of stdout. Returns zero or more complete, trimmed,
   * non-empty lines ready to parse.
   *
   * Throws `FramingOverflowError` (clearing the buffer) when the
   * still-unterminated line would exceed the byte cap — a runaway agent
   * writing non-JSONL to stdout, or one enormous frame, must not grow this
   * buffer without bound.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxBufferBytes) {
      this.buffer = '';
      throw new FramingOverflowError(this.maxBufferBytes);
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** Bytes currently buffered as part of an incomplete line. */
  get pendingBytes(): number {
    return Buffer.byteLength(this.buffer);
  }
}
