/**
 * `agile codex install-gate|status` (T512): Codex's gate is three user-level
 * `PreToolUse` entries in `$CODEX_HOME/hooks.json` (design/spike-findings.md
 * §C5 round 5), each running `<home>/agile-pre-tool-use.sh`. Codex trusts
 * each hook separately, in its own `/hooks`, so installing is the
 * operator's explicit step: the daemon never writes Codex's `hooks.json`
 * on its own. `install-gate` asks the daemon to merge the entries, write
 * the script and sweep the old (T506/T511) repo-root files; `status` reads
 * whether the entries are there and trusted. Neither prints anything of
 * Codex's `config.toml` (its trust hashes).
 */

import type { CodexGateInstallResult, CodexGateStatus } from '@agile-agents/shared';
import { callRpc } from '../client';
import { printJson } from '../format';

/** What to do once the entries are in `hooks.json`. */
export const CODEX_TRUST_NEXT_STEP =
  'Now open `codex`, run `/hooks`, and trust the three `agile gate` hooks (Hooks need review → trust each).';

/** One line for `agile daemon status`. */
export function formatCodexGateLine(status: CodexGateStatus): string {
  if (!status.installed) return 'Codex gate: not installed — run agile codex install-gate';
  if (!status.trusted) {
    return 'Codex gate: installed, not trusted — in Codex run /hooks and trust the three agile gate hooks';
  }
  return 'Codex gate: installed, trusted';
}

/** `agile codex status`: installed, trusted per entry, the file. Never a hash. */
export function formatCodexGateStatus(status: CodexGateStatus): string {
  const lines = [
    `hooks.json: ${status.hooks_path}`,
    `installed: ${status.installed ? 'yes' : 'no'}`,
    `trusted: ${status.trusted ? 'yes' : 'no'}`,
    ...status.entries.map(
      (e) =>
        `  ${e.matcher}: ${e.index === undefined ? 'missing' : e.trusted ? 'trusted' : 'not trusted'}`,
    ),
    `script: ${status.script_path}`,
  ];
  if (status.problem !== undefined) lines.push(`problem: ${status.problem}`);
  if (!status.installed) lines.push('Run `agile codex install-gate`.');
  else if (!status.trusted) lines.push(CODEX_TRUST_NEXT_STEP);
  return lines.join('\n');
}

/** What `install-gate` did, then the next step (none when Codex already trusts all three). */
export function formatCodexInstall(result: CodexGateInstallResult): string {
  const lines = [
    result.hooks === 'added'
      ? `Added the three agile gate hooks to ${result.hooks_path}`
      : `The three agile gate hooks are already in ${result.hooks_path} (unchanged)`,
    `script: ${result.script_path} (${result.script})`,
  ];
  for (const sweep of result.swept) {
    for (const path of sweep.removed) lines.push(`removed old gate file: ${path}`);
    if (sweep.left !== undefined) lines.push(`left: ${sweep.left}`);
  }
  lines.push(
    result.status.trusted
      ? 'Codex already trusts all three: nothing more to do.'
      : CODEX_TRUST_NEXT_STEP,
  );
  return lines.join('\n');
}

export async function runCodexInstallGate(socketPath: string, json: boolean): Promise<number> {
  const result = await callRpc<CodexGateInstallResult>(socketPath, 'codex.install_gate', {});
  if (json) printJson(result);
  else console.log(formatCodexInstall(result));
  return 0;
}

export async function runCodexStatus(socketPath: string, json: boolean): Promise<number> {
  const status = await callRpc<CodexGateStatus>(socketPath, 'codex.gate_status', {});
  if (json) printJson(status);
  else console.log(formatCodexGateStatus(status));
  return 0;
}
