/**
 * T422 (D42): Turn into work — a conversation that concluded something needs
 * doing becomes that work, right there: same node, same thread. Its goal is
 * drafted from the talk (the cheap model; else its last reply), yours to
 * edit. Pick a repository and it becomes a work node on its own branch; pick
 * none and it stays a research node whose goal is what it should find out.
 * Either way its agent is told to start on the goal.
 */

import { START_ON_GOAL } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { type GoalDraft, addRepoToStream, draftGoal, sayOnStream, updateStream } from '../lib/api';
import type { CockpitRepoRow } from '../lib/feed-types';
import { Icon } from './Icon';
import { type PickOption, PickerField } from './Pickers';
import { Button, Dialog, Field, Kbd, RepoIcon, repoKindLabel } from './ui';

const GOAL_HINT: Record<GoalDraft['from'], string> = {
  model: 'Drafted from the conversation: edit it as you like.',
  reply: 'From its last reply: edit it as you like.',
  question: 'Its question, as asked: say what the work should do.',
};

export function TurnIntoWorkDialog({
  node,
  goal: current,
  repos,
  onClose,
  onDone,
}: {
  node: string;
  goal: string;
  repos: readonly CockpitRepoRow[];
  onClose: () => void;
  onDone: (repo: string | undefined) => void;
}): JSX.Element {
  const [goal, setGoal] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState<GoalDraft['from']>('question');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    draftGoal(node)
      .then((d) => {
        if (!live) return;
        setGoal(d.goal);
        setFrom(d.from);
      })
      .catch(() => live && setGoal(current));
    return () => {
      live = false;
    };
  }, [node, current]);

  const options: PickOption[] = [
    {
      value: '',
      text: 'No repository',
      icon: <Icon name="search" size={14} />,
      sub: 'Research: the goal is what it finds out',
      pinned: true,
      attrs: { 'data-repo': '' },
    },
    ...repos.map(
      (r): PickOption => ({
        value: r.name,
        text: r.name,
        icon: <RepoIcon remote={r.remote} size={14} />,
        sub: repoKindLabel(r.remote),
        attrs: { 'data-repo': r.name },
      }),
    ),
  ];
  const picked = repos.find((r) => r.name === repo);

  const submit = async (): Promise<void> => {
    const text = (goal ?? '').trim();
    if (busy || text === '') return;
    setBusy(true);
    setError(undefined);
    try {
      if (text !== current.trim()) await updateStream(node, { goal: text });
      // In place (T205, D42): its branch and worktree; a live agent restarts in it.
      if (repo !== '') await addRepoToStream(node, repo);
      await sayOnStream(node, START_ON_GOAL, { start: true });
      onDone(repo === '' ? undefined : repo);
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
            <Kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>↵</Kbd> to start
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={goal === undefined || goal.trim() === ''}
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
          hint={goal === undefined ? 'Drafting the goal from the conversation…' : GOAL_HINT[from]}
        >
          <textarea
            className="cr-ask-input"
            data-testid="turn-into-work-goal"
            aria-label="Goal"
            rows={5}
            value={goal ?? ''}
            disabled={goal === undefined}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        <Field label="Repository">
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
        {error && (
          <p className="cr-error" role="alert" data-testid="turn-into-work-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
