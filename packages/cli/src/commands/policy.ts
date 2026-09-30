/**
 * `agile policy show|set|choose-again|try` (T482, T483, design/model-routing.md §4–§5):
 * model choice over the daemon's `policy.*` RPC, the same service as
 * Settings → Agents → Model choice and a node's Details. With neither
 * `--project` nor `--node` it is the home's (the default every project
 * inherits, D54). A value of `inherit` clears the field on that layer.
 */

import {
  EFFORT_LEVELS,
  MODEL_ESCALATIONS,
  MODEL_POLICY_FIELDS,
  MODEL_POLICY_MODES,
  type ModelPolicy,
  type ModelPolicyField,
  type ModelPolicyPartial,
  type ModelPolicyTryResult,
  type PolicySource,
  ROUTING_CRITERIA,
  type ResolvedModelPolicy,
  policySourceWords,
} from '@agile-agents/shared';
import type { ParsedArgs } from '../args';
import { optionalString, requirePositional } from '../args';
import { callRpc } from '../client';
import { printFields, printJson } from '../format';

interface PolicyView {
  policy: ModelPolicyPartial;
  resolved: ResolvedModelPolicy;
  node?: { id: string; title: string };
  project?: { id: string; name: string };
  pick?: {
    vendor: string;
    model: string;
    effort?: string;
    how: string;
    why: string;
    note?: string;
  };
  choose_again?: boolean;
}

function layerParams(args: ParsedArgs): { project?: string; node?: string } {
  const project = optionalString(args.options, 'project');
  const node = optionalString(args.options, 'node');
  if (project !== undefined && node !== undefined) {
    throw new Error('agile policy: name --project or --node, not both');
  }
  return {
    ...(project !== undefined ? { project } : {}),
    ...(node !== undefined ? { node } : {}),
  };
}

/** `effort-ceiling` and `effort_ceiling` both name the field. */
export function policyField(raw: string): ModelPolicyField {
  const field = raw.replace(/-/g, '_');
  if (!(MODEL_POLICY_FIELDS as readonly string[]).includes(field)) {
    throw new Error(
      `agile policy set: unknown field ${raw} (one of ${MODEL_POLICY_FIELDS.join(', ')})`,
    );
  }
  return field as ModelPolicyField;
}

function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  const v = value.replace(/-/g, '_');
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`agile policy set ${field}: ${value} is not one of ${allowed.join(', ')}`);
  }
  return v as T;
}

/**
 * One field's value from the command line: `inherit` → `null` (the layer
 * stops setting it). Presets are `vendor/model` pairs, comma-separated, or
 * `any` (any installed model); weights `clarity=2,stakes=3`; pinned rules JSON.
 */
export function parsePolicyValue(field: ModelPolicyField, raw: string): unknown {
  const value = raw.trim();
  if (value === 'inherit') return null;
  switch (field) {
    case 'mode':
      return oneOf(field, value, MODEL_POLICY_MODES);
    case 'escalation':
      return oneOf(field, value, MODEL_ESCALATIONS);
    case 'effort_ceiling':
      return oneOf(field, value, EFFORT_LEVELS);
    case 'quality': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        throw new Error(
          'agile policy set quality: a whole number from 0 (speed & cost) to 100 (quality)',
        );
      }
      return n;
    }
    case 'presets': {
      if (value === 'any' || value === 'none' || value === '') return [];
      return value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((pair) => {
          const at = pair.indexOf('/');
          if (at <= 0 || at === pair.length - 1) {
            throw new Error(`agile policy set presets: ${pair} is not vendor/model`);
          }
          return { vendor: pair.slice(0, at), model: pair.slice(at + 1) };
        });
    }
    case 'weights': {
      const out: Record<string, number> = {};
      for (const part of value
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)) {
        const [name = '', w = ''] = part.split('=');
        if (!(ROUTING_CRITERIA as readonly string[]).includes(name)) {
          throw new Error(
            `agile policy set weights: ${name} is not one of ${ROUTING_CRITERIA.join(', ')}`,
          );
        }
        out[name] = Number(w);
      }
      return out;
    }
    case 'pinned_rules':
      try {
        return JSON.parse(value);
      } catch {
        throw new Error('agile policy set pinned_rules: a JSON list of {when, pick}');
      }
    default:
      return raw;
  }
}

