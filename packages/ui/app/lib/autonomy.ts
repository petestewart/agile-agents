/**
 * T423 (audit finding 15): how far a project's coordinators and its
 * Director act on their own (projects-design §9 "Autonomy", §12; the gate
 * is `allowed` in the daemon's `coordination/autonomy.ts`), in the words
 * the details panel shows: "Advise — proposes, you apply", a sentence under
 * each picker, "Inherits Advise from the project", and what Run asks before
 * it is set. The Director's words are its own panel's (`DIRECTOR_AUTONOMY`).
 */

import type { Autonomy } from '@agile-agents/shared';
import { DIRECTOR_AUTONOMY } from './director';

export const AUTONOMY_LEVELS: readonly Autonomy[] = ['advise', 'organise', 'run'];

export interface AutonomyWords {
  label: string;
  /** A few words after the label in a picker. */
  short: string;
  /** One sentence under the picker. */
  hint: string;
}

/** A coordinator's levels (projects-design §9): what it does with a change to its parts. */
export const COORDINATOR_AUTONOMY: Record<Autonomy, AutonomyWords> = {
  advise: {
    label: 'Advise',
    short: 'proposes, you apply',
    hint: 'Proposes new parts, links and owners; you apply them.',
  },
  organise: {
    label: 'Organise',
    short: 'makes changes itself',
    hint: 'Adds parts, links and owners itself, and tells you.',
  },
  run: {
    label: 'Run',
    short: 'also approves contracts',
    hint: 'Also approves routine contract changes itself.',
  },
};

export type AutonomyWho = 'coordinator' | 'director';

export function autonomyWords(who: AutonomyWho): Record<Autonomy, AutonomyWords> {
  return who === 'director' ? DIRECTOR_AUTONOMY : COORDINATOR_AUTONOMY;
}

/** "Advise — proposes, you apply": a picker's option. */
export function autonomyOption(who: AutonomyWho, level: Autonomy): string {
  const words = autonomyWords(who)[level];
  return `${words.label} — ${words.short}`;
}

/** "Inherits Advise from the project": a coordinating node's option to follow its project. */
export function inheritsOption(level: Autonomy): string {
  return `Inherits ${COORDINATOR_AUTONOMY[level].label} from the project`;
}

/** A change asks first when it lets the agent run on its own (Run), and it didn't before. */
export function confirmsRun(before: Autonomy, after: Autonomy): boolean {
  return after === 'run' && before !== 'run';
}

/** What the confirmation says before a level goes to Run. */
export function runConfirm(
  who: AutonomyWho,
  project: string,
): { title: string; body: string; confirm: string } {
  return who === 'director'
    ? {
        title: `Let the Director run ${project} on its own?`,
        body: 'At Run it also approves routine contract changes and restarts stuck work without asking. Merging and accepting knowledge stay yours.',
        confirm: 'Set to Run',
      }
    : {
        title: 'Let the coordinator run on its own?',
        body: 'At Run it also approves routine contract changes without asking. Plans, changes to what gets built, and merging stay yours.',
        confirm: 'Set to Run',
      };
}

// ---------------------------------------------------------------- a held proposal's card (T446)

/** T446: the kinds of held change, as a proposal's summary starts (`describeChange`). */
export type ProposalChange =
  | 'add_child'
  | 'add_waits_on'
  | 'set_owner'
  | 'approve_contract'
  | 'create_tree'
  | 'create_node'
  | 'create_project'
  | 'start_node'
  | 'restart_node'
  | 'other';

/**
 * T446: which change a proposal holds, from its summary's first words (the
 * daemon's `describeChange`, and its wording before T446: "add child …").
 */
export function proposalChange(summary: string): ProposalChange {
  const s = summary.trim();
  if (/^(?:Add a (?:part|node) |add child )/.test(s)) return 'add_child';
  if (/^Make .+ wait on |^.+ waits on /s.test(s)) return 'add_waits_on';
  if (/^Let .+ own |^.+ owns /s.test(s)) return 'set_owner';
  if (/^(?:Approve a (?:routine )?change to |contract )/.test(s)) return 'approve_contract';
  if (/^Create the project |^create project /.test(s)) return 'create_project';
  if (/^Create "[^"]*" in .+ with \d+ parts?|^create "[^"]*" in /s.test(s)) return 'create_tree';
  if (/^(?:Create|create node) "/.test(s)) return 'create_node';
  if (/^[Ss]tart /.test(s)) return 'start_node';
  if (/^[Rr]estart /.test(s)) return 'restart_node';
  return 'other';
}

/** T446: what Apply does, per held change. */
const APPLY_DOES: Record<ProposalChange, string> = {
  add_child: 'Apply creates the node and starts it.',
  add_waits_on: 'Apply makes it wait.',
  set_owner: 'Apply gives it those paths.',
  approve_contract: 'Apply approves the change and tells the parts.',
  create_tree: 'Apply creates the node and its parts and starts them.',
  create_node: 'Apply creates the node and starts it.',
  create_project: 'Apply creates the project.',
  start_node: 'Apply starts its agent.',
  restart_node: 'Apply restarts its agent.',
  other: 'Apply makes the change.',
};

export interface ProposalCardWords {
  /** Where the level is set ("Shop", or the node that overrides it), the link's text before it. */
  where: string;
  /** The level's name: the link to where it is set. */
  level: string;
  /** After the level: why it asks ": nothing changes until you apply."). */
  why: string;
  /** What pressing Apply does. */
  apply: string;
}

/**
 * T446 (audit r7 #6): what an autonomy proposal's card says under the change:
 * the level it is held at and what Apply does — "Shop is at Advise: nothing
 * changes until you apply. Apply creates the node and starts it." `level`
 * is `undefined` when the change makes a new project (no level yet).
 */
export function proposalCardWords(input: {
  principal: AutonomyWho;
  summary: string;
  /** The project, or the node whose own level overrides it. */
  where: string | undefined;
  level: Autonomy | undefined;
}): ProposalCardWords {
  const change = proposalChange(input.summary);
  const apply = APPLY_DOES[change];
  const who = input.principal === 'director' ? 'The Director' : 'Its coordinator';
  if (input.level === undefined || input.where === undefined) {
    return {
      where: '',
      level: '',
      why: `${who} asks first: a new project always comes to you.`,
      apply,
    };
  }
  const label = autonomyWords(input.principal)[input.level].label;
  const why =
    input.level === 'advise'
      ? ': nothing changes until you apply.'
      : change === 'approve_contract'
        ? input.level === 'run'
          ? ': only routine contract changes apply on their own.'
          : ': contract changes still come to you.'
        : change === 'restart_node'
          ? ': restarting stuck work still comes to you.'
          : ': this change still comes to you.';
  const where =
    input.principal === 'director'
      ? `The Director’s level in ${input.where} is`
      : `${input.where} is at`;
  return { where, level: label, why, apply };
}
