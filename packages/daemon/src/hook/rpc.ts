/** `hook.*` RPC: the raw Claude hook payload in (forwarded by `agile hook <event>`), raw hook JSON out. */

import type { CodexGateInstallResult, CodexGateStatus } from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import { codexGateStatus, installCodexGate } from './codex';
import type { ClaudePostToolUsePayload, ClaudeStopPayload, HookService } from './service';
import type { ClaudePreToolUsePayload } from './types';

function asObject(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export function buildHookRpcMethods(service: HookService): Record<string, RpcMethodHandler> {
  return {
    'hook.pre_tool_use': (params) =>
      service.preToolUse(asObject(params) as ClaudePreToolUsePayload),
    'hook.post_tool_use': (params) =>
      service.postToolUse(asObject(params) as ClaudePostToolUsePayload),
    'hook.stop': (params) => service.stop(asObject(params) as ClaudeStopPayload),
  };
}

export interface CodexGateRpcOptions {
  /** The agile home: the gate script lives in it. */
  home: string;
  /** Codex's home, read per call (as a Codex start resolves it). */
  codexHome: () => string;
  /** Every registered repo root, read per call. */
  repoRoots: () => string[];
  /** The `agile` CLI as a shell prefix, for the script. */
  agileBin: string;
  socketPath?: string;
}

/**
 * T512: `codex.install_gate` (`agile codex install-gate`: the entries in
 * `$CODEX_HOME/hooks.json`, the script, the legacy sweep across every
 * registered repo) and `codex.gate_status` (`agile codex status`, read only).
 */
export function buildCodexGateRpcMethods(
  options: CodexGateRpcOptions,
): Record<string, RpcMethodHandler> {
  return {
    'codex.install_gate': (): CodexGateInstallResult => {
      const repoRoots = options.repoRoots();
      return installCodexGate({
        codexHome: options.codexHome(),
        script: {
          agileBin: options.agileBin,
          ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
          home: options.home,
          repoRoots,
        },
        sweep: repoRoots,
      });
    },
    'codex.gate_status': (): CodexGateStatus =>
      codexGateStatus(options.codexHome(), options.home),
  };
}
