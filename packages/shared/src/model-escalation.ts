/**
 * T484 (design/model-routing.md §6, D56): escalation. Under `start cheap`,
 * a node whose work stalls or whose merge keeps being refused steps up the
 * **ladder** at its agent's next start: the next effort level on the same
 * model first, then the next model. The ladder is the preset models (any
 * installed model when there are none) ordered by tier then cost, and within
 * one model its effort levels up to the effort ceiling.
 *
 * The triggers (§6) record a pending step on the node (`Stream.escalation`,
 * written by the daemon only); the step happens at the next start, never in
 * the middle of a turn. At the top of the ladder there is no step: the node
 * goes to Needs me instead. `strongest first` never steps, and goes to Needs
 * me on the same triggers.
 */

import { z } from 'zod';
import { EFFORT_LEVELS, type Effort } from './effort';
import { UlidSchema } from './ids';
import {
  DEFAULT_MODEL_PROFILES,
  MODEL_TIERS,
  type ModelPolicy,
  type ModelProfile,
  type ModelTier,
  type PickModelInput,
  modelKey,
  pickWords,
  presetCandidates,
  profileOf,
} from './model-policy';
import { vendorTakesEffort } from './session-defaults';

// ---------------------------------------------------------------- the triggers

/**
 * What asked for a step (§6): a merge refused twice for the same reason, a
 * failed turn, a context past 90% without the goal met, quiet turns, the
 * agent's `escalate`, or the operator's Step up.
 */
export const ESCALATION_TRIGGERS = [
  'merge_refused',
  'turn_failed',
  'context_full',
  'quiet_turns',
  'asked',
  'operator',
] as const;
export const EscalationTriggerSchema = z.enum(ESCALATION_TRIGGERS);
export type EscalationTrigger = z.infer<typeof EscalationTriggerSchema>;

/**
 * §6's "N turns pass with no commit and no `progress`", N = 3. A constant,
 * not a policy field: the policy's fields are what the operator trades
 * (quality, the lock, the ceiling), and a stall's length is not one of them.
 */
export const QUIET_TURNS_MAX = 3;

/** §6's "the context fills": T411's reading passes this share of the window. */
export const CONTEXT_FULL_SHARE = 0.9;

/** How long a reason may be (it rides on the thread line and the Needs me card). */
export const ESCALATION_REASON_MAX_CHARS = 500;

const Reason = z.string().min(1).max(ESCALATION_REASON_MAX_CHARS);

/** Who asked: the operator (Step up), the daemon (a trigger it saw), or the node's agent (`escalate`). */
export const ESCALATION_BY = ['human', 'daemon', 'agent'] as const;

/** A step waiting for the node's next start. */
export const EscalationPendingSchema = z
  .object({
    trigger: EscalationTriggerSchema,
    /** In words, never ids: "the ship check refused the merge twice (…)". */
    reason: Reason,
    by: z.enum(ESCALATION_BY),
    /** The agent's session, for `asked`. */
    session: UlidSchema.optional(),
    at: z.string().min(1),
  })
  .strict();
export type EscalationPending = z.infer<typeof EscalationPendingSchema>;

/** The top of the ladder (or `strongest first`): the node is on Needs me. */
export const EscalationStuckSchema = z
  .object({
    trigger: EscalationTriggerSchema,
    reason: Reason,
    /** The model it is stuck on, in words ("Claude Opus 5.5 · max"). */
    model: z.string().min(1).max(200),
    at: z.string().min(1),
  })
  .strict();
export type EscalationStuck = z.infer<typeof EscalationStuckSchema>;

/**
 * The node's escalation record (`Stream.escalation`). Daemon-only: the
 * store refuses every other principal's write, the operator's included (Step
 * up goes through the daemon, which records it as the operator's).
 */
