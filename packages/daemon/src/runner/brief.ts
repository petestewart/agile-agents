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
import type {
  Autonomy,
  Contract,
  KnowledgeItem,
  PermissionPosture,
  Plan,
  SessionRole,
  StatusCard,
  Stream,
  ThreadEntry,
} from '@agile-agents/shared';
import { quoteThreadBody } from '@agile-agents/shared';
import type { ChildPlanView } from '../coordination/plans';
import { knowledgeInScope } from '../knowledge/service';
import { isLiveWorkNode } from '../sync/overlap';

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
  /** P20 (T280): a coordinator's children and autonomy level. */
  coordinator?: {
    children: readonly Stream[];
    autonomy: Autonomy;
    /** T283: each child's status card, or the refusal of a corrupt one. */
    cards?: ReadonlyMap<string, StatusCard | { error: string }>;
    /** T281: the node's plan and its contracts, when written. */
    plan?: Plan;
    contracts?: readonly Contract[];
  };
  /** T281: this child's part of its parent's approved plan. */
  plan?: ChildPlanView;
  /**
   * T420 (D42): the node is a conversation. Its goal is the human's question,
   * and it is told about the node it sits under (its parent's state). T458:
   * `work`, its project's open work it can read (absent without a project).
   */
  conversation?: { about?: AboutParent; work?: readonly WipNode[] };
  /** T339: the repo's own check commands (repos.yaml `checks`, else package.json scripts). */
  checks?: readonly string[];
  /** T330 (§4.4): the registered repos it may read (a work node: the others than its own). */
  readableRepos?: readonly ReadableRepo[];
  /** T330: the session runs in a worktree of its own (a work node), not a session dir. */
  inWorktree?: boolean;
  /** T457: the node's permission posture: what a read outside those repos gets. */
  readPosture?: PermissionPosture;
  /** Overrides `BRIEF_THREAD_ENTRIES`. */
  threadEntries?: number;
  /** Overrides `BRIEF_CHAR_CEILING`. Test seam. */
  ceiling?: number;
  /** Test seam: where the role files live. */
  briefsDir?: string;
}

/** T420 (D42): what a conversation is told about the node it was asked under. */
export interface AboutParent {
  node: Stream;
  /** "work", "coordinating", "project" or "conversation". */
  role: string;
  /** Its latest status card, or why it can't be read. */
  card?: StatusCard | { error: string };
  /** Its thread, oldest first; the newest lines are shown. */
  thread: readonly ThreadEntry[];
  /** Its parts (a coordinator's or a root's), with their state. */
  parts?: readonly Stream[];
  plan?: Plan;
}

/** How many of the parent's newest lines a conversation reads. */
export const ABOUT_THREAD_LINES = 12;
/** A parent's line is quoted up to this many characters. */
const ABOUT_LINE_CHARS = 400;

const clipText = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * T477: a node started with no goal. Its agent talks the work through with
 * the operator until one is set (the thread then says "goal set: …").
 */
export const NO_GOAL_YET =
  'No goal yet. The operator wants to talk it through first: answer their questions, read and research, and propose what the goal could be. Do not change files or commit until they set a goal; the thread will say "goal set: …" when they do.';

/**
 * T478: a node set to auto-close. `goal_met` is the only signal it closes
 * on, so the agent is told what it is for and when not to call it.
 */
export const AUTO_CLOSE_HINT =
  'This node closes itself when its goal is met. When the whole goal is done and nothing is left to fix or ask, call `goal_met` with a one-line summary as your last step; if you committed changes, they wait for the operator to merge. Never call it after a partial step or when you stop to ask.';

/**
 * T420 (D42): the node this conversation was asked under, as it stands: its
 * goal, state, card, branch and worktree (to read, never to change), its
 * parts and plan, and its newest lines. The conversation answers here; what
 * it concludes reaches the parent only when the human sends it.
 */
