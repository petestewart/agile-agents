/**
 * `rule.*` RPC over a `RulesService`. Params are validated at the boundary
 * (`RpcParamError`, -32602). The principal is always `human` here (§2.2):
 * an agent proposes through the `propose_rule` verb, and this edge has no
 * way to act as one.
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
import { RpcParamError, optionalString, paramErrors, requireObject } from '../gates/rpc';
import type { RpcMethodHandler } from '../rpc';
import { buildEvent } from '../store/events';
import { AlreadyExistsError } from '../store/store';
import { type RuleEvalReport, evaluableRules, runRuleEvals } from './evals';
import { RULE_REPORT_DEFAULT_DAYS, buildRuleReport } from './report';
import { RuleAlreadyDecidedError, type RulesService, UnknownRuleScopeError } from './service';

/** Every `rule.*` write from this edge is the human's. */
const EDGE_PRINCIPAL = 'human' as const;

/** The `decided_by` this edge stamps when the caller names nobody. */
const DEFAULT_DECIDED_BY = 'human';

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

/** A shared-schema validation failure is caller input: -32602, not an internal fault. */
function validated<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new RpcParamError(err instanceof Error ? err.message : String(err));
  }
}

/** Errors here that are caller input: -32602, not an internal fault. */
const asParamErrors = paramErrors(
  RuleWriteError,
  UnknownRuleScopeError,
  RuleAlreadyDecidedError,
  AlreadyExistsError,
);

/**
 * What `rule.test` (§5.6) needs: the classifier and its bands. Optional:
 * without one, every other `rule.*` method still works.
 */
export interface RuleRpcEvalDeps {
  classifier: Classifier;
  bands: ClassifierBands;
  /** The per-call timeout, reported by `rule.test {plan: true}` so the CLI can size its deadline. */
  timeout_ms?: number;
  /** Where each eval call's `classifier_call` event goes (§6.2). */
  events?: { appendEvent(event: Event, options?: { commit?: 'deferred' }): Promise<unknown> };
}

/** `rule.test {plan: true}`: what a run would cost, without making a call. */
export interface RuleEvalPlan {
  rules: number;
  examples: number;
  timeout_ms: number;
}

/** §5.6's evals with a `classifier_call` event per call, shared by `rule.test` and the cockpit. */
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
    /** Always a proposal, whoever calls (§5.1); acceptance is a second act. */
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

    /** §5.3's filter for one stream, as the brief and the hook see it. */
    'rule.in_scope': (params) => {
      const p = requireObject(params);
      const stream = optionalString(p.stream, 'stream');
      if (stream === undefined) {
        throw new RpcParamError('invalid "stream": must be a stream id', { stream: p.stream });
      }
      return { rules: service.inScope(stream) };
    },

    /** §5.7's pruning view: derived and read-only; pruning is `rule.retire`. */
    'rule.report': (params) => {
      const p = params === undefined ? {} : requireObject(params);
      const days = optionalPositiveInt(p.days, 'days') ?? RULE_REPORT_DEFAULT_DAYS;
      return buildRuleReport(service, { days });
    },

    /** §5.6's evals for every accepted classifier rule, or one. An eval is not a firing: no `stats`. */
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

    /** §3.1's edit-then-accept. Decisions and provenance are refused by name, not as unknown keys. */
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
