/**
 * T482 (design/model-routing.md §4, §8; D53–D55): the model policy service.
 * It resolves a node's policy (node → ancestors → project → home →
 * built-in), makes a start's pick with the shared `pickModel`, keeps each
 * layer's writes (the operator's), and stamps the projects that predate
 * model routing (D54). T483: a routed start under Choose (or a pinned rule
 * that names a topic) asks the chooser (`chooser.ts`) first, and Try it
 * reads a pasted task without starting anything. T484: the escalation
 * watcher (`escalation.ts`) and the ladder a step climbs.
 */

import {
  CHOOSER_FAILURE_WORDS,
  type ChooserTask,
  type Effort,
  type LadderRung,
  type ModelPick,
  type ModelPickRecord,
  type ModelPickTriple,
  type ModelPolicy,
  type ModelPolicyPartial,
  type ModelPolicyPatch,
  type ModelPolicyTryInput,
  type ModelPolicyTryResult,
  type ModelProfile,
  type ModelProfilesPatch,
  type PickCatalogModel,
  type PinnedRole,
  type Project,
  type ResolvedModelPolicy,
  SESSION_VENDORS,
  type SessionVendor,
  type StepUpView,
  type Stream,
  type VendorModels,
  applyModelPolicyPatch,
  chooserNeed,
  effectiveModelProfiles,
  escalationLadder,
  isAgentRole,
  isConversationNode,
  liveChildrenOf,
  pickModel,
  presetCandidates,
  resolveModelPolicy,
  resolveSessionDefaults,
  routedPickLine,
  taskFromText,
  vendorOrderFor,
  vendorOrderWords,
} from '@agile-agents/shared';
import type { Classifier } from '../classifier';
import type { PlanService } from '../coordination/plans';
import type { EmitRouted } from '../events/producers';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';
import { type ChooserCall, ModelChooser } from './chooser';
import { EscalationService } from './escalation';

/**
 * D54: what a project that predates model routing is stamped with. Default,
 * and no preset models: with favourites set (T469), the home's presets would
 * otherwise clamp its default model, and nothing may move under running work.
 */
export const PREDATES_ROUTING: Readonly<ModelPolicyPartial> = Object.freeze({
  mode: 'default',
  presets: [],
});

/** D54: the root thread's line when a project that predates model routing is stamped Default. */
export const STAMP_LINE =
  'Model choice stays at Default for this project, as before model routing: a node starts on the project’s, repository’s or global default model. Change it in the project’s Details → Model choice.';

export interface ModelPolicyServiceOptions {
  store: StateStore;
  streams: Pick<
    StreamService,
    'get' | 'list' | 'appendThread' | 'setModelPolicy' | 'chooseModelAgain'
  >;
  /** T467: each vendor's model list (names, and what "any installed model" means). */
  models?: () => Readonly<Partial<Record<SessionVendor, VendorModels>>>;
  /** Whether a vendor's command is installed here (default: every vendor). */
  installed?: (vendor: SessionVendor) => boolean;
  /**
   * After a choose-again: a resting session (T465) ends, so the next message
   * starts an agent (and the policy picks) instead of waking the old one.
   */
  onChooseAgain?: (node: string) => Promise<void>;
  /** T483: the classifier tier the chooser asks (read per call). Absent: "no classifier key". */
  classifier?: Classifier | (() => Classifier | undefined);
  /** T483: how long a start waits for Jev (default: the classifier's timeout). */
  chooserTimeoutMs?: number | (() => number);
  /** T483: the parent's approved plan entry for a part, for the chooser's task. */
  plans?: Pick<PlanService, 'childView'>;
  /**
   * T483: whether a start can ask Jev now (a key is loaded), so a preview
   * says the chooser picks. Default: a classifier was given.
   */
  chooserReady?: () => boolean;
  /** T484: records a step or a Needs me card as a `model_escalated` event. */
  emitRouted?: EmitRouted;
  /** T484 (T465): ends a node's resting session when its model will step up. */
  endResting?: (node: string, why: string) => Promise<void>;
}