export function aboutSection(about: AboutParent): string {
  const p = about.node;
  const lines: string[] = [
    `You were asked about **${p.title}** (\`${p.id}\`, a ${about.role} node). It carries on its own work in its own thread: read what you need, never change its files or its thread. Answer here; when your conclusion should reach it, the human sends it up.`,
    '',
    `- Goal: ${p.goal !== undefined ? clipText(p.goal, 600) : 'none yet'}`,
    `- State: agent ${p.agent.status}, human ${p.human.status}${p.agent.progress ? `; last progress: ${clipText(p.agent.progress, 300)}` : ''}`,
  ];
  if (p.repo !== undefined) {
    lines.push(
      `- Repo: ${p.repo}${p.branch ? `, branch \`${p.branch}\`` : ''}${p.worktree ? `, worktree \`${p.worktree}\` (read it; don't edit)` : ''}`,
    );
  }
  const card = about.card;
  if (card !== undefined) {
    lines.push(
      'error' in card
        ? `- Its status card can't be read: ${card.error}`
        : `- Its status card: ${card.state}${card.doing ? ` — ${clipText(card.doing, 300)}` : ''}${card.files.length > 0 ? `; files: ${card.files.slice(0, 12).join(', ')}` : ''}`,
    );
  }
  if (about.parts !== undefined && about.parts.length > 0) {
    lines.push(
      '- Its parts:',
      ...about.parts.map(
        (c) =>
          `  - ${c.title} (\`${c.id}\`): agent ${c.agent.status}, human ${c.human.status}${c.agent.progress ? ` — ${clipText(c.agent.progress, 160)}` : ''}`,
      ),
    );
  }
  if (about.plan !== undefined) {
    lines.push(
      `- Its plan: v${about.plan.version}, ${about.plan.status}; ${about.plan.owners.map((o) => `${about.parts?.find((c) => c.id === o.child)?.title ?? o.child} owns ${o.owns.join(', ') || 'nothing'}`).join('; ') || 'no owners'}`,
    );
  }
  const recent = about.thread
    .filter((e) => e.kind === 'line' || e.kind === 'question')
    .slice(-ABOUT_THREAD_LINES);
  if (recent.length > 0) {
    lines.push(
      '',
      'Its newest lines:',
      ...recent.map((e) => `- **${e.by}**: ${clipText(e.body, ABOUT_LINE_CHARS)}`),
    );
  }
  return section('What you were asked about', lines.join('\n'));
}

/** T458: one open work node a conversation may read, with what was looked up for it. */
export interface WipNode {
  node: Stream;
  /** Its status card, when one can be read. */
  card?: StatusCard;
  /** When its thread last changed (`StateStore.threadUpdatedAt`). */
  threadAt?: string;
}

/** T458: "Work in progress" lists at most this many nodes, in at most this many characters. */
export const WIP_MAX_NODES = 15;
export const WIP_SECTION_CHARS = 6_000;
const WIP_LATEST_CHARS = 160;

/**
 * T458: the project's open work a conversation can read: live work nodes
 * (not archived, closed, landed or merged; a coordinator's parts included)
 * on a repo its read scope sees (`readable`, the same rule as its "Repos you
 * can read"), other than itself and the node it was asked about. No project,
 * none.
 */
export function openWorkFor(
  conversation: Stream,
  all: readonly Stream[],
  readable: ReadonlySet<string>,
): Stream[] {
  if (conversation.project === undefined) return [];
  return all.filter(
    (s) =>
      s.project === conversation.project &&
      s.id !== conversation.id &&
      s.id !== conversation.parent &&
      s.repo !== undefined &&
      readable.has(s.repo) &&
      isLiveWorkNode(s, all),
  );
}

const latestOf = (first: string, ...rest: Array<string | undefined>): string =>
  rest.reduce<string>((at, t) => (t !== undefined && t > at ? t : at), first);

