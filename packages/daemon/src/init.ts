/**
 * `agile init` — create the state home if it is missing (PLAN.md §5, D9).
 *
 * T111: the home is `AGILE_HOME` (default `~/.agile/`), a plain directory of
 * YAML/JSONL/Markdown files shared by every repo this daemon serves. The
 * orphan `agile-state` branch, its worktree at `<repo>/.agile/`, and the
 * `.gitignore` entries that went with them are deleted: no `.agile/`
 * directory is ever created inside a repo any more.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

/** Default `policy.yaml` — verbatim repo-default example (§16). */
function defaultPolicy(): Policy {
  return validatePolicy({
    // T121: the three surviving gate kinds (cockpit design §3.1). Every
    // other row — approve_plan, approve_decision, sprint_review, unblock,
    // demo, promote_to_main — is deleted with the ceremony that needed it.
    gates: {
      land: 'human',
      rule_accept: 'human',
      classifier_review: 'human',
    },
    breaker_signals: [],
  });
}

/**
 * Default `vendors.yaml` — v0 scope is "Claude for every role" (§18),
 * so the only account wired up by default is a Claude subscription login.
 *
 * T027 note (design §6/§8, design/spike-findings.md §D): adding Cursor,
 * Grok, or Codex here as *seeded* candidates was tried and reverted —
 * `QuotaService.list`/`routeCandidates`/the feed snapshot/`agile status`'s
 * spend table (`packages/daemon/src/quota/**`, `packages/daemon/src/
 * feed/**`, `packages/cli/src/commands/status.ts`, none of them this
 * ticket's files) all hard-code "the shipped default vendors.yaml is
 * claude/default, one account" in their own test fixtures/assertions, so
 * seeding three more vendors by default breaks eight tests outside this
 * ticket's ownership — a cross-cutting change, not this ticket's to make
 * unilaterally (CLAUDE.md: "No new codebase conventions without explicit
 * approval"). See `recommendedVendorEntries` below for the entries an
 * operator adds to `vendors.yaml` by hand to enable Cursor/Grok/
 * Codex routing, and `vendors.test.ts`/`init.test.ts` for the schema-level
 * coverage of the shape (`requires_sandbox: true` on grok/codex).
 */
function defaultVendorsConfig(): VendorsConfig {
  return validateVendorsConfig({
    claude: {
      accounts: [{ id: 'default', auth: 'subscription' }],
    },
  });
}

/**
 * T027: the `vendors.yaml` stanzas an operator adds by hand to route
 * to Cursor/Grok/Codex — not seeded into `defaultVendorsConfig()`'s output
 * (see that function's header for why). Keyed by `@agile-agents/acp-client`
 * `ACP_PROVIDERS` id (`cursor`/`grok`/`codex`) — the id
 * `Runner.vendorConfigFor(provider.id)` looks vendors.yaml entries up by
 * (`packages/daemon/src/runner/runner.ts`), not design §8's example's
 * company-name key (`openai`), which nothing in the runtime path resolves
 * against. `requires_sandbox: true` on grok/codex
 * (`packages/shared/src/vendors.ts`, merged in T026): design/
 * spike-findings.md's final per-vendor matrix (§C3) measured **zero** ACP
 * permission requests and no hook layer for both — "codex-acp never asks,
 * regardless of mode or approval policy" and Grok's exec is entirely
 * ungated (only its client-fs reads/writes are gated, §C2) — so
 * `Runner.spawn`/`wrapAgentCommand` refuse to run either as an engineer
 * without a live tier-0 sandbox backend (T026, fail-closed) rather than
 * ever running ungated exec unsandboxed. Cursor omits the flag: its `agent`
 * mode raises an ACP permission request for **every exec** (§C2), so tier 2
 * already gates it (`decidePermission`/`policy-tables.ts` apply unchanged —
 * no per-vendor branching needed there).
 */
export function recommendedVendorEntries(): VendorsConfig {
  return validateVendorsConfig({
    cursor: {
      accounts: [{ id: 'default', auth: 'subscription' }],
    },
    grok: {
      accounts: [{ id: 'default', auth: 'subscription' }],
      requires_sandbox: true,
    },
    codex: {
      accounts: [{ id: 'default', auth: 'subscription' }],
      requires_sandbox: true,
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

/**
 * `oracle/product.md` as `agile init` first writes it. Exported so callers
 * that *derive* something from the product brief (the sprint goal, T046
 * defect 2) can tell "the architect hasn't written a brief yet" from a real
 * one, rather than lifting the placeholder `# Product` heading.
 */
export const PRODUCT_MD_STUB =
  '# Product\n\nVision, non-goals, and glossary go here.\n\n(Stub written by `agile init`; the architect fills this in.)\n';

/** Every file the §4 layout needs at init time. Directories with no listed
 * default file get a `.gitkeep` so git tracks the (otherwise empty) dir. */
function layoutFiles(stateRoot: string): Array<[string, string]> {
  const p = (...parts: string[]) => join(stateRoot, ...parts);
  return [
    [p('oracle', 'product.md'), PRODUCT_MD_STUB],
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
    // T111: the repos this daemon serves. Empty until `agile repo add`.
    [p('repos.yaml'), '{}\n'],
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

export interface InitResult {
  /** The state home that was created (or already existed). */
  home: string;
  /** Alias for `home` — the root every store path is relative to. */
  stateRoot: string;
  filesWritten: string[];
}

/**
 * Creates `home` (the state home) and the file layout inside it if missing.
 * Idempotent per file: an existing home keeps whatever is already there and
 * only gains the files it is missing, so running it again is a no-op that
 * reports zero files written.
 */
export function runInit(home: string): InitResult {
  mkdirSync(home, { recursive: true });

  const filesWritten: string[] = [];
  for (const [path, content] of layoutFiles(home)) {
    if (existsSync(path)) continue;
    writeFile(path, content);
    filesWritten.push(path);
  }

  return { home, stateRoot: home, filesWritten };
}
