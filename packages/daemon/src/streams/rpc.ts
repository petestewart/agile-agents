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
import { RpcParamError } from '../gates/rpc';
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

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  return params as Record<string, unknown>;
}

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

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParamError(`invalid "${field}": must be a non-empty string`, { [field]: value });
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

/**
 * Errors the service/store raise for **caller input** — a parent cycle, a
 * duplicate id, an unknown parent or an unregistered repo. `dispatch()`
 * only reads a `code` off the thrown error, so without this they surfaced
 * as -32603 "internal error" while every other validation failure on this
 * surface is -32602 (T126, QA rough edge 1). Everything else still
 * propagates untouched: a real internal fault must not be relabelled as
 * the caller's fault.
 */
async function asParamErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof StreamCycleError ||
      err instanceof AlreadyExistsError ||
      err instanceof UnknownParentStreamError ||
      err instanceof UnknownRepoError
    ) {
      throw new RpcParamError(err.message);
    }
    throw err;
  }
}

export function buildStreamRpcMethods(service: StreamService): Record<string, RpcMethodHandler> {
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
      return service.appendThread(EDGE_PRINCIPAL, requireStreamId(p.id), {
        kind: p.kind === undefined ? 'line' : requireThreadKind(p.kind),
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
