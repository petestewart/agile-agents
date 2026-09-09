/**
 * `agile init` — bootstrap the §4 state layout (design/agile-agents-design.md
 * §4 "State model" → Layout; §15 "Git model": ".agile/ lives on an orphan
 * branch agile-state, checked out as its own worktree").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Policy,
  type ToolDefinition,
  type VendorsConfig,
  validatePolicy,
  validateToolDefinition,
  validateVendorsConfig,
} from '@agile-agents/shared';
import { stringify as stringifyYaml } from 'yaml';

export const STATE_BRANCH = 'agile-state';
const STATE_DIR_NAME = '.agile';

export class AlreadyInitialisedError extends Error {
  constructor(reason: string) {
    super(`agile init: already initialised (${reason})`);
    this.name = 'AlreadyInitialisedError';
  }
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function branchExists(repoRoot: string, branch: string): boolean {
  const result = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
  });
  return result.exitCode === 0;
}

/** Default `.agile/policy.yaml` — verbatim repo-default example (§16). */
function defaultPolicy(): Policy {
  return validatePolicy({
    gates: {
      approve_plan: 'human',
      approve_decision: 'human',
      sprint_review: 'human',
      unblock: 'em',
      demo: 'human',
    },
    breaker_signals: [],
  });
}

/**
 * Default `.agile/vendors.yaml` — v0 scope is "Claude for every role" (§18),
 * so the only account wired up by default is a Claude subscription login.
 * Other vendors are added by later tickets as they land.
 */
function defaultVendorsConfig(): VendorsConfig {
  return validateVendorsConfig({
    claude: {
      accounts: [{ id: 'default', auth: 'subscription' }],
    },
  });
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Starter tool set (T011 — design/agile-agents-design.md §7 "Tool framework":
 * "Starter set: read_summary ... test_run ..."; this ticket's scope names
 * exactly these two). Seeded through `validateToolDefinition` so a broken
 * seed can never itself fail `loadToolRegistry`'s validation on the very
 * first daemon start after `agile init`.
 */
function starterToolDefinition(def: ToolDefinition): ToolDefinition {
  return validateToolDefinition(def);
}

const READ_SUMMARY_TOOL: ToolDefinition = starterToolDefinition({
  name: 'read_summary',
  kind: 'reader',
  trigger: {
    hook: 'pre-tool-use',
    match: 'tool in [Read, Grep] and (file.size > 30KB or files > 5)',
  },
  action: 'redirect',
  runner: { tier: 'trivial', max_output_tokens: 400 },
  input: { path: 'string', question: 'string?' },
  output: { summary: 'string', refs: '[{path, lines}]' },
  cache: { key: ['file_hash', 'question'], ttl: 'sprint' },
  ledger_kind: 'reader',
  promote_to_kb: 'optional',
});

const READ_SUMMARY_PROMPT = `# read_summary

You are a reader agent. You are given a file's full contents and, optionally,
a question about it. Produce:

- \`summary\`: at most 400 tokens (~1600 characters). Describe what the file
  does; if a question was given, answer it directly.
- \`refs\`: a list of \`{"path": "...", "lines": "<start>-<end>"}\` pointers
  backing the claims in your summary.

Respond with **only** a JSON object of the shape
\`{"summary": "...", "refs": [{"path": "...", "lines": "12-40"}]}\`.
No prose outside the JSON.
`;

const TEST_RUN_TOOL: ToolDefinition = starterToolDefinition({
  name: 'test_run',
  kind: 'reader',
  trigger: {
    hook: 'pre-tool-use',
    match: 'tool in [Bash] and command matches test_runner',
  },
  action: 'augment',
  runner: { tier: 'trivial', max_output_tokens: 500 },
  input: { command: 'string', cwd: 'string?' },
  output: {
    ok: 'boolean',
    failures: '[{name, message, frames}]',
    summary: 'string',
    exit_code: 'number',
  },
  ledger_kind: 'reader',
  promote_to_kb: 'never',
});

const TEST_RUN_PROMPT = `# test_run

Not a runner-tier prompt: \`test_run\` executes \`command\` directly in the
ticket worktree (\`Bun.spawn\`, no ACP session) and parses its own output for
failing test names, assertion messages, and relevant frames — never a green
log. This file exists for the registry's "tool.yaml + prompt" convention;
nothing reads it at runtime.
`;

/** Writes `tool.yaml` + `prompt.md` for one starter tool, unless a `tool.yaml` is already there — "keep it idempotent" (this ticket's file-ownership note). */
function starterToolFiles(
  toolsDir: string,
  def: ToolDefinition,
  prompt: string,
): Array<[string, string]> {
  const dir = join(toolsDir, def.name);
  const yamlPath = join(dir, 'tool.yaml');
  if (existsSync(yamlPath)) return [];
  return [
    [yamlPath, stringifyYaml(def)],
    [join(dir, 'prompt.md'), prompt],
  ];
}

/** Every file the §4 layout needs at init time. Directories with no listed
 * default file get a `.gitkeep` so git tracks the (otherwise empty) dir. */
function layoutFiles(stateRoot: string): Array<[string, string]> {
  const p = (...parts: string[]) => join(stateRoot, ...parts);
  return [
    [
      p('oracle', 'product.md'),
      '# Product\n\nVision, non-goals, and glossary go here.\n\n(Stub written by `agile init`; the architect fills this in.)\n',
    ],
    [p('oracle', 'decisions', '.gitkeep'), ''],
    [p('oracle', 'specs', '.gitkeep'), ''],
    [p('oracle', 'index.yaml'), '{}\n'],
    [p('oracle', 'changelog.md'), '# Oracle changelog\n\n(append-only)\n'],
    [p('knowledge', 'facts', '.gitkeep'), ''],
    [p('knowledge', 'index.yaml'), '{}\n'],
    [p('tickets', '.gitkeep'), ''],
    [p('board', 'status', '.gitkeep'), ''],
    [p('board', 'halts', '.gitkeep'), ''],
    [p('sprints', '.gitkeep'), ''],
    [p('policy.yaml'), stringifyYaml(defaultPolicy())],
    [p('vendors.yaml'), stringifyYaml(defaultVendorsConfig())],
    [p('tools', '.gitkeep'), ''],
    ...starterToolFiles(p('tools'), READ_SUMMARY_TOOL, READ_SUMMARY_PROMPT),
    ...starterToolFiles(p('tools'), TEST_RUN_TOOL, TEST_RUN_PROMPT),
    [p('rules', '.gitkeep'), ''],
    [p('ledger', '.gitkeep'), ''],
    [p('log', 'events.jsonl'), ''],
    [p('bus', 'inbox', '.gitkeep'), ''],
    [p('bus', 'threads', '.gitkeep'), ''],
    [p('bus', 'agents', '.gitkeep'), ''],
  ];
}

// `.agile-daemon.lock`/`.sock` are ratified v0 paths (see lock.ts, config.ts)
// but are host/process-instance files, not repo state — they must never
// land in product history alongside `.agile/` and `.worktrees/`. Sibling
// precedent, T011: `.agile-daemon-cache/` (tool result cache + raw test_run
// output, `tools/cache.ts`) is the same kind of host-local, non-audit file.
const GITIGNORE_LINES = [
  '.agile/',
  '.worktrees/',
  '.agile-daemon.lock',
  '.agile-daemon.sock',
  '.agile-daemon-cache/',
];

function ensureGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const addition = `${needsLeadingNewline ? '\n' : ''}${missing.join('\n')}\n`;
  writeFileSync(path, existing + addition);
}