/** The distinct vendors of the candidates, for the pinned rules that name only a vendor. */
function vendorsOf(candidates: readonly { vendor: string }[]): string[] {
  return [...new Set(candidates.map((c) => c.vendor))];
}

/** Why a resting session ended on a choose-again. */
export const CHOOSE_AGAIN_END_REASON = 'the operator asked the model policy to choose again';

/** `GET /api/settings/model-policy`: the home layer, and the profiles. */
export interface HomeModelPolicyView {
  /** What the home `config.yaml` sets itself. */
  policy: ModelPolicyPartial;
  /** The home and the built-in resolved: what a project that sets nothing gets. */
  resolved: ResolvedModelPolicy;
  /** The shipped profiles with the home's own over them. */
  profiles: Record<string, ModelProfile>;
  /** The home's own profiles (the others are shipped). */
  own_profiles: Record<string, ModelProfile>;
}

/** `GET /api/projects/:id/model-policy`. */
export interface ProjectModelPolicyView {
  project: { id: string; name: string; root: string };
  policy: ModelPolicyPartial;
  resolved: ResolvedModelPolicy;
}

/** `GET /api/streams/:id/model-policy`. */
export interface NodeModelPolicyView {
  node: { id: string; title: string; project?: string };
  policy: ModelPolicyPartial;
  resolved: ResolvedModelPolicy;
  /** What its agent last started on, and why. */
  pick?: ModelPickRecord;
  /** "Let the policy choose again" is waiting for the next start. */
  choose_again: boolean;
  /** T484: Step up's next rung, a pending step, the Needs me card at the top. */
  step_up: StepUpView;
}

/** What attach asks for one agent start. */
export interface StartPickInput {
  stream: Stream;
  /** The operator's pick, resolved (flags filled from the defaults). */
  explicit?: ModelPickTriple;
  /** T464's kept pick. */
  kept?: ModelPickTriple;
  /** Today's resolution with no flags: the `default` mode's pick. */
  fallback: ModelPickTriple;
  /** T483: the role the pinned rules match (the node's agent: worker, coordinator or conversation). */
  role?: PinnedRole;
}

export class ModelPolicyService {
  readonly chooser: ModelChooser;
  /** T484: the triggers, the pending step and the Needs me card (§6). */
  readonly escalation: EscalationService;

  constructor(private readonly options: ModelPolicyServiceOptions) {
    this.chooser = new ModelChooser({
      ...(options.classifier !== undefined ? { classifier: options.classifier } : {}),
      ...(options.chooserTimeoutMs !== undefined ? { timeoutMs: options.chooserTimeoutMs } : {}),
    });
    this.escalation = new EscalationService({
      store: options.store,
      streams: options.streams,
      policy: this,
      ...(options.emitRouted !== undefined ? { emit: options.emitRouted } : {}),
      ...(options.endResting !== undefined ? { endResting: options.endResting } : {}),
    });
  }

  private projectOf(id: string | undefined): Project | undefined {
    if (id === undefined) return undefined;
    try {
      return this.options.store.getProject(id);
    } catch {
      return undefined;
    }
  }

  private homeConfig() {
    return this.options.store.getHomeConfig();
  }

