/**
 * The ship check (T262, projects-design §6): at delivery, `ship` items go
 * through the classifier over the diff (`ClassifierDiffRules`), then a
 * reviewer session checks the diff against a checklist of every `review`
 * item in scope for the files it changes.
 *
 * - Findings hold delivery and go back to the worker as a `ship_findings`
 *   event (§15). The worker fixes and delivers again, or disputes with `ask`.
 * - An unsure check (the classifier's route band, a reviewer that could not
 *   finish) goes to the inbox as a `classifier_review` gate with
 *   `origin: 'diff_rules'`: approving it lands, as for the classifier step.
 *
 * The reviewer session is asynchronous: the first delivery starts it and is
 * held; when it exits, `onFinished` re-runs the delivery, which picks up the
 * result recorded for that exact diff.
 */

import type {
  GateKind,
  HilRequest,
  KnowledgeEnforcement,
  KnowledgeItem,
  Policy,
  StreamFinding,
} from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import { clipLine } from '../events/producers';
import type { GateRequestContext } from '../gates/service';
import { type RuleStatsOutcome, knowledgeMatchesPaths } from '../knowledge/service';
import { type DiffRuleGates, answeredDiffGate, changedFilesOf, diffCall } from './diff-rules';
import type { DiffRuleContext, DiffRuleVerdict, DiffRules } from './service';

/** What a reviewer returns for one diff. `running`: started, not finished; delivery waits. */
export type ShipReviewResult =
  | { status: 'pass' }
  | { status: 'findings'; findings: StreamFinding[] }
  | { status: 'unsure'; reason: string }
  | { status: 'running' };

/** The reviewer step. `key` identifies the exact diff; a changed diff is a new review. */
export interface ShipReviewer {
  review(ctx: DiffRuleContext, checklist: KnowledgeItem[], key: string): Promise<ShipReviewResult>;
}

/** The checklist the reviewer's brief carries (and so its `brief.md`). */
export function renderChecklist(items: readonly KnowledgeItem[], files: readonly string[]): string {
  const lines = items.map((item) => `- [ ] ${item.name ? `${item.name}: ` : ''}${item.text}`);
  return [
    '## Ship review checklist',
    '',
    `This is a ship check: delivery is held until you finish. Check the diff (${files.length} changed file${files.length === 1 ? '' : 's'}) against every item below. File one \`finding\` per violation, naming the item. No findings means the delivery goes ahead. If you cannot tell, \`ask\`.`,
    '',
    ...lines,
  ].join('\n');
}

function findingLine(finding: StreamFinding): string {
  const at = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
  return clipLine(`${finding.severity} ${at}: ${finding.text}`, 300);
}

function cap(text: string): string {
  return text.length > MESSAGE_BODY_MAX_CHARS ? text.slice(0, MESSAGE_BODY_MAX_CHARS) : text;
}

export interface ShipChecksOptions {
  /** The classifier step (`ClassifierDiffRules`). */
  classifier: DiffRules;
  rules: {
    inScope(streamId: string, enforcement?: KnowledgeEnforcement): KnowledgeItem[];
    recordFired(id: string, outcome: RuleStatsOutcome): Promise<void>;
  };
  /** Without one, `review` items are not checked at delivery. */
  reviewer?: ShipReviewer;
  /** Where an unsure review goes; without it, an unsure review refuses. */
  gates?: DiffRuleGates & {
    request(gate: GateKind, ctx: GateRequestContext): Promise<HilRequest>;
  };
  policy: () => Policy;
  /** Emits `ship_findings` to the worker. */
  emit?: EmitRouted;
}

export class ShipChecks implements DiffRules {
  constructor(private readonly options: ShipChecksOptions) {}

  async check(ctx: DiffRuleContext): Promise<DiffRuleVerdict> {
    const first = await this.options.classifier.check(ctx);
    if (first.decision === 'deny') {
      // A deny that is a human's answer (a gate) is not a finding to fix.
      if (first.rule !== undefined) await this.emitFindings(ctx, 'classifier', [first.reason]);
      return first;
    }
    if (first.decision === 'route') return first;
    return await this.review(ctx);
  }

