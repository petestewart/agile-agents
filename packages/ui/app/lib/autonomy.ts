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
