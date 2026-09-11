/**
 * Human vs `--json` output (ticket T008: "Human-readable and `--json`
 * output"). Every command builds a plain-data result and hands it to one of
 * these two instead of `console.log`-ing ad hoc — keeps the two output
 * modes for a given verb impossible to drift apart.
 */

/** Strips a leading `--json` flag out of argv, returning whether it was present. */
export function extractJsonFlag(argv: string[]): { json: boolean; rest: string[] } {
  const rest = argv.filter((a) => a !== '--json');
  return { json: rest.length !== argv.length, rest };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Renders `rows` as a simple left-aligned column table (no dependency, no ANSI). */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

/** A minimal `key: value` block for a single-object human view. */
export function printFields(fields: Array<[string, string]>): void {
  const width = Math.max(...fields.map(([k]) => k.length));
  for (const [k, v] of fields) console.log(`${k.padEnd(width)}  ${v}`);
}
