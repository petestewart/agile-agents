/**
 * T483 (design/model-routing.md §5, D52): the chooser's questions and the
 * reading of Jev's answers, as pure functions so the daemon, the CLI and
 * the cockpit's Try it agree. One Jev call (TypeSafe `systemone`) with the
 * **choice** primitive: each question names a fixed set of options, and
 * Jev returns the chosen option, every option's probability and a
 * confidence. All the questions go in one request.
 *
 * The wire schemas are here (every schema lives in `shared`); the mapping
 * to and from the HTTP body is `classifier/jev-wire.ts` in the daemon.
 * The pick itself (pinned rules, the confidence threshold, the rule over the
 * scores, the clamp) is `pickModel` in `model-policy.ts`.
 */

import { z } from 'zod';
import { EFFORT_LEVELS, type Effort } from './effort';
import { UlidSchema } from './ids';
import {
  CHOOSER_TOPICS,
  type ChooserReading,
  type ChooserScores,
  type ChooserTopic,
  type InTier,
  MODEL_TIERS,
  type ModelPolicy,
  type ModelProfile,
  type ModelTier,
  type PickCatalogModel,
  type PickHow,
  type PresetModel,
  ROUTING_CRITERIA,
  type RoutingCriterion,
  type TierBy,
  modelWords,
  profileOf,
  tiersPresent,
} from './model-policy';
import { ProjectIdSchema } from './project';
import { vendorTakesEffort } from './session-defaults';

// ---------------------------------------------------------------- the wire

/** TypeSafe's limit on one choice question's options. */
export const JEV_CHOICE_OPTIONS_MAX = 255;
export const JEV_CHOICE_OPTION_MAX_CHARS = 600;

/** One choice question in the request's `questions` map (checked live, 2026-09-30). */
export const JevChoiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    instructions: z.string().min(1).max(8000),
    criteria: z
      .record(z.string().min(1).max(200), z.string().min(1).max(JEV_CHOICE_OPTION_MAX_CHARS))
      .refine((c) => Object.keys(c).length >= 2, { message: 'a choice needs two options' })
      .refine((c) => Object.keys(c).length <= JEV_CHOICE_OPTIONS_MAX, {
        message: `at most ${JEV_CHOICE_OPTIONS_MAX} options`,
      }),
  })
  .strict();
export type JevChoiceQuestion = z.infer<typeof JevChoiceQuestionSchema>;

/**
 * One choice answer: `{type: 'choice', choice, confidence, probabilities}`.
 * A reply that fails it is a bad response, never defaulted.
 */
export const JevChoiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string().min(1).max(200), z.number().finite().min(0)),
  })
  .strict();
export type JevChoiceAnswer = z.infer<typeof JevChoiceAnswerSchema>;

/** One choice question as the classifier tier takes it: an id, the instructions, each option described. */
export interface ChoiceQuestion {
  id: string;
  instructions: string;
  /** Option → what it means. The keys are what Jev answers with. */
  options: Record<string, string>;
}

