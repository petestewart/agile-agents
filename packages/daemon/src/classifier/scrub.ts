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
 * Applied in order. Earlier patterns win: a PEM block is redacted whole
 * before the generic key-shaped-run pattern can nibble at its base64, and
 * an `Authorization:` header is redacted by the header rule rather than by
 * whatever token shape happens to be inside it.
 */
const PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp; readonly to: string }> =
  [
    // Private-key PEM blocks, header to footer.
    {
      name: 'pem',
      re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
      to: REDACTION_MARKER,
    },
    // `Authorization:` / `Proxy-Authorization:` headers, in a header block
    // or in a quoted headers object. The name is kept, the value goes.
    {
      name: 'authorization-header',
      re: /((?:Proxy-)?Authorization)(["']?\s*:\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,}]*)/gi,
      to: `$1$2${REDACTION_MARKER}`,
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
