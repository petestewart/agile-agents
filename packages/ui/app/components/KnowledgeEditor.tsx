/**
 * T366: the knowledge form, in the side panel — Edit (`mode="edit"`) and
 * "Add knowledge" (`mode="create"`). Grouped as a person thinks about an
 * item: *what* it says, *where* it applies, *how* it is enforced; a check's
 * fields show only when they apply (a pattern's kind and values for a
 * pattern check; the question, criteria and examples for a classifier
 * check). Cancel and Esc discard the draft; nothing is sent until Save /
 * Propose. Every write is `rule.update`'s patch or `POST /api/rules`,
 * stamped `human` by the daemon.
 */

import {
  KNOWLEDGE_KINDS,
  RULE_EXAMPLES_MAX,
  RULE_PATTERN_KINDS,
  RULE_TEXT_MAX_CHARS,
  type RulePatternKind,
  parseKnowledgeScope,
} from '@agile-agents/shared';
import { useId, useMemo, useState } from 'react';
import { useFeed } from '../lib/feed-context';
import {
  ENFORCEMENT_INFO,
  ENFORCEMENT_ORDER,
  KIND_HINT,
  KIND_LABEL,
  PATTERN_KIND_LABEL,
  type RuleDraft,
  draftCheck,
  examplesShort,
  plainError,
  scopeChoices,
  scopeHint,
} from '../lib/rules';
import { Icon } from './Icon';
import { ENFORCEMENT_ICON } from './KnowledgeList';
import { Button, Field, IconButton, Segmented } from './ui';

