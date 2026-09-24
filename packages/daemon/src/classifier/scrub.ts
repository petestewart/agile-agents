/**
 * The credential scrub (§6.5, D11, after KiroCrew), run on the state
 * before every classifier call. Two pinned properties that pull apart:
 * matches are replaced with a marker, not removed (the classifier must
 * still see the action's shape), and benign secret-adjacent strings (a
 * base64 fixture, a `tokenizer`, `KEY_CODES`) survive, or the tier is
 * useless. Never catches: a throw propagates and nothing is sent, since a
 * trusted scrub that fails open is worse than none.
 */

/** The fixed marker every match is replaced with (§6.5). */
export const REDACTION_MARKER = '[REDACTED]';

/**
 * Applied in order, and order is load-bearing: a private-key block goes
 * whole before the key-shaped run can nibble it, an `Authorization:`
 * header by the header rule, and a JWT as one credential before
 * `keyed-opaque-run` takes only its first segment.
 */
const PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp; readonly to: string }> =
  [
    // Private-key blocks, generic on both delimiters and unterminated-safe:
    // a truncated diff hunk with no footer is redacted to the end of the
    // state, while a terminated block stops at its own footer.
    {
      name: 'private-key-block',
      re: /-----BEGIN [^\n-]*PRIVATE KEY[^\n-]*-----[\s\S]*?(?:-----END [^\n-]*PRIVATE KEY[^\n-]*-----|$)/g,
      to: REDACTION_MARKER,
    },
    // `Authorization:` / `Proxy-Authorization:` headers, in a header block
    // or in a quoted headers object. The name is kept, the value goes.
    {
      name: 'authorization-header',
      re: /((?:Proxy-)?Authorization)(["']?\s*:\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,}]*)/gi,
      to: `$1$2${REDACTION_MARKER}`,
    },
    // JWTs, before `keyed-opaque-run` (whose class has no `.`, so it would
    // redact one segment and leave output that looks scrubbed). Anchored on
    // `eyJ` (base64url `{"`), not "three dotted runs", which would eat
    // versions and hostnames.
    {
      name: 'jwt',
      re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      to: REDACTION_MARKER,
    },
    // `.env`-shaped lines: an upper-case secret-ish name, `=`, a value.
    // Case-sensitive, so a lower-case `token` identifier is left alone.
    {
      name: 'env-assignment',
      re: /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:_SECRET|_KEY|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS)|[ \t]*(?:export[ \t]+)?(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY))([ \t]*=[ \t]*).+$/gm,
      to: `$1$2${REDACTION_MARKER}`,
    },
    // A long opaque run right next to a key/token/secret word; a bare blob
    // with no such word is left alone.
    {
      name: 'keyed-opaque-run',
      re: /((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|key|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)([A-Za-z0-9+/_=-]{32,})/gi,
      to: `$1${REDACTION_MARKER}`,
    },
    // The same with a whitespace delimiter (`aws configure set
    // aws_secret_access_key wJalr…`), with a narrower keyword list: a bare
    // `key` or `token` followed by a space would eat prose.
    {
      name: 'spaced-secret-assignment',
      re: /((?:aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|secret[_-]?key|password|passphrase)["']?[ \t]+)([A-Za-z0-9+/_=-]{20,})/gi,
      to: `$1${REDACTION_MARKER}`,
    },
    // Vendor key shapes, which are recognisable with no context at all.
    {
      name: 'openai-key',
      re: /\bsk-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9_-]{16,}/g,
      to: REDACTION_MARKER,
    },
    { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: REDACTION_MARKER },
    { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: REDACTION_MARKER },
    { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, to: REDACTION_MARKER },
    { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, to: REDACTION_MARKER },
    // URL userinfo: `https://user:pw@host` keeps the scheme and the host.
    {
      name: 'url-userinfo',
      re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g,
      to: `$1${REDACTION_MARKER}@`,
    },
  ];

/** The state with every known secret shape replaced. A non-string throws: the call must stop (§6.5). */
export function scrub(state: string): string {
  if (typeof state !== 'string') {
    throw new TypeError(`scrub expects a string state, got ${typeof state}`);
  }
  let out = state;
  for (const { re, to } of PATTERNS) {
    // Every pattern is `g`; `replace` resets `lastIndex`.
    out = out.replace(re, to);
  }
  return out;
}
