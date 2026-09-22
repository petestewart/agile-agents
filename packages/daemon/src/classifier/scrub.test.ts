import { describe, expect, test } from 'bun:test';
import { REDACTION_MARKER, scrub } from './scrub';

describe('scrub — positive (§6.5, known secret shapes are redacted)', () => {
  test('redacts an OpenAI-shaped key', () => {
    const out = scrub('run with sk-proj-abc123DEF456ghi789JKL012 in the env');
    expect(out).not.toContain('sk-proj-abc123DEF456ghi789JKL012');
    expect(out).toContain(REDACTION_MARKER);
    // The *shape* of the action survives: the sentence is still readable.
    expect(out).toContain('run with');
    expect(out).toContain('in the env');
  });

  test('redacts GitHub tokens and PATs', () => {
    const out = scrub(
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and github_pat_11ABCDEFG0aBcDeFgHiJkL',
    );
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(out).not.toContain('github_pat_11ABCDEFG0aBcDeFgHiJkL');
  });

  test('redacts an AWS access key id', () => {
    expect(scrub('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTION_MARKER);
  });

  test('redacts an Authorization header but keeps the header name', () => {
    const out = scrub('POST /v1/x\nAuthorization: Bearer abcdef.ghijkl\nAccept: application/json');
    expect(out).toContain('Authorization:');
    expect(out).not.toContain('abcdef.ghijkl');
    expect(out).toContain('Accept: application/json');
  });

  test('redacts a Proxy-Authorization header', () => {
    expect(scrub('Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNz');
  });

  test('redacts .env-shaped assignment lines', () => {
    const out = scrub(
      [
        'DATABASE_PASSWORD=hunter2',
        'STRIPE_SECRET=abc',
        'export GH_TOKEN=xyz',
        'PASSWORD=letmein',
        'MY_API_KEY=plainvalue',
      ].join('\n'),
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('letmein');
    expect(out).not.toContain('plainvalue');
    // Names are kept so the classifier still sees what kind of line it was.
    expect(out).toContain('DATABASE_PASSWORD=');
    expect(out).toContain('export GH_TOKEN=');
  });

  test('redacts a PEM private-key block whole', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxLotsOfBase64Here0123456789abcdefghijklmnopqrstuv',
      'MoreBase64Here0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = scrub(`key file:\n${pem}\nend`);
    expect(out).toBe(`key file:\n${REDACTION_MARKER}\nend`);
  });

  test('redacts URL userinfo but keeps scheme and host', () => {
    const out = scrub('git remote add origin https://pete:s3cr3tpw@github.com/acme/repo.git');
    expect(out).not.toContain('s3cr3tpw');
    expect(out).toContain('https://');
    expect(out).toContain('@github.com/acme/repo.git');
  });

  test('redacts a long opaque run adjacent to a key word', () => {
    const out = scrub('{"api_key": "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}');
    expect(out).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6');
    expect(out).toContain('api_key');
  });
});

describe('scrub — negative (§6.5, benign strings are not mangled)', () => {
  test('leaves a base64 test fixture alone', () => {
    // No key/token/secret word next to it: this is just data.
    const fixture = 'const FIXTURE = "SGVsbG8gd29ybGQsIHRoaXMgaXMgYSB0ZXN0IGZpeHR1cmUu";';
    expect(scrub(fixture)).toBe(fixture);
  });

  test('leaves an identifier named token alone', () => {
    const code = 'const token = nextToken(stream);\nif (token.kind === "ident") return token;';
    expect(scrub(code)).toBe(code);
  });

  test('leaves a tokenizer function alone', () => {
    const code = 'export function tokenizer(input: string) { return input.split(/\\s+/); }';
    expect(scrub(code)).toBe(code);
  });

  test('leaves a KEY_CODES constant alone', () => {
    const code = 'const KEY_CODES = { enter: 13, escape: 27 };\nexport { KEY_CODES };';
    expect(scrub(code)).toBe(code);
  });

  test('leaves ordinary prose and a diff hunk alone', () => {
    const hunk = [
      'tool: Edit',
      'file: packages/daemon/src/rules/service.ts',
      '@@ -1,3 +1,4 @@',
      '+  // the reviewer asked for a keyword here',
      '   return rules.filter((rule) => rule.scope === scope);',
    ].join('\n');
    expect(scrub(hunk)).toBe(hunk);
  });

  test('throws on a non-string state rather than passing it through', () => {
    // §6.5 is fail-closed: a scrub that cannot do its job stops the call.
    expect(() => scrub(undefined as unknown as string)).toThrow(TypeError);
  });
});