/** A resolved field's value in words. */
export function policyValueText(field: ModelPolicyField, policy: ModelPolicy): string {
  switch (field) {
    case 'presets':
      return policy.presets.length === 0
        ? 'any installed model'
        : policy.presets.map((p) => `${p.vendor}/${p.model}`).join(', ');
    case 'pinned_rules':
      return policy.pinned_rules.length === 0
        ? 'none'
        : `${policy.pinned_rules.length} rule${policy.pinned_rules.length === 1 ? '' : 's'}`;
    case 'guidance':
      return policy.guidance === '' ? '(none)' : JSON.stringify(policy.guidance);
    case 'weights':
      return ROUTING_CRITERIA.map((c) => `${c} ${policy.weights[c]}`).join(' · ');
    default:
      return String(policy[field]);
  }
}

function printView(view: PolicyView, here: 'node' | 'project' | 'home'): void {
  const heading =
    here === 'node'
      ? `node ${view.node?.title ?? ''}`
      : here === 'project'
        ? `project ${view.project?.name ?? ''}`
        : 'home (every project inherits it)';
  console.log(`model choice: ${heading}`);
  printFields(
    MODEL_POLICY_FIELDS.map((field): [string, string] => [
      field,
      `${policyValueText(field, view.resolved.policy)}  (${policySourceWords(
        view.resolved.sources[field] as PolicySource,
        here,
      )})`,
    ]),
  );
  if (view.pick !== undefined) {
    const effort = view.pick.effort !== undefined ? ` · ${view.pick.effort}` : '';
    console.log(
      `last pick: ${view.pick.vendor}/${view.pick.model}${effort} (${view.pick.how}: ${view.pick.why})`,
    );
  }
  if (view.choose_again === true) console.log('choose again: the next start picks afresh');
}

export async function runPolicyShow(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const layer = layerParams(args);
  const view = await callRpc<PolicyView>(socketPath, 'policy.show', layer);
  if (json) printJson(view);
  else
    printView(
      view,
      layer.node !== undefined ? 'node' : layer.project !== undefined ? 'project' : 'home',
    );
  return 0;
}

/** `agile policy set <field> <value…> [--project P | --node N]`. */
export async function runPolicySet(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const field = policyField(requirePositional(args, 0, 'field'));
  requirePositional(args, 1, 'value');
  // The guidance is free text: every word after the field.
  const raw = args.positionals.slice(1).join(' ');
  const layer = layerParams(args);
  const view = await callRpc<PolicyView>(socketPath, 'policy.set', {
    ...layer,
    patch: { [field]: parsePolicyValue(field, raw) },
  });
  if (json) printJson(view);
  else
    printView(
      view,
      layer.node !== undefined ? 'node' : layer.project !== undefined ? 'project' : 'home',
    );
  return 0;
}

/** `agile policy choose-again --node N`: the node's next start picks its model afresh (D55). */
export async function runPolicyChooseAgain(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  const node = optionalString(args.options, 'node') ?? args.positionals[0];
  if (node === undefined) throw new Error('agile policy choose-again: --node <id> is required');
  const view = await callRpc<PolicyView>(socketPath, 'policy.choose_again', { node });
  if (json) printJson(view);
  else
    console.log(
      `agile policy choose-again: ${view.node?.title ?? node} picks its model afresh at its next start`,
    );
  return 0;
}

/** The five scores in one line: "clarity 4.6 · verifiability 4.2 · …". */
export function scoresText(scores: NonNullable<ModelPolicyTryResult['scores']>): string {
  return ROUTING_CRITERIA.map((c) => `${c} ${scores[c].toFixed(1)}`).join(' · ');
}

/**
 * `agile policy try "<task text>" [--project P | --node N]` (T483): the
 * chooser's scores and pick for a pasted task under that layer's policy, as
 * Choose would; nothing starts. It may call Jev.
 */
export async function runPolicyTry(
  socketPath: string,
  args: ParsedArgs,
  json: boolean,
): Promise<number> {
  requirePositional(args, 0, 'task text');
  const text = args.positionals.join(' ');
  const result = await callRpc<ModelPolicyTryResult>(socketPath, 'policy.try', {
    ...layerParams(args),
    text,
  });
  if (json) {
    printJson(result);
    return 0;
  }
  console.log(result.line);
  const fields: Array<[string, string]> = [];
  if (result.scores !== undefined) fields.push(['scores', scoresText(result.scores)]);
  if (result.topic !== undefined) fields.push(['topic', result.topic]);
  if (result.confidence !== undefined) {
    fields.push(['confidence', result.confidence.toFixed(2)]);
  }
  fields.push(['decided by', result.pick.how + (result.pick.base ? ` (${result.pick.base})` : '')]);
  if (result.failed !== undefined) fields.push(['without Jev', result.failed.words]);
  if (result.mode !== 'choose') {
    fields.push(['note', `the mode here is ${result.mode}: a start would not use this pick`]);
  }
  printFields(fields);
  return 0;
}