export function KnowledgeEditor({
  mode,
  title,
  initial,
  submit,
  onDone,
  onCancel,
}: {
  mode: 'edit' | 'create';
  /** Edit: the item's title, for the panel's bar. */
  title?: string;
  initial: RuleDraft;
  submit: (draft: RuleDraft) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const set = (patch: Partial<RuleDraft>): void => setDraft((prev) => ({ ...prev, ...patch }));
  const creating = mode === 'create';
  const ids = useId();
  // T338: scopes are picked by name, never typed as ids.
  const { cockpit } = useFeed();
  const scopes = useMemo(() => {
    const choices = scopeChoices(cockpit);
    return choices.some((c) => c.value === draft.scope)
      ? choices
      : [...choices, { value: draft.scope, label: 'A node or project that has gone' }];
  }, [cockpit, draft.scope]);
  const how = draftCheck(draft);
  const short = examplesShort(draft);
  let scopeKind: string | undefined;
  try {
    scopeKind = parseKnowledgeScope(draft.scope).kind;
  } catch {
    scopeKind = undefined;
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await submit(draft);
      onDone();
    } catch (err) {
      setError(plainError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  const setExample = (index: number, patch: Partial<RuleDraft['examples'][number]>): void =>
    set({ examples: draft.examples.map((x, i) => (i === index ? { ...x, ...patch } : x)) });

  return (
    <form
      className="cr-kn-form"
      data-testid={creating ? 'rules-new-form' : 'rules-editor'}
      aria-label={creating ? 'Add knowledge' : 'Edit knowledge'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="cr-kn-panel-bar">
        <span className="cr-kn-panel-crumb">
          <Icon name={creating ? 'plus' : 'pencil'} size={14} />
          {creating ? 'Add knowledge' : 'Edit'}
          {title !== undefined && <span className="cr-kn-crumb-title">{title}</span>}
        </span>
        <IconButton icon="x" label="Cancel (Esc)" onClick={onCancel} disabled={busy} />
      </div>
      {creating && (
        <p className="cr-kn-form-lede">
          It starts as a proposal: nothing applies until you accept it.
        </p>
      )}

      <div className="cr-kn-form-body">
        <fieldset className="cr-kn-group">
          <legend>What</legend>
          <Field label="Kind" hint={KIND_HINT[draft.kind]}>
            <Segmented
              label="Kind"
              testid="rules-edit-kind"
              value={draft.kind}
              onChange={(kind) => set({ kind })}
              items={KNOWLEDGE_KINDS.map((kind) => ({ id: kind, label: KIND_LABEL[kind] }))}
            />
          </Field>
          <Field
            label="What agents should know"
            htmlFor={`${ids}-text`}
            hint={
              <span className="cr-kn-counter">
                <span>Markdown. Agents in scope see this in their brief.</span>
                <span data-over={draft.text.length > RULE_TEXT_MAX_CHARS ? 'true' : undefined}>
                  {draft.text.length}/{RULE_TEXT_MAX_CHARS}
                </span>
              </span>
            }
          >
            <textarea
              id={`${ids}-text`}
              data-testid="rules-edit-text"
              rows={4}
              value={draft.text}
              placeholder="e.g. Store money as integer cents; convert only at the edges."
              onChange={(e) => set({ text: e.target.value })}
            />
          </Field>
          <Field
            label="Name"
            htmlFor={`${ids}-name`}
            hint="Optional. A short handle for lists and messages."
          >
            <input
              id={`${ids}-name`}
              data-testid="rules-edit-name"
              value={draft.name}
              maxLength={64}
              placeholder="e.g. money-in-cents"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
        </fieldset>

        <fieldset className="cr-kn-group">
          <legend>Where</legend>
          <Field
            label="Applies to"
            htmlFor={`${ids}-scope`}
            hint={scopeKind === undefined ? undefined : scopeHint(parseKnowledgeScope(draft.scope))}
          >
            <select
              id={`${ids}-scope`}
              data-testid="rules-edit-scope"
              value={draft.scope}
              onChange={(e) => set({ scope: e.target.value })}
            >
              {scopes.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Only these paths"
            htmlFor={`${ids}-paths`}
            hint="Optional. Globs relative to the repo root, one per line. Empty means every path."
          >
            <textarea
              id={`${ids}-paths`}
              data-testid="rules-edit-paths"
              rows={2}
              className="cr-kn-mono"
              value={draft.paths}
              placeholder="src/money/**"
              onChange={(e) => set({ paths: e.target.value })}
            />
          </Field>
        </fieldset>

        <fieldset className="cr-kn-group">
          <legend>How it's enforced</legend>
          <div
            className="cr-kn-choices"
            role="radiogroup"
            aria-label="Enforcement"
            data-testid="rules-edit-enforcement"
          >
            {ENFORCEMENT_ORDER.map((value) => (
              <label
                key={value}
                className="cr-kn-choice"
                data-value={value}
                data-checked={draft.enforcement === value ? 'true' : undefined}
              >
                <input
                  type="radio"
                  name={`${ids}-enforcement`}
                  value={value}
                  checked={draft.enforcement === value}
                  onChange={() => set({ enforcement: value })}
                />
                <span className="cr-kn-choice-icon">
                  <Icon name={ENFORCEMENT_ICON[value]} size={15} />
                </span>
                <span className="cr-kn-choice-text">
                  <span className="cr-kn-choice-label">{ENFORCEMENT_INFO[value].label}</span>
                  <span className="cr-kn-choice-hint">{ENFORCEMENT_INFO[value].hint}</span>
                </span>
              </label>
            ))}
          </div>

          {draft.enforcement === 'action' && (
            <Field
              label="Check with"
              hint={
                how.pattern
                  ? 'A fixed pattern: fast, no classifier call, always the same answer.'
                  : 'The classifier: a yes/no question for rules a pattern cannot express.'
              }
            >
              <Segmented
                label="Check with"
                testid="rules-edit-check-by"
                value={draft.checkBy}
                onChange={(checkBy) => set({ checkBy })}
                items={[
                  { id: 'classifier', label: 'The classifier' },
                  { id: 'pattern', label: 'A fixed pattern' },
                ]}
              />
            </Field>
          )}
          {draft.enforcement === 'ship' && (
            <p className="cr-kn-form-note">
              The classifier checks the whole diff with the question below.
            </p>
          )}

          {how.pattern && (
            <div className="cr-kn-subgroup">
              <Field label="Pattern" htmlFor={`${ids}-pattern`}>
                <select
                  id={`${ids}-pattern`}
                  data-testid="rules-edit-pattern-kind"
                  value={draft.patternKind}
                  onChange={(e) => set({ patternKind: e.target.value as RulePatternKind })}
                >
                  {RULE_PATTERN_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {PATTERN_KIND_LABEL[value]}
                    </option>
                  ))}
                </select>
              </Field>
              {(draft.patternKind === 'path_deny' || draft.patternKind === 'command_deny') && (
                <Field
                  label={draft.patternKind === 'path_deny' ? 'Paths to block' : 'Commands to block'}
                  htmlFor={`${ids}-pattern-args`}
                  hint={
                    draft.patternKind === 'path_deny'
                      ? "One glob per line. Writes outside the node's worktree are always blocked."
                      : 'One per line; a command matching any of them is blocked.'
                  }
                >
                  <textarea
                    id={`${ids}-pattern-args`}
                    data-testid="rules-edit-pattern-args"
                    rows={3}
                    className="cr-kn-mono"
                    value={draft.patternArgs}
                    placeholder={draft.patternKind === 'path_deny' ? 'secrets/**' : 'rm -rf'}
                    onChange={(e) => set({ patternArgs: e.target.value })}
                  />
                </Field>
              )}
            </div>
          )}

          {how.classifier && (
            <div className="cr-kn-subgroup">
              <Field
                label="Question"
                htmlFor={`${ids}-question`}
                hint="One yes/no question; yes means the rule is broken. Leave it empty to ask the default shown."
              >
                <input
                  id={`${ids}-question`}
                  data-testid="rules-edit-question"
                  value={draft.question}
                  placeholder={`Does this action violate: ${draft.text.trim() || '…'}?`}
                  onChange={(e) => set({ question: e.target.value })}
                />
              </Field>
              <div className="cr-kn-pair">
                <Field label="Yes means" htmlFor={`${ids}-yes`}>
                  <textarea
                    id={`${ids}-yes`}
                    data-testid="rules-edit-criteria-true"
                    rows={2}
                    value={draft.criteriaTrue}
                    placeholder="Optional: when the rule is broken"
                    onChange={(e) => set({ criteriaTrue: e.target.value })}
                  />
                </Field>
                <Field label="No means" htmlFor={`${ids}-no`}>
                  <textarea
                    id={`${ids}-no`}
                    data-testid="rules-edit-criteria-false"
                    rows={2}
                    value={draft.criteriaFalse}
                    placeholder="Optional: when it holds"
                    onChange={(e) => set({ criteriaFalse: e.target.value })}
                  />
                </Field>
              </div>
              <div className="cr-kn-examples-edit">
                <div className="cr-kn-examples-hd">
                  <span className="cr-field-label">Examples</span>
                  <span className="cr-field-hint">
                    {short > 0
                      ? `Needs ${short} more before it can be accepted: one that breaks the rule and one that doesn't.`
                      : 'Each is a test for the classifier: "Test examples" runs them.'}
                  </span>
                </div>
                {draft.examples.map((example, index) => (
                  <div
                    className="cr-kn-example"
                    // biome-ignore lint/suspicious/noArrayIndexKey: examples have no identity but their place
                    key={index}
                    data-testid="rules-edit-example"
                  >
                    <input
                      aria-label="Example action"
                      value={example.action}
                      placeholder={
                        draft.enforcement === 'ship'
                          ? 'e.g. diff changes src/a.ts and adds no test'
                          : 'e.g. bun add lodash'
                      }
                      onChange={(e) => setExample(index, { action: e.target.value })}
                    />
                    <label
                      className="cr-kn-violates"
                      data-on={example.violates ? 'true' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={example.violates}
                        onChange={(e) => setExample(index, { violates: e.target.checked })}
                      />
                      Violates
                    </label>
                    <IconButton
                      icon="x"
                      size="sm"
                      label="Remove example"
                      onClick={() =>
                        set({ examples: draft.examples.filter((_, i) => i !== index) })
                      }
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="plus"
                  data-testid="rules-edit-add-example"
                  disabled={draft.examples.length >= RULE_EXAMPLES_MAX}
                  title={`At most ${RULE_EXAMPLES_MAX} examples per item`}
                  onClick={() =>
                    set({
                      examples: [
                        ...draft.examples,
                        // Alternate: a violation first, then an allowed action.
                        { action: '', violates: draft.examples.length % 2 === 0 },
                      ],
                    })
                  }
                >
                  Add example
                </Button>
              </div>
            </div>
          )}

          {how.checked && (
            <label className="cr-kn-critical-opt">
              <input
                type="checkbox"
                data-testid="rules-edit-critical"
                checked={draft.critical}
                onChange={(e) => set({ critical: e.target.checked })}
              />
              <span>
                <span className="cr-kn-choice-label">Critical</span>
                <span className="cr-kn-choice-hint">
                  Block even when the checker can't be reached. Otherwise an outage lets actions
                  through, with a note on the node.
                </span>
              </span>
            </label>
          )}
        </fieldset>
      </div>

      <div className="cr-kn-form-ft">
        {error && (
          <p className="cr-kn-note" data-tone="red" role="alert">
            <Icon name="alert-circle" size={14} />
            {error}
          </p>
        )}
        <div className="cr-kn-form-buttons">
          <Button data-testid="rules-edit-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" data-testid="rules-edit-save" busy={busy}>
            {creating ? 'Propose' : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
}
