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

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
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
