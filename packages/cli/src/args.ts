/**
 * Minimal `--flag value` / `--flag` argv parsing shared by every command
 * (CLAUDE.md: hand-roll arg parsing, no CLI framework dependency).
 * `node:util`'s `parseArgs` would work too, but each verb here takes a
 * small, ad hoc set of options and error messages read better hand-rolled.
 */

export interface ParsedArgs {
  /** Positional arguments (no leading `--`), in order. */
  positionals: string[];
  /** `--flag value` pairs; a flag with no following value (or followed by
   * another flag) is recorded with value `true`. */
  options: Record<string, string | true>;
  /** Every string value of a repeated `--flag value`, in order; `options` keeps the last (T200). */
  repeated?: Record<string, string[]>;
}

/** `--`: the end of the options, as in most CLIs. */
export const END_OF_OPTIONS = '--';

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // T523: `--` ends the options; every word after it is positional, as typed.
    if (arg === END_OF_OPTIONS) {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        repeated[key] = [...(repeated[key] ?? []), next];
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, options, repeated };
}

/** T523: a verb whose words are a sentence, and the options it has of its own. */
export interface KnownArgsSpec {
  /** The command as typed, for its errors (`agile answer`). */
  verb: string;
  /** Its options that take a value (`by` for `--by <who>`). */
  values?: readonly string[];
  /** Its on/off options. */
  flags?: readonly string[];
  /** How to keep a word that looks like an option. Default: quote the text or put `--` before it. */
  hint?: string;
}

/**
 * T523 (CLI audit C3): argv for a verb that takes a sentence (`agile answer
 * Q-1 use the second option`, `agile node say <id> …`). `parseArgs` made any
 * `--word` an option that ate the next word, so `agile answer Q-1 use
 * --no-verify then push` sent "use push" and exited 0. Here only the verb's
 * own options are read (wherever they are), every other word is kept as
 * typed and in order, `--` ends the options, and any other `--word` is
 * refused by name rather than dropped. A word starting with a single `-`
 * (`-1`, `- first`) is text.
 */
export function parseKnownArgs(argv: readonly string[], spec: KnownArgsSpec): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};
  const values = new Set(spec.values ?? []);
  const flags = new Set(spec.flags ?? []);
  const own = (word: string) =>
    word.startsWith('--') && (values.has(word.slice(2)) || flags.has(word.slice(2)));

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === END_OF_OPTIONS) {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.has(name)) {
      options[name] = true;
      continue;
    }
    if (values.has(name)) {
      // The next word is the value, whatever it looks like (`--note "--force
      // was wrong"`), unless it is `--` or another of the verb's own options.
      const value = argv[i + 1];
      if (value === undefined || value === END_OF_OPTIONS || own(value)) {
        throw new Error(`${spec.verb}: --${name} needs a value`);
      }
      options[name] = value;
      repeated[name] = [...(repeated[name] ?? []), value];
      i++;
      continue;
    }
    const known = [...values, ...flags].map((o) => `--${o}`);
    throw new Error(
      `${spec.verb}: unknown option ${arg}${known.length > 0 ? ` (its options: ${known.join(', ')})` : ''}. ${
        spec.hint ?? 'If it is part of the text, quote the text or put -- before it'
      }`,
    );
  }

  return { positionals, options, repeated };
}

/**
 * T523 (CLI audit C3): words a verb has no place for are refused, never
 * dropped. An option takes one word, so an unquoted `--text which branch`
 * kept "which" and lost "branch" without a sign.
 */
export function refuseExtraWords(
  args: ParsedArgs,
  keep: number,
  verb: string,
  example: string,
): void {
  const extra = args.positionals.slice(keep);
  if (extra.length === 0) return;
  throw new Error(
    `${verb}: "${extra.join(' ')}" belongs to no option; quote a value with spaces (${example})`,
  );
}

/** Reads a required string option, throwing a CLI-friendly error if absent. */
export function requireOption(options: ParsedArgs['options'], name: string): string {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export function optionalString(options: ParsedArgs['options'], name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

/** All values of a repeatable option, each also split on commas; undefined when absent. */
export function optionalList(args: ParsedArgs, name: string): string[] | undefined {
  const values =
    args.repeated?.[name] ??
    (typeof args.options[name] === 'string' ? [args.options[name] as string] : []);
  if (values.length === 0) return undefined;
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function hasFlag(options: ParsedArgs['options'], name: string): boolean {
  return options[name] !== undefined;
}

/** Reads a required positional argument by index, throwing a CLI-friendly error if absent. */
export function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (!value) {
    throw new Error(`<${name}> is required`);
  }
  return value;
}

/** Reads stdin to completion as a UTF-8 string (used by `agile hook`). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
