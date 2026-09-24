/**
 * Diff-level rules at landing (§8.2): accepted classifier rules with stage
 * `diff` or `both`, one call with the scrubbed stream diff as state (over
 * budget: split per file, take the max). DENY blocks the land, naming the
 * rule; ROUTE raises an inbox item and landing waits. Some rules are only
 * checkable against the whole change, and this is the only enforcement a
 * hookless vendor gets.
 *
 * Shared with the hook rather than re-derived: the bands (`bandFor`), the
 * scope filter (`KnowledgeService.inScope`) and the fail-closed scrub (§6.5).
 *
 * A route's gate is keyed on a digest of the stream, target and diff, so
 * pressing Land again reuses the answer, and a changed diff is a new
 * question (an approval is one call, not a standing permission).
 */

import { createHash } from 'node:crypto';
import type {
  ClassifierConfig,
  GateCall,
  GateKind,
  HilId,
  HilRequest,
  KnowledgeEnforcement,
  KnowledgeId,
  KnowledgeItem,
  Policy,
  RepoEntry,
  Stream,
} from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { Answer, Classifier, Noul } from '../classifier';
import { bandFor, classifierEnabled, noulFor, scrub } from '../classifier';
import type { GateRequestContext } from '../gates/service';
import { type RuleStatsOutcome, knowledgeMatchesPaths } from '../knowledge/service';
import type { DiffRuleContext, DiffRuleVerdict, DiffRules } from './service';

/** The slice of `KnowledgeService` this tier needs. */
export interface DiffRuleRules {
  inScope(streamId: string, enforcement?: KnowledgeEnforcement): KnowledgeItem[];
  recordFired(id: string, outcome: RuleStatsOutcome): Promise<void>;
}

/** The slice of `GateService` a routed diff needs. */
export interface DiffRuleGates {
  list(): HilRequest[];
  request(gate: GateKind, ctx: GateRequestContext): Promise<HilRequest>;
  consume(id: HilId): Promise<HilRequest>;
}

/** The thread writer, for §6.4's `hook_unchecked` entry. */
export interface DiffRuleThread {
  appendThread(
    principal: 'daemon',
    streamId: string,
    entry: { kind: 'event'; body: string },
  ): Promise<unknown>;
}

export interface ClassifierDiffRulesOptions {
  rules: DiffRuleRules;
  classifier: Classifier;
  /** `classifier:` from `config.yaml`: bands, budget and the opt-out. */
  config: ClassifierConfig;
  streams: DiffRuleThread;
  policy: () => Policy;
  repos: () => Record<string, RepoEntry>;
  /** Without it, a routed diff degrades to a refusal (nowhere to put the card). */
  gates?: DiffRuleGates;
  /** Key lookup for `classifierEnabled`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function cap(text: string): string {
  return text.length > MESSAGE_BODY_MAX_CHARS ? text.slice(0, MESSAGE_BODY_MAX_CHARS) : text;
}

/**
 * One file whose own diff is over the budget is sent as a prefix with this
 * marker: an oversized call the provider rejects would fall into §6.4 and
 * stop checking the rule, while a prefix still answers for what fits.
 * Truncation happens after the scrub, so a secret is never split across
 * the cut and left half-redacted.
 */
export const TRUNCATION_MARKER = '\n[truncated: file diff exceeds the classifier budget]';

export function truncateTo(state: string, budget: number): string {
  if (state.length <= budget) return state;
  const room = Math.max(0, budget - TRUNCATION_MARKER.length);
  return `${state.slice(0, room)}${TRUNCATION_MARKER}`;
}

/** `R-…` is unreadable on an inbox card; a built-in's `name` is not. */
function nameOf(rule: KnowledgeItem): string {
  return rule.name ?? rule.id;
}

/** §8.2's per-file split on `diff --git` sections; any preamble stays with the first section. */
export function splitDiffByFile(diff: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      parts.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(current.join('\n'));
  return parts.filter((part) => part.trim().length > 0);
}

/** Every repo-relative path a unified diff touches (both sides of a rename). */
export function changedFilesOf(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match === null) continue;
    files.add(match[1] as string);
    files.add(match[2] as string);
  }
  return [...files];
}

/**
 * The gate call for a routed diff: its digest is what an approval is good
 * for. `origin: 'diff_rules'` is what `wireLandGateResolution` keys on
 * (answering one performs a merge), and the hook path never sets it.
 */