/** One choice answer, by question id. */
export interface ChoiceAnswer {
  id: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

// ---------------------------------------------------------------- the task

/** The role in the task's words (the state). */
const ROLE_WORDS = {
  worker: 'a worker: it writes the code on its own branch',
  coordinator: 'a coordinator: it plans the parts and starts the agents that build them',
  conversation: 'a conversation: it talks and researches, with no repository of its own',
  reviewer: 'a reviewer: it reads the work and returns findings',
} as const;

/** What the chooser is told about a task (§5): never credentials, the thread or file contents. */
export interface ChooserTask {
  title: string;
  goal?: string;
  role: keyof typeof ROLE_WORDS;
  repo?: string;
  labels?: readonly string[];
  parent?: { title: string; goal?: string };
  /** The parent's approved plan entry for this part: the paths it owns. */
  plan?: readonly string[];
  /** Siblings starting now, or running beside it (volume). */
  siblings?: { count: number; titles: readonly string[] };
}

export const CHOOSER_STATE_MAX_CHARS = 8000;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The `state` Jev reads: the task alone. The policy is in the questions' instructions. */
export function buildChooserState(task: ChooserTask): string {
  const lines = [`Task: ${clip(task.title, 300)}`];
  if (task.goal !== undefined && task.goal.trim() !== '')
    lines.push(`Goal: ${clip(task.goal, 3000)}`);
  lines.push(`Role: ${ROLE_WORDS[task.role]}`);
  if (task.repo !== undefined) lines.push(`Repository: ${clip(task.repo, 100)}`);
  if (task.labels !== undefined && task.labels.length > 0) {
    lines.push(`Labels: ${task.labels.slice(0, 20).join(', ')}`);
  }
  if (task.parent !== undefined) {
    lines.push(`Part of: ${clip(task.parent.title, 300)}`);
    if (task.parent.goal !== undefined && task.parent.goal.trim() !== '') {
      lines.push(`The parent's goal: ${clip(task.parent.goal, 1500)}`);
    }
  }
  if (task.plan !== undefined && task.plan.length > 0) {
    lines.push(
      `The parent's plan gives this part: ${clip(task.plan.slice(0, 30).join(', '), 800)}`,
    );
  }
  if (task.siblings !== undefined) {
    const { count, titles } = task.siblings;
    lines.push(
      count === 0
        ? 'Siblings starting now: none (a one-off).'
        : `Siblings starting now: ${count}${
            titles.length > 0 ? ` (${clip(titles.slice(0, 10).join('; '), 800)})` : ''
          }`,
    );
  }
  return clip(lines.join('\n'), CHOOSER_STATE_MAX_CHARS);
}

/** Try it: the pasted text as a task (the first line its title, the rest its goal). */
export function taskFromText(text: string): ChooserTask {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split(/\r?\n/);
  const goal = rest.join('\n').trim();
  return {
    title: clip(first, 300) || 'Task',
    ...(goal !== '' ? { goal } : first.length > 300 ? { goal: trimmed } : {}),
    role: 'worker',
  };
}

/** `POST /api/model-policy/try` and `policy.try`: a task's text, and the layer whose policy reads it. */
export const MODEL_POLICY_TRY_MAX_CHARS = 4000;
export const ModelPolicyTryInputSchema = z
  .object({
    text: z.string().trim().min(1).max(MODEL_POLICY_TRY_MAX_CHARS),
    project: ProjectIdSchema.optional(),
    node: UlidSchema.optional(),
  })
  .strict();
export type ModelPolicyTryInput = z.infer<typeof ModelPolicyTryInputSchema>;

// ---------------------------------------------------------------- the questions

/** §5's criteria: what each asks and what each of 1–5 means. */
export const CRITERION_QUESTIONS: Record<
  RoutingCriterion,
  { instructions: string; options: Record<'1' | '2' | '3' | '4' | '5', string> }
> = {
  clarity: {
    instructions: 'How well specified is the task?',
    options: {
      '1': 'Open-ended: the goal is vague and what done looks like is not said.',
      '2': 'Loosely specified: a direction, with most details left to decide.',
      '3': 'Partly specified: the goal is clear; some scope or acceptance is missing.',
      '4': 'Well specified: a clear goal and scope; acceptance is mostly implied.',
      '5': 'Well defined: the exact goal and scope, with acceptance stated.',
    },
  },
  verifiability: {
    instructions: 'Can a test, a build or a typecheck prove the work is done and right?',
    options: {
      '1': 'No: only a person’s judgement can tell (design, writing, research).',
      '2': 'Barely: mostly manual checking.',
      '3': 'Partly: some tests or a build cover it, with gaps.',
      '4': 'Mostly: tests, a build or a typecheck would catch most mistakes.',
      '5': 'Fully: a test, a build or a typecheck proves it.',
    },
  },
  horizon: {
    instructions: 'How long a job is it: a quick fix, or a multi-hour, many-step job?',
    options: {
      '1': 'A quick fix: minutes, one or two steps.',
      '2': 'Short: under an hour, a few steps.',
      '3': 'Medium: an hour or two, several steps.',
      '4': 'Long: a few hours, many steps across files.',
      '5': 'A multi-hour, many-step job with sub-tasks and iteration.',
    },
  },
  stakes: {
    instructions:
      'What does a mistake cost: easily undone, or security, a data migration, architecture or money?',
    options: {
      '1': 'Easily undone: cosmetic or local; no one is affected.',
      '2': 'Low: a small bug, quickly reverted.',
      '3': 'Moderate: user-facing behaviour or shared code.',
      '4': 'High: stored data, public interfaces, or hard to revert.',
      '5': 'Critical: security, a data migration, architecture or money.',
    },
  },
  volume: {
    instructions:
      'Is it a one-off, or one of many similar parts starting at once? Use the siblings starting now.',
    options: {
      '1': 'A one-off: no similar parts.',
      '2': 'One or two similar parts.',
      '3': 'A few similar parts.',
      '4': 'Several similar parts starting together.',
      '5': 'One of many near-identical parts starting at once.',
    },
  },
};

export const TOPIC_QUESTION: { instructions: string; options: Record<ChooserTopic, string> } = {
  instructions: 'Is the task mainly about one of these topics?',
  options: {
    architecture:
      'Architecture: the structure of a system, its modules, boundaries, interfaces or data flow.',
    migration:
      'Migration: moving or transforming stored data or schemas, or moving to another framework or version.',
    security:
      'Security: authentication, authorization, secrets, input validation or other security-sensitive code.',
    none: 'None of these.',
  },
};

/** §5's default rule, written into the `tier` question (T483: the `model` question). */
export const DEFAULT_CHOOSER_RULE =
  'Use a balanced model when the task is well specified and checkable. Use the strongest preset model when it is ambiguous, high-stakes or long-horizon. Use the fastest when it is high-volume and checkable. Quality priority moves the thresholds: toward speed, a balanced model needs clarity and verifiability of only 3; toward quality, 4.';

const EFFORT_OPTION_WORDS: Record<Effort, string> = {
  low: 'Low: routine work that needs little thought.',
  medium: 'Medium: the usual amount of reasoning.',
  high: 'High: careful reasoning for long-horizon or high-stakes work.',
  max: 'Max: the most reasoning the model offers, for the hardest work.',
};

function qualityText(quality: number): string {
  const lean =
    quality <= 20
      ? 'favour speed and cost'
      : quality < 45
        ? 'lean to speed and cost'
        : quality <= 55
          ? 'balance quality against speed and cost'
          : quality < 80
            ? 'lean to quality'
            : 'favour quality';
  return `Quality priority: ${quality} of 100 (0 favours speed and cost, 100 favours quality): ${lean}.`;
}

function weightsText(weights: ModelPolicy['weights']): string {
  const list = ROUTING_CRITERIA.map((c) => `${c} ${weights[c]}`).join(', ');
  return `Weigh the criteria by these weights (0 ignores one, 1 is normal, 3 counts it most): ${list}.`;
}

/** T490 (D57): what each tier means, for the `tier` question's options. */
export const TIER_OPTION_WORDS: Record<ModelTier, string> = {
  fast: 'Fast: the quickest, cheapest models, for simple, checkable work, above all when many similar parts start at once.',
  balanced:
    'Balanced: capable everyday models, for work that is well specified and can be checked by tests, a build or a typecheck.',
  strongest:
    'Strongest: the most capable and costliest models, for ambiguous, high-stakes or long-horizon work.',
};

/**
 * A tier as an option: what it means, and the preset models in it with
 * their relative cost ("Here: Claude Sonnet 5.5 (cost 1), GPT-5.6 Sol (cost 1).").
 */
export function tierOptionText(
  tier: ModelTier,
  candidates: readonly PresetModel[],
  profiles: Readonly<Record<string, ModelProfile>>,
  models?: Readonly<Partial<Record<string, readonly PickCatalogModel[]>>>,
): string {
  const here = candidates
    .filter((c) => profileOf(c.vendor, c.model, profiles).tier === tier)
    .slice(0, 12)
    .map(
      (c) =>
        `${modelWords(c.vendor, c.model, models)} (cost ${profileOf(c.vendor, c.model, profiles).cost})`,
    );
  return clip(`${TIER_OPTION_WORDS[tier]} Here: ${here.join(', ')}.`, JEV_CHOICE_OPTION_MAX_CHARS);
}

export interface ChooserQuestionsInput {
  policy: ModelPolicy;
  /** The models a routed pick may land on (the installed presets, else every installed model). */
  candidates: readonly PresetModel[];
  profiles: Readonly<Record<string, ModelProfile>>;
  models?: Readonly<Partial<Record<string, readonly PickCatalogModel[]>>>;
  /** `topic`: only the topic (a pinned rule names one); `full`: all of §5's questions. */
  need: 'topic' | 'full';
}

/** The ids of §5's questions (T490: `tier` in place of T483's `model`). */
export const CHOOSER_QUESTION_IDS = [...ROUTING_CRITERIA, 'topic', 'tier', 'effort'] as const;

/**
 * §5's questions for one call: the five criteria (1–5), `topic`, `tier`
 * (T490, D57: only the tiers the candidates have, asked under Start cheap
 * when there are at least two) and `effort` (the levels up to the ceiling,
 * when a candidate's vendor takes effort).
 */
export function chooserQuestions(input: ChooserQuestionsInput): ChoiceQuestion[] {
  const topic: ChoiceQuestion = {
    id: 'topic',
    ...TOPIC_QUESTION,
    options: { ...TOPIC_QUESTION.options },
  };
  if (input.need === 'topic') return [topic];
  const { policy } = input;
  const questions: ChoiceQuestion[] = ROUTING_CRITERIA.map((c) => ({
    id: c,
    instructions: CRITERION_QUESTIONS[c].instructions,
    options: { ...CRITERION_QUESTIONS[c].options },
  }));
  questions.push(topic);
  const guidance =
    policy.guidance.trim() !== ''
      ? ` The operator's guidance, to follow as written: ${policy.guidance.trim()}`
      : '';
  const tiers = tiersPresent(input.candidates, input.profiles);
  // Strongest first always runs the strongest preset model (§3): Jev isn't asked which tier.
  if (policy.escalation === 'start_cheap' && tiers.length >= 2) {
    const options: Record<string, string> = {};
    for (const tier of tiers) {
      options[tier] = tierOptionText(tier, input.candidates, input.profiles, input.models);
    }
    questions.push({
      id: 'tier',
      instructions: `Which tier of model should run this task? The rule: ${DEFAULT_CHOOSER_RULE} ${qualityText(
        policy.quality,
      )} ${weightsText(policy.weights)}${guidance}`,
      options,
    });
  }
  const ceiling = EFFORT_LEVELS.indexOf(policy.effort_ceiling);
  const levels = EFFORT_LEVELS.slice(0, ceiling + 1);
  if (levels.length >= 2 && input.candidates.some((c) => vendorTakesEffort(c.vendor))) {
    const options: Record<string, string> = {};
    for (const level of levels) options[level] = EFFORT_OPTION_WORDS[level];
    questions.push({
      id: 'effort',
      instructions: `How much reasoning effort should the model spend on this task? Start from medium; long-horizon or high-stakes work goes one level up. ${qualityText(
        policy.quality,
      )}${guidance}`,
      options,
    });
  }
  return questions;
}

// ---------------------------------------------------------------- the reading

/** An answer the chooser can't read: the call counts as failed ("Jev didn't answer"). */
export class ChooserReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChooserReadError';
  }
}

