/**
 * `buildBrief`: the text a freshly attached session is prompted with
 * (§4.1): role brief, stream goal, ancestor goals root→leaf, rules in
 * scope, docs, thread tail, trimmed to `BRIEF_CHAR_CEILING`. Trimming
 * drops thread entries oldest-first, then shrinks doc bodies; the goal and
 * rules are never trimmed (they are what the session is held to). Rules go
 * through §5.3's one filter here, not the caller's. Pure apart from
 * reading the role file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeItem, SessionRole, Stream, ThreadEntry } from '@agile-agents/shared';
import { knowledgeInScope } from '../knowledge/service';

/** One Markdown file per role. */
export const BRIEFS_DIR = join(import.meta.dir, '..', '..', 'briefs');

/** How many thread entries the brief carries by default. */
export const BRIEF_THREAD_ENTRIES = 20;

/** Hard ceiling in characters (~6k tokens), leaving the vendor's context for the work. */
export const BRIEF_CHAR_CEILING = 24_000;

/** Shortest a doc body is squeezed to before it is dropped entirely. */
const MIN_DOC_BODY_CHARS = 200;

const DOC_TRUNCATION_MARKER = '\n\n… [truncated to fit the brief]';

export interface BriefDoc {
  name: string;
  body: string;
}

export interface BuildBriefInput {
  role: SessionRole;
  stream: Stream;
  /** The stream's ancestors, root→leaf, excluding the stream itself. */
  ancestors: Stream[];
  /** The stream's thread, oldest first; only the tail is rendered. */
  thread: ThreadEntry[];
  docs: BriefDoc[];
  /** Every knowledge item in the home; `knowledgeInScope` filters them here, not the caller. */
  rules: readonly KnowledgeItem[];
  /** Overrides `BRIEF_THREAD_ENTRIES`. */
  threadEntries?: number;
  /** Overrides `BRIEF_CHAR_CEILING`. Test seam. */
  ceiling?: number;
  /** Test seam: where the role files live. */
  briefsDir?: string;
}

/** The role's Markdown file, or an empty string when there is none on disk. */
export function readRoleBrief(role: SessionRole, briefsDir = BRIEFS_DIR): string {
  const path = join(briefsDir, `${role}.md`);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trimEnd();
}

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`;
}

/** §6: a `tell` item is its text; a checked item is marked with its checkpoint. */
function renderRule(rule: KnowledgeItem): string {
  if (rule.enforcement === 'tell') return `- ${rule.text}`;
  const marks = [`enforced: ${rule.enforcement}`, ...(rule.critical ? ['critical'] : [])];
  return `- ${rule.text} (${marks.join(', ')})`;
}

/** Items for every path first, then path-limited items grouped under their globs (T261). */
function renderRules(rules: readonly KnowledgeItem[]): string {
  if (rules.length === 0) return 'none yet';
  const everywhere: string[] = [];
  const byGlobs = new Map<string, string[]>();
  for (const rule of rules) {
    const globs = rule.paths ?? [];
    if (globs.length === 0) {
      everywhere.push(renderRule(rule));
      continue;
    }
    const key = globs.map((g) => `\`${g}\``).join(', ');
    byGlobs.set(key, [...(byGlobs.get(key) ?? []), renderRule(rule)]);
  }
  const lines = [...everywhere];
  for (const [globs, items] of byGlobs) {
    lines.push(`- Only when touching ${globs}:`, ...items.map((item) => `  ${item}`));
  }
  return lines.join('\n');
}

/** T263: the brief carries everything in scope; the lookup narrows it to one path. */
export const LOOKUP_HINT =
  'Before touching an unfamiliar area, call `lookup_knowledge` with its path for the items that apply there.';

function renderDoc(doc: BriefDoc, bodyCap: number): string {
  const body = doc.body.trimEnd();
  const capped =
    body.length <= bodyCap ? body : `${body.slice(0, bodyCap).trimEnd()}${DOC_TRUNCATION_MARKER}`;
  return `### ${doc.name}\n\n${capped}`;
}