export function diffCall(ctx: DiffRuleContext, diff: string, step?: string): GateCall {
  const fingerprint = createHash('sha256')
    .update([ctx.stream.id, ctx.branch, ctx.target, diff, ...(step ? [step] : [])].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return {
    tool: 'land',
    path: `${ctx.branch} → ${ctx.target}`,
    fingerprint,
    origin: 'diff_rules',
  };
}

/** This stream's `classifier_review` gates on this exact diff, newest first. */
function matchingGates(gates: DiffRuleGates, stream: Stream, call: GateCall): HilRequest[] {
  return gates
    .list()
    .filter(
      (gate) =>
        gate.gate === 'classifier_review' &&
        gate.stream === stream.id &&
        gate.call?.origin === 'diff_rules' &&
        gate.call?.fingerprint === call.fingerprint,
    )
    .sort((a, b) =>
      a.requested_at === b.requested_at ? 0 : a.requested_at < b.requested_at ? 1 : -1,
    );
}

/**
 * An answer the human already gave for this diff (an approval is spent
 * here), or `undefined` to ask the check. Shared by the classifier step and
 * the reviewer step (T262), each with its own fingerprint.
 */
export async function answeredDiffGate(
  gates: DiffRuleGates | undefined,
  stream: Stream,
  call: GateCall,
): Promise<DiffRuleVerdict | undefined> {
  if (gates === undefined) return undefined;
  const candidates = matchingGates(gates, stream, call);
  const approved = candidates.find(
    (gate) => gate.decision === 'approve' && gate.consumed_at === undefined,
  );
  if (approved !== undefined) {
    await gates.consume(approved.id);
    return { decision: 'allow' };
  }
  const pending = candidates.find((gate) => gate.status === 'pending');
  if (pending !== undefined) {
    return {
      decision: 'route',
      gate: pending,
      reason: `waiting on ${pending.id} — ${pending.summary ?? 'a ship check routed this land'}`,
    };
  }
  const denied = candidates.find((gate) => gate.decision === 'deny');
  if (denied !== undefined) {
    return {
      decision: 'deny',
      reason: cap(`${denied.id} was denied: ${denied.note ?? 'no reason given'}`),
    };
  }
  return undefined;
}

export class ClassifierDiffRules implements DiffRules {
  constructor(private readonly options: ClassifierDiffRulesOptions) {}

  async check(ctx: DiffRuleContext): Promise<DiffRuleVerdict> {
    const candidates = this.options.rules
      .inScope(ctx.stream.id, 'ship')
      .filter((rule) => rule.check?.by === 'classifier');
    if (candidates.length === 0) return { decision: 'allow' };

    const diff = ctx.diff();
    // `paths` against the files the diff changes (T261).
    const changed = changedFilesOf(diff);
    const rules = candidates.filter((rule) => knowledgeMatchesPaths(rule, changed));
    if (rules.length === 0) return { decision: 'allow' };
    const call = diffCall(ctx, diff);

    // The human may already have answered this exact diff.
    const answered = await answeredDiffGate(this.options.gates, ctx.stream, call);
    if (answered !== undefined) return answered;

    let answers: Map<string, Answer>;
    try {
      answers = await this.ask(ctx, rules, diff);
    } catch (error) {
      return await this.failPolicy(ctx.stream, rules, error);
    }

    // Deny wins over route wins over allow; the first denying rule is named.
    let routed: { rule: KnowledgeItem; answer: Answer } | undefined;
    let verdict: DiffRuleVerdict = { decision: 'allow' };
    for (const rule of rules) {
      const answer = answers.get(rule.id);
      if (answer === undefined) {
        // A skipped question: §6.4 applies to that rule alone. A rule that
        // causes the deny is recorded `violated`, never merely `fired`.
        await this.noteUnchecked(ctx.stream, [rule], 'no answer for this rule');
        await this.options.rules.recordFired(rule.id, rule.critical ? 'violated' : 'fired');
        if (rule.critical) {
          return {
            decision: 'deny',
            rule: nameOf(rule),
            reason: `${nameOf(rule)} is critical and the classifier returned no answer for it`,
          };
        }
        continue;
      }
      const band = bandFor(answer, this.options.config.bands);
      await this.options.rules.recordFired(
        rule.id,
        band === 'deny' ? 'violated' : band === 'route' ? 'routed' : 'fired',
      );
      if (band === 'deny' && verdict.decision !== 'deny') {
        verdict = {
          decision: 'deny',
          rule: nameOf(rule),
          reason: cap(`${nameOf(rule)}: ${rule.text} (probability ${answer.probability})`),
        };
      }
      if (band === 'route' && routed === undefined) routed = { rule, answer };
    }
    if (verdict.decision === 'deny') return verdict;
    if (routed !== undefined) return await this.route(ctx, call, routed.rule, routed.answer);
    return { decision: 'allow' };
  }

  /**
   * One call for the whole diff, or one per file over budget with the max
   * per rule ("one bad file makes the whole diff bad", D14).
   */
  private async ask(
    ctx: DiffRuleContext,
    rules: KnowledgeItem[],
    diff: string,
  ): Promise<Map<string, Answer>> {
    if (!this.enabled(ctx.stream)) {
      throw new Error('classifier tier is off for this stream');
    }
    const questions: Noul[] = rules.map(noulFor);
    const header = `Stream ${ctx.stream.id} (${ctx.stream.title}) landing ${ctx.branch} into ${ctx.target}.`;
    const budget = this.options.config.state_max_chars;
    const whole = scrub(`${header}\n\n${diff}`);
    const states =
      whole.length <= budget
        ? [whole]
        : splitDiffByFile(diff).map((part) => truncateTo(scrub(`${header}\n\n${part}`), budget));

    const best = new Map<string, Answer>();
    for (const state of states) {
      const answers = await this.options.classifier.ask(state, questions);
      for (const answer of answers) {
        const current = best.get(answer.id);
        if (current === undefined || answer.probability > current.probability) {
          best.set(answer.id, answer);
        }
      }
    }
    return best;
  }

  private enabled(stream: Stream): boolean {
    const repo = stream.repo === undefined ? undefined : this.options.repos()[stream.repo];
    return classifierEnabled({
      stream,
      repo,
      config: this.options.config,
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    });
  }

  /**
   * §6.4: critical rules deny, the rest allow with a `hook_unchecked` entry.
   * The opt-out and a missing key land here too (nothing to call).
   */
  private async failPolicy(
    stream: Stream,
    rules: KnowledgeItem[],
    error: unknown,
  ): Promise<DiffRuleVerdict> {
    const why = error instanceof Error ? error.message : String(error);
    const critical = rules.filter((rule) => rule.critical);
    const rest = rules.filter((rule) => !rule.critical);
    if (rest.length > 0) {
      await this.noteUnchecked(stream, rest, why);
      for (const rule of rest) await this.options.rules.recordFired(rule.id, 'fired');
    }
    if (critical.length === 0) return { decision: 'allow' };
    for (const rule of critical) await this.options.rules.recordFired(rule.id, 'violated');
    const named = critical.map(nameOf).join(', ');
    return {
      decision: 'deny',
      rule: nameOf(critical[0] as KnowledgeItem),
      reason: cap(`classifier unavailable (${why}); critical diff rules deny: ${named}`),
    };
  }

  /** §6.4's visible mark. Stats are the caller's: a critical rule that goes on to deny is `violated`. */
  private async noteUnchecked(stream: Stream, rules: KnowledgeItem[], why: string): Promise<void> {
    await this.options.streams.appendThread('daemon', stream.id, {
      kind: 'event',
      body: cap(`hook_unchecked: diff rules ${rules.map(nameOf).join(', ')} not checked — ${why}`),
    });
  }

  /** §8.2's "ROUTE ⇒ inbox item, landing waits". */
  private async route(
    ctx: DiffRuleContext,
    call: GateCall,
    rule: KnowledgeItem,
    answer: Answer,
  ): Promise<DiffRuleVerdict> {
    const summary = cap(`${nameOf(rule)}: ${rule.text} (probability ${answer.probability})`);
    const gates = this.options.gates;
    if (gates === undefined) {
      // Nowhere to put the card: refuse rather than merge unreviewed.
      return { decision: 'route', rule: nameOf(rule), reason: summary };
    }
    const gate = await gates.request('classifier_review', {
      policy: this.options.policy(),
      stream: ctx.stream.id,
      call,
      summary,
      // The routing rule, so the human's deny counts as its violation.
      rule: rule.id as KnowledgeId,
    });
    return {
      decision: 'route',
      rule: nameOf(rule),
      gate,
      reason: cap(`${summary} — routed to your inbox as ${gate.id}; landing waits`),
    };
  }
}
