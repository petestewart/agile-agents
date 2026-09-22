/**
 * The credential scrub (design/cockpit-design.md §6.5, **D11**, borrowed
 * from KiroCrew). It runs on the state before **every** classifier call.
 *
 * Two properties the tests pin, because they pull in opposite directions:
 *
 *  - **Matches are replaced, not removed.** The classifier still has to see
 *    the *shape* of the action it is judging, so a redacted secret leaves a
 *    marker where it stood rather than a hole.
 *  - **Benign strings that look secret-adjacent survive.** A base64 test
 *    fixture, an identifier named `token`, a `tokenizer` function, a
 *    `KEY_CODES` constant — a scrub that mangles those redacts the state
 *    into uselessness and the tier gets turned off.
 *
 * This module never catches: if a pattern throws, the throw propagates and
 * `JevClassifier.ask` abandons the call (§6.5, "if the scrub itself throws,
 * nothing is sent"). A scrub that can fail open is worse than no scrub,
 * because it is trusted.
 */

/** The fixed marker every match is replaced with (§6.5). */
export const REDACTION_MARKER = '[REDACTED]';

/**
 * Applied in order, and the order is load-bearing. Earlier patterns win: a
 * private-key block is redacted whole before the generic key-shaped-run
 * pattern can nibble at its base64, an `Authorization:` header is redacted
 * by the header rule rather than by whatever token shape is inside it, and
 * a JWT is redacted as one credential before `keyed-opaque-run` can take a
 * bite out of its first dot-segment and leave the rest looking handled.
 */
const PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp; readonly to: string }> =
  [
    // Private-key blocks. Deliberately generic on both delimiters and
    // **unterminated-safe**: `-----BEGIN OPENSSH PRIVATE KEY-----`,
    // `-----BEGIN PGP PRIVATE KEY BLOCK-----` and anything else shaped like
    // them all match, and a block whose footer is not in this state at all
    // — a per-action state is often a diff hunk, truncated wherever the
    // hunk ended — is redacted from the header to the end of the state
    // rather than left whole. The lazy body tries the footer at every
    // length first and only falls through to end-of-string when there is no
    // footer to find, so a terminated block still stops at its own footer
    // and does not swallow whatever follows it.
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
    // JWTs — `header.payload.signature`, base64url segments joined by
    // dots, the textbook shape of a bearer or session credential. This runs
    // **before** `keyed-opaque-run` on purpose: that pattern's character
    // class has no `.` in it, so it would redact only the first segment and
    // leave the payload and the signature standing behind an output that
    // *looks* scrubbed. A partial redaction that looks complete is worse
    // than none, because §6.5's whole premise is that the scrub is trusted.
    //
    // Anchored on `eyJ` — base64url for the `{"` that opens every JOSE
    // header — rather than on "three dot-separated runs", which would eat
    // dotted identifiers, version strings and hostnames.
    {
      name: 'jwt',
      re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      to: REDACTION_MARKER,
    },
    // `.env`-shaped assignment lines: an upper-case name that *is* or ends
    // in a secret word, `=`, a value. Case-sensitive on purpose — this is
    // what keeps a lower-case `token` identifier in code out of it.
    {
      name: 'env-assignment',
      re: /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:_SECRET|_KEY|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS)|[ \t]*(?:export[ \t]+)?(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY))([ \t]*=[ \t]*).+$/gm,
      to: `$1$2${REDACTION_MARKER}`,
    },
    // A long opaque run sitting right next to a key/token/secret word —
    // `api_key: "…"`, `"secret" = '…'`. The adjacency requirement is the
    // whole point: a bare base64 blob with no such word is left alone.
    {
      name: 'keyed-opaque-run',
      re: /((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|key|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)([A-Za-z0-9+/_=-]{32,})/gi,
      to: `$1${REDACTION_MARKER}`,
    },
    // The same idea with a whitespace delimiter instead of `:`/`=`, for the
    // CLI shape the colon/equals pattern above cannot see — `aws configure
    // set aws_secret_access_key wJalr…`. The keyword list here is
    // deliberately *narrower* than the one above: only compound names that
    // are unambiguously about a credential, never a bare `key` or `token`,
    // because with a space delimiter those two would start eating prose.
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

/**
 * Returns the state with every known secret shape replaced by
 * `[REDACTED]`. Throws on anything that is not a string — a caller that
 * hands the scrub a non-string has a bug, and §6.5 says a scrub that cannot
 * do its job must stop the call rather than let the state through.
 */
export function scrub(state: string): string {
  if (typeof state !== 'string') {
    throw new TypeError(`scrub expects a string state, got ${typeof state}`);
  }
  let out = state;
  for (const { re, to } of PATTERNS) {
    // Every pattern is `g`, so `replace` is exhaustive; `lastIndex` never
    // carries between calls because `replace` resets it.
    out = out.replace(re, to);
  }
  return out;
}
