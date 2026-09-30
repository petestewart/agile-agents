/**
 * T482 (design/model-routing.md §4, §8; D53–D55): the model policy service.
 * It resolves a node's policy (node → ancestors → project → home →
 * built-in), makes a start's pick with the shared `pickModel`, keeps each
 * layer's writes (the operator's), and stamps the projects that predate
 * model routing (D54). T483 adds the chooser beside it; T484 the escalation
 * watcher.
 */

import {
  type Effort,
  type ModelPick,
  type ModelPickRecord,
  type ModelPickTriple,
  type ModelPolicyPartial,
  type ModelPolicyPatch,
  type ModelProfile,
  type ModelProfilesPatch,
  type PickCatalogModel,
  type Project,
  type ResolvedModelPolicy,
  SESSION_VENDORS,
  type SessionVendor,
  type Stream,
  type VendorModels,
  applyModelPolicyPatch,
  effectiveModelProfiles,
  isAgentRole,
  pickModel,
  resolveModelPolicy,
  resolveSessionDefaults,
} from '@agile-agents/shared';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';

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
  streams: Pick<StreamService, 'get' | 'appendThread' | 'setModelPolicy' | 'chooseModelAgain'>;
  /** T467: each vendor's model list (names, and what "any installed model" means). */
  models?: () => Readonly<Partial<Record<SessionVendor, VendorModels>>>;
  /** Whether a vendor's command is installed here (default: every vendor). */
  installed?: (vendor: SessionVendor) => boolean;
  /**
   * After a choose-again: a resting session (T465) ends, so the next message
   * starts an agent (and the policy picks) instead of waking the old one.
   */
  onChooseAgain?: (node: string) => Promise<void>;
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
}

export class ModelPolicyService {
  constructor(private readonly options: ModelPolicyServiceOptions) {}

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
    };
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
      out[vendor] = list.options.map((o) => ({ value: o.value, name: o.name }));
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

  /**
   * One agent start's pick (§4's precedence), and the words for its thread
   * line and record. Explicit and kept picks pass through; a routed one is
   * made here.
   */
  pickForStart(input: StartPickInput): { pick: ModelPick; resolved: ResolvedModelPolicy } {
    const resolved = this.resolveFor(input.stream);
    const home = this.homeConfig();
    const parent = this.parentPick(input.stream);
    const pick = pickModel({
      policy: resolved.policy,
      ...(input.explicit !== undefined ? { explicit: input.explicit } : {}),
      ...(input.kept !== undefined ? { kept: input.kept } : {}),
      ...(parent !== undefined ? { parent } : {}),
      fallback: input.fallback,
      installed: this.installedVendors(),
      models: this.catalog(),
      profiles: effectiveModelProfiles(home.model_profiles),
      inProject: input.stream.project !== undefined,
    });
    return { pick, resolved };
  }

  /**
   * What a start with no pick would run on this node when that start is a
   * routed pick: the node never ran (or its last vendor is gone), or it
   * waits on a choose-again. `undefined` when its kept pick would run (T464).
   * The cockpit names it on "Starts the agent with …".
   */
  nextPick(stream: Stream): ModelPick | undefined {
    const installed = new Set(this.installedVendors());
    if (stream.human.choose_again !== true) {
      for (let i = stream.sessions.length - 1; i >= 0; i--) {
        const s = stream.sessions[i];
        if (s === undefined || !isAgentRole(s.role)) continue;
        if (installed.has(s.vendor as SessionVendor)) return undefined;
        break;
      }
    }
    const home = this.homeConfig();
    const project = this.projectOf(stream.project);
    const repo = stream.repo !== undefined ? this.options.store.getRepos()[stream.repo] : undefined;
    const today = resolveSessionDefaults({
      ...(project?.session !== undefined ? { project: project.session } : {}),
      ...(repo !== undefined ? { repo } : {}),
      home,
    });
    return this.pickForStart({
      stream,
      fallback: { vendor: today.vendor, model: today.model ?? 'default', effort: today.effort },
    }).pick;
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
