/**
 * T482 (design/model-routing.md §3–§4, D53–D55): model choice. Who picks
 * the model when a node's agent starts without your pick (a coordinator's
 * or the Director's part, a wake, a node made without a model), and inside
 * which preset models. Your own pick always runs.
 *
 *  - `ModelChoiceCard`: Settings → Agents → Model choice, the home default
 *    every project inherits (D54), with the model profiles.
 *  - `ModelChoiceSection`: a node's Details (or a project root's, where it
 *    is the project's), each field "from Home" or "set here", with Let the
 *    policy choose again and how the current model was picked.
 *
 * Every change saves at once. The pure half is `lib/model-policy.ts`.
 */

import {
  EFFORT_LEVELS,
  type Effort,
  MODEL_ESCALATIONS,
  MODEL_POLICY_MODES,
  MODEL_TIERS,
  type ModelEscalation,
  type ModelPolicyField,
  type ModelPolicyMode,
  type ModelPolicyPatch,
  type ModelProfile,
  type PresetModel,
  type SessionDefaultsStatus,
  type SessionVendor,
  type Stream,
} from '@agile-agents/shared';
import { useEffect, useRef, useState } from 'react';
import {
  type HomeModelPolicyPayload,
  type ModelPolicyPayload,
  type NodeModelPolicyPayload,
  chooseModelAgain,
  getHomeModelPolicy,
  getNodeModelPolicy,
  getProjectModelPolicy,
  getSessionDefaults,
  setHomeModelPolicy,
  setModelProfiles,
  setNodeModelPolicy,
  setProjectModelPolicy,
} from '../lib/api';
import { agentLabel, sessionIdText } from '../lib/chat';
import { pickerView } from '../lib/favourites';
import {
  EFFORT_WORDS,
  ESCALATION_HINTS,
  ESCALATION_WORDS,
  MODE_HINTS,
  MODE_WORDS,
  type ModelPolicyView,
  type PolicyLayer,
  TIER_WORDS,
  favouritePresets,
  isPreset,
  pickHowWords,
  pickLine,
  presetsWords,
  profileRows,
  qualityWords,
  setHere,
  sourceWords,
  togglePreset,
} from '../lib/model-policy';
import { useFavouriteModels } from '../lib/use-favourites';
import { DetailSection } from './NodeDetails';
import { FormError, SavedNote, SetCard, SetRow, errorText, useSavedFlash } from './SettingsCard';
import { Button, Segmented, Spinner } from './ui';

type Save = (patch: ModelPolicyPatch) => Promise<void>;

/** "from Home" / "set here", and on a project or node a way back to inheriting. */
function Source({
  view,
  field,
  here,
  testid,
  busy,
  save,
}: {
  view: ModelPolicyView;
  field: ModelPolicyField;
  here: PolicyLayer;
  testid: string;
  busy: boolean;
  save: Save;
}): JSX.Element {
  const own = setHere(view, field);
  return (
    <span
      className="cr-mpol-source"
      data-testid={`${testid}-source`}
      data-set={own ? 'here' : 'inherited'}
    >
      {sourceWords(view, field, here)}
      {own && here !== 'home' ? (
        <button
          type="button"
          className="cr-link"
          data-testid={`${testid}-clear`}
          disabled={busy}
          title="Stop setting it here and use the inherited value"
          onClick={() => void save({ [field]: null })}
        >
          Use inherited
        </button>
      ) : null}
      {own && here === 'home' ? (
        <button
          type="button"
          className="cr-link"
          data-testid={`${testid}-clear`}
          disabled={busy}
          title="Go back to what ships"
          onClick={() => void save({ [field]: null })}
        >
          Reset
        </button>
      ) : null}
    </span>
  );
}

