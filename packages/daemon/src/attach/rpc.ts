/**
 * `attach.*` and `agent.*` RPC. Params are validated at the boundary
 * (`RpcParamError`, -32602), and an explicit `principal` is refused (§2.2):
 * `attach.*` is the operator's edge, and `agent.*` (the verbs) is the one
 * family that takes a `session`, which `VerbService` resolves itself.
 */

import {
  RpcParamError,
  optionalString,
  paramErrors,
  requireObject as requireParams,
  requireStreamId,
} from '../gates/rpc';
import type { LandingService } from '../landing/service';
import { LandRefusedError } from '../landing/service';
import type { RpcMethodHandler } from '../rpc';
import { WorktreeRefusedError } from '../runner/worktrees';
import { NotFoundError } from '../store/store';
import { UnknownVendorError } from './resolve';
import {
  type AttachService,
  ParentAttachError,
  StreamBusyError,
  UnregisteredRepoError,
} from './service';
import { NoWorktreeError, UnknownSessionError, type VerbService, verbHandlers } from './verbs';

function requireObject(params: unknown): Record<string, unknown> {
  const p = requireParams(params);
  if ('principal' in p) {
    throw new RpcParamError(
      'invalid "principal": the principal is stamped by the daemon, not supplied by the caller',
      { principal: p.principal },
    );
  }
  return p;
}

/** Errors here that are caller input: -32602, not an internal fault. */
const asParamErrors = paramErrors(
  StreamBusyError,
  UnregisteredRepoError,
  UnknownVendorError,
  UnknownSessionError,
  NoWorktreeError,
  WorktreeRefusedError,
  NotFoundError,
  ParentAttachError,
  LandRefusedError,
);

/** The picker's flags, shared by `attach.start` and `attach.resolve`. */
function flagsOf(p: Record<string, unknown>): { vendor?: string; model?: string; effort?: string } {
  const out: { vendor?: string; model?: string; effort?: string } = {};
  for (const key of ['vendor', 'model', 'effort'] as const) {
    const value = optionalString(p[key], key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function buildAttachRpcMethods(
  attach: AttachService,
  verbs: VerbService,
  landing?: LandingService,
): Record<string, RpcMethodHandler> {
  const methods: Record<string, RpcMethodHandler> = {
    /** `agile attach <stream>` / `agile review <stream>` [--vendor] [--model] [--effort] [--role worker|reviewer]. */
    'attach.start': async (params) => {
      const p = requireObject(params);
      const stream = requireStreamId(p.stream);
      const role = optionalString(p.role, 'role');
      if (role !== undefined && role !== 'worker' && role !== 'reviewer') {
        throw new RpcParamError('invalid "role": must be "worker" or "reviewer"', { role });
      }
      if (p.force !== undefined && typeof p.force !== 'boolean') {
        throw new RpcParamError('invalid "force": must be a boolean', { force: p.force });
      }
      const result = await asParamErrors(() =>
        attach.attach(stream, {
          ...flagsOf(p),
          ...(role !== undefined ? { role } : {}),
          ...(p.force === true ? { force: true } : {}),
        }),
      );
      // The handle is in-process only; the wire carries the record.
      return { session: result.session, stream: result.stream };
    },

    /** T176 `agile resolve <stream>`: a worker told to merge the target in and fix the conflicted files. */
    'attach.resolve': async (params) => {
      const p = requireObject(params);
      const stream = requireStreamId(p.stream);
      if (landing === undefined) throw new RpcParamError('landing is not available');
      const result = await asParamErrors(() =>
        attach.attach(stream, {
          ...flagsOf(p),
          force: true,
          briefAppendix: landing.resolvePrompt(stream),
        }),
      );
      return { session: result.session, stream: result.stream };
    },

    /** `agile detach <stream>`: stops what is live; `stopped` is the truth, and the ids come back to print. */
    'attach.stop': async (params) => {
      const p = requireObject(params);
      const stream = requireStreamId(p.stream);
      const sessions = await asParamErrors(() => attach.stop(stream, undefined, { detach: true }));
      return { stopped: sessions.length > 0, sessions, stream };
    },
  };

  // The eight verbs, one method each; `VerbService` resolves the session.
  for (const [verb, handler] of Object.entries(verbHandlers(verbs))) {
    methods[`agent.${verb}`] = async (params) =>
      asParamErrors(async () => handler(requireObject(params)));
  }

  return methods;
}
