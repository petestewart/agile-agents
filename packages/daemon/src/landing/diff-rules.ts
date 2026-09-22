/**
 * Diff-level rules at landing — design/cockpit-design.md §8.2:
 *
 * ```
 * ├─ DIFF-LEVEL rules: accepted classifier rules with stage 'diff' or 'both'
 * │     one call with the full stream diff as state, scrubbed
 * │     over the classifier's budget ⇒ split per file, take the MAX
 * │     DENY ⇒ landing blocked, the rule named in the thread
 * │     ROUTE ⇒ inbox item, landing waits
 * ```
 *
 * Why this tier exists next to the per-action hook: "some rules are only
 * checkable against the whole change ('don't broaden the public API',
 * 'don't leave a TODO in shipped code'), and they are the only enforcement
 * a hookless vendor gets."
 *
 * Three things it deliberately shares with the hook's per-action band
 * rather than re-deriving:
 *
 *  - the **bands** (`classifier/bands.ts` — `bandFor`), read from
 *    `classifier.bands` in `<home>/config.yaml`, so the two callers cannot
 *    disagree about what 0.8 means;
 *  - the **scope filter** (`rulesInScope`, via `RulesService.inScope`),
 *    with §5.3's one implementation now taking a stage;
 *  - the **scrub** (§6.5), fail-closed: if it throws, nothing is sent and
 *    §6.4's fail policy applies.
 *
 * A route raises a `classifier_review` gate keyed on the *diff*: the gate's
 * `call.fingerprint` digests the stream, the target and the diff itself, so
 * pressing Land again re-uses the human's answer, and a diff that changed
 * since is a new question rather than an approval the operator never gave.
 * That is the same "an approval is one call, not a standing permission"
 * rule the route band applies per tool call (§8.1).
 */

import { createHash } from 'node:crypto';
import type {
  ClassifierConfig,
  GateCall,
  GateKind,
  HilId,
  HilRequest,
  Policy,
  RepoEntry,
  Rule,
  Stream,
} from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS, classifierQuestion } from '@agile-agents/shared';
import type { Answer, Classifier, Noul } from '../classifier';
import { bandFor, classifierEnabled, scrub } from '../classifier';
import type { GateRequestContext } from '../gates/service';
import type { RuleStatsOutcome } from '../rules/service';
import type { DiffRuleContext, DiffRuleVerdict, DiffRules } from './service';

/** The slice of `RulesService` this tier needs (the hook's `RuleSource` precedent). */
export interface DiffRuleRules {
  inScope(streamId: string, stage?: 'action' | 'diff' | 'both'): Rule[];
  recordFired(id: string, outcome: RuleStatsOutcome): Promise<void>;
}

/** The slice of `GateService` a routed diff needs — the same three methods the route band takes. */
export interface DiffRuleGates {
  list(): HilRequest[];
  request(gate: GateKind, ctx: GateRequestContext): Promise<HilRequest>;
  consume(id: HilId): Promise<HilRequest>;
}

/** The thread writer (`StreamService.appendThread`), for §6.4's `hook_unchecked` entry. */
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
  /** `classifier:` from `<home>/config.yaml` — bands, budget and the opt-out. */
  config: ClassifierConfig;
  streams: DiffRuleThread;
  policy: () => Policy;
  repos: () => Record<string, RepoEntry>;
  /** Without one, a routed diff degrades to a plain refusal (there is nowhere to put the card). */
  gates?: DiffRuleGates;
  /** Key lookup for `classifierEnabled`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function cap(text: string): string {
  return text.length > MESSAGE_BODY_MAX_CHARS ? text.slice(0, MESSAGE_BODY_MAX_CHARS) : text;
}

/**
 * The end of the split, for the case the file boundary cannot fix: one file
 * whose own diff is over the budget. §8.2 splits per file and no finer, so
 * the choice is send it oversized or send a prefix that fits. It sends the
 * prefix, with a marker that says so: a call the provider rejects for length
 * is a call that falls into §6.4 and quietly stops checking the rule at all,
 * whereas a truncated state still answers the question for the part of the
 * file that fits, and the marker keeps the classifier (and anyone reading
 * the recorded state) from mistaking a prefix for the whole change.
 *
 * Truncation happens **after** the scrub, never before: cutting the state
 * first could split a secret across the boundary and leave the tail of it
 * unredacted (§6.5 is fail-closed, and this keeps it that way).
 */
export const TRUNCATION_MARKER = '\n[truncated: file diff exceeds the classifier budget]';

export function truncateTo(state: string, budget: number): string {
  if (state.length <= budget) return state;
  const room = Math.max(0, budget - TRUNCATION_MARKER.length);
  return `${state.slice(0, room)}${TRUNCATION_MARKER}`;
}

/** `R-…` is unreadable on an inbox card; a built-in's `name` is not. */
function nameOf(rule: Rule): string {
  return rule.name ?? rule.id;
}

/**
 * The per-file split of §8.2. A unified diff is a sequence of `diff --git`
 * sections; anything before the first one (there is nothing in git's own
 * output, but a caller could hand us a fragment) stays with the first
 * section so no hunk is silently dropped.
 */
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

/**
 * The gate call for a routed diff: the diff *is* the "call", and its digest
 * is what an approval is good for. `origin: 'diff_rules'` is the structural
 * marker `wireLandGateResolution` keys on — answering one of these gates
 * performs a merge, so what tells it apart from the route band's per-tool
 * gates must be something the hook path cannot emit. `tool` is the vendor's
 * own `tool_name` and would have been a naming coincidence, not a
 * guarantee; `fingerprintCall` never sets `origin`.
 */
