/**
 * `buildBrief` — the text a freshly attached session is prompted with
 * (design/cockpit-design.md §4.1 step 2: "assembles the brief:
 * `briefs/worker.md`, the stream goal and its ancestors' goals, the last N
 * thread entries, repo docs from `<repo>/.agile-docs/*.md`, and accepted
 * rules in scope").
 *
 * The body is assembled in a fixed order — role brief, goal, ancestor goals
 * root→leaf, docs, rules in scope, thread tail — and then trimmed to a hard
 * character ceiling (`BRIEF_CHAR_CEILING`) so a long-running stream can
 * never grow a brief the session cannot read. Trimming drops thread entries
 * oldest-first, then truncates doc bodies; the goal and the rules are never
 * trimmed, because they are the two things the session is being held to.
 *
 * Rules are filtered through `rulesInScope` here rather than by the caller:
 * design §5.3 has exactly one scope filter, shared by the brief assembler
 * and the hook, so an out-of-scope rule cannot reach a brief by a caller
 * forgetting to filter. T140 makes that filter `rules/service.ts`'s — the
 * brief holds no scope logic of its own any more.
 *
 * Pure apart from reading the role file off disk: everything else is
 * handed in, so a brief is a function of the stream, not of the daemon's
 * state at the moment it ran.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rule, SessionRole, Stream, ThreadEntry } from '@agile-agents/shared';
import { rulesInScope } from '../rules/service';

/** `packages/daemon/briefs/` — one Markdown file per role. */
export const BRIEFS_DIR = join(import.meta.dir, '..', '..', 'briefs');

/** How many thread entries the brief carries by default. */
export const BRIEF_THREAD_ENTRIES = 20;

/**
 * Hard ceiling on the assembled brief, in characters: 24k chars is roughly
 * 6k tokens, small enough to leave a vendor's context for the actual work.
 */
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
  /** Every rule in the home; `rulesInScope` filters them here, not the caller. */
  rules: readonly Rule[];
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

/**
 * §5.2: a `guidance` rule *is* its text and nothing more — the brief is the
 * whole mechanism. A `pattern` or `classifier` rule is enforced by the hook,
 * so the brief says so: the session should know which lines it will be
 * stopped at rather than merely advised about.
 */
function renderRule(rule: Rule): string {
  if (rule.enforcement === 'guidance') return `- ${rule.text}`;
  const marks = [`enforced: ${rule.enforcement}`, ...(rule.critical ? ['critical'] : [])];
  return `- ${rule.text} (${marks.join(', ')})`;
}

function renderRules(rules: readonly Rule[]): string {
  if (rules.length === 0) return 'none yet';
  return rules.map(renderRule).join('\n');
}

function renderDoc(doc: BriefDoc, bodyCap: number): string {
  const body = doc.body.trimEnd();
  const capped =
    body.length <= bodyCap ? body : `${body.slice(0, bodyCap).trimEnd()}${DOC_TRUNCATION_MARKER}`;
  return `### ${doc.name}\n\n${capped}`;
}

function renderEntry(entry: ThreadEntry): string {
  return `- **${entry.by}** (${entry.kind}): ${entry.body}`;
}

/** One pass of the assembler at a given thread-tail length and doc body cap. */
function assemble(
  input: BuildBriefInput,
  rules: readonly Rule[],
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

  parts.push(section('Rules in scope', renderRules(rules)));

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
  const rules = rulesInScope(input.rules, input.stream, input.ancestors);
  const ceiling = input.ceiling ?? BRIEF_CHAR_CEILING;
  const maxTail = Math.min(input.threadEntries ?? BRIEF_THREAD_ENTRIES, input.thread.length);
  const docCap = Number.MAX_SAFE_INTEGER;

  let brief = assemble(input, rules, maxTail, docCap);
  if (brief.length <= ceiling) return brief;

  // 1. Thread entries, oldest first — the cheapest thing to lose.
  for (let tail = maxTail - 1; tail >= 0; tail--) {
    brief = assemble(input, rules, tail, docCap);
    if (brief.length <= ceiling) return brief;
  }

  // 2. Doc bodies, halved until they fit or are gone. The goal and the
  //    rules are never trimmed: past this point the brief may exceed the
  //    ceiling, and that is the honest outcome rather than a brief that
  //    silently drops what the session is held to.
  let cap = ceiling;
  while (cap >= MIN_DOC_BODY_CHARS) {
    brief = assemble(input, rules, 0, cap);
    if (brief.length <= ceiling) return brief;
    cap = Math.floor(cap / 2);
  }
  return assemble(input, rules, 0, 0);
}