export const EscalationStateSchema = z
  .object({
    pending: EscalationPendingSchema.optional(),
    stuck: EscalationStuckSchema.optional(),
    /**
     * The last merge refusal: its reason's key (a ship check's rule, or a
     * conflict), in words, and the agent turns that ended since. The same key
     * again after at least one turn is "refused twice".
     */
    refusal: z
      .object({
        key: z.string().min(1).max(300),
        words: Reason,
        turns: z.number().int().nonnegative(),
        at: z.string().min(1),
      })
      .strict()
      .optional(),
    /**
     * Quiet turns: finished worker turns in a row with no commit (the
     * worktree's HEAD) and no `progress` call.
     */
    quiet: z
      .object({
        turns: z.number().int().nonnegative(),
        head: z.string().min(1).max(64).optional(),
        /** A `progress` call since the last turn ended. */
        progress: z.literal(true).optional(),
      })
      .strict()
      .optional(),
    /** The session whose context already passed 90% (counted once). */
    context: UlidSchema.optional(),
  })
  .strict();
export type EscalationState = z.infer<typeof EscalationStateSchema>;

// ---------------------------------------------------------------- the ladder

/** One rung: a model, and an effort for a vendor that takes one. */
export interface LadderRung {
  vendor: string;
  model: string;
  effort?: Effort;
}

function tierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

