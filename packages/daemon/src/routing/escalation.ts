/**
 * T484 (design/model-routing.md §6, D56): the escalation watcher. It hears
 * the signals the daemon already sees (a merge refused, a turn that failed,
 * the context filling, quiet turns, the agent's `escalate`, the operator's
 * Step up) and records a **pending step** on the node (`Stream.escalation`,
 * daemon-only), which the agent's next start takes (attach's routed path).
 * Nothing changes mid-turn. At the top of the ladder, or under Strongest
 * first, there is no step: the node goes to Needs me (`escalation.stuck`, a
 * `model_stuck` inbox item) with the reason.
 *
 * Everything it counts lives on the node's record, so a daemon restart keeps
 * a pending step, a Needs me card and a first refusal alike.
 */

import {
  CONTEXT_FULL_REASON,
  CONTEXT_FULL_SHARE,
  type Effort,
  type EscalationPending,
  type EscalationState,
  type EscalationTrigger,
  type LadderRung,
  type ModelPick,
  OPERATOR_STEP_REASON,
  QUIET_TURNS_MAX,
  QUIET_TURNS_REASON,
  type StepUpView,
  type Stream,
  isAgentRole,
  nextRung,
  pickWords,
  steppedUpLine,
  stuckLine,
} from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';
import type { ModelPolicyService } from './policy';

/** Step up can't be pressed: why, in words (an HTTP 409, an RPC param error). */
export class StepUpRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepUpRefusedError';
  }
}

/** Why a resting session ends when a step is recorded (T465: a model change ends it). */
export function escalationEndReason(reason: string): string {
  return `its model steps up at the next start (${reason})`.slice(0, 280);
}

export interface EscalationServiceOptions {
  store: StateStore;
  streams: Pick<StreamService, 'get' | 'appendThread'>;
  policy: ModelPolicyService;
  /** Records a step or a Needs me card as a `model_escalated` event (record-only). */
  emit?: EmitRouted;
  /** T465: ends the node's resting session, so the next message starts on the new rung. */
  endResting?: (node: string, why: string) => Promise<void>;
}

/** What a trigger came to. */
export type TriggerOutcome =
  /** A step waits for the next start. */
  | { status: 'pending'; to: LadderRung }
  /** The top of the ladder (or Strongest first): the node is on Needs me. */
  | { status: 'stuck' }
  /** A step was already waiting. */
  | { status: 'already' }
  /** Escalation is off here (the Default model choice), or the node isn't open or never ran. */
  | { status: 'off'; why: string };

/** What a start takes from a pending step. */
export type StartStep =
  | { to: LadderRung; from: LadderRung; pending: EscalationPending }
  | { top: true; from: LadderRung; pending: EscalationPending };

function isOpen(stream: Stream): boolean {
  return (
    stream.archived !== true && stream.human.status !== 'closed' && stream.human.status !== 'landed'
  );
}

