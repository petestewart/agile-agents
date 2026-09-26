import { describe, expect, test } from 'bun:test';
import { MESSAGE_MAX_CHARS, errorDetails, errorMessage, isChunkLoadError } from './boundary';

describe('isChunkLoadError (T394)', () => {
  test('each browser’s words for a lazy chunk that could not be downloaded', () => {
    // Chromium, Firefox, Safari, then Vite's preload helper.
    for (const message of [
      'Failed to fetch dynamically imported module: http://127.0.0.1:4700/control-room/assets/Settings-B6eGMoiQ.js',
      'error loading dynamically imported module: http://127.0.0.1:4700/control-room/assets/Rules-x.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /control-room/assets/Lenses-x.css',
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    const named = new Error('Loading chunk 7 failed');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  test('anything else is an ordinary error', () => {
    expect(
      isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toBe(false);
    expect(isChunkLoadError(new Error('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
  });
});

describe('errorMessage (T394)', () => {
  test('the message of an Error, a thrown string, or an error-like object', () => {
    expect(errorMessage(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(
      "Cannot read properties of undefined (reading 'id')",
    );
    expect(errorMessage('the node went away')).toBe('the node went away');
    expect(errorMessage({ message: 'from a worker' })).toBe('from a worker');
    expect(errorMessage(404)).toBe('404');
  });

  test('one line: whitespace collapsed, clipped with an ellipsis', () => {
    expect(errorMessage(new Error('line one\n\n   line two\t'))).toBe('line one line two');
    const long = errorMessage(new Error('x'.repeat(MESSAGE_MAX_CHARS * 2)));
    expect(long.length).toBe(MESSAGE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  test('nothing to say still says something', () => {
    expect(errorMessage(new Error(''))).toBe('An unknown error was thrown.');
    expect(errorMessage('  ')).toBe('An unknown error was thrown.');
  });
});

describe('errorDetails (T394)', () => {
  const at = new Date('2026-09-26T12:00:00.000Z');

  test('the full message, where, when, the browser, the stack and the components', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    error.stack = `TypeError: Cannot read properties of undefined (reading 'id')\n    at StreamPage (index.js:28:2225)\n    at renderWithHooks (react.js:38:16959)`;
    const text = errorDetails({
      error,
      componentStack: '\n    at StreamPage\n    at ErrorBoundary\n    at App',
      where: '/?node=01M3FDRYDVMT2681JCBBY4RA1P',
      at,
      agent: 'Mozilla/5.0 (Android 14) Chrome/141',
    });
    expect(text).toBe(
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        'Page: /?node=01M3FDRYDVMT2681JCBBY4RA1P',
        'Time: 2026-09-26T12:00:00.000Z',
        'Browser: Mozilla/5.0 (Android 14) Chrome/141',
        '',
        'Stack:',
        'at StreamPage (index.js:28:2225)\n    at renderWithHooks (react.js:38:16959)',
        '',
        'Components:',
        'at StreamPage\n    at ErrorBoundary\n    at App',
      ].join('\n'),
    );
  });

  test('a stack without the message (Firefox, Safari) is kept whole; missing parts are left out', () => {
    const error = new Error('boom');
    error.stack = 'render@index.js:1:2\nApp@index.js:3:4';
    expect(errorDetails({ error })).toBe(
      'Error: boom\n\nStack:\nrender@index.js:1:2\nApp@index.js:3:4',
    );
    expect(errorDetails({ error: 'a thrown string', componentStack: null })).toBe(
      'a thrown string',
    );
  });
});