function effortRank(effort: Effort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

export interface LadderInput {
  /** The vendors installed here. */
  installed: readonly string[];
  models?: PickModelInput['models'];
  profiles?: Readonly<Record<string, ModelProfile>>;
  /** With no presets, the default's vendor first on a tie (as a routed pick). */
  prefer?: string;
  /**
   * T490 (D59): the node's vendor order: two models of one tier and cost
   * climb in this order (a vendor it names first; the others after).
   */
  vendorOrder?: readonly string[];
}

/**
 * §6's ladder: the preset models (any installed model when there are none)
 * by tier (fast, balanced, strongest), then cost, then (T490) the vendor
 * order, then the order they're listed in; within one model, its effort
 * levels from low up to the ceiling (one rung for a vendor that takes no
 * effort).
 */
export function escalationLadder(
  policy: Pick<ModelPolicy, 'presets' | 'effort_ceiling'>,
  input: LadderInput,
): LadderRung[] {
  const profiles = input.profiles ?? DEFAULT_MODEL_PROFILES;
  const { candidates } = presetCandidates(policy, {
    installed: input.installed,
    ...(input.models !== undefined ? { models: input.models } : {}),
    ...(input.prefer !== undefined ? { prefer: input.prefer } : {}),
  });
  const order = input.vendorOrder ?? [];
  const rank = (vendor: string) => {
    const at = order.indexOf(vendor);
    return at < 0 ? order.length : at;
  };
  const seen = new Set<string>();
  const rows = candidates
    .filter((c) => {
      const key = modelKey(c.vendor, c.model);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c, order) => ({ c, order, p: profileOf(c.vendor, c.model, profiles) }))
    .sort(
      (a, b) =>
        tierRank(a.p.tier) - tierRank(b.p.tier) ||
        a.p.cost - b.p.cost ||
        rank(a.c.vendor) - rank(b.c.vendor) ||
        a.order - b.order,
    );
  const ceiling = effortRank(policy.effort_ceiling);
  const out: LadderRung[] = [];
  for (const { c } of rows) {
    if (!vendorTakesEffort(c.vendor)) {
      out.push({ vendor: c.vendor, model: c.model });
      continue;
    }
    for (const effort of EFFORT_LEVELS) {
      if (effortRank(effort) > ceiling) break;
      out.push({ vendor: c.vendor, model: c.model, effort });
    }
  }
  return out;
}

function sameModel(
  a: Pick<LadderRung, 'vendor' | 'model'>,
  b: Pick<LadderRung, 'vendor' | 'model'>,
) {
  return a.vendor === b.vendor && a.model === b.model;
}

/**
 * The next model's rung: at the effort the node ran on (so a step to a
 * stronger model never lowers the effort), capped at the ceiling; `medium`
 * when the node's vendor took none. A vendor with no effort has one rung.
 */
function landOn(rest: readonly LadderRung[], effort: Effort | undefined): LadderRung | undefined {
  const first = rest[0];
  if (first === undefined) return undefined;
  const rungs = rest.filter((r) => sameModel(r, first));
  const want = effort ?? 'medium';
  return (
    rungs.find((r) => r.effort === want) ??
    [...rungs]
      .reverse()
      .find((r) => r.effort !== undefined && effortRank(r.effort) <= effortRank(want)) ??
    rungs[0]
  );
}

/**
 * One step up from `current` (§6): the next effort level on the same model
 * first, then the next model up the ladder. A model not on the ladder (an
 * explicit pick outside the presets) steps to the first preset ranked above
 * it by tier then cost. `undefined` at the top of the ladder.
 */
export function nextRung(
  ladder: readonly LadderRung[],
  current: Pick<LadderRung, 'vendor' | 'model'> & { effort?: Effort | undefined },
  profiles: Readonly<Record<string, ModelProfile>> = DEFAULT_MODEL_PROFILES,
): LadderRung | undefined {
  const effort = vendorTakesEffort(current.vendor) ? (current.effort ?? 'medium') : undefined;
  const same = ladder.filter((r) => sameModel(r, current));
  const last = same.at(-1);
  if (last !== undefined) {
    if (effort !== undefined) {
      const up = same.find(
        (r) => r.effort !== undefined && effortRank(r.effort) > effortRank(effort),
      );
      if (up !== undefined) return up;
    }
    return landOn(ladder.slice(ladder.lastIndexOf(last) + 1), effort);
  }
  const at = profileOf(current.vendor, current.model, profiles);
  const above = ladder.filter((r) => {
    const p = profileOf(r.vendor, r.model, profiles);
    return tierRank(p.tier) > tierRank(at.tier) || (p.tier === at.tier && p.cost > at.cost);
  });
  return landOn(above, effort);
}

// ---------------------------------------------------------------- the words

/**
 * The thread line a step writes (§6): "Stepped up to Claude Opus 5.5 · high:
 * the ship check refused the merge twice on Claude Sonnet 5.5 · high".
 */
export function steppedUpLine(
  to: Pick<LadderRung, 'vendor' | 'model'> & { effort?: Effort | undefined },
  from: Pick<LadderRung, 'vendor' | 'model'> & { effort?: Effort | undefined },
  reason: string,
  models?: PickModelInput['models'],
): string {
  return `Stepped up to ${pickWords(to, models)}: ${reason} on ${pickWords(from, models)}`;
}

/** The Needs me card's text (§6): "<node> is stuck on the strongest preset model: <reason>". */
export function stuckLine(title: string, reason: string): string {
  return `${title} is stuck on the strongest preset model: ${reason}`;
}

/** The trigger's reason for a quiet stall, in words. */
export const QUIET_TURNS_REASON = `${QUIET_TURNS_MAX} turns passed with no commit and no progress`;
/** The trigger's reason for a full context, in words. */
export const CONTEXT_FULL_REASON = `its context passed ${Math.round(
  CONTEXT_FULL_SHARE * 100,
)}% before the goal was met`;
/** The operator's Step up, in words. */
export const OPERATOR_STEP_REASON = 'you asked for a stronger model';

/**
 * What Details shows about stepping up (`NodeModelPolicyView.step_up`):
 * the next rung, a pending step, the Needs me card, or why there is no step.
 */
export interface StepUpView {
  /** The rung Step up would take (words and triple); absent at the top. */
  next?: LadderRung & { words: string };
  /** A step waiting for the next start. */
  pending?: EscalationPending & { to?: string };
  /** On Needs me: the top of the ladder. */
  stuck?: EscalationStuck;
  /** Why Step up can't be pressed now, in words (strongest first, the top, never started). */
  blocked?: string;
}