/**
 * A score: the probability-weighted mean of the numbered options, so 4.6
 * says how sure Jev was, not only its top answer. Probabilities for options
 * that weren't asked are dropped and the rest renormalised; with none left,
 * the chosen option itself.
 */
export function scoreOf(answer: ChoiceAnswer, options: readonly string[]): number {
  let sum = 0;
  let weighted = 0;
  for (const option of options) {
    const p = answer.probabilities[option];
    if (p === undefined || !Number.isFinite(p) || p <= 0) continue;
    sum += p;
    weighted += p * Number(option);
  }
  if (sum > 0) return Math.round((weighted / sum) * 100) / 100;
  if (options.includes(answer.choice)) return Number(answer.choice);
  throw new ChooserReadError(`the answer for "${answer.id}" names no option it was asked`);
}

/**
 * Jev's answers as a reading. Every question asked must have an answer; a
 * topic, tier or effort outside its options is a bad answer.
 */
export function readChooserAnswers(
  questions: readonly ChoiceQuestion[],
  answers: readonly ChoiceAnswer[],
): ChooserReading {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const answer = (q: ChoiceQuestion): ChoiceAnswer => {
    const a = byId.get(q.id);
    if (a === undefined) throw new ChooserReadError(`no answer for "${q.id}"`);
    return a;
  };
  const asked = new Map(questions.map((q) => [q.id, q]));
  const topicQ = asked.get('topic');
  if (topicQ === undefined) throw new ChooserReadError('the topic was not asked');
  const topicA = answer(topicQ);
  if (!(CHOOSER_TOPICS as readonly string[]).includes(topicA.choice)) {
    throw new ChooserReadError(`"${topicA.choice}" is not a topic`);
  }
  const reading: ChooserReading = { topic: topicA.choice as ChooserTopic };
  if (ROUTING_CRITERIA.every((c) => asked.has(c))) {
    const scores = {} as ChooserScores;
    for (const c of ROUTING_CRITERIA) {
      const q = asked.get(c) as ChoiceQuestion;
      scores[c] = Math.min(5, Math.max(1, scoreOf(answer(q), Object.keys(q.options))));
    }
    reading.scores = scores;
  }
  const tierQ = asked.get('tier');
  if (tierQ !== undefined) {
    const a = answer(tierQ);
    const tier = MODEL_TIERS.find((t) => t === a.choice);
    if (tier === undefined || tierQ.options[tier] === undefined) {
      throw new ChooserReadError(`"${a.choice}" is not a tier it was asked`);
    }
    reading.tier = { tier, confidence: a.confidence };
  }
  const effortQ = asked.get('effort');
  if (effortQ !== undefined) {
    const a = answer(effortQ);
    const level = EFFORT_LEVELS.find((l) => l === a.choice);
    if (level === undefined || effortQ.options[level] === undefined) {
      throw new ChooserReadError(`"${a.choice}" is not an effort level it was asked`);
    }
    reading.effort = { level, confidence: a.confidence };
  }
  return reading;
}

/** What Try it returns: the reading, the pick and its line, without starting anything. */
export interface ModelPolicyTryResult {
  /** The resolved mode here; Try it reads the task as Choose would. */
  mode: ModelPolicy['mode'];
  pick: {
    vendor: string;
    model: string;
    effort: Effort;
    how: PickHow;
    base?: PickHow;
    why: string;
    note?: string;
  };
  /** "Model: Claude Sonnet 5.5 · medium — well specified and covered by tests; short, low stakes". */
  line: string;
  scores?: ChooserScores;
  topic?: ChooserTopic;
  /** T490: Jev's confidence in its tier. */
  confidence?: number;
  /** T490 (D57, D59): the tier, how it was decided, and why this model in it. */
  tier?: ModelTier;
  tier_by?: TierBy;
  in_tier?: InTier;
  /** T490: the vendor order that broke ties (a worker's), in words. */
  vendor_order?: string;
  /** Why there was no reading. */
  failed?: { reason: 'no_key' | 'no_answer'; words: string };
  /** How long the Jev call took. */
  latency_ms?: number;
}
