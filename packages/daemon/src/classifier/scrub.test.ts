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

  test('redacts a PGP private-key block, whose footer is not "...PRIVATE KEY-----"', () => {
    // gpg's own export format. The delimiters are matched generically, so
    // the "PRIVATE KEY BLOCK" footer is not a way out of the pattern.
    const block = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      '',
      'lQOYBGabcdefBCADlotsOfBase64Here0123456789abcdefghijklmnopqrstuvw',
      '=Ab1C',
      '-----END PGP PRIVATE KEY BLOCK-----',
    ].join('\n');
    const out = scrub(`before\n${block}\nafter`);
    expect(out).toBe(`before\n${REDACTION_MARKER}\nafter`);
  });

  test('redacts an OPENSSH private-key block', () => {
    const block =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----';
    expect(scrub(block)).toBe(REDACTION_MARKER);
  });

  test('redacts a key body whose END never arrives (a truncated diff hunk)', () => {
    // A per-action state is often a hunk, cut wherever the hunk ended. The
    // body must not leak just because the footer is in the next chunk.
    const body = 'MIIEowIBAAKCAQEAxLotsOfBase64Here0123456789abcdefghijklmnopqrstuv';
    const out = scrub(`@@ -0,0 +1,9 @@\n+-----BEGIN RSA PRIVATE KEY-----\n+${body}\n`);
    expect(out).not.toContain(body);
    expect(out).toContain(REDACTION_MARKER);
    // Everything before the header is still readable.
    expect(out).toContain('@@ -0,0 +1,9 @@');
  });

  test('a terminated block stops at its own footer and does not swallow the rest', () => {
    const out = scrub(
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nand this survives',
    );
    expect(out).toBe(`${REDACTION_MARKER}\nand this survives`);
  });

  test('redacts a bare JWT, with no keyword or header around it', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(scrub(`session ${jwt} ok`)).toBe(`session ${REDACTION_MARKER} ok`);
  });

  test('redacts a keyword-adjacent JWT whole, not just its first dot-segment', () => {
    // The failure this pins is a *partial* redaction: `keyed-opaque-run`'s
    // character class has no `.` in it, so on its own it would redact the
    // header and leave the payload (claims, often PII) and the signature
    // standing behind an output that looks scrubbed.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = scrub(`const token = "${jwt}";`);
    expect(out).toBe(`const token = "${REDACTION_MARKER}";`);
    expect(out).not.toContain('eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0');
    expect(out).not.toContain('dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
  });

  test('redacts a space-delimited secret assignment (the CLI shape)', () => {
    const out = scrub(
      'aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(out).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(out).toContain('aws configure set aws_secret_access_key');
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

  test('leaves dotted identifiers, versions and hostnames alone (not JWTs)', () => {
    // The JWT pattern is anchored on `eyJ` — the base64url of the `{"` that
    // opens every JOSE header — precisely so "three dot-separated runs"
    // does not become a licence to eat ordinary dotted text.
    const text =
      'import x from "a.b.c";\nversion 1.2.3\nhost api.example.com.br\nrequire("lodash.debounce.min")';
    expect(scrub(text)).toBe(text);
  });

  test('leaves a long base64 run alone when it only looks JWT-adjacent', () => {
    // Two segments is not a JWT, and no keyword is next to it.
    const text = 'const CHUNK = "SGVsbG8gd29ybGQ.dGhpcyBpcyBub3QgYSBqd3Q";';
    expect(scrub(text)).toBe(text);
  });

  test('leaves prose that names a credential but carries no value alone', () => {
    const text = 'rotate the api_key before the next release; the password policy is unchanged';
    expect(scrub(text)).toBe(text);
  });

  test('a lone BEGIN line that is not a private key is not a redaction trigger', () => {
    const text = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAK\n-----END CERTIFICATE-----\nafter';
    expect(scrub(text)).toBe(text);
  });

  test('throws on a non-string state rather than passing it through', () => {
    // §6.5 is fail-closed: a scrub that cannot do its job stops the call.
    expect(() => scrub(undefined as unknown as string)).toThrow(TypeError);
  });
});
