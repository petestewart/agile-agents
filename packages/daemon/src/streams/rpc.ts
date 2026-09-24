/**
 * `stream.*` RPC over a `StreamService`. Params are validated at the
 * boundary (`RpcParamError`, -32602). The principal is always `human`
 * (§2.2); agent writes go through `StreamService` via the verbs.
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
import { WorktreeRefusedError } from '../runner/worktrees';
import { EmptyRepoError } from '../store/rpc-methods';
import { AlreadyExistsError } from '../store/store';
import { RepoInPlaceError, type RepoInPlaceService } from './repo-in-place';
import {
  type StreamNode,
  type StreamPatch,
  StreamProjectError,
  type StreamService,
  UnknownParentStreamError,
  UnknownRepoError,
} from './service';

/** Every `stream.*` write from this edge is the human's. */
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

function requireRepoName(value: unknown): string {
  const repo = optionalString(value, 'repo');
  if (repo === undefined) {
    throw new RpcParamError('invalid "repo": must be a registered repo name', { repo: value });
  }
  return repo;
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

/** The patch a human may send. `agent` is refused here so the error says why (the store would reject it, D11). */
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
  if (params.parent !== undefined) patch.parent = requireStreamId(params.parent);
  // §6.4's per-stream opt-out. `'on'` just clears it, so the repo/home default decides.
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
  StreamProjectError,
  RepoInPlaceError,
  WorktreeRefusedError,
  EmptyRepoError,
);

/**
 * With `reply`, a plain human `line` goes through `sayAndAnswer` (the
 * composer's path), so `agile stream say` prompts the live worker and
 * closes its open questions, as the web does.
 */
export interface StreamRpcOptions {
  reply?: ThreadReplyDeps;
  /** T204: create and start the node's agent (`AttachService.createNode`). */
  create?: StreamService['create'];
  /** T205: `node.add_repo` / `node.switch_repo` (projects-design §7). */
  repoInPlace?: RepoInPlaceService;
}

export function buildStreamRpcMethods(
  service: StreamService,
  options: StreamRpcOptions = {},
): Record<string, RpcMethodHandler> {
  const repoInPlace = options.repoInPlace;
  const reshapes: Record<string, RpcMethodHandler> =
    repoInPlace === undefined
      ? {}
      : {
          'node.add_repo': async (params) => {
            const p = requireObject(params);
            const id = requireStreamId(p.id);
            const repo = requireRepoName(p.repo);
            return asParamErrors(() => repoInPlace.addRepo(id, repo));
          },
          'node.switch_repo': async (params) => {
            const p = requireObject(params);
            const id = requireStreamId(p.id);
            const repo = requireRepoName(p.repo);
            return asParamErrors(() => repoInPlace.switchRepo(id, repo));
          },
        };
  return {
    ...reshapes,
    'stream.create': async (params) =>
      asParamErrors(() =>
        (options.create ?? service.create.bind(service))(
          EDGE_PRINCIPAL,
          validateStreamCreateInput(requireObject(params)),
          {
            requireProject: true,
          },
        ),
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

    /** T228 (P8): `{id, on, remove?}` adds or drops a `waits_on` edge. */
    'node.wait': async (params) => {
      const p = requireObject(params);
      const id = requireStreamId(p.id);
      const on = requireStreamId(p.on);
      const remove = optionalBoolean(p.remove, 'remove');
      return asParamErrors(() =>
        service.wait(EDGE_PRINCIPAL, id, on, remove === undefined ? {} : { remove }),
      );
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
