/**
 * `stream.*` RPC methods over a `StreamService` (T120). Same contract as
 * `questions/rpc.ts`: every handler validates its params at the boundary
 * and throws `RpcParamError` (-32602) rather than letting a destructuring
 * `TypeError` reach `dispatch()`.
 *
 * **The principal is stamped here, never read from params** (cockpit design
 * §2.2: "the HTTP edge stamps `human` and never accepts a principal from a
 * request body"). This edge serves the CLI and the UI, so every call is
 * `human`. An agent-principal write goes through `StreamService` directly
 * (T130's MCP verbs), not through this table.
 */

import {
  StreamCycleError,
  THREAD_ENTRY_KINDS,
  type ThreadEntryKind,
  UlidSchema,
  validateStreamCreateInput,
} from '@agile-agents/shared';
import { RpcParamError, optionalString, paramErrors, requireObject } from '../gates/rpc';
import { type ThreadReplyDeps, sayAndAnswer } from '../questions/thread-reply';
import type { RpcMethodHandler } from '../rpc';
import { AlreadyExistsError } from '../store/store';
import {
  type StreamNode,
  type StreamPatch,
  type StreamService,
  UnknownParentStreamError,
  UnknownRepoError,
} from './service';

/** Every `stream.*` write from this edge is the human's (design §2.2). */
const EDGE_PRINCIPAL = 'human' as const;

function requireStreamId(value: unknown): string {
  const result = UlidSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "id": must be a 26-character Crockford-base32 ULID', {
      id: value,
    });
  }
  return result.data;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new RpcParamError(`invalid "${field}": must be a boolean`, { [field]: value });
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RpcParamError(`invalid "${field}": must be a non-negative integer`, {
      [field]: value,
    });
  }
  return value;
}

function requireThreadKind(value: unknown): ThreadEntryKind {
  if (typeof value !== 'string' || !(THREAD_ENTRY_KINDS as readonly string[]).includes(value)) {
    throw new RpcParamError(`invalid "kind": must be one of ${THREAD_ENTRY_KINDS.join(', ')}`, {
      kind: value,
    });
  }
  return value as ThreadEntryKind;
}

/**
 * The patch a human may send. `agent` is deliberately not accepted: the
 * store would reject it anyway (D11), and refusing it at the edge makes the
 * error say why instead of surfacing as a store-level write violation.
 */
function requireHumanPatch(params: Record<string, unknown>): StreamPatch {
  if ('agent' in params) {
    throw new RpcParamError(
      'invalid "agent": agent.* fields are agent-owned; a human principal may not write them',
      { agent: params.agent },
    );
  }
  if ('principal' in params) {
    throw new RpcParamError(
      'invalid "principal": the principal is stamped by the daemon, not supplied by the caller',
      { principal: params.principal },
    );
  }
  const patch: StreamPatch = {};
  const title = optionalString(params.title, 'title');
  if (title !== undefined) patch.title = title;
  const goal = optionalString(params.goal, 'goal');
  if (goal !== undefined) patch.goal = goal;
  const targetBranch = optionalString(params.target_branch, 'target_branch');
  if (targetBranch !== undefined) patch.target_branch = targetBranch;
  if (params.parent !== undefined) patch.parent = requireStreamId(params.parent);
  // T150 (§6.4): the per-stream classifier opt-out. `'on'` is not a
  // stream-level override that re-enables the tier — it clears the
  // opt-out and lets the repo/home default decide again.
  if (params.classifier !== undefined) {
    if (params.classifier !== 'on' && params.classifier !== 'off') {
      throw new RpcParamError('invalid "classifier": must be "on" or "off"', {
        classifier: params.classifier,
      });
    }
    patch.classifier = params.classifier === 'off' ? 'off' : null;
  }
  if (params.human !== undefined) {
    if (typeof params.human !== 'object' || params.human === null || Array.isArray(params.human)) {
      throw new RpcParamError('invalid "human": must be an object', { human: params.human });
    }
    patch.human = params.human as StreamPatch['human'];
  }
  return patch;
}

/** Errors here that are caller input: -32602, not an internal fault. */
const asParamErrors = paramErrors(
  StreamCycleError,
  AlreadyExistsError,
  UnknownParentStreamError,
  UnknownRepoError,
);

/**
 * T169: optional wiring for `stream.thread_append`. With `reply`, a plain
 * human `line` (no `ref`) goes through `sayAndAnswer` — the cockpit
 * composer's path — so `agile stream say` prompts the live worker and
 * closes the questions that worker had open, exactly as the web does.
 */
export interface StreamRpcOptions {
  reply?: ThreadReplyDeps;
}

export function buildStreamRpcMethods(
  service: StreamService,
  options: StreamRpcOptions = {},
): Record<string, RpcMethodHandler> {
  return {
    'stream.create': async (params) =>
      asParamErrors(() =>
        service.create(EDGE_PRINCIPAL, validateStreamCreateInput(requireObject(params))),
      ),

    'stream.get': (params) => {
      const p = requireObject(params);
      return service.get(requireStreamId(p.id));
    },

    /** Tree, not a flat list: parent/child structure is what the UI renders. */
    'stream.list': (params): { tree: StreamNode[] } => {
      const p = params === undefined ? {} : requireObject(params);
      const includeArchived = optionalBoolean(p.include_archived, 'include_archived');
      return {
        tree: service.tree(
          includeArchived === undefined ? {} : { include_archived: includeArchived },
        ),
      };
    },

    'stream.update': async (params) => {
      const { id, ...rest } = requireObject(params);
      const streamId = requireStreamId(id);
      const patch = requireHumanPatch(rest);
      return asParamErrors(() => service.update(EDGE_PRINCIPAL, streamId, patch));
    },

    'stream.close': async (params) => {
      const p = requireObject(params);
      return service.close(EDGE_PRINCIPAL, requireStreamId(p.id), optionalString(p.note, 'note'));
    },

    'stream.archive': async (params) => {
      const p = requireObject(params);
      return service.archive(EDGE_PRINCIPAL, requireStreamId(p.id));
    },

    'stream.thread_append': async (params) => {
      const p = requireObject(params);
      const body = optionalString(p.body, 'body');
      if (body === undefined) {
        throw new RpcParamError('invalid "body": must be a non-empty string', { body: p.body });
      }
      const ref = optionalString(p.ref, 'ref');
      const kind = p.kind === undefined ? 'line' : requireThreadKind(p.kind);
      if (options.reply !== undefined && kind === 'line' && ref === undefined) {
        return (await sayAndAnswer(options.reply, requireStreamId(p.id), body)).entry;
      }
      return service.appendThread(EDGE_PRINCIPAL, requireStreamId(p.id), {
        kind,
        body,
        ...(ref !== undefined ? { ref } : {}),
      });
    },

    'stream.thread_read': (params) => {
      const p = requireObject(params);
      const after = optionalNonNegativeInt(p.after, 'after');
      const limit = optionalNonNegativeInt(p.limit, 'limit');
      return service.readThread(requireStreamId(p.id), {
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
  };
}
