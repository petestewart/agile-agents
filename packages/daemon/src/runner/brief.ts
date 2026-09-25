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
import type { Rule, SessionRole, Stream, ThreadEntry } from '@agile-agents/shared';
import { quoteThreadBody } from '@agile-agents/shared';
import { rulesInScope } from '../rules/service';

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
  /** Every rule in the home; `rulesInScope` filters them here, not the caller. */
  rules: readonly Rule[];
  /** T330 (§4.4): the registered repos it may read (a work node: the others than its own). */
  readableRepos?: readonly { name: string; path: string }[];
  /** T330: the session runs in a worktree of its own (a work node), not a session dir. */
  inWorktree?: boolean;
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

/** §5.2: a guidance rule is its text; a pattern or classifier rule is marked as enforced. */
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
  // T330: an agent line may run to 16k chars; the brief quotes its head (the rest is on the thread).
  const body = entry.by.startsWith('agent:') ? quoteThreadBody(entry.body) : entry.body;
  return `- **${entry.by}** (${entry.kind}): ${body}`;
}

/**
 * T330 (projects-design §4.4, §7): every agent may read the registered repos
 * its project can see, so it is told where they are. A node with no
 * worktree (a conversation, a coordinator) also learns how code work starts;
 * a work node reads the others beside its own worktree.
 */
export function readableReposSection(
  repos: readonly { name: string; path: string }[],
  inWorktree = false,
): string {
  const lines =
    repos.length === 0
      ? ['none registered yet']
      : repos.map((repo) => `- ${repo.name}: \`${repo.path}\``);
  const body = inWorktree
    ? [
        'Besides your own worktree, you may read these registered repos (read only; change code only in your worktree):',
        ...lines,
      ]
    : [
        'This node has no worktree of its own. You may read these registered repos (read only; write only in your session dir):',
        ...lines,
        '',
        'Code changes happen in a work node: the operator starts one by adding a repo to this node with **+ Repo**, which cuts a branch and a worktree in that repo.',
      ];
  return section('Repos you can read', body.join('\n'));
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

  if (input.readableRepos !== undefined) {
    parts.push(readableReposSection(input.readableRepos, input.inWorktree));
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
