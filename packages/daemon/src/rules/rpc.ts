/**
 * `rule.*` RPC methods over a `RulesService` (T140). Same contract as
 * `streams/rpc.ts`: every handler validates its params at the boundary and
 * throws `RpcParamError` (-32602) rather than letting a destructuring
 * `TypeError` reach `dispatch()`.
 *
 * **The principal is stamped here, never read from params** (design §2.2).
 * This edge serves the CLI and the UI, so every call is `human`. An agent
 * proposes through the `propose_rule` verb (`attach/verbs.ts`), which calls
 * `RulesService` directly with the `agent` principal — there is no way to
 * reach this table as an agent, and no `--as` flag anywhere on this path.
 */

import {
  RULE_STATUSES,
  type RuleStatus,
  RuleWriteError,
  validateRulePatch,
  validateRuleProposal,
} from '@agile-agents/shared';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { AlreadyExistsError } from '../store/store';
import { RuleAlreadyDecidedError, type RulesService, UnknownRuleScopeError } from './service';

/** Every `rule.*` write from this edge is the human's (design §2.2). */
const EDGE_PRINCIPAL = 'human' as const;

/** The `decided_by` this edge stamps when the caller names nobody. */
const DEFAULT_DECIDED_BY = 'human';

function requireObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RpcParamError('params must be an object', { params });
  }
  return params as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcParamError(`invalid "${field}": must be a non-empty string`, { [field]: value });
  }
  return value;
}

function requireRuleId(value: unknown): string {
  const id = optionalString(value, 'id');
  if (id === undefined) {
    throw new RpcParamError('invalid "id": must be a rule id (R-<ulid>)', { id: value });
  }
  return id;
}

function optionalStatus(value: unknown): RuleStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(RULE_STATUSES as readonly string[]).includes(value)) {
    throw new RpcParamError(`invalid "status": must be one of ${RULE_STATUSES.join(', ')}`, {
      status: value,
    });
  }
  return value as RuleStatus;
}

/**
 * Errors the service/store raise for **caller input** — an unknown scope
 * ref, a duplicate id, a second decision on a decided rule, or any
 * `RuleWriteError` (the principal split and the tier invariants, §5.1/§5.6).
 * `dispatch()` only reads a `code` off the thrown error, so without this
 * they would surface as -32603 "internal error" while every other
 * validation failure on this surface is -32602.
 */
/**
 * A shared-schema validation failure is caller input too: `validateRule*`
 * throws a plain `Error` (it is a pure shared function and knows nothing
 * about JSON-RPC), so the edge relabels it -32602 rather than letting a
 * rejected unknown key read as an internal daemon fault.
 */
function validated<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new RpcParamError(err instanceof Error ? err.message : String(err));
  }
}

async function asParamErrors<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof RuleWriteError ||
      err instanceof UnknownRuleScopeError ||
      err instanceof RuleAlreadyDecidedError ||
      err instanceof AlreadyExistsError
    ) {
      throw new RpcParamError(err.message);
    }
    throw err;
  }
}

export function buildRuleRpcMethods(service: RulesService): Record<string, RpcMethodHandler> {
  return {
    /**
     * A create is always a *proposal*, whoever calls it (§5.1): the human's
     * authority lives in the accept, which is a second, explicit act.
     */
    'rule.create': async (params) =>
      asParamErrors(() =>
        service.create(
          EDGE_PRINCIPAL,
          validated(() => validateRuleProposal(requireObject(params))),
        ),
      ),

    'rule.get': (params) => {
      const p = requireObject(params);
      return service.get(requireRuleId(p.id));
    },

    'rule.list': (params) => {
      const p = params === undefined ? {} : requireObject(params);
      const status = optionalStatus(p.status);
      const scope = optionalString(p.scope, 'scope');
      return {
        rules: service.list({
          ...(status !== undefined ? { status } : {}),
          ...(scope !== undefined ? { scope } : {}),
        }),
      };
    },

    /** §5.3's filter, for one stream — the same call the brief and the hook make. */
    'rule.in_scope': (params) => {
      const p = requireObject(params);
      const stream = optionalString(p.stream, 'stream');
      if (stream === undefined) {
        throw new RpcParamError('invalid "stream": must be a stream id', { stream: p.stream });
      }
      return { rules: service.inScope(stream) };
    },

    'rule.accept': async (params) => {
      const p = requireObject(params);
      const id = requireRuleId(p.id);
      const by = optionalString(p.by, 'by') ?? DEFAULT_DECIDED_BY;
      return asParamErrors(() => service.accept(id, by));
    },

    'rule.retire': async (params) => {
      const p = requireObject(params);
      const id = requireRuleId(p.id);
      const by = optionalString(p.by, 'by') ?? DEFAULT_DECIDED_BY;
      return asParamErrors(() => service.retire(id, by));
    },

    /**
     * §3.1's "edit-then-accept". `RulePatchSchema` is exactly the fields a
     * human may edit, so `status`, `decided_*` and `provenance` cannot be
     * smuggled in through an update; the explicit checks above name *why*
     * rather than letting them fail as unknown keys.
     */
    'rule.update': async (params) => {
      const { id, ...rest } = requireObject(params);
      const ruleId = requireRuleId(id);
      if ('status' in rest || 'decided_at' in rest || 'decided_by' in rest) {
        throw new RpcParamError(
          'invalid patch: status/decided_at/decided_by are set by rule.accept and rule.retire, not by an update',
        );
      }
      if ('provenance' in rest) {
        throw new RpcParamError('invalid "provenance": a rule’s provenance is immutable');
      }
      return asParamErrors(() => service.update(EDGE_PRINCIPAL, ruleId, validateRulePatch(rest)));
    },
  };
}
