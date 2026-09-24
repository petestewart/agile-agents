/**
 * `agile rules seed --from PLAN-v1.md`: imports the project's recorded
 * decisions (the §9 Discovered Issues Log, `Decision:` / `Decisions (…):`
 * entries) as `proposed` global `guidance` rules, one per decision
 * sentence, so the first accept pass is over real material. A module
 * beside its service rather than a script (the repo has no scripts dir).
 * Idempotent: `agile rules seed` skips text that is already a rule.
 */

import { readFileSync } from 'node:fs';
import {
  RULE_TEXT_MAX_CHARS,
  type RuleCriteria,
  SEED_PROVENANCE_PREFIX,
} from '@agile-agents/shared';

/** The §9 heading, matched on its text rather than its number. */
const DECISIONS_SECTION = /^##\s+\d+\.\s+Discovered Issues Log\s*$/;

/** `Decision:` · `Decisions:` · `Decisions (manager, yolo):` · `Decision (T011):`. */
const DECISION_MARKER = /Decisions?\s*(?:\([^)]*\))?\s*:/;

/** `(1) … (2) …` — the numbered form several entries use for multiple decisions. */
const NUMBERED = /\((\d)\)\s*/g;

/** Shorter than this is a fragment, not a decision. */
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

/** One rule per numbered decision, else per `;`-separated clause. */
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

/** `provenance.by` of every seeded rule; the `seed:` prefix groups them into one inbox card. */
export const SEED_PROVENANCE = `${SEED_PROVENANCE_PREFIX}PLAN-v1`;

/**
 * D14: classifier wording for seeded sentences too thin to ask as-is (both
 * examples scored near 0.5 under the default question). Each is one yes/no
 * question where yes means the rule is broken, with `criteria`. Matched on
 * the seeded text.
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
 * The proposal for one decision sentence: guidance and global (prose with
 * no pattern or repo; the human narrows or promotes it when accepting),
 * with the rewritten `question`/`criteria` when there is one.
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
