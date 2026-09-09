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
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, options };
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
