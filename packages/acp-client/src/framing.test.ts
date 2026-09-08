import { describe, expect, it } from 'bun:test';
import { DEFAULT_MAX_BUFFER_BYTES, FramingOverflowError, LineFramer } from './framing';

describe('LineFramer', () => {
  it('yields nothing for a chunk with no newline', () => {
    const framer = new LineFramer();
    expect(framer.push('no newline yet')).toEqual([]);
  });

  it('yields one line per newline-terminated chunk', () => {
    const framer = new LineFramer();
    expect(framer.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a line split across chunks', () => {
    const framer = new LineFramer();
    const line = '{"jsonrpc":"2.0","method":"session/update"}';
    expect(framer.push(line.slice(0, 12))).toEqual([]);
    expect(framer.push(`${line.slice(12)}\n`)).toEqual([line]);
  });

  it('splits on \\n only, trimming a trailing \\r left by a CRLF agent', () => {
    const framer = new LineFramer();
    expect(framer.push('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('drops blank lines', () => {
    const framer = new LineFramer();
    expect(framer.push('\n\n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('carries an incomplete line across two pushes with nothing yielded early', () => {
    const framer = new LineFramer();
    expect(framer.push('partial')).toEqual([]);
    expect(framer.pendingBytes).toBe(Buffer.byteLength('partial'));
    expect(framer.push(' line\n')).toEqual(['partial line']);
    expect(framer.pendingBytes).toBe(0);
  });

  it('throws and clears the buffer when an unterminated line exceeds the byte cap', () => {
    const framer = new LineFramer(16);
    expect(() => framer.push('x'.repeat(17))).toThrow(FramingOverflowError);
    expect(framer.pendingBytes).toBe(0);
    // Recovers cleanly afterwards.
    expect(framer.push('{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it('defaults the cap to DEFAULT_MAX_BUFFER_BYTES', () => {
    const framer = new LineFramer();
    expect(() => framer.push('x'.repeat(DEFAULT_MAX_BUFFER_BYTES + 1))).toThrow(
      FramingOverflowError,
    );
  });

  it('handles multiple complete lines arriving in one chunk after a partial', () => {
    const framer = new LineFramer();
    framer.push('{"a"');
    expect(framer.push(':1}\n{"b":2}\n{"c":3}\n')).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
