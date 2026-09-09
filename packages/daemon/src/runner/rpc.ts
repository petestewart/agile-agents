/**
 * `runner.*` RPC methods — same shape as every other `build*RpcMethods(x)`
 * in this package (`tools/rpc.ts`, `bus/rpc-methods.ts`, `gates/rpc.ts`).
 */

import {
  AGENT_RUNNER_ROLES,
  type AgentId,
  type AgentRunnerRole,
  type TicketId,
} from '@agile-agents/shared';
import type { RpcMethodHandler } from '../rpc';
import type { Runner } from './runner';

function isAgentRunnerRole(value: string): value is AgentRunnerRole {
  return (AGENT_RUNNER_ROLES as readonly string[]).includes(value);
}

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('params must be an object');
  }
  return params as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value;
}

export function buildRunnerRpcMethods(runner: Runner): Record<string, RpcMethodHandler> {
  return {
    'runner.spawn': async (params) => {
      const p = requireObject(params);
      const role = requireString(p.role, 'role');
      if (!isAgentRunnerRole(role)) {
        throw new Error(`"role" must be one of engineer, reviewer, qa (got ${role})`);
      }
      const ticket = requireString(p.ticket, 'ticket') as TicketId;
      const result = await runner.spawn(role, ticket);
      // `exited`/`stop` aren't JSON-serializable — the RPC surface reports
      // the shape of the just-started session, not its live handle.
      return {
        agentId: result.agentId,
        role: result.role,
        ticket: result.ticket,
        worktree: result.worktree,
      };
    },
    'runner.list': () =>
      runner.list().map((r) => ({
        agentId: r.agentId,
        role: r.role,
        ticket: r.ticket,
        worktree: r.worktree,
      })),
    'runner.stop': (params) => {
      const p = requireObject(params);
      const agentId = requireString(p.agentId, 'agentId') as AgentId;
      return { stopped: runner.stop(agentId) };
    },
  };
}