export interface InitResult {
  repoRoot: string;
  stateRoot: string;
  branch: string;
  filesWritten: string[];
}

/**
 * Bootstraps `.agile/` in `repoRoot`: an orphan `agile-state` branch checked
 * out as a worktree at `.agile/`, the §4 layout, and `.gitignore` entries.
 * Refuses cleanly (`AlreadyInitialisedError`) if either the branch or the
 * `.agile/` directory already exists.
 */
export function runInit(repoRoot: string): InitResult {
  if (!existsSync(join(repoRoot, '.git'))) {
    throw new Error(`agile init: ${repoRoot} is not a git repository (no .git)`);
  }

  const stateRoot = join(repoRoot, STATE_DIR_NAME);
  if (existsSync(stateRoot)) {
    throw new AlreadyInitialisedError(`${STATE_DIR_NAME}/ already exists`);
  }
  if (branchExists(repoRoot, STATE_BRANCH)) {
    throw new AlreadyInitialisedError(`branch ${STATE_BRANCH} already exists`);
  }

  // git 2.42+: creates an unborn/orphan branch checked out in a brand new
  // worktree with an empty working directory — no separate "clear the
  // working tree" step needed, unlike `checkout --orphan` in the current
  // worktree.
  git(['worktree', 'add', '--orphan', '-b', STATE_BRANCH, STATE_DIR_NAME], repoRoot);

  const filesWritten: string[] = [];
  for (const [path, content] of layoutFiles(stateRoot)) {
    writeFile(path, content);
    filesWritten.push(path);
  }

  git(['add', '-A'], stateRoot);
  git(
    [
      '-c',
      'user.name=agiled',
      '-c',
      'user.email=agiled@localhost',
      // Daemon-authored state commits are never signed with the user's key.
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'agile init: bootstrap state layout',
    ],
    stateRoot,
  );

  ensureGitignore(repoRoot);

  return { repoRoot, stateRoot, branch: STATE_BRANCH, filesWritten };
}