/** "just now", "5m ago", "2h ago", "3d ago", else the date. */
function agoText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const m = Math.round(Math.max(0, now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d}d ago` : `on ${iso.slice(0, 10)}`;
}

/**
 * T458: the project's other open work, newest change first: where each
 * node's code is (to read, never to change) and what it is doing. Capped at
 * `WIP_MAX_NODES` nodes and `WIP_SECTION_CHARS`; the rest are counted.
 */
export function workInProgressSection(work: readonly WipNode[], now = Date.now()): string {
  const lead =
    'Other open work in this project, most recently changed first. Read these worktrees to answer questions about ongoing work; never change their files or their threads. Answer here; a change happens only when the human sends your conclusion up or turns this conversation into work.';
  if (work.length === 0) {
    return section('Work in progress', `${lead}\n\nNone right now.`);
  }
  const rows = work
    .map(({ node, card, threadAt }) => ({
      node,
      card,
      at: latestOf(node.created_at, node.agent.updated_at, threadAt, card?.updated_at),
    }))
    .sort((a, b) => (a.at === b.at ? a.node.id.localeCompare(b.node.id) : a.at > b.at ? -1 : 1));
  const blocks = rows.map(({ node: n, card, at }) => {
    const doing = card?.doing ?? '';
    const latest =
      doing !== '' &&
      (n.agent.progress === undefined || (card?.updated_at ?? '') >= n.agent.updated_at)
        ? doing
        : (n.agent.progress ?? '');
    return [
      `- **${clipText(n.title, 120)}** (\`${n.id}\`): repo ${n.repo}${n.branch ? `, branch \`${n.branch}\`` : ', no branch yet'}${n.worktree ? `, worktree \`${n.worktree}\`` : ''}; agent ${n.agent.status}, human ${n.human.status}; changed ${agoText(at, now)}`,
      ...(latest !== '' ? [`  - Latest: ${clipText(latest, WIP_LATEST_CHARS)}`] : []),
    ].join('\n');
  });
  const shown: string[] = [];
  let used = lead.length;
  for (const block of blocks) {
    // Room is kept for the "and N more" line.
    if (shown.length === WIP_MAX_NODES || used + block.length + 40 > WIP_SECTION_CHARS) break;
    shown.push(block);
    used += block.length + 1;
  }
  const more = blocks.length - shown.length;
  if (more > 0) shown.push(`- and ${more} more not listed`);
  return section('Work in progress', `${lead}\n\n${shown.join('\n')}`);
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
  // T330: an agent line may run to 16k chars; the brief quotes its head (the rest is on the thread).
  const body = entry.by.startsWith('agent:') ? quoteThreadBody(entry.body) : entry.body;
  return `- **${entry.by}** (${entry.kind}): ${body}`;
}

/**
 * T330, T457: a repo the node may read. `own`: its project lists it. No
 * `name`: a dir the project allowed with "Always for this project".
 */
export interface ReadableRepo {
  name?: string;
  path: string;
  own?: true;
}

/** T457: one line on what a read outside the listed repos gets. */
const POSTURE_LINES: Record<PermissionPosture, string> = {
  trusted:
    "Permissions: Trusted. You may also read other paths on disk without asking (read only), but never the agile home, other projects' private repos or credential files (~/.ssh, ~/.aws and the like).",
  ask: 'Permissions: Ask. A read anywhere else asks the human first: the call is refused with a gate id; wait for the answer, then retry the exact call.',
};

/**
 * T330 (projects-design §4.4, §7): every agent may read the registered repos
 * its project can see, so it is told where they are. A node with no
 * worktree (a conversation, a coordinator) also learns how code work starts;
 * a work node reads the others beside its own worktree.
 */
export function readableReposSection(
  repos: readonly ReadableRepo[],
  inWorktree = false,
  posture?: PermissionPosture,
): string {
  const line = (repo: ReadableRepo) =>
    repo.name !== undefined
      ? `- ${repo.name}: \`${repo.path}\``
      : `- \`${repo.path}\` (allowed for this project)`;
  const own = repos.filter((repo) => repo.own === true);
  const others = repos.filter((repo) => repo.own !== true);
  // T457: the project's own repos lead; the rest follow under their own heading.
  const lines =
    repos.length === 0
      ? ['none registered yet']
      : own.length === 0
        ? repos.map(line)
        : [
            "Your project's repos:",
            ...own.map(line),
            ...(others.length > 0 ? ['', 'Other repos you can read:', ...others.map(line)] : []),
          ];
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
  if (posture !== undefined) body.push('', POSTURE_LINES[posture]);
  return section('Repos you can read', body.join('\n'));
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

/** T282: what the level means for `add_child`, `add_waits_on`, `set_owner` and a contract bump. */
const AUTONOMY_HINT: Record<Autonomy, string> = {
  advise:
    '`add_child`, `add_waits_on` and `set_owner` become proposals the operator applies; contract changes (`decide_contract`) go to the operator.',
  organise:
    '`add_child`, `add_waits_on` and `set_owner` apply at once (the thread says so), and a child you add starts its agent (a part waits while your plan waits for the operator); `start_node` starts a child that stopped. Contract changes go to the operator.',
  run: '`add_child`, `add_waits_on` and `set_owner` apply at once, and a child you add starts its agent (a part waits while your plan waits for the operator); `start_node` starts a child that stopped, `restart_node` restarts a stuck one; a routine (additive) contract change with `routine: true` applies too.',
};

/** T338: people read what agents write; ids are for tool calls only. */
export const NAMES_HINT =
  'When you write for people (thread lines, questions, notes), name nodes and contracts by their title, never by id; ids are for tool calls.';

/** P20 (T280): what a coordinator coordinates, and how far it may act on its own. */
export function coordinatorSection(
  children: readonly Stream[],
  autonomy: Autonomy,
  plan?: Plan,
  contracts: readonly Contract[] = [],
  cards?: ReadonlyMap<string, StatusCard | { error: string }>,
): string {
  const contractTitle = (id: string) => contracts.find((c) => c.id === id)?.title ?? id;
  const lines =
    children.length === 0
      ? [
          'none yet. To split the work, `add_child` one part per repo or area (a clear goal each), then `plan_write` who owns which paths.',
        ]
      : children.map((c) => {
          const card = cards?.get(c.id);
          const head = `- ${c.title} (\`${c.id}\`): agent ${c.agent.status}, human ${c.human.status}`;
          if (card === undefined)
            return `${head}${c.agent.progress ? ` — ${c.agent.progress}` : ''}`;
          if ('error' in card) return `${head}; card unreadable: ${card.error}`;
          return `${head}; card: ${card.state}, ${card.files.length} files${
            card.relies_on.length > 0
              ? `, relies on ${card.relies_on.map(contractTitle).join(', ')}`
              : ''
          }${card.doing !== '' ? ` — ${card.doing}` : ''}`;
        });
  const planLine =
    plan === undefined
      ? 'Plan: none yet. Split the work with `contract_write` (the seams) and `plan_write` (who owns which paths); the operator approves it.'
      : `Plan: v${plan.version}, **${plan.status}**${plan.status === 'draft' ? ' (waiting for the operator)' : ''}. Contracts: ${
          contracts.length === 0
            ? 'none'
            : contracts.map((c) => `${c.title} v${c.version} (\`${c.id}\`)`).join('; ')
        }.`;
  return section(
    'Your children',
    [
      ...lines,
      '',
      `Autonomy: **${autonomy}**. ${AUTONOMY_HINT[autonomy]}`,
      planLine,
      'A child’s `ask` about the plan, a contract or a sibling comes to you first (`child_question`): answer it with `answer_child`, or pass it to the operator.',
      NAMES_HINT,
    ].join('\n'),
  );
}

/** T281 (§9.1): what this child owns, whose files are whose, and the contracts it relies on. */
export function planSection(view: ChildPlanView): string {
  const lines = [
    `The approved plan (v${view.version}) gives you: ${
      view.owns.length === 0 ? 'no paths of your own' : view.owns.map((g) => `\`${g}\``).join(', ')
    }. Stay inside them; a sibling's paths are theirs.`,
    ...view.siblings.map(
      (s) =>
        `- ${s.title} owns ${s.owns.length === 0 ? 'nothing' : s.owns.map((g) => `\`${g}\``).join(', ')}`,
    ),
  ];
  if (view.contracts.length > 0) {
    lines.push(
      '',
      'Contracts you rely on (you can’t change one; `propose_contract` to your coordinator):',
    );
    for (const c of view.contracts) lines.push(`- **${c.title}** (v${c.version}): ${c.body}`);
  }
  lines.push(
    '',
    'Settle details with a sibling directly (`ask_sibling`, `reply_sibling`; your coordinator sees a copy). Anything that changes the plan, a contract or who owns what goes to your coordinator: agree it with the sibling first, then `propose_contract` with them in `with`. An `ask` about the plan, a contract or a sibling goes to your coordinator first.',
    NAMES_HINT,
  );
  return section('Your part of the plan', lines.join('\n'));
}

/** T339: the repo's own check commands, so an agent never fetches a tool to check its work. */
export function checksSection(checks: readonly string[]): string {
  return section(
    'Checks',
    `${checks.map((c) => `- \`${c}\``).join('\n')}\n\nUse these to test, typecheck, lint and build. Don't install or fetch tools (\`bunx tsc\`, \`npx <tool>\`, \`bun add\`) to check your work.`,
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

  if (input.conversation !== undefined) {
    // T420 (D42): a conversation's goal is the human's question.
    parts.push(
      section(
        'Conversation',
        `**${stream.title}**\n\nThe human asked:\n\n${(stream.goal ?? stream.question ?? stream.title).replace(/^/gm, '> ')}`,
      ),
    );
    if (input.conversation.about !== undefined) parts.push(aboutSection(input.conversation.about));
  } else {
    parts.push(
      section(
        'Stream',
        stream.goal !== undefined
          ? `**${stream.title}**\n\n${stream.goal}${stream.auto_close === true ? `\n\n${AUTO_CLOSE_HINT}` : ''}`
          : `**${stream.title}**\n\n${NO_GOAL_YET}`,
      ),
    );
  }

  if (ancestors.length > 0) {
    parts.push(
      section(
        'Where this sits',
        ancestors
          .map(
            (ancestor, depth) =>
              `${'  '.repeat(depth)}- ${ancestor.title}: ${ancestor.goal ?? '(no goal yet)'}`,
          )
          .join('\n'),
      ),
    );
  }

  if (input.coordinator !== undefined) {
    const c = input.coordinator;
    parts.push(coordinatorSection(c.children, c.autonomy, c.plan, c.contracts, c.cards));
  }

  if (input.plan !== undefined) parts.push(planSection(input.plan));

  if (input.checks !== undefined && input.checks.length > 0)
    parts.push(checksSection(input.checks));

  const babysit = babysitSection(stream);
  if (babysit !== undefined) parts.push(babysit);

  if (input.readableRepos !== undefined) {
    parts.push(readableReposSection(input.readableRepos, input.inWorktree, input.readPosture));
  }

  if (input.conversation?.work !== undefined) {
    parts.push(workInProgressSection(input.conversation.work));
  }

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
