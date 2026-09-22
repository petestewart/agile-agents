/**
 * `attach.*` and `agent.*` RPC (T130), following the `streams/rpc.ts`
 * precedent: every handler validates its params at the boundary and throws
 * `RpcParamError` (-32602) rather than letting a `TypeError` reach
 * `dispatch()`.
 *
 * **Principals are stamped here, never read from params** (design §2.2).
 * `attach.*` is the operator's edge, so the attach itself is a `human`
 * action. `agent.*` is the verb family, and it is the *only* RPC family
 * that takes a `session`: the session id is what stamps the `agent`
 * principal inside `VerbService`, and the edge still rejects an explicit
 * `principal` in the body exactly as `stream.*` does.
 */

import { AGENT_VERBS, UlidSchema } from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { WorktreeRefusedError } from '../runner/worktrees';
import { NotFoundError } from '../store/store';
import { UnknownVendorError } from './resolve';
import { type AttachService, StreamBusyError, UnregisteredRepoError } from './service';
import { NoWorktreeError, UnknownSessionError, type VerbService, verbHandlers } from './verbs';

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  const p = params as Record<string, unknown>;
  if ('principal' in p) {
    throw new RpcParamError(
      'invalid "principal": the principal is stamped by the daemon, not supplied by the caller',
      { principal: p.principal },
    );
  }
  return p;
}

function requireStreamId(value: unknown): string {
  const result = UlidSchema.safeParse(value);
  if (!result.success) {
    throw new RpcParamError('invalid "stream": must be a 26-character Crockford-base32 ULID', {
      stream: value,
    });
  }
  return result.data;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParamError(`invalid "${field}": must be a non-empty string`, { [field]: value });
  }
  return value;
}

/**
 * Caller-input failures on this surface. Without this they would surface as
 * -32603 "internal error" while every other validation failure here is
 * -32602; a genuine internal fault still propagates untouched.
 */
async function asParamErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof StreamBusyError ||
      err instanceof UnregisteredRepoError ||
      err instanceof UnknownVendorError ||
      err instanceof UnknownSessionError ||
      err instanceof NoWorktreeError ||
      err instanceof WorktreeRefusedError ||
      err instanceof NotFoundError
    ) {
      throw new RpcParamError(err.message);
    }
    throw err;
  }
}

export function buildAttachRpcMethods(
  attach: AttachService,
  verbs: VerbService,
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
      const result = await asParamErrors(() =>
        attach.attach(stream, {
          ...(optionalString(p.vendor, 'vendor') !== undefined
            ? { vendor: p.vendor as string }
            : {}),
          ...(optionalString(p.model, 'model') !== undefined ? { model: p.model as string } : {}),
          ...(optionalString(p.effort, 'effort') !== undefined
            ? { effort: p.effort as string }
            : {}),
          ...(role !== undefined ? { role } : {}),
        }),
      );
      // The handle is in-process only — the wire carries the record.
      return { session: result.session, stream: result.stream };
    },

    /**
     * `agile detach <stream>` — stops whatever is live on the stream. T137:
     * `stopped` is the truth ("was anything actually stopped"), not a
     * constant, and the session ids come back so the CLI can print them.
     */
    'attach.stop': async (params) => {
      const p = requireObject(params);
      const stream = requireStreamId(p.stream);
      const sessions = await asParamErrors(() => attach.stop(stream, undefined, { detach: true }));
      return { stopped: sessions.length > 0, sessions, stream };
    },
  };

  // The eight verbs, one RPC method each. `agent.*` is the only family that
  // takes a session, and `VerbService` resolves it to a stream through the
  // registry rather than trusting anything else in the body.
  for (const [verb, handler] of Object.entries(verbHandlers(verbs))) {
    methods[`agent.${verb}`] = async (params) =>
      asParamErrors(async () => handler(requireObject(params)));
  }

  return methods;
}

/** The RPC method names the MCP bridge publishes, in design order. */
export const AGENT_VERB_METHODS = AGENT_VERBS.map((verb) => `agent.${verb}` as const);
