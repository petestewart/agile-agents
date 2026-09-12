/**
 * `.agile/rules/` loader (T016 — design/agile-agents-design.md §4 layout:
 * "rules/RULE-012.md  # coding standards, one per file", §12 "Review
 * protocol": "Rules live in `.agile/rules/RULE-012.md`, one per file with
 * an ID, so findings cite them and the retro counts which rules are
 * violated most").
 *
 * Mirrors `tools/registry.ts`'s loader shape (read the directory directly
 * off disk, validate eagerly, throw naming the offending file rather than
 * silently dropping a broken rule) rather than going through `StateStore` —
 * rules are read-only reference material for the reviewer, not a
 * `StateStore`-mutated entity, and `.agile/rules/*.md` already exists as a
 * plain-file layout the store has no dedicated helper for.
 *
 * Two file shapes are accepted, both named `<id>.md` / `<id>.yaml`:
 *   - `.md`: first line is a heading (`# RULE-012: Title` or `# Title`);
 *     everything after is the rule's body text.
 *   - `.yaml`: `{ id, title, text }` directly.
 * DESIGN-GAP: the design never gives a literal example of a rule *file's*
 * contents (only the path), so both shapes are read permissively — id and
 * title from a heading is the natural authoring format for a markdown rule,
 * and yaml is offered for anything wanting the fields split out precisely
 * (an oracle-style frontmatter would also be reasonable but has no
 * precedent to copy either).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RuleIdSchema } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import { isHiddenOrTempFile } from '../store/fs';

export class RuleLoadError extends Error {
  constructor(
    public readonly fileName: string,
    message: string,
  ) {
    super(`${fileName}: ${message}`);
    this.name = 'RuleLoadError';
  }
}

export interface RuleDefinition {
  id: string;
  title: string;
  text: string;
}

const RULE_FILE_PATTERN = /^(RULE-\d{3,})\.(md|yaml)$/;

function parseMarkdownRule(fileName: string, idFromFile: string, raw: string): RuleDefinition {
  const lines = raw.split('\n');
  const heading = lines[0] ?? '';
  const match = /^#\s*(RULE-\d{3,})?\s*:?\s*(.*)$/.exec(heading.trim());
  if (!match) {
    throw new RuleLoadError(fileName, 'must start with a "# <title>" heading');
  }
  const headingId = match[1];
  const title = match[2]?.trim();
  if (!title) {
    throw new RuleLoadError(fileName, 'heading has no title text');
  }
  if (headingId && headingId !== idFromFile) {
    throw new RuleLoadError(
      fileName,
      `heading id (${headingId}) does not match its filename (${idFromFile})`,
    );
  }
  const text = lines.slice(1).join('\n').trim();
  if (!text) {
    throw new RuleLoadError(fileName, 'has a heading but no body text');
  }
  return { id: idFromFile, title, text };
}

function parseYamlRule(fileName: string, idFromFile: string, raw: string): RuleDefinition {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new RuleLoadError(
      fileName,
      `not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RuleLoadError(fileName, 'must be a YAML mapping with id/title/text');
  }
  const p = parsed as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id : idFromFile;
  if (id !== idFromFile) {
    throw new RuleLoadError(fileName, `"id" (${id}) does not match its filename (${idFromFile})`);
  }
  if (typeof p.title !== 'string' || p.title.length === 0) {
    throw new RuleLoadError(fileName, '"title" must be a non-empty string');
  }
  if (typeof p.text !== 'string' || p.text.length === 0) {
    throw new RuleLoadError(fileName, '"text" must be a non-empty string');
  }
  return { id, title: p.title, text: p.text };
}

function loadOneRuleFile(dir: string, fileName: string, match: RegExpExecArray): RuleDefinition {
  const [, idFromFile, ext] = match;
  const idResult = RuleIdSchema.safeParse(idFromFile);
  if (!idResult.success) {
    throw new RuleLoadError(fileName, `invalid rule id ${JSON.stringify(idFromFile)}`);
  }
  const raw = readFileSync(join(dir, fileName), 'utf8');
  return ext === 'md'
    ? parseMarkdownRule(fileName, idResult.data, raw)
    : parseYamlRule(fileName, idResult.data, raw);
}

/**
 * Loads every rule under `<stateRoot>/rules/`. Returns `[]` when the
 * directory doesn't exist yet — same "empty, not an error" convention as
 * every other loader in this codebase (`tools/registry.ts`'s
 * `loadToolRegistry`, every `StateStore.listX` on an uninitialized
 * collection).
 *
 * A file that isn't even named `RULE-###.md`/`.yaml` (a stray `README.md`)
 * is **skipped with a warning**, not thrown on — matching
 * `tools/registry.ts`'s tolerance (a directory with no `tool.yaml` is
 * skipped, not an error; opus review, blocker 3). A file that *is* named
 * like a rule but is malformed once opened (bad heading, filename/id
 * mismatch, invalid YAML, a duplicate id across two files) still throws,
 * naming the file — that's a rule someone meant to author and got wrong,
 * not stray repo clutter.
 *
 * Hidden and atomic-write temp files (`.gitkeep`, `.DS_Store`, `*.tmp-*`)
 * are skipped **silently** — `agile init` itself seeds `rules/.gitkeep`
 * (`init.ts`), so warning on them printed a `skipping .gitkeep` line on
 * every single tick of a clean run (T046 defect 1). Same predicate every
 * store directory reader already filters on (`store/fs.ts`'s
 * `isHiddenOrTempFile`, used by `listDataFiles`).
 */
export function loadRules(stateRoot: string): RuleDefinition[] {
  const rulesDir = join(stateRoot, 'rules');
  if (!existsSync(rulesDir)) return [];

  const names = readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const rules: RuleDefinition[] = [];
  const seenIds = new Set<string>();
  for (const name of names) {
    // Seeded/OS clutter is not authoring clutter: never a warning (T046).
    if (isHiddenOrTempFile(name)) continue;
    const match = RULE_FILE_PATTERN.exec(name);
    if (!match) {
      // The one warn/log surface this pure fs loader has — it takes no
      // StateStore/event-log handle (see the module header), so an
      // `.agile/log/events.jsonl` line isn't reachable from here without a
      // larger signature change than this fix warrants (same `console.*`
      // precedent as `daemon.ts`/`http.ts`).
      console.warn(`review/rules: skipping ${name} in ${rulesDir} — not a RULE-###.md/.yaml file`);
      continue;
    }
    const rule = loadOneRuleFile(rulesDir, name, match);
    if (seenIds.has(rule.id)) {
      throw new RuleLoadError(
        name,
        `duplicate rule id ${rule.id} (already loaded from another file)`,
      );
    }
    seenIds.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

export function findRule(rules: RuleDefinition[], id: string): RuleDefinition | undefined {
  return rules.find((r) => r.id === id);
}