  private async review(ctx: DiffRuleContext): Promise<DiffRuleVerdict> {
    const { reviewer } = this.options;
    if (reviewer === undefined) return { decision: 'allow' };
    const candidates = this.options.rules.inScope(ctx.stream.id, 'review');
    if (candidates.length === 0) return { decision: 'allow' };
    const diff = ctx.diff();
    const files = changedFilesOf(diff);
    const checklist = candidates.filter((item) => knowledgeMatchesPaths(item, files));
    if (checklist.length === 0) return { decision: 'allow' };

    const call = diffCall(ctx, diff, 'review');
    const answered = await answeredDiffGate(this.options.gates, ctx.stream, call);
    if (answered !== undefined) return answered;

    const result = await reviewer.review(ctx, checklist, call.fingerprint);
    switch (result.status) {
      case 'running':
        return {
          decision: 'route',
          reason: `a reviewer is checking ${checklist.length} review item${checklist.length === 1 ? '' : 's'}; delivery resumes when it finishes`,
        };
      case 'pass':
        for (const item of checklist) await this.options.rules.recordFired(item.id, 'fired');
        return { decision: 'allow' };
      case 'findings': {
        for (const item of checklist) await this.options.rules.recordFired(item.id, 'fired');
        const lines = result.findings.map(findingLine);
        await this.emitFindings(ctx, 'reviewer', lines);
        return {
          decision: 'deny',
          rule: 'review checklist',
          reason: cap(
            `${lines.length} finding${lines.length === 1 ? '' : 's'}: ${lines.slice(0, 3).join(' | ')}`,
          ),
        };
      }
      case 'unsure': {
        const summary = cap(`review checklist unsure: ${result.reason}`);
        const gates = this.options.gates;
        if (gates === undefined) return { decision: 'route', reason: summary };
        const gate = await gates.request('classifier_review', {
          policy: this.options.policy(),
          stream: ctx.stream.id,
          call,
          summary,
        });
        return {
          decision: 'route',
          gate,
          reason: cap(`${summary} — routed to your inbox as ${gate.id}; landing waits`),
        };
      }
    }
  }

  private async emitFindings(
    ctx: DiffRuleContext,
    source: 'classifier' | 'reviewer',
    lines: string[],
  ): Promise<void> {
    if (this.options.emit === undefined || lines.length === 0) return;
    const findings = lines.slice(0, 20).map((line) => clipLine(line, 300));
    await this.options.emit({
      type: 'ship_findings',
      subject: ctx.stream.id,
      by: 'daemon',
      ...(ctx.stream.repo !== undefined ? { repo: ctx.stream.repo } : {}),
      ...(ctx.stream.project !== undefined ? { project: ctx.stream.project } : {}),
      payload: {
        source,
        findings,
        ...(lines.length > findings.length
          ? { more_findings: lines.length - findings.length }
          : {}),
      },
    });
  }
}

/** The slice of `AttachService` the session reviewer needs. */
export interface ShipReviewAttach {
  attach(
    streamId: string,
    options: { role: 'reviewer'; briefAppendix: string },
  ): Promise<{ handle: { exited: Promise<{ ok: boolean; reason: string }> } }>;
}

export interface SessionShipReviewerOptions {
  attach: ShipReviewAttach;
  /** Findings are read from the stream record (`agent.findings`). */
  streams: { get(id: string): { agent: { findings?: StreamFinding[] } } };
  /** Called when a review finishes, to re-run the delivery. */
  onFinished?: (streamId: string) => unknown;
}

/**
 * The real reviewer: a read-only reviewer session whose brief carries the
 * checklist. Its `finding`s filed during the session are the result; a
 * session that does not exit cleanly is `unsure`. Results are kept in
 * memory per stream and diff (a daemon restart starts a fresh review).
 */
export class SessionShipReviewer implements ShipReviewer {
  private readonly results = new Map<string, ShipReviewResult>();

  constructor(private readonly options: SessionShipReviewerOptions) {}

  async review(
    ctx: DiffRuleContext,
    checklist: KnowledgeItem[],
    key: string,
  ): Promise<ShipReviewResult> {
    const id = `${ctx.stream.id}:${key}`;
    const known = this.results.get(id);
    if (known !== undefined) return known;
    const before = this.options.streams.get(ctx.stream.id).agent.findings?.length ?? 0;
    const files = changedFilesOf(ctx.diff());
    let started: Awaited<ReturnType<ShipReviewAttach['attach']>>;
    try {
      started = await this.options.attach.attach(ctx.stream.id, {
        role: 'reviewer',
        briefAppendix: renderChecklist(checklist, files),
      });
    } catch (err) {
      return {
        status: 'unsure',
        reason: `the reviewer did not start: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.results.set(id, { status: 'running' });
    void started.handle.exited.then(async (info) => {
      let result: ShipReviewResult;
      try {
        const findings = (this.options.streams.get(ctx.stream.id).agent.findings ?? []).slice(
          before,
        );
        result = !info.ok
          ? { status: 'unsure', reason: `the reviewer ended early: ${info.reason}` }
          : findings.length > 0
            ? { status: 'findings', findings }
            : { status: 'pass' };
      } catch (err) {
        result = { status: 'unsure', reason: err instanceof Error ? err.message : String(err) };
      }
      this.results.set(id, result);
      try {
        await this.options.onFinished?.(ctx.stream.id);
      } catch (err) {
        console.error(`ship review re-delivery for ${ctx.stream.id} failed:`, err);
      }
    });
    return { status: 'running' };
  }
}