/** The quality slider: saved once it rests (a drag is one save). */
function QualitySlider({
  value,
  disabled,
  testid,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  testid: string;
  onCommit: (next: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="cr-mpol-quality">
      <span className="cr-mpol-quality-end">Favor speed &amp; cost</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={draft}
        disabled={disabled}
        aria-label="Quality priority"
        aria-valuetext={`${draft}: ${qualityWords(draft)}`}
        data-testid={testid}
        onChange={(e) => {
          const next = Number(e.target.value);
          setDraft(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            if (next !== value) onCommit(next);
          }, 400);
        }}
      />
      <span className="cr-mpol-quality-end">Favor quality</span>
    </div>
  );
}

/** Preset models: the set routed picks stay in, picked from every model the agents list. */
function PresetsField({
  presets,
  disabled,
  testid,
  onChange,
}: {
  presets: readonly PresetModel[];
  disabled: boolean;
  testid: string;
  onChange: (next: PresetModel[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SessionDefaultsStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const favourites = useFavouriteModels(status ?? {});
  useEffect(() => {
    if (!open || status !== undefined) return;
    getSessionDefaults()
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
  }, [open, status]);
  const groups =
    status === undefined
      ? []
      : pickerView({
          known: status.known_models,
          vendors: status.vendors,
          ...(status.vendor_models !== undefined ? { lists: status.vendor_models } : {}),
          favourites: [],
          keep: presets,
          showAll: true,
          query,
          folded: [],
        }).groups;
  return (
    <div className="cr-mpol-presets" data-testid={testid}>
      <p className="cr-mpol-presets-now" data-testid={`${testid}-now`}>
        {presetsWords(presets)}
      </p>
      <div className="cr-mpol-presets-actions">
        <Button
          size="sm"
          icon={open ? 'chevron-down' : 'chevron-right'}
          aria-expanded={open}
          data-testid={`${testid}-change`}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          Change…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="star"
          data-testid={`${testid}-favourites`}
          disabled={disabled || (status !== undefined && favourites.length === 0)}
          title="Use the models you starred as favourites"
          onClick={async () => {
            let favs = favourites;
            if (status === undefined) {
              try {
                const loaded = await getSessionDefaults();
                setStatus(loaded);
                favs = loaded.favourite_models ?? [];
              } catch (err) {
                setError(errorText(err));
                return;
              }
            }
            if (favs.length === 0) {
              setError('No favourites yet: star models in Settings → Agents → Models.');
              return;
            }
            onChange(favouritePresets(favs));
          }}
        >
          Use my favourites
        </Button>
        {presets.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testid}-any`}
            disabled={disabled}
            title="No preset models: a routed pick may use any installed model"
            onClick={() => onChange([])}
          >
            Any model
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="cr-mpol-presets-list" data-testid={`${testid}-list`}>
          <input
            type="search"
            className="cr-mpol-presets-search"
            placeholder="Find a model"
            aria-label="Find a model"
            value={query}
            data-testid={`${testid}-search`}
            onChange={(e) => setQuery(e.target.value)}
          />
          {status === undefined && error === undefined ? (
            <span className="cr-set-muted">
              <Spinner size={12} /> Loading…
            </span>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className="cr-mpol-presets-group">
              <div className="cr-mpol-presets-vendor">{group.label}</div>
              {group.rows.map((row) => {
                const on = isPreset(presets, row);
                return (
                  <label
                    key={`${row.vendor}/${row.model ?? ''}`}
                    className="cr-mpol-preset"
                    title={sessionIdText({ vendor: row.vendor, model: row.model })}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={disabled}
                      data-testid="model-preset-option"
                      data-model={`${row.vendor}/${row.model ?? 'default'}`}
                      onChange={() =>
                        onChange(
                          togglePreset(
                            presets,
                            { vendor: row.vendor as SessionVendor, model: row.model },
                            !on,
                          ),
                        )
                      }
                    />
                    <span>{row.label}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      <FormError error={error} />
    </div>
  );
}

/** The policy's rows: Mode, Quality priority, Preset models, Effort ceiling, Escalation. */
export function ModelPolicyFields({
  view,
  here,
  busy,
  save,
  testid,
}: {
  view: ModelPolicyView;
  here: PolicyLayer;
  busy: boolean;
  save: Save;
  testid: string;
}): JSX.Element {
  const p = view.resolved.policy;
  const src = (field: ModelPolicyField) => (
    <Source
      view={view}
      field={field}
      here={here}
      testid={`${testid}-${field.replace(/_/g, '-')}`}
      busy={busy}
      save={save}
    />
  );
  return (
    <div className="cr-mpol-fields" data-testid={testid}>
      <SetRow
        label="Mode"
        stack={here !== 'home'}
        hint={
          <>
            {MODE_HINTS[p.mode]} {src('mode')}
          </>
        }
        testid={`${testid}-mode-row`}
      >
        <Segmented<ModelPolicyMode>
          label="Model choice mode"
          testid={`${testid}-mode`}
          value={p.mode}
          onChange={(mode) => void save({ mode })}
          items={MODEL_POLICY_MODES.map((id) => ({
            id,
            label: MODE_WORDS[id],
            title: MODE_HINTS[id],
            testid: `${testid}-mode-${id}`,
            disabled: busy,
          }))}
        />
      </SetRow>
      <SetRow
        label="Quality priority"
        hint={
          <>
            <span data-testid={`${testid}-quality-words`}>{qualityWords(p.quality)}</span>{' '}
            {src('quality')}
          </>
        }
        testid={`${testid}-quality-row`}
        stack
      >
        <QualitySlider
          value={p.quality}
          disabled={busy}
          testid={`${testid}-quality`}
          onCommit={(quality) => void save({ quality })}
        />
      </SetRow>
      <SetRow
        label="Preset models"
        hint={<>A routed pick stays in these. Your own pick can be any model. {src('presets')}</>}
        testid={`${testid}-presets-row`}
        stack
      >
        <PresetsField
          presets={p.presets}
          disabled={busy}
          testid={`${testid}-presets`}
          onChange={(presets) => void save({ presets })}
        />
      </SetRow>
      <SetRow
        label="Effort ceiling"
        stack={here !== 'home'}
        hint={<>The highest effort a routed pick may use. {src('effort_ceiling')}</>}
        testid={`${testid}-effort-row`}
      >
        <Segmented<Effort>
          label="Effort ceiling"
          testid={`${testid}-effort`}
          value={p.effort_ceiling}
          onChange={(effort_ceiling) => void save({ effort_ceiling })}
          items={EFFORT_LEVELS.map((id) => ({
            id,
            label: EFFORT_WORDS[id],
            testid: `${testid}-effort-${id}`,
            disabled: busy,
          }))}
        />
      </SetRow>
      <SetRow
        label="Escalation"
        stack={here !== 'home'}
        hint={
          <>
            {ESCALATION_HINTS[p.escalation]} {src('escalation')}
          </>
        }
        testid={`${testid}-escalation-row`}
      >
        <Segmented<ModelEscalation>
          label="Escalation"
          testid={`${testid}-escalation`}
          value={p.escalation}
          onChange={(escalation) => void save({ escalation })}
          items={MODEL_ESCALATIONS.map((id) => ({
            id,
            label: ESCALATION_WORDS[id],
            title: ESCALATION_HINTS[id],
            testid: `${testid}-escalation-${id}`,
            disabled: busy,
          }))}
        />
      </SetRow>
    </div>
  );
}

/** One model profile: its tier and relative cost. */
function ProfileRow({
  row,
  busy,
  onSave,
}: {
  row: ReturnType<typeof profileRows>[number];
  busy: boolean;
  onSave: (key: string, profile: ModelProfile | null) => void;
}): JSX.Element {
  const [cost, setCost] = useState(String(row.profile.cost));
  useEffect(() => setCost(String(row.profile.cost)), [row.profile.cost]);
  const commit = () => {
    const n = Number(cost);
    if (!Number.isFinite(n) || n <= 0) {
      setCost(String(row.profile.cost));
      return;
    }
    if (n !== row.profile.cost) onSave(row.key, { tier: row.profile.tier, cost: n });
  };
  return (
    <div className="cr-mpol-profile" data-testid="model-profile" data-model={row.key}>
      <span className="cr-mpol-profile-name" title={row.key}>
        {agentLabel({ vendor: row.vendor, model: row.model })}
      </span>
      <select
        aria-label={`Tier of ${row.key}`}
        value={row.profile.tier}
        disabled={busy}
        data-testid="model-profile-tier"
        onChange={(e) =>
          onSave(row.key, { tier: e.target.value as ModelProfile['tier'], cost: row.profile.cost })
        }
      >
        {MODEL_TIERS.map((tier) => (
          <option key={tier} value={tier}>
            {TIER_WORDS[tier]}
          </option>
        ))}
      </select>
      <input
        className="cr-mpol-profile-cost"
        type="number"
        min={0.05}
        step={0.1}
        aria-label={`Relative cost of ${row.key}`}
        value={cost}
        disabled={busy}
        data-testid="model-profile-cost"
        onChange={(e) => setCost(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setCost(String(row.profile.cost));
        }}
      />
      {row.own ? (
        <button
          type="button"
          className="cr-link"
          disabled={busy}
          data-testid="model-profile-reset"
          onClick={() => onSave(row.key, null)}
        >
          Reset
        </button>
      ) : (
        <span className="cr-mpol-profile-shipped">Shipped</span>
      )}
    </div>
  );
}

/** Settings → Agents → Model choice: the home default every project inherits (D54). */
export function ModelChoiceCard(): JSX.Element {
  const [view, setView] = useState<HomeModelPolicyPayload | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showProfiles, setShowProfiles] = useState(false);
  const flash = useSavedFlash();

  useEffect(() => {
    getHomeModelPolicy()
      .then(setView)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function run(write: () => Promise<HomeModelPolicyPayload>): Promise<void> {
    setBusy(true);
    setError(undefined);
    flash.clear();
    try {
      setView(await write());
      flash.markSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetCard
      title="Model choice"
      icon="sliders"
      description="Who picks the model when a node’s agent starts without your pick: a part a coordinator or the Director starts, a wake, a node made without a model. The pick is made once, at the node’s first start. Your own pick always runs. Every project uses this unless it sets its own, in its Details."
      testid="settings-model-choice"
      status={
        busy ? (
          <span className="cr-set-muted">
            <Spinner size={12} /> Saving
          </span>
        ) : (
          <SavedNote show={flash.saved} testid="settings-model-choice-saved" />
        )
      }
    >
      <p className="cr-set-muted" data-testid="settings-model-choice-note">
        Choose picks by a simple rule for now: under Start cheap the cheapest balanced preset model
        at medium effort, under Strongest first the strongest. Picking with Jev comes next; it will
        need the classifier key, and without one Choose keeps using this rule.
      </p>
      {view === undefined && error === undefined ? (
        <span className="cr-set-muted">
          <Spinner size={12} /> Loading…
        </span>
      ) : null}
      {view !== undefined ? (
        <ModelPolicyFields
          view={view}
          here="home"
          busy={busy}
          testid="settings-model-policy"
          save={(patch) => run(() => setHomeModelPolicy(patch))}
        />
      ) : null}
      {view !== undefined ? (
        <div className="cr-mpol-profiles" data-testid="settings-model-profiles">
          <SetRow
            label="Model profiles"
            hint="Which models are fast, balanced or strongest, and what each costs relative to the others. A model with none reads balanced, cost 1."
          >
            <Button
              size="sm"
              icon={showProfiles ? 'chevron-down' : 'chevron-right'}
              aria-expanded={showProfiles}
              data-testid="settings-model-profiles-toggle"
              onClick={() => setShowProfiles((open) => !open)}
            >
              {showProfiles ? 'Hide' : 'Show'}
            </Button>
          </SetRow>
          {showProfiles
            ? profileRows(view.profiles, view.own_profiles).map((row) => (
                <ProfileRow
                  key={row.key}
                  row={row}
                  busy={busy}
                  onSave={(key, profile) => void run(() => setModelProfiles({ [key]: profile }))}
                />
              ))
            : null}
        </div>
      ) : null}
      <FormError error={error} />
    </SetCard>
  );
}

/**
 * A node's Details → Model choice (a project root's is the project's):
 * each field "from Home", "from <project>" or "set here", how the node's
 * current model was picked, and Let the policy choose again.
 */
export function ModelChoiceSection({
  stream,
  projectId,
  isRoot,
}: {
  stream: Stream;
  /** The node's project; on its root, the fields are the project's. */
  projectId?: string;
  isRoot: boolean;
}): JSX.Element {
  const [node, setNode] = useState<NodeModelPolicyPayload | undefined>();
  const [project, setProject] = useState<ModelPolicyPayload | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const flash = useSavedFlash();
  const asProject = isRoot && projectId !== undefined;
  // What changes the view: the node's own policy, its pick, a choose-again.
  const stamp = JSON.stringify([
    stream.id,
    stream.human.model_policy ?? null,
    stream.human.choose_again ?? null,
    stream.agent.pick ?? null,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` is the dependency.
  useEffect(() => {
    let live = true;
    getNodeModelPolicy(stream.id)
      .then((v) => live && setNode(v))
      .catch((err: unknown) => live && setError(errorText(err)));
    if (asProject && projectId !== undefined) {
      getProjectModelPolicy(projectId)
        .then((v) => live && setProject(v))
        .catch((err: unknown) => live && setError(errorText(err)));
    }
    return () => {
      live = false;
    };
  }, [stamp, asProject, projectId]);

  async function run(write: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    flash.clear();
    try {
      await write();
      const [n, p] = await Promise.all([
        getNodeModelPolicy(stream.id),
        asProject && projectId !== undefined ? getProjectModelPolicy(projectId) : undefined,
      ]);
      setNode(n);
      if (p !== undefined) setProject(p);
      flash.markSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const view = asProject ? project : node;
  const pick = node?.pick;
  return (
    <DetailSection
      title="Model choice"
      testid="details-model-choice"
      aside={
        busy ? (
          <span className="cr-set-muted">
            <Spinner size={12} /> Saving
          </span>
        ) : (
          <SavedNote show={flash.saved} testid="details-model-choice-saved" />
        )
      }
    >
      {pick !== undefined ? (
        <p className="cr-mpol-pick" data-testid="details-model-pick" data-how={pick.how}>
          <span className="cr-mpol-pick-how">{pickHowWords(pick.how)}:</span> {pickLine(pick)}
          {pick.note !== undefined ? <span className="cr-mpol-pick-note"> {pick.note}</span> : null}
        </p>
      ) : (
        <p className="cr-set-muted" data-testid="details-model-pick">
          Its agent hasn’t started yet: the policy picks at its first start.
        </p>
      )}
      <div className="cr-dsec-actions">
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          data-testid="details-choose-again"
          disabled={busy || node === undefined || node.choose_again}
          title="Set the current model aside: the next start of this node’s agent lets the policy pick"
          onClick={() => void run(() => chooseModelAgain(stream.id))}
        >
          Let the policy choose again
        </Button>
        {node?.choose_again ? (
          <span className="cr-set-muted" data-testid="details-choose-again-waiting">
            The policy picks at the next start.
          </span>
        ) : null}
      </div>
      {view !== undefined ? (
        <ModelPolicyFields
          view={view}
          here={asProject ? 'project' : 'node'}
          busy={busy}
          testid="details-model-policy"
          save={(patch) =>
            run(() =>
              asProject && projectId !== undefined
                ? setProjectModelPolicy(projectId, patch)
                : setNodeModelPolicy(stream.id, patch),
            )
          }
        />
      ) : error === undefined ? (
        <span className="cr-set-muted">
          <Spinner size={12} /> Loading…
        </span>
      ) : null}
      <FormError error={error} />
    </DetailSection>
  );
}
