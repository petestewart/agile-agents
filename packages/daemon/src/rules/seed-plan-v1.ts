/**
 * `agile rules seed --from PLAN-v1.md` (T140) — imports the decisions the
 * project already made into the rules store as `proposed` global
 * `guidance` rules, so the first accept pass (§5.1) is over real material
 * rather than over a demo fixture.
 *
 * Where this lives: no package in this repo has a `scripts` directory and
 * there is no top-level `scripts/` either, and "no new codebase conventions without explicit
 * approval" (CLAUDE.md) rules out inventing one for a single file — so the
 * importer is an ordinary module beside its service and ships as a CLI
 * subcommand instead of a script.
 *
 * What it reads: the "Discovered Issues Log" (§9) of `PLAN-v1.md`, whose
 * entries record decisions in two spellings — `Decisions (manager, yolo):`
 * / `Decisions (T011):` and a bare `Decision:`. Each decision *sentence*
 * becomes one rule; nothing else in the file is touched.
 *
 * Idempotent: `agile rules seed` skips a decision whose text already exists
 * as a rule, so running it twice imports nothing the second time. Nothing
 * is committed — the state home is per machine (§7.1); the command is what
 * ships.
 */

import { readFileSync } from 'node:fs';
import {
  RULE_TEXT_MAX_CHARS,
  type RuleCriteria,
  SEED_PROVENANCE_PREFIX,
} from '@agile-agents/shared';
import type { RulesService } from './service';

/** The §9 heading, matched on its text rather than its number. */
const DECISIONS_SECTION = /^##\s+\d+\.\s+Discovered Issues Log\s*$/;

/** `Decision:` · `Decisions:` · `Decisions (manager, yolo):` · `Decision (T011):`. */
const DECISION_MARKER = /Decisions?\s*(?:\([^)]*\))?\s*:/;

/** `(1) … (2) …` — the numbered form several entries use for multiple decisions. */
const NUMBERED = /\((\d)\)\s*/g;

/** Shortest fragment worth proposing: below this it is a fragment, not a decision. */
const MIN_RULE_CHARS = 25;

/** The §9 section body of a PLAN-v1-shaped document, or `''` when there is none. */
export function decisionsSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => DECISIONS_SECTION.test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function tidy(fragment: string): string {
  return fragment
    .replace(/\s+/g, ' ')
    .replace(/^[\s;,.—-]+/, '')
    .replace(/[\s;,]+$/, '')
    .trim()
    .slice(0, RULE_TEXT_MAX_CHARS);
}

/**
 * One decision sentence per rule. An entry with a numbered list of
 * decisions yields one rule per number; otherwise the decision text is
 * split on `;`, which is how the log separates independent decisions
 * inside one sentence.
 */
function fragmentsOf(decisionText: string): string[] {
  const numbered = decisionText.split(NUMBERED);
  if (numbered.length > 1) {
    // split() with one capture group yields [pre, '1', body, '2', body, …].
    return numbered.filter((_, index) => index > 0 && index % 2 === 0).map(tidy);
  }
  return decisionText.split(';').map(tidy);
}

/** Every decision sentence in §9, in file order, deduplicated. */
export function parsePlanV1Decisions(markdown: string): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const line of decisionsSection(markdown).split('\n')) {
    if (!line.trimStart().startsWith('- ')) continue;
    const marker = DECISION_MARKER.exec(line);
    if (marker === null) continue;
    for (const fragment of fragmentsOf(line.slice(marker.index + marker[0].length))) {
      if (fragment.length < MIN_RULE_CHARS || seen.has(fragment)) continue;
      seen.add(fragment);
      texts.push(fragment);
    }
  }
  return texts;
}

/**
 * `provenance.by` every seeded rule carries — the answer to "why does this
 * rule exist". T163: the `seed:` prefix is what collapses them into one
 * inbox card (`isSeededRule`).
 */
export const SEED_PROVENANCE = `${SEED_PROVENANCE_PREFIX}PLAN-v1`;

/**
 * T156 (**D14**): classifier wording for seeded decisions whose sentence,
 * lifted out of the log, is too thin to ask as-is. The Phase 5 agreement
 * check (PLAN T154 note) put both examples of each of these near 0.5 under
 * the default "Does this action violate: <text>?". Each is rewritten as one
 * yes/no question where **yes means the rule is broken**, with `criteria`
 * because both lines are subtle. Matched on the seeded text, so a fresh
 * `agile rules seed` proposes them already worded; the rules already in a
 * home (…GR77MM, …8CMD5B) take the same wording through `agile rules edit`.
 */
export interface SeedClassifierWording {
  /** Matches the seeded decision sentence. */
  match: RegExp;
  question: string;
  criteria: RuleCriteria;
}

export const SEED_CLASSIFIER_WORDING: readonly SeedClassifierWording[] = [
  {
    // PLAN-v1 §9, 2026-09-09 (T025): "browser writes are always actor `human` …"
    match: /^browser writes are always actor `human`/,
    question:
      'Does this change let an HTTP request from the browser decide which actor a write is recorded as, instead of always recording it as `human`?',
    criteria: {
      true: 'Code on a browser/HTTP write path takes the actor (or principal, author, by) from the request body, query or headers, even as an optional override that falls back to `human`.',
      false:
        'The browser write path always records the actor as the constant `human` and ignores or rejects any actor field in the request, or the change does not touch a browser write path at all.',
    },
  },
  {
    // PLAN-v1 §9, 2026-09-08 (T002): "all shared schemas are `.strict()` by default …"
    match: /^all shared schemas are `\.strict\(\)` by default/,
    question:
      'Does this change define or modify a zod object schema in packages/shared without `.strict()`, so that unknown keys would be silently dropped?',
    criteria: {
      true: 'A `z.object({...})` in packages/shared is added or changed and is not made `.strict()`.',
      false:
        'Every `z.object` the change touches in packages/shared is `.strict()`. A deliberately free-form field such as `z.record(...)` inside a strict object, or a schema outside packages/shared, does not break the rule.',
    },
  },
];

/** The rewritten wording for a seeded sentence, when it has one. */
export function seedClassifierWording(text: string): SeedClassifierWording | undefined {
  return SEED_CLASSIFIER_WORDING.find((wording) => wording.match.test(text));
}

/**
 * The proposal `agile rules seed` sends for one decision sentence.
 * Guidance and global on purpose: these are the project's own decisions,
 * written as prose, with no pattern to check and no repo to pin them to —
 * the human narrows or promotes one when accepting it (§3.1's
 * edit-then-accept). A sentence with rewritten wording (T156) carries its
 * `question` and `criteria`, ready for a promotion to `classifier`.
 */
export function seedProposal(text: string): {
  text: string;
  question?: string;
  criteria?: RuleCriteria;
  scope: { kind: 'global' };
  enforcement: 'guidance';
  provenance: { by: string };
} {
  const wording = seedClassifierWording(text);
  return {
    text,
    ...(wording !== undefined ? { question: wording.question, criteria: wording.criteria } : {}),
    scope: { kind: 'global' },
    enforcement: 'guidance',
    provenance: { by: SEED_PROVENANCE },
  };
}

/** Reads a PLAN-v1-shaped file and returns its §9 decision sentences. */
export function readPlanV1Decisions(path: string): string[] {
  return parsePlanV1Decisions(readFileSync(path, 'utf8'));
}