  /** The parent chain, nearest first. */
  private ancestorsOf(stream: Stream): Stream[] {
    const chain: Stream[] = [];
    const seen = new Set<string>([stream.id]);
    let parentId = stream.parent;
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      let parent: Stream;
      try {
        parent = this.options.streams.get(parentId);
      } catch {
        break;
      }
      chain.push(parent);
      parentId = parent.parent;
    }
    return chain;
  }

  /** §4: the node's policy, each field with where it came from. */
  resolveFor(stream: Stream): ResolvedModelPolicy {
    const home = this.homeConfig();
    const project = this.projectOf(stream.project);
    // A project's root is the project itself: its layer is the project's.
    const isRoot = project !== undefined && project.root === stream.id;
    return resolveModelPolicy({
      ...(!isRoot && stream.human.model_policy !== undefined
        ? { node: stream.human.model_policy }
        : {}),
      ancestors: this.ancestorsOf(stream).map((a) => ({
        id: a.id,
        title: a.title,
        // The root's own layer is the project's, below.
        ...(a.human.model_policy !== undefined && a.id !== project?.root
          ? { policy: a.human.model_policy }
          : {}),
      })),
      ...(project !== undefined
        ? {
            project: {
              id: project.id,
              name: project.name,
              ...(project.model_policy !== undefined ? { policy: project.model_policy } : {}),
            },
          }
        : {}),
      ...(home.model_policy !== undefined ? { home: home.model_policy } : {}),
      ...(home.favourite_models !== undefined ? { favourites: home.favourite_models } : {}),
    });
  }

  homeView(): HomeModelPolicyView {
    const home = this.homeConfig();
    return {
      policy: home.model_policy ?? {},
      resolved: resolveModelPolicy({
        ...(home.model_policy !== undefined ? { home: home.model_policy } : {}),
        ...(home.favourite_models !== undefined ? { favourites: home.favourite_models } : {}),
      }),
      profiles: effectiveModelProfiles(home.model_profiles),
      own_profiles: { ...(home.model_profiles ?? {}) },
    };
  }

  projectView(id: string): ProjectModelPolicyView {
    const project = this.options.store.getProject(id);
    const home = this.homeConfig();
    return {
      project: { id: project.id, name: project.name, root: project.root },
      policy: project.model_policy ?? {},
      resolved: resolveModelPolicy({
        project: {
          id: project.id,
          name: project.name,
          ...(project.model_policy !== undefined ? { policy: project.model_policy } : {}),
        },
        ...(home.model_policy !== undefined ? { home: home.model_policy } : {}),
        ...(home.favourite_models !== undefined ? { favourites: home.favourite_models } : {}),
      }),
    };
  }

  nodeView(id: string): NodeModelPolicyView {
    const stream = this.options.streams.get(id);
    return {
      node: {
        id: stream.id,
        title: stream.title,
        ...(stream.project !== undefined ? { project: stream.project } : {}),
      },
      policy: stream.human.model_policy ?? {},
      resolved: this.resolveFor(stream),
      ...(stream.agent.pick !== undefined ? { pick: stream.agent.pick } : {}),
      choose_again: stream.human.choose_again === true,
      step_up: this.escalation.view(stream),
    };
  }

  /** T484: the node's Step up (the operator's). */
  async stepUp(id: string): Promise<NodeModelPolicyView> {
    await this.escalation.stepUp(id);
    return this.nodeView(id);
  }

  /** T484: the operator dismissed the node's "stuck on the strongest model" card. */
  async dismissStuck(id: string): Promise<NodeModelPolicyView> {
    await this.escalation.dismissStuck(id);
    return this.nodeView(id);
  }

  async setHome(patch: ModelPolicyPatch, by = 'human'): Promise<HomeModelPolicyView> {
    await this.options.store.setHomeModelPolicy(patch, { by });
    return this.homeView();
  }

  async setProfiles(patch: ModelProfilesPatch, by = 'human'): Promise<HomeModelPolicyView> {
    await this.options.store.setModelProfiles(patch, { by });
    return this.homeView();
  }

  async setProject(id: string, patch: ModelPolicyPatch): Promise<ProjectModelPolicyView> {
    await this.options.store.updateProject(id, (before) => ({
      ...before,
      model_policy: applyModelPolicyPatch(before.model_policy, patch),
    }));
    return this.projectView(id);
  }

  async setNode(id: string, patch: ModelPolicyPatch): Promise<NodeModelPolicyView> {
    await this.options.streams.setModelPolicy(id, patch);
    return this.nodeView(id);
  }

  async chooseAgain(id: string): Promise<NodeModelPolicyView> {
    await this.options.streams.chooseModelAgain(id);
    await this.options
      .onChooseAgain?.(id)
      .catch((err) => console.error('ending a resting session for a choose-again failed:', err));
    return this.nodeView(id);
  }

  /**
   * D54: every project with no `model_policy` (it predates T482) is stamped
   * `{mode: default, presets: []}` once, through the validating store, with a line on its
   * root's thread. Idempotent: a stamped project has the field. Returns the
   * ids stamped.
   */
  async stampExistingProjects(): Promise<string[]> {
    const stamped: string[] = [];
    for (const project of this.options.store.listProjects()) {
      if (project.model_policy !== undefined) continue;
      let changed = false;
      await this.options.store.updateProject(project.id, (before) => {
        if (before.model_policy !== undefined) return before;
        changed = true;
        return { ...before, model_policy: { ...PREDATES_ROUTING } };
      });
      if (!changed) continue;
      stamped.push(project.id);
      try {
        await this.options.streams.appendThread('daemon', project.root, {
          kind: 'event',
          body: STAMP_LINE,
        });
      } catch {
        // A root that is gone: the stamp is the record.
      }
    }
    return stamped;
  }

  /** Whether a vendor's command is installed here. */
  isInstalled(vendor: string): boolean {
    return (this.installedVendors() as readonly string[]).includes(vendor);
  }

  /**
   * T484 (§6): the node's ladder: its presets (any installed model when
   * there are none) by tier, then cost; each model's efforts up to the ceiling.
   */
  ladderFor(stream: Stream): {
    ladder: LadderRung[];
    policy: ModelPolicy;
    profiles: Record<string, ModelProfile>;
  } {
    const { policy } = this.resolveFor(stream);
    const profiles = effectiveModelProfiles(this.homeConfig().model_profiles);
    return {
      ladder: escalationLadder(policy, {
        installed: this.installedVendors(),
        models: this.catalog(),
        profiles,
        prefer: this.todayFor(stream).vendor,
        // T490 (D59): ties climb in the node's own role's vendor order.
        vendorOrder: vendorOrderFor(policy, this.agentRoleOf(stream)),
      }),
      policy,
      profiles,
    };
  }

  /**
   * T490: the role a node's agent runs as, for its vendor order: a
   * coordinator when its last agent session coordinated, a conversation,
   * else a worker.
   */
  private agentRoleOf(stream: Stream): PinnedRole {
    const last = [...stream.sessions].reverse().find((s) => isAgentRole(s.role));
    if (last?.role === 'coordinator') return 'coordinator';
    try {
      if (isConversationNode(stream, this.options.streams.list())) return 'conversation';
    } catch {
      // No list: a worker.
    }
    return 'worker';
  }

  /** The vendors installed here, in the registry's order. */
  private installedVendors(): SessionVendor[] {
    const installed = this.options.installed;
    return SESSION_VENDORS.filter((v) => installed === undefined || installed(v));
  }

  private catalog(): Partial<Record<SessionVendor, PickCatalogModel[]>> {
    const lists = this.options.models?.() ?? {};
    const out: Partial<Record<SessionVendor, PickCatalogModel[]>> = {};
    for (const [vendor, list] of Object.entries(lists) as Array<[SessionVendor, VendorModels]>) {
      if (list === undefined) continue;
      out[vendor] = list.options.map((o) => ({
        value: o.value,
        name: o.name,
        ...(o.description !== undefined ? { description: o.description } : {}),
      }));
    }
    return out;
  }

  /** The parent node's current pick (its live or last agent session), for `inherit`. */
  private parentPick(stream: Stream): (ModelPickTriple & { title: string }) | undefined {
    if (stream.parent === undefined) return undefined;
    let parent: Stream;
    try {
      parent = this.options.streams.get(stream.parent);
    } catch {
      return undefined;
    }
    for (let i = parent.sessions.length - 1; i >= 0; i--) {
      const s = parent.sessions[i];
      if (s === undefined || !isAgentRole(s.role)) continue;
      if (!this.installedVendors().includes(s.vendor as SessionVendor)) return undefined;
      return {
        vendor: s.vendor,
        model: s.model,
        effort: (s.effort ?? 'low') as Effort,
        title: parent.title,
      };
    }
    return undefined;
  }

  /** The pick's inputs every start shares. */
  private pickInputs(stream: Stream, fallback: ModelPickTriple) {
    const home = this.homeConfig();
    const models = this.catalog();
    const installed = this.installedVendors();
    const profiles = effectiveModelProfiles(home.model_profiles);
    return { home, models, installed, profiles, fallback, inProject: stream.project !== undefined };
  }

  /**
   * T483 (§5): the chooser's task for a node: its title and goal, role,
   * repo, labels, its parent's title and goal, the parent's plan entry for
   * it, and the siblings starting now (running, or not started yet).
   */
  taskFor(stream: Stream, role: PinnedRole): ChooserTask {
    let parent: Stream | undefined;
    if (stream.parent !== undefined) {
      try {
        parent = this.options.streams.get(stream.parent);
      } catch {
        parent = undefined;
      }
    }
    let plan: readonly string[] | undefined;
    try {
      plan = this.options.plans?.childView(stream)?.owns;
    } catch {
      plan = undefined;
    }
    const siblings =
      parent !== undefined
        ? liveChildrenOf(parent.id, this.options.streams.list())
            .filter((s) => s.id !== stream.id && s.helper_of === undefined)
            .filter(
              (s) => s.agent.status === 'working' || !s.sessions.some((x) => isAgentRole(x.role)),
            )
        : [];
    return {
      title: stream.title,
      ...(stream.goal !== undefined ? { goal: stream.goal } : {}),
      role,
      ...(stream.repo !== undefined ? { repo: stream.repo } : {}),
      ...(stream.labels !== undefined && stream.labels.length > 0 ? { labels: stream.labels } : {}),
      ...(parent !== undefined
        ? {
            parent: {
              title: parent.title,
              ...(parent.goal !== undefined ? { goal: parent.goal } : {}),
            },
          }
        : {}),
      ...(plan !== undefined && plan.length > 0 ? { plan } : {}),
      ...(parent !== undefined
        ? { siblings: { count: siblings.length, titles: siblings.map((s) => s.title) } }
        : {}),
    };
  }

  /**
   * One agent start's pick (§4's precedence), and the words for its thread
   * line and record. Explicit and kept picks pass through; a routed one is
   * made here: the chooser is asked first when the policy needs it (Choose,
   * or a pinned rule that names a topic), once per routed start (D55).
   */
  async pickForStart(
    input: StartPickInput,
  ): Promise<{ pick: ModelPick; resolved: ResolvedModelPolicy; chooser?: ChooserCall }> {
    const resolved = this.resolveFor(input.stream);
    const parent = this.parentPick(input.stream);
    const role = input.role ?? 'worker';
    const task = {
      role,
      ...(input.stream.labels !== undefined ? { labels: input.stream.labels } : {}),
    };
    const base = this.pickInputs(input.stream, input.fallback);
    let chooser: ChooserCall | undefined;
    if (input.explicit === undefined && input.kept === undefined) {
      const { candidates } = presetCandidates(resolved.policy, {
        installed: base.installed,
        models: base.models,
        prefer: input.fallback.vendor,
      });
      // T490: a pinned rule naming only a vendor with no preset model here doesn't apply.
      const need = chooserNeed(resolved.policy, task, vendorsOf(candidates));
      if (need !== 'none') {
        chooser = await this.chooser.read({
          task: this.taskFor(input.stream, role),
          policy: resolved.policy,
          candidates,
          profiles: base.profiles,
          models: base.models,
          need,
        });
      }
    }
    const pick = pickModel({
      policy: resolved.policy,
      ...(input.explicit !== undefined ? { explicit: input.explicit } : {}),
      ...(input.kept !== undefined ? { kept: input.kept } : {}),
      ...(parent !== undefined ? { parent } : {}),
      fallback: input.fallback,
      installed: base.installed,
      models: base.models,
      profiles: base.profiles,
      inProject: base.inProject,
      task,
      ...(chooser !== undefined ? { chooser: chooser.outcome } : {}),
    });
    return { pick, resolved, ...(chooser !== undefined ? { chooser } : {}) };
  }

  /**
   * T490 (D59): a reviewer's start with no pick is routed like any other
   * start, as the `reviewer` role: its pinned rules, its vendor order, and
   * the tier from the chooser under Choose. An explicit pick never comes
   * here (D53). `undefined` when the policy leaves it as before (Default,
   * or Inherit with no parent model): the reviewer resolves as it did.
   */
  async pickForReviewer(stream: Stream, fallback: ModelPickTriple): Promise<ModelPick | undefined> {
    const { pick } = await this.pickForStart({ stream, fallback, role: 'reviewer' });
    return pick.how === 'default' ? undefined : pick;
  }

  /** A pick with no chooser call: what the cockpit names before a start (Choose reads as the rule). */
  private previewPick(stream: Stream, fallback: ModelPickTriple): ModelPick {
    const resolved = this.resolveFor(stream);
    const parent = this.parentPick(stream);
    const base = this.pickInputs(stream, fallback);
    const task = {
      role: 'worker' as const,
      ...(stream.labels !== undefined ? { labels: stream.labels } : {}),
    };
    const pick = pickModel({
      policy: resolved.policy,
      ...(parent !== undefined ? { parent } : {}),
      fallback,
      installed: base.installed,
      models: base.models,
      profiles: base.profiles,
      inProject: base.inProject,
      task,
    });
    const ready = this.options.chooserReady?.() ?? this.options.classifier !== undefined;
    const { candidates } = presetCandidates(resolved.policy, {
      installed: base.installed,
      models: base.models,
      prefer: fallback.vendor,
    });
    // A pinned rule that names a model decides with no Jev call; one naming only a vendor asks the tier.
    return ready && chooserNeed(resolved.policy, task, vendorsOf(candidates)) === 'full'
      ? { ...pick, chooses: true }
      : pick;
  }

  /** Today's resolution for a node with no flags (project, repo, home, built-in). */
  private todayFor(stream: Pick<Stream, 'project' | 'repo'>): ModelPickTriple {
    const home = this.homeConfig();
    const project = this.projectOf(stream.project);
    const repo = stream.repo !== undefined ? this.options.store.getRepos()[stream.repo] : undefined;
    const today = resolveSessionDefaults({
      ...(project?.session !== undefined ? { project: project.session } : {}),
      ...(repo !== undefined ? { repo } : {}),
      home,
    });
    return { vendor: today.vendor, model: today.model ?? 'default', effort: today.effort };
  }

  /**
   * T483 Try it: a pasted task read by the chooser and picked for, under
   * the policy of the home (or a project's, or a node's), as Choose would,
   * without starting anything. It may call Jev: that is the point.
   */
  async tryTask(input: ModelPolicyTryInput): Promise<ModelPolicyTryResult> {
    const home = this.homeConfig();
    let resolved: ResolvedModelPolicy;
    let where: Pick<Stream, 'project' | 'repo'> = {};
    if (input.node !== undefined) {
      const stream = this.options.streams.get(input.node);
      resolved = this.resolveFor(stream);
      where = {
        ...(stream.project !== undefined ? { project: stream.project } : {}),
        ...(stream.repo !== undefined ? { repo: stream.repo } : {}),
      };
    } else if (input.project !== undefined) {
      resolved = this.projectView(input.project).resolved;
      where = { project: input.project };
    } else {
      resolved = this.homeView().resolved;
    }
    const policy = { ...resolved.policy, mode: 'choose' as const };
    const fallback = this.todayFor(where);
    const models = this.catalog();
    const installed = this.installedVendors();
    const profiles = effectiveModelProfiles(home.model_profiles);
    const { candidates } = presetCandidates(policy, { installed, models, prefer: fallback.vendor });
    const task = taskFromText(input.text);
    const call = await this.chooser.read({
      task,
      policy,
      candidates,
      profiles,
      models,
      need: 'full',
    });
    const pick = pickModel({
      policy,
      fallback,
      installed,
      models,
      profiles,
      inProject: where.project !== undefined,
      task: { role: 'worker' },
      chooser: call.outcome,
    });
    return {
      mode: resolved.policy.mode,
      pick: {
        vendor: pick.vendor,
        model: pick.model,
        effort: pick.effort,
        how: pick.how,
        ...(pick.base !== undefined ? { base: pick.base } : {}),
        why: pick.why,
        ...(pick.note !== undefined ? { note: pick.note } : {}),
      },
      line: routedPickLine(pick, models),
      ...(pick.scores !== undefined ? { scores: pick.scores } : {}),
      ...(pick.topic !== undefined ? { topic: pick.topic } : {}),
      ...(pick.confidence !== undefined ? { confidence: pick.confidence } : {}),
      ...(pick.tier !== undefined ? { tier: pick.tier } : {}),
      ...(pick.tier_by !== undefined ? { tier_by: pick.tier_by } : {}),
      ...(pick.in_tier !== undefined ? { in_tier: pick.in_tier } : {}),
      vendor_order: vendorOrderWords(vendorOrderFor(policy, 'worker')),
      ...(call.outcome.ok
        ? {}
        : {
            failed: {
              reason: call.outcome.reason,
              words: CHOOSER_FAILURE_WORDS[call.outcome.reason],
            },
          }),
      latency_ms: call.latency_ms,
    };
  }

  /**
   * What a start with no pick would run on this node when that start is a
   * routed pick: the node never ran (or its last vendor is gone), or it
   * waits on a choose-again, or (T484) a step up waits for its next start.
   * `undefined` when its kept pick would run (T464).
   * The cockpit names it on "Starts the agent with …".
   */
  nextPick(stream: Stream): ModelPick | undefined {
    const installed = new Set(this.installedVendors());
    if (stream.human.choose_again !== true) {
      // T484: a step waiting for the next start is what that start runs.
      if (stream.escalation?.pending !== undefined) {
        const from = this.escalation.current(stream);
        const step = from !== undefined ? this.escalation.stepAtStart(stream, from) : undefined;
        if (step !== undefined && 'to' in step) {
          return this.escalation.stepPick(step, from?.effort ?? 'medium');
        }
      }
      for (let i = stream.sessions.length - 1; i >= 0; i--) {
        const s = stream.sessions[i];
        if (s === undefined || !isAgentRole(s.role)) continue;
        if (installed.has(s.vendor as SessionVendor)) return undefined;
        break;
      }
    }
    return this.previewPick(stream, this.todayFor(stream));
  }

  /**
   * New node's line: what a node made here with no model would start on
   * (its first start is a routed pick). `parent` wins over `project` for
   * the project, as a create does.
   */
  previewNew(where: { project?: string; parent?: string; repo?: string }): ModelPick {
    const parent = where.parent !== undefined ? this.options.streams.get(where.parent) : undefined;
    const project = parent?.project ?? where.project;
    const now = new Date().toISOString();
    const draft: Stream = {
      id: '00000000000000000000000000',
      title: 'New node',
      created_at: now,
      ...(parent !== undefined ? { parent: parent.id } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(where.repo !== undefined ? { repo: where.repo } : {}),
      agent: { status: 'idle', updated_at: now },
      human: { status: 'open' },
      sessions: [],
    };
    return this.nextPick(draft) as ModelPick;
  }

  /** The model's name for a sentence, from the vendor's own list when it has one. */
  catalogModels(): Partial<Record<SessionVendor, PickCatalogModel[]>> {
    return this.catalog();
  }
}