function renderEntry(entry: ThreadEntry): string {
  return `- **${entry.by}** (${entry.kind}): ${entry.body}`;
}

/**
 * T246 (projects-design §4.1): a work node with an open PR looks after it
 * until it merges or closes. Only rendered while the PR is open.
 */
export function babysitSection(stream: Stream): string | undefined {
  const pr = stream.delivery_state?.pr;
  if (stream.delivery_state?.mode !== 'pr' || pr === undefined || pr.state !== 'open') {
    return undefined;
  }
  return section(
    'Your PR',
    [
      `PR #${pr.number} (${pr.url}) is open: review ${pr.review.replace('_', ' ')}, CI ${pr.checks}, ${pr.mergeable}. Look after it until it merges or closes. Events wake you: \`pr_review\`, \`ci_failed\`, \`pr_behind\`.`,
      '- **CI failed:** read the log excerpt the event points at, fix the cause, commit, `deliver`. A flaky test is reported with `ask`, never skipped, retried away or disabled.',
      '- **Review comments:** fix small asks, commit, `deliver`. A design disagreement goes to the operator with `ask`; do not argue it on the PR.',
      '- **Behind or conflicting:** merge main in, resolve keeping both intents, run the tests, commit, `deliver`.',
      '- Never merge the PR yourself. With auto-merge on, it merges once checks and reviews pass.',
    ].join('\n'),
  );
}

/** One pass of the assembler at a given thread-tail length and doc body cap. */
function assemble(
  input: BuildBriefInput,
  rules: readonly KnowledgeItem[],
  tailLength: number,
  docBodyCap: number,
): string {
  const { role, stream, ancestors, thread, docs } = input;
  const parts: string[] = [];

  const roleBrief = readRoleBrief(role, input.briefsDir);
  if (roleBrief.length > 0) parts.push(roleBrief);

  parts.push(section('Stream', `**${stream.title}**\n\n${stream.goal}`));

  if (ancestors.length > 0) {
    parts.push(
      section(
        'Where this sits',
        ancestors
          .map((ancestor, depth) => `${'  '.repeat(depth)}- ${ancestor.title}: ${ancestor.goal}`)
          .join('\n'),
      ),
    );
  }

  const babysit = babysitSection(stream);
  if (babysit !== undefined) parts.push(babysit);

  parts.push(section('Knowledge in scope', `${renderRules(rules)}\n\n${LOOKUP_HINT}`));

  const shownDocs = docBodyCap > 0 ? docs : [];
  if (shownDocs.length > 0) {
    parts.push(section('Docs', shownDocs.map((doc) => renderDoc(doc, docBodyCap)).join('\n\n')));
  }

  const tail = tailLength > 0 ? thread.slice(-tailLength) : [];
  if (tail.length > 0) {
    parts.push(section('Thread so far', tail.map(renderEntry).join('\n')));
  }

  return `${parts.join('\n\n')}\n`;
}

export function buildBrief(input: BuildBriefInput): string {
  const rules = knowledgeInScope(input.rules, input.stream, input.ancestors);
  const ceiling = input.ceiling ?? BRIEF_CHAR_CEILING;
  const maxTail = Math.min(input.threadEntries ?? BRIEF_THREAD_ENTRIES, input.thread.length);
  const docCap = Number.MAX_SAFE_INTEGER;

  let brief = assemble(input, rules, maxTail, docCap);
  if (brief.length <= ceiling) return brief;

  // 1. Thread entries, oldest first: the cheapest thing to lose.
  for (let tail = maxTail - 1; tail >= 0; tail--) {
    brief = assemble(input, rules, tail, docCap);
    if (brief.length <= ceiling) return brief;
  }

  // 2. Doc bodies, halved until they fit or are gone. Goal and rules are
  //    never trimmed, so past this the brief may honestly exceed the ceiling.
  let cap = ceiling;
  while (cap >= MIN_DOC_BODY_CHARS) {
    brief = assemble(input, rules, 0, cap);
    if (brief.length <= ceiling) return brief;
    cap = Math.floor(cap / 2);
  }
  return assemble(input, rules, 0, 0);
}