function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class EscalationService {
  constructor(private readonly options: EscalationServiceOptions) {}

  /**
   * The model the node runs now: its last agent session (vendor still
   * installed), else its pick record. `undefined` for a node that never ran.
   */
  current(stream: Stream): LadderRung | undefined {
    for (let i = stream.sessions.length - 1; i >= 0; i--) {
      const s = stream.sessions[i];
      if (s === undefined || !isAgentRole(s.role)) continue;
      if (!this.options.policy.isInstalled(s.vendor)) break;
      return {
        vendor: s.vendor,
        model: s.model,
        ...(s.effort !== undefined ? { effort: s.effort as Effort } : {}),
      };
    }
    const pick = stream.agent.pick;
    if (pick === undefined) return undefined;
    return {
      vendor: pick.vendor,
      model: pick.model,
      ...(pick.effort !== undefined ? { effort: pick.effort } : {}),
    };
  }

  /** The rung one step above `from` under the node's policy; `undefined` at the top. */
  nextFor(stream: Stream, from: LadderRung): LadderRung | undefined {
    const { ladder, profiles } = this.options.policy.ladderFor(stream);
    return nextRung(ladder, from, profiles);
  }

  private words(rung: LadderRung): string {
    return pickWords(rung, this.options.policy.catalogModels());
  }

  /** Details → Model choice: Step up's next rung, a pending step, the Needs me card. */
  view(stream: Stream): StepUpView {
    const state = stream.escalation;
    const { policy } = this.options.policy.resolveFor(stream);
    const current = this.current(stream);
    const next = current !== undefined ? this.nextFor(stream, current) : undefined;
    const blocked = !isOpen(stream)
      ? 'This node is closed.'
      : policy.escalation === 'strongest_first'
        ? 'Strongest first never steps up: it runs the strongest preset model. Pick a model with the chip instead.'
        : current === undefined
          ? 'Its agent hasn’t started yet: the policy picks at its first start.'
          : next === undefined
            ? `${this.words(current)} is the top of the ladder: no preset model is stronger.`
            : undefined;
    return {
      ...(next !== undefined ? { next: { ...next, words: this.words(next) } } : {}),
      ...(state?.pending !== undefined
        ? {
            pending: {
              ...state.pending,
              ...(next !== undefined ? { to: this.words(next) } : {}),
            },
          }
        : {}),
      ...(state?.stuck !== undefined ? { stuck: state.stuck } : {}),
      ...(blocked !== undefined ? { blocked } : {}),
    };
  }

  private async write(
    id: string,
    change: (before: EscalationState) => EscalationState,
  ): Promise<Stream> {
    return this.options.store.updateStream('daemon', id, (s) => {
      const next = Object.fromEntries(
        Object.entries(change(s.escalation ?? {})).filter(([, v]) => v !== undefined),
      ) as EscalationState;
      const { escalation: _old, ...rest } = s;
      return Object.keys(next).length === 0 ? rest : { ...rest, escalation: next };
    });
  }

  /**
   * A trigger (§6). Under Start cheap a pending step is recorded for the
   * next start (a resting session ends, T465); at the top of the ladder, or
   * under Strongest first, the node goes to Needs me. The Default model
   * choice (a project that predates routing, D54) never escalates on its
   * own; the operator's Step up still works there.
   */
  async trigger(
    id: string,
    input: {
      trigger: EscalationTrigger;
      reason: string;
      by: EscalationPending['by'];
      session?: string;
    },
  ): Promise<TriggerOutcome> {
    let stream: Stream;
    try {
      stream = this.options.streams.get(id);
    } catch {
      return { status: 'off', why: 'the node is gone' };
    }
    if (!isOpen(stream)) return { status: 'off', why: 'the node is closed' };
    const { policy } = this.options.policy.resolveFor(stream);
    if (input.by !== 'human' && policy.mode === 'default') {
      return {
        status: 'off',
        why: 'model choice here is Default, which never steps up on its own',
      };
    }
    if (stream.escalation?.pending !== undefined) return { status: 'already' };
    const current = this.current(stream);
    if (current === undefined) return { status: 'off', why: 'its agent hasn’t started yet' };
    const reason = clip(input.reason);
    const next =
      policy.escalation === 'strongest_first' ? undefined : this.nextFor(stream, current);
    if (next === undefined) {
      await this.stuck(stream, { trigger: input.trigger, reason }, current);
      return { status: 'stuck' };
    }
    const pending: EscalationPending = {
      trigger: input.trigger,
      reason,
      by: input.by,
      ...(input.session !== undefined ? { session: input.session } : {}),
      at: new Date().toISOString(),
    };
    await this.write(id, (e) => ({ ...e, pending }));
    await this.options
      .endResting?.(id, escalationEndReason(reason))
      .catch((err) => console.error('ending a resting session for a step up failed:', err));
    return { status: 'pending', to: next };
  }

  /** The top of the ladder: the Needs me card (once), a thread line and a record-only event. */
  private async stuck(
    stream: Stream,
    input: { trigger: EscalationTrigger; reason: string },
    current: LadderRung,
  ): Promise<void> {
    if (stream.escalation?.stuck !== undefined) return;
    const model = this.words(current);
    await this.write(stream.id, (e) => ({
      ...e,
      stuck: { trigger: input.trigger, reason: input.reason, model, at: new Date().toISOString() },
    }));
    await this.options.streams
      .appendThread('daemon', stream.id, {
        kind: 'event',
        body: clip(stuckLine(stream.title, input.reason), 800),
      })
      .catch(() => undefined);
    await this.emit(stream, {
      step: 'stuck',
      trigger: input.trigger,
      from: model,
      reason: input.reason,
    });
  }

  private async emit(
    stream: Stream,
    payload: {
      step: 'up' | 'stuck';
      trigger: EscalationTrigger;
      from: string;
      to?: string;
      reason: string;
    },
  ): Promise<void> {
    await this.options
      .emit?.({
        type: 'model_escalated',
        subject: stream.id,
        ...(stream.project !== undefined ? { project: stream.project } : {}),
        ...(stream.repo !== undefined ? { repo: stream.repo } : {}),
        payload: {
          ...payload,
          from: clip(payload.from, 200),
          ...(payload.to !== undefined ? { to: clip(payload.to, 200) } : {}),
          reason: clip(payload.reason, 800),
        },
        by: 'daemon',
      })
      .catch((err) => console.error('model_escalated not recorded:', err));
  }

  /** The operator's Step up (Details, `POST /api/streams/:id/step-up`, `agile policy step-up`). */
  async stepUp(id: string): Promise<void> {
    const stream = this.options.streams.get(id);
    if (stream.escalation?.pending !== undefined) return;
    const view = this.view(stream);
    if (view.blocked !== undefined) throw new StepUpRefusedError(view.blocked);
    const outcome = await this.trigger(id, {
      trigger: 'operator',
      reason: OPERATOR_STEP_REASON,
      by: 'human',
    });
    if (outcome.status === 'off') throw new StepUpRefusedError(`Can’t step up: ${outcome.why}.`);
    if (outcome.status === 'pending') {
      await this.options.streams
        .appendThread('daemon', id, {
          kind: 'event',
          body: `the operator asked for a stronger model: the next start of this node’s agent runs ${this.words(outcome.to)}`,
        })
        .catch(() => undefined);
    }
    // Asking again after Needs me: the card has done its job.
    if (outcome.status === 'pending' && stream.escalation?.stuck !== undefined) {
      await this.write(id, ({ stuck: _s, ...e }) => e);
    }
  }

  /** The operator dismissed the Needs me card. */
  async dismissStuck(id: string): Promise<void> {
    this.options.streams.get(id);
    await this.write(id, ({ stuck: _s, ...e }) => e);
  }

  /** D56: the agent's `escalate {why}`. What it came to, in words for the agent. */
  async asked(id: string, session: string, why: string): Promise<string> {
    const outcome = await this.trigger(id, {
      trigger: 'asked',
      reason: `the agent asked: ${why}`,
      by: 'agent',
      session,
    });
    switch (outcome.status) {
      case 'pending':
        return 'Recorded. The next start of this node’s agent runs one rung up the operator’s preset models. Finish or stop your turn now.';
      case 'already':
        return 'A step up already waits for the next start of this node’s agent.';
      case 'stuck':
        return 'You are on the strongest preset model, so there is no step up; the operator is told. Carry on, or ask the operator with `ask`.';
      case 'off':
        return `No step up: ${outcome.why}.`;
    }
  }

  /**
   * §6 "a merge refused twice": the same reason (`key`) again, with at
   * least one agent turn in between that tried to fix it. A different reason
   * starts the count again.
   */
  async mergeRefused(id: string, key: string, words: string): Promise<TriggerOutcome | undefined> {
    let stream: Stream;
    try {
      stream = this.options.streams.get(id);
    } catch {
      return undefined;
    }
    const last = stream.escalation?.refusal;
    if (last !== undefined && last.key === key && last.turns > 0) {
      await this.write(id, ({ refusal: _r, ...e }) => e);
      return this.trigger(id, {
        trigger: 'merge_refused',
        reason: `the merge was refused twice (${words})`,
        by: 'daemon',
      });
    }
    if (last !== undefined && last.key === key) return undefined;
    await this.write(id, (e) => ({
      ...e,
      refusal: { key: clip(key, 300), words: clip(words), turns: 0, at: new Date().toISOString() },
    }));
    return undefined;
  }

  /**
   * A worker's first start on its worktree: the HEAD its quiet turns are
   * counted from (written once, when nothing is counted yet).
   */
  async baseline(id: string, head: string): Promise<void> {
    const stream = this.options.streams.get(id);
    if (stream.escalation?.quiet !== undefined) return;
    await this.write(id, (e) => (e.quiet !== undefined ? e : { ...e, quiet: { turns: 0, head } }));
  }

  /** A `progress` call: the turn isn't quiet. */
  async progressed(id: string): Promise<void> {
    const stream = this.options.streams.get(id);
    if (stream.escalation?.quiet?.progress === true) return;
    await this.write(id, (e) => ({
      ...e,
      quiet: {
        turns: e.quiet?.turns ?? 0,
        ...(e.quiet?.head ? { head: e.quiet.head } : {}),
        progress: true,
      },
    }));
  }

  /**
   * A node's agent finished a turn (it rests now). A merge refusal waiting
   * for a fix counts the turn; a context past 90% without `goal_met` in this
   * session is a stall (once per session); a worker's turn with no new commit
   * and no `progress` is quiet, and `QUIET_TURNS_MAX` in a row are a stall.
   */
  async turnEnded(
    id: string,
    info: {
      session: string;
      worker: boolean;
      context?: { used: number; size: number };
      /** The worktree's HEAD now (a worker with a worktree). */
      head?: string;
    },
  ): Promise<TriggerOutcome | undefined> {
    let stream: Stream;
    try {
      stream = this.options.streams.get(id);
    } catch {
      return undefined;
    }
    const before = stream.escalation ?? {};
    const goalMet = stream.agent.goal_met?.session === info.session;
    const full =
      info.context !== undefined &&
      info.context.size > 0 &&
      info.context.used / info.context.size > CONTEXT_FULL_SHARE &&
      !goalMet &&
      before.context !== info.session;
    // Quiet turns count only on a worker with a worktree (a commit is possible there);
    // the first turn seen learns its HEAD. A met goal, a commit or a `progress` resets it.
    let quietTurns: number | undefined;
    if (info.worker && info.head !== undefined) {
      const prev = before.quiet;
      quietTurns =
        goalMet || prev?.progress === true || prev?.head === undefined || prev.head !== info.head
          ? 0
          : prev.turns + 1;
    }
    const stalled = quietTurns !== undefined && quietTurns >= QUIET_TURNS_MAX;
    const head = info.head;
    await this.write(id, (e) => ({
      ...e,
      ...(e.refusal !== undefined ? { refusal: { ...e.refusal, turns: e.refusal.turns + 1 } } : {}),
      ...(full ? { context: info.session } : {}),
      ...(quietTurns !== undefined && head !== undefined
        ? { quiet: { turns: stalled ? 0 : quietTurns, head } }
        : {}),
    }));
    if (full) {
      return this.trigger(id, {
        trigger: 'context_full',
        reason: CONTEXT_FULL_REASON,
        by: 'daemon',
      });
    }
    if (stalled) {
      return this.trigger(id, { trigger: 'quiet_turns', reason: QUIET_TURNS_REASON, by: 'daemon' });
    }
    return undefined;
  }

  /** §6 "a turn fails" (T460), once its retry and fallback (T456) are spent. */
  async turnFailed(id: string, words: string): Promise<TriggerOutcome> {
    return this.trigger(id, {
      trigger: 'turn_failed',
      reason: `a turn failed (${words})`,
      by: 'daemon',
    });
  }

  /**
   * At a routed start with a pending step: the rung it takes, one above
   * `from` (what the node ran). At the top now (the policy changed since),
   * no step: the start keeps its model and the node goes to Needs me.
   */
  stepAtStart(stream: Stream, from: LadderRung): StartStep | undefined {
    const pending = stream.escalation?.pending;
    if (pending === undefined) return undefined;
    const { policy } = this.options.policy.resolveFor(stream);
    const to = policy.escalation === 'strongest_first' ? undefined : this.nextFor(stream, from);
    return to !== undefined ? { to, from, pending } : { top: true, from, pending };
  }

  /** The pick a step makes, for the node's `agent.pick`. */
  stepPick(step: Extract<StartStep, { to: LadderRung }>, fallbackEffort: Effort): ModelPick {
    return {
      vendor: step.to.vendor,
      model: step.to.model,
      effort: step.to.effort ?? fallbackEffort,
      how: 'escalation',
      why: clip(`stepped up: ${step.pending.reason}`, 300),
    };
  }

  /**
   * After a routed start: the pending step is spent (D55), and an explicit
   * pick also clears the Needs me card (the operator chose). A step writes
   * its thread line and its record-only event; the top writes the card.
   */
  async started(
    stream: Stream,
    outcome: { step?: StartStep; explicit: boolean; ran: LadderRung; session: string },
  ): Promise<void> {
    const had = stream.escalation;
    if (had?.pending === undefined && !(outcome.explicit && had?.stuck !== undefined)) return;
    await this.write(stream.id, ({ pending: _p, stuck, ...e }) => ({
      ...e,
      ...(stuck !== undefined && !outcome.explicit && outcome.step === undefined ? { stuck } : {}),
      ...(stuck !== undefined && outcome.step !== undefined && 'top' in outcome.step
        ? { stuck }
        : {}),
    }));
    const step = outcome.step;
    if (step === undefined) return;
    if ('top' in step) {
      await this.stuck(
        this.options.streams.get(stream.id),
        { trigger: step.pending.trigger, reason: step.pending.reason },
        outcome.ran,
      );
      return;
    }
    const models = this.options.policy.catalogModels();
    await this.options.streams
      .appendThread('daemon', stream.id, {
        kind: 'event',
        body: clip(steppedUpLine(outcome.ran, step.from, step.pending.reason, models), 800),
        ref: outcome.session,
      })
      .catch(() => undefined);
    await this.emit(stream, {
      step: 'up',
      trigger: step.pending.trigger,
      from: pickWords(step.from, models),
      to: pickWords(outcome.ran, models),
      reason: step.pending.reason,
    });
  }
}