function diffCall(ctx: DiffRuleContext, diff: string): GateCall {
  const fingerprint = createHash('sha256')
    .update([ctx.stream.id, ctx.branch, ctx.target, diff].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return {
    tool: 'land',
    path: `${ctx.branch} → ${ctx.target}`,
    fingerprint,
    origin: 'diff_rules',
  };
}

export class ClassifierDiffRules implements DiffRules {
  constructor(private readonly options: ClassifierDiffRulesOptions) {}

  async check(ctx: DiffRuleContext): Promise<DiffRuleVerdict> {
    const rules = this.options.rules
      .inScope(ctx.stream.id, 'diff')
      .filter((rule) => rule.enforcement === 'classifier');
    if (rules.length === 0) return { decision: 'allow' };

    const diff = ctx.diff();
    const call = diffCall(ctx, diff);

    // The human may already have answered this exact diff.
    const answered = await this.answeredGate(ctx.stream, call);
    if (answered !== undefined) return answered;

    let answers: Map<string, Answer>;
    try {
      answers = await this.ask(ctx, rules, diff);
    } catch (error) {
      return await this.failPolicy(ctx.stream, rules, error);
    }

    // Deny wins over route wins over allow: the first rule that denies is
    // the one named, and a route only survives if nothing denied.
    let routed: { rule: Rule; answer: Answer } | undefined;
    let verdict: DiffRuleVerdict = { decision: 'allow' };
    for (const rule of rules) {
      const answer = answers.get(rule.id);
      if (answer === undefined) {
        // A classifier that skipped a question answered nothing about it;
        // §6.4's split applies to that rule alone. The rule that *causes*
        // the deny is recorded `violated`, never merely `fired` — the same
        // convention `failPolicy` and the hook's `recordRuleStats` keep.
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
          reason: cap(
            `${nameOf(rule)}: ${rule.text} (probability ${answer.probability}, confidence ${answer.confidence})`,
          ),
        };
      }
      if (band === 'route' && routed === undefined) routed = { rule, answer };
    }
    if (verdict.decision === 'deny') return verdict;
    if (routed !== undefined) return await this.route(ctx, call, routed.rule, routed.answer);
    return { decision: 'allow' };
  }

  /**
   * One call for the whole diff, or — over the budget — one per file with
   * the **max** taken per rule ("one bad file makes the whole diff bad").
   * The whole answer with the highest probability is kept, not a max of
   * each axis independently: a probability and the confidence in it are one
   * reading, and pairing the highest probability with some other file's
   * confidence would invent an answer nobody gave.
   */
  private async ask(
    ctx: DiffRuleContext,
    rules: Rule[],
    diff: string,
  ): Promise<Map<string, Answer>> {
    if (!this.enabled(ctx.stream)) {
      throw new Error('classifier tier is off for this stream');
    }
    const questions: Noul[] = rules.map((rule) => ({
      id: rule.id,
      question: classifierQuestion(rule),
    }));
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
   * §6.4, verbatim: "rules marked `critical` DENY; all other rules ALLOW,
   * and the daemon writes a `hook_unchecked` entry to the stream's thread."
   * The opt-out and a missing key land here too — there is nothing to call,
   * which is the same situation as an outage.
   */
  private async failPolicy(
    stream: Stream,
    rules: Rule[],
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
      rule: nameOf(critical[0] as Rule),
      reason: cap(`classifier unavailable (${why}); critical diff rules deny: ${named}`),
    };
  }

  /**
   * §6.4's visible mark: the tier ran but these rules were not checked. It
   * writes the thread entry only — the caller records the stats, because
   * what a rule's counter should say depends on what the caller then did
   * with it (a critical rule that goes on to deny is `violated`, not
   * `fired`).
   */
  private async noteUnchecked(stream: Stream, rules: Rule[], why: string): Promise<void> {
    await this.options.streams.appendThread('daemon', stream.id, {
      kind: 'event',
      body: cap(`hook_unchecked: diff rules ${rules.map(nameOf).join(', ')} not checked — ${why}`),
    });
  }

  /** This stream's `classifier_review` gates on this exact diff, newest first. */
  private matching(stream: Stream, call: GateCall): HilRequest[] {
    const gates = this.options.gates;
    if (gates === undefined) return [];
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

  /** An answer the human already gave for this diff, or `undefined` to ask the classifier. */
  private async answeredGate(stream: Stream, call: GateCall): Promise<DiffRuleVerdict | undefined> {
    const gates = this.options.gates;
    if (gates === undefined) return undefined;
    const candidates = this.matching(stream, call);
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
        reason: `waiting on ${pending.id} — ${pending.summary ?? 'a diff rule routed this land'}`,
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

  /** §8.2's "ROUTE ⇒ inbox item, landing waits". */
  private async route(
    ctx: DiffRuleContext,
    call: GateCall,
    rule: Rule,
    answer: Answer,
  ): Promise<DiffRuleVerdict> {
    const summary = cap(
      `${nameOf(rule)}: ${rule.text} (probability ${answer.probability}, confidence ${answer.confidence})`,
    );
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
    });
    return {
      decision: 'route',
      rule: nameOf(rule),
      gate,
      reason: cap(`${summary} — routed to your inbox as ${gate.id}; landing waits`),
    };
  }
}
