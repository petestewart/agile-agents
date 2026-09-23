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
  type ClassifierBands,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type Event,
  RULE_STATUSES,
  type RuleStatus,
  RuleWriteError,
  validateRulePatch,
  validateRuleProposal,
} from '@agile-agents/shared';
import type { Classifier } from '../classifier';
import { RpcParamError } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { buildEvent } from '../store/events';
import { AlreadyExistsError } from '../store/store';
import { type RuleEvalReport, evaluableRules, runRuleEvals } from './evals';
import { RULE_REPORT_DEFAULT_DAYS, buildRuleReport } from './report';
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

/** `--days N` for the pruning report: a positive whole number of days. */
function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new RpcParamError(`invalid "${field}": must be a positive whole number of days`, {
      [field]: value,
    });
  }
  return n;
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

/**
 * What `rule.test` (§5.6) needs beyond the service: the configured
 * classifier and the bands to read its answers with. Optional, because a
 * home with no classifier still gets every other `rule.*` method — the
 * eval verb is the only one that needs to make a call, and it says so
 * rather than the whole table disappearing.
 */
export interface RuleRpcEvalDeps {
  classifier: Classifier;
  bands: ClassifierBands;
  /**
   * T155: the classifier's per-call timeout, reported by `rule.test
   * {plan: true}` so the CLI can size its RPC deadline to the run (one call
   * per example). Defaults to the config default.
   */
  timeout_ms?: number;
  /** T155: where each eval call's `classifier_call` event goes (§6.2). */
  events?: { appendEvent(event: Event, options?: { commit?: 'deferred' }): Promise<unknown> };
}

/** `rule.test {plan: true}`: what a run would cost, without making a call. */
export interface RuleEvalPlan {
  rules: number;
  examples: number;
  timeout_ms: number;
}

/**
 * §5.6's evals, with a `classifier_call` event per call (T155). Shared by
 * `rule.test` and the cockpit's "Test examples" (T163), so both report the
 * same thing and log the same events.
 */
export function testRules(
  service: RulesService,
  evals: RuleRpcEvalDeps,
  id?: string,
): Promise<RuleEvalReport> {
  const events = evals.events;
  return runRuleEvals({
    rules: service,
    classifier: evals.classifier,
    bands: evals.bands,
    ...(id !== undefined ? { ruleId: id } : {}),
    ...(events !== undefined
      ? {
          onCall: (call) =>
            events.appendEvent(
              buildEvent('classifier_call', {
                data: {
                  source: 'eval',
                  rule: call.rule,
                  rules: 1,
                  questions: 1,
                  latency_ms: call.latency_ms,
                  ...(call.band !== undefined ? { outcome: call.band } : {}),
                  ...(call.error !== undefined ? { error: call.error } : {}),
                },
              }),
              { commit: 'deferred' },
            ),
        }
      : {}),
  });
}

export function buildRuleRpcMethods(
  service: RulesService,
  evals?: RuleRpcEvalDeps,
): Record<string, RpcMethodHandler> {
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

    /**
     * §5.7's pruning view. Read-only and derived: it reports the `stats`
     * the hook path and the diff check wrote, and never retires anything —
     * the prune itself is `rule.retire`, a human decision.
     */
    'rule.report': (params) => {
      const p = params === undefined ? {} : requireObject(params);
      const days = optionalPositiveInt(p.days, 'days') ?? RULE_REPORT_DEFAULT_DAYS;
      return buildRuleReport(service, { days });
    },

    /**
     * §5.6's evals: every accepted classifier rule's examples through the
     * configured classifier, or the one rule named. Read-only — an eval is
     * not a firing, so nothing here touches `stats`.
     */
    'rule.test': async (params) => {
      const p = params === undefined ? {} : requireObject(params);
      const id = optionalString(p.id, 'id');
      if (p.plan !== undefined && typeof p.plan !== 'boolean') {
        throw new RpcParamError('invalid "plan": must be a boolean', { plan: p.plan });
      }
      if (evals === undefined) {
        throw new RpcParamError(
          'rule.test needs a classifier: set classifier.provider and a key in config.yaml (§6.2)',
        );
      }
      if (p.plan === true) {
        return asParamErrors((): RuleEvalPlan => {
          const selected = evaluableRules(service, id);
          return {
            rules: selected.length,
            examples: selected.reduce((n, rule) => n + rule.examples.length, 0),
            timeout_ms: evals.timeout_ms ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
          };
        });
      }
      return asParamErrors(() => testRules(service, evals, id));
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
