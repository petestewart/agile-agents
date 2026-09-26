/**
 * T422 (D42): Turn into work — a conversation that concluded something needs
 * doing becomes that work, right there: same node, same thread. Its goal is
 * drafted from the talk (the cheap model; else its last reply), yours to
 * edit. Pick a repository and it becomes a work node on its own branch; pick
 * none and it stays a research node whose goal is what it should find out.
 * Either way its agent is told to start on the goal.
 *
 * T435 (audit r6):
 *  - #3: under a **work** node, a repository would make that node coordinate
 *    it (its Merge card gone, a coordinator started). So "Where": **Next to
 *    <parent>** (the default: the node moves up beside it first) or **Under
 *    <parent>**, with that consequence in words; and a pointer to Send to
 *    <parent>, for when the parent's own agent should do it.
 *  - #12: Enter starts, Shift+Enter is a new line (Ctrl/⌘+Enter too).
 *  - #13: the repositories grouped as New node's are ("In <project>" first);
 *    one outside the project is added to the project's list on Start, as the
 *    hint under the picker says.
 *  - #27: a title that is still the question is renamed from the new goal
 *    (and the cheap model names it better, D41); one you gave it stays.
 */

import { START_ON_GOAL } from '@agile-agents/shared';
import { useEffect, useRef, useState } from 'react';
import {
  type GoalDraft,
  addRepoToStream,
  draftGoal,
  moveStream,
  sayOnStream,
  updateProject,
  updateStream,
} from '../lib/api';
import { type TurnWhere, coordinatesIt, keepsTitle } from '../lib/ask';
import type { CockpitProjectRow, CockpitRepoRow, CockpitStreamRow } from '../lib/feed-types';
import { splitRepos, titleFromGoal } from '../lib/tree';
import { Icon } from './Icon';
import { type PickOption, PickerField } from './Pickers';
import { Button, Dialog, Field, Kbd, RepoIcon, repoKindLabel } from './ui';

/** T431: what a draft that arrived after you typed says, before "Use it instead". */
const DRAFT_READY: Record<GoalDraft['from'], string> = {
  model: 'A draft from the conversation is ready.',
  reply: 'Its last reply is ready as a goal.',
  question: 'Its question is ready as a goal.',
};

const GOAL_HINT: Record<GoalDraft['from'], string> = {
  model: 'Drafted from the conversation: edit it as you like.',
  reply: 'From its last reply: edit it as you like.',
  question: 'Its question, as asked: say what the work should do.',
};

export function TurnIntoWorkDialog({
  node,
  title,
  goal: current,
  repos,
  project,
  parent,
  grandparent,
  onSendUp,
  onClose,
  onDone,
}: {
  node: string;
  /** The conversation's title: still its question, it is renamed from the new goal. */
  title: string;
  goal: string;
  repos: readonly CockpitRepoRow[];
  /** Its project: its repositories come first, and one from outside joins them. */
  project?: CockpitProjectRow;
  /** The node it sits under; a work node there asks where the work goes. */
  parent?: Pick<CockpitStreamRow, 'id' | 'title' | 'role' | 'parent'>;
  /** The parent's own parent, where "Next to" puts it (its title, for the words). */
  grandparent?: Pick<CockpitStreamRow, 'id' | 'title'>;
  /** Send to <parent> instead (absent when the parent can't take one). */
  onSendUp?: () => void;
  onClose: () => void;
  onDone: (result: { repo?: string; where?: TurnWhere }) => void;
}): JSX.Element {
  const [goal, setGoal] = useState('');
  // T431: the draft takes seconds (a model call); the box is yours meanwhile, and a
  // draft that lands after you started typing waits behind "Use the draft".
  const [draft, setDraft] = useState<GoalDraft | undefined>(undefined);
  const [drafting, setDrafting] = useState(true);
  const typed = useRef(false);
  const [repo, setRepo] = useState('');
  const [where, setWhere] = useState<TurnWhere>('next-to');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    draftGoal(node)
      .then((d) => {
        if (!live) return;
        setDraft(d);
        if (!typed.current) setGoal(d.goal);
      })
      .catch(() => {
        if (live && !typed.current) setGoal(current);
      })
      .finally(() => live && setDrafting(false));
    return () => {
      live = false;
    };
  }, [node, current]);

  // T435 (#13): New node's grouping — the project's repositories first.
  const projectName = project?.name ?? 'this project';
  const { inProject, others } = splitRepos(repos, project?.repos);
  const repoOption = (r: CockpitRepoRow, group: string): PickOption => ({
    value: r.name,
    text: r.name,
    icon: <RepoIcon remote={r.remote} size={14} />,
    sub: repoKindLabel(r.remote),
    group,
    attrs: { 'data-repo': r.name },
  });
  const options: PickOption[] = [
    {
      value: '',
      text: 'No repository',
      icon: <Icon name="search" size={14} />,
      sub: 'Research, no branch',
      pinned: true,
      attrs: { 'data-repo': '' },
    },
    ...inProject.map((r) => repoOption(r, `In ${projectName}`)),
    ...others.map((r) =>
      repoOption(r, inProject.length > 0 ? 'Other repositories' : 'Repositories'),
    ),
  ];
  const picked = repos.find((r) => r.name === repo);
  // A repo from outside the project joins its list when the work starts.
  const joinsProject =
    project !== undefined && repo !== '' && !(project.repos ?? []).includes(repo);
  // T435 (#3): under a work node, a repository would make it coordinate this.
  const coordinates = coordinatesIt(parent);
  const asksWhere = coordinates !== undefined && repo !== '';
  const nextTo = asksWhere && where === 'next-to';
  const renames = !keepsTitle(title, current);

  const submit = async (): Promise<void> => {
    const text = (goal ?? '').trim();
    if (busy || text === '') return;
    setBusy(true);
    setError(undefined);
    try {
      // T435 (#3): beside its parent first, so the parent stays what it is.
      if (nextTo && parent?.parent !== undefined) await moveStream(node, parent.parent);
      if (text !== current.trim()) {
        // T435 (#27): a title that is still the question follows the new goal.
        const placeholder = titleFromGoal(text);
        await updateStream(node, {
          goal: text,
          ...(renames && placeholder !== '' ? { title: placeholder, auto_title: true } : {}),
        });
      }
      // T435 (#13): as the hint under the picker says.
      if (joinsProject && project !== undefined) {
        await updateProject(project.id, { repos: [...(project.repos ?? []), repo] });
      }
      // In place (T205, D42): its branch and worktree; a live agent restarts in it.
      if (repo !== '') await addRepoToStream(node, repo);
      await sayOnStream(node, START_ON_GOAL, { start: true });
      onDone({
        ...(repo !== '' ? { repo } : {}),
        ...(asksWhere ? { where } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Turn into work"
      description="Same node, same thread: its agent starts on the goal."
      size="md"
      testid="turn-into-work"
      label="Turn into work"
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="cr-newnode-keys">
            <Kbd>↵</Kbd> to start · <Kbd>Shift</Kbd>
            <Kbd>↵</Kbd> new line
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={goal.trim() === ''}
            data-testid="turn-into-work-start"
          >
            Start the work
          </Button>
        </>
      }
    >
      <div className="cr-ask">
        <Field
          label="Goal"
          hint={
            drafting ? (
              'Drafting the goal from the conversation… or write your own.'
            ) : draft && goal !== draft.goal && goal.trim() !== '' ? (
              <>
                {DRAFT_READY[draft.from]}{' '}
                <button
                  type="button"
                  className="cr-link"
                  data-testid="turn-into-work-use-draft"
                  onClick={() => setGoal(draft.goal)}
                >
                  Use it instead
                </button>
              </>
            ) : draft ? (
              GOAL_HINT[draft.from]
            ) : (
              'Say what the work should do and what done looks like.'
            )
          }
        >
          <textarea
            className="cr-ask-input"
            data-testid="turn-into-work-goal"
            data-drafting={drafting ? 'true' : undefined}
            aria-label="Goal"
            aria-busy={drafting}
            rows={5}
            value={goal}
            placeholder={drafting ? 'Drafting from the conversation…' : 'What should be done?'}
            onChange={(e) => {
              typed.current = true;
              setGoal(e.target.value);
            }}
            onKeyDown={(e) => {
              // T435 (#12): prose, like Ask: Enter starts, Shift+Enter is a new line.
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
              e.preventDefault();
              void submit();
            }}
          />
        </Field>
        <Field
          label="Repository"
          hint={
            joinsProject ? (
              <span data-testid="turn-into-work-joins">
                Also adds {repo} to {projectName}’s repositories.
              </span>
            ) : undefined
          }
        >
          <PickerField
            testid="turn-into-work-repo"
            label="Repository"
            value={repo}
            display={
              picked ? (
                <>
                  <RepoIcon remote={picked.remote} size={14} />
                  <span className="cr-pickfield-text">{picked.name}</span>
                </>
              ) : (
                <>
                  <Icon name="search" size={14} />
                  <span className="cr-pickfield-text">No repository · research</span>
                </>
              )
            }
            options={options}
            placeholder="Search repositories…"
            onPick={setRepo}
          />
        </Field>
        {asksWhere && parent !== undefined && (
          <Field label="Where">
            <div
              className="cr-kn-choices cr-turn-where"
              role="radiogroup"
              aria-label="Where"
              data-testid="turn-into-work-where"
            >
              {(
                [
                  {
                    id: 'next-to',
                    icon: 'git-branch',
                    label: `Next to ${parent.title}`,
                    hint: `Its own node${grandparent ? ` under ${grandparent.title}` : ''}; ${parent.title} stays as it is.`,
                  },
                  {
                    id: 'under',
                    icon: 'network',
                    label: `Under ${parent.title}`,
                    hint: coordinates,
                  },
                ] as const
              ).map((choice) => (
                <label
                  key={choice.id}
                  className="cr-kn-choice"
                  data-value={choice.id}
                  data-testid={`turn-into-work-where-${choice.id}`}
                  data-checked={where === choice.id ? 'true' : undefined}
                >
                  <input
                    type="radio"
                    name={`turn-where-${node}`}
                    value={choice.id}
                    checked={where === choice.id}
                    onChange={() => setWhere(choice.id)}
                  />
                  <span className="cr-kn-choice-icon">
                    <Icon name={choice.icon} size={15} />
                  </span>
                  <span className="cr-kn-choice-text">
                    <span className="cr-kn-choice-label">{choice.label}</span>
                    <span className="cr-kn-choice-hint">{choice.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}
        {coordinates !== undefined && parent !== undefined && onSendUp !== undefined && (
          <p className="cr-turn-alt" data-testid="turn-into-work-send-up">
            To have {parent.title}’s agent do it instead, use{' '}
            <button type="button" className="cr-link" onClick={onSendUp}>
              Send to {parent.title}
            </button>
            .
          </p>
        )}
        {error && (
          <p className="cr-error" role="alert" data-testid="turn-into-work-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
