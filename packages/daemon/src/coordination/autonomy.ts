/**
 * Autonomy levels (projects-design §9 "Autonomy", §12, P12, T282).
 *
 * One gate, `allowed(principal, action, level)`, decides what a
 * coordinator (and later the Director, T301) does with a structural
 * change: apply it, turn it into an inbox proposal with Apply, or refuse.
 *
 *   Advise   → every coordinator action is a proposal
 *   Organise → applied, with a thread line
 *   Run      → also routine contract approvals (P12)
 *
 * At every level a non-routine contract change comes to the human, and
 * merge, accepting knowledge, answering a question and changing a goal
 * are never the coordinator's.
 *
 * `AutonomyService.act` is the one place a gated change goes through:
 * the verbs call it, and Apply on the inbox card replays the held change
 * as the human. `reorder` and `merge_siblings` have no verb yet; when one
 * lands it adds its case to `CoordinatorChangeSchema` and `perform`.
 */

import {
  type Autonomy,
  type AutonomyProposal,
  AutonomyProposalIdSchema,
  type CoordinatorAction,
  type CoordinatorChange,
  DIRECTOR_NODE,
  HUMAN_ONLY_ACTIONS,
  type HumanOnlyAction,
  ulid,
  validateAutonomyProposal,
} from '@agile-agents/shared';
import type { ProjectService } from '../projects/service';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';
import { type ContractService, assertChildren } from './contracts';
import type { PlanService } from './plans';

export type AutonomyPrincipal = 'human' | 'coordinator' | 'director' | 'agent';
export type GateVerdict = 'apply' | 'propose' | 'refuse';

/**
 * The gate. `routine` only matters for `approve_contract`: the
 * coordinator's judgement that the change is additive (P12).
 */
export function allowed(
  principal: AutonomyPrincipal,
  action: CoordinatorAction | HumanOnlyAction,
  level: Autonomy,
  options: { routine?: boolean } = {},
): GateVerdict {
  if (principal === 'human') return 'apply';
  if (principal === 'agent') return 'refuse';
  if ((HUMAN_ONLY_ACTIONS as readonly string[]).includes(action)) return 'refuse';
  if (action === 'approve_contract') {
    return level === 'run' && options.routine === true ? 'apply' : 'propose';
  }
  // §12: restarting stuck work is Run's.
  if (action === 'restart_node') return level === 'run' ? 'apply' : 'propose';
  return level === 'advise' ? 'propose' : 'apply';
}

/** A proposal that is not open (already applied or dismissed). */
export class ProposalClosedError extends Error {
  constructor(id: string, status: string) {
    super(`proposal ${id} is already ${status}`);
    this.name = 'ProposalClosedError';
  }
}

/** A proposal that no longer fits the tree (a child reparented or removed). */
export class StaleProposalError extends Error {
  constructor(id: string, reason: string) {
    super(`proposal ${id} no longer applies: ${reason}; dismiss it`);
    this.name = 'StaleProposalError';
  }
}

export interface AutonomyServiceOptions {
  store: StateStore;
  streams: StreamService;
  plans?: PlanService;
  contracts?: ContractService;
  /** T301: the Director's `create_project` / `create_tree` on a new project. */
  projects?: ProjectService;
  now?: () => Date;
}

/** T301: starting and restarting a node's agent (the attach service), wired once it exists. */
export interface NodeAgents {
  start(node: string): Promise<unknown>;
  restart(node: string): Promise<unknown>;
}

export type ActOutcome =
  | { applied: true; level: Autonomy; result: unknown }
  | { applied: false; level: Autonomy; proposal: AutonomyProposal };

function proposalPath(id: string): string {
  const parsed = AutonomyProposalIdSchema.safeParse(id);
  if (!parsed.success) throw new Error(`invalid proposal id: ${id} must look like AP-<ulid>`);
  return `proposals/${parsed.data}.yaml`;
}

/** One line for the card and the thread. */
export function describeChange(change: CoordinatorChange, titleOf: (id: string) => string): string {
  switch (change.action) {
    case 'add_child':
      return `add child "${change.title}"${change.repo !== undefined ? ` on ${change.repo}` : ''}: ${change.goal}`;
    case 'add_waits_on':
      return `${titleOf(change.child)} waits on ${titleOf(change.on)}`;
    case 'set_owner':
      return `${titleOf(change.child)} owns ${change.owns.join(', ') || 'nothing'}`;
    case 'approve_contract':
      return `contract ${change.title}${change.routine === true ? ' (routine)' : ''}: ${change.body}${
        change.reason ? `. Reason: ${change.reason}` : ''
      }`;
    case 'create_tree': {
      const t = change.tree;
      const where =
        t.new_project !== undefined ? `new project ${t.new_project}` : titleOf(t.project ?? '');
      return `create "${t.title}" in ${where} (${t.parts.length} part${t.parts.length === 1 ? '' : 's'}: ${t.parts.map((p) => p.title).join(', ')})`;
    }
    case 'create_project':
      return `create project ${change.name}`;
    case 'create_node':
      return `create node "${change.node.title}" under ${titleOf(change.node.parent ?? change.node.project ?? '')}: ${change.node.goal}`;
    case 'start_node':
      return `start ${titleOf(change.node)}`;
    case 'restart_node':
      return `restart ${titleOf(change.node)}`;
  }
}

export class AutonomyService {
  private agents: NodeAgents | undefined;

  constructor(private readonly options: AutonomyServiceOptions) {}

  setAgents(agents: NodeAgents): void {
    this.agents = agents;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** The node's override, else its project's setting for `principal`, else Advise. */
  levelFor(node: string, principal: 'coordinator' | 'director' = 'coordinator'): Autonomy {
    const stream = this.options.streams.get(node);
    if (principal === 'coordinator' && stream.autonomy !== undefined) return stream.autonomy;
    if (stream.project === undefined) return 'advise';
    try {
      return this.options.store.getProject(stream.project).autonomy[principal];
    } catch {
      return 'advise';
    }
  }

  /**
   * T301 (P16): the Director's level is its project's `director` setting,
   * read from the project the change touches. A new project has none yet,
   * so its creation is always Advise.
   */
  directorLevelFor(change: CoordinatorChange): Autonomy {
    const { streams, store } = this.options;
    const project = (): string | undefined => {
      switch (change.action) {
        case 'create_tree':
          return change.tree.project;
        case 'create_project':
          return undefined;
        case 'create_node':
          return change.node.project ?? streams.get(change.node.parent ?? '').project;
        case 'start_node':
        case 'restart_node':
          return streams.get(change.node).project;
        case 'add_waits_on':
          return streams.get(change.child).project;
        case 'set_owner':
          return streams.get(change.child).project;
        case 'add_child':
        case 'approve_contract':
          return undefined;
      }
    };
    const id = project();
    if (id === undefined) return 'advise';
    try {
      return store.getProject(id).autonomy.director;
    } catch {
      return 'advise';
    }
  }

  /** The gate plus the effect: applied now, or held as a proposal for the inbox. */
  async act(
    node: string,
    principal: 'coordinator' | 'director',
    by: string,
    change: CoordinatorChange,
  ): Promise<ActOutcome> {
    const level =
      node === DIRECTOR_NODE ? this.directorLevelFor(change) : this.levelFor(node, principal);
    const routine = change.action === 'approve_contract' ? change.routine : undefined;
    const verdict = allowed(principal, change.action, level, { routine: routine === true });
    if (verdict === 'refuse') throw new Error(`${change.action}: not allowed to a ${principal}`);
    this.check(node, change);
    const summary = describeChange(change, (id) => this.titleOf(id));
    if (verdict === 'apply') {
      const result = await this.perform(node, principal, by, change);
      await this.note(principal, node, {
        kind: 'event',
        body: `${principal} (${level}) applied: ${summary}`.slice(0, 800),
      });
      return { applied: true, level, result };
    }
    const proposal = validateAutonomyProposal({
      id: `AP-${ulid()}`,
      node,
      principal,
      by,
      change,
      summary: summary.slice(0, 800),
      status: 'open',
      created_at: this.now(),
    });
    await this.options.store.putEntity(
      proposalPath(proposal.id),
      validateAutonomyProposal,
      proposal,
    );
    await this.note(principal, node, {
      kind: 'proposal',
      body: `${principal} (${level}) proposes: ${summary}`.slice(0, 800),
      ref: proposalPath(proposal.id),
    });
    return { applied: false, level, proposal };
  }

  get(id: string): AutonomyProposal {
    return this.options.store.getEntity(proposalPath(id), validateAutonomyProposal);
  }

  listOpen(): AutonomyProposal[] {
    return this.options.store
      .listEntities('proposals', validateAutonomyProposal)
      .filter((p) => p.status === 'open');
  }

  /** The inbox card's Apply: the held change, performed as the human. */
  async apply(id: string): Promise<AutonomyProposal> {
    const before = this.openProposal(id);
    // The tree may have moved since it was proposed: refuse a stale change.
    try {
      this.check(before.node, before.change);
    } catch (err) {
      throw new StaleProposalError(id, err instanceof Error ? err.message : String(err));
    }
    await this.perform(before.node, 'human', 'human', before.change);
    return this.close(before, 'applied');
  }

  async dismiss(id: string): Promise<AutonomyProposal> {
    const proposal = this.openProposal(id);
    // T285: dismissing a held contract proposal rejects the child's proposal.
    const cp = proposal.change.action === 'approve_contract' ? proposal.change.proposal : undefined;
    if (cp !== undefined && this.options.contracts !== undefined) {
      try {
        await this.options.contracts.reject(cp, 'dismissed by the operator', 'human');
      } catch {
        // Already gone (the contract moved on); the card still closes.
      }
    }
    return this.close(proposal, 'dismissed');
  }

  private openProposal(id: string): AutonomyProposal {
    const proposal = this.get(id);
    if (proposal.status !== 'open') throw new ProposalClosedError(id, proposal.status);
    return proposal;
  }

  private async close(
    proposal: AutonomyProposal,
    status: 'applied' | 'dismissed',
  ): Promise<AutonomyProposal> {
    const saved = await this.options.store.putEntity(
      proposalPath(proposal.id),
      validateAutonomyProposal,
      validateAutonomyProposal({ ...proposal, status, decided_at: this.now() }),
    );
    await this.note('human', proposal.node, {
      kind: 'event',
      body: `${status}: ${proposal.summary}`.slice(0, 800),
      ref: proposalPath(proposal.id),
    });
    return saved;
  }

  /** A thread line on the node, or on the Director's own thread. */
  private async note(
    by: 'human' | 'coordinator' | 'director',
    node: string,
    entry: { kind: 'event' | 'proposal'; body: string; ref?: string },
  ): Promise<void> {
    if (node !== DIRECTOR_NODE) {
      await this.options.streams.appendThread(by, node, entry);
      return;
    }
    await this.options.store.appendDirectorThread({
      ts: this.now(),
      by: by === 'human' ? 'human' : 'director',
      ...entry,
    });
  }

  /** A node's title, or a project's name (T371); the id when neither reads. */
  private titleOf(id: string): string {
    try {
      return id.startsWith('P-')
        ? this.options.store.getProject(id).name
        : this.options.streams.get(id).title;
    } catch {
      return id;
    }
  }

  /** Refuses a change that could never apply, before anything is held. */
  private check(node: string, change: CoordinatorChange): void {
    const { streams } = this.options;
    if (node === DIRECTOR_NODE) {
      this.checkDirector(change);
      return;
    }
    streams.get(node);
    if (change.action === 'add_waits_on') {
      assertChildren(streams, node, [change.child], change.action);
      streams.get(change.on);
    }
    if (change.action === 'set_owner') assertChildren(streams, node, [change.child], 'set_owner');
    if (change.action === 'approve_contract') {
      const contract = this.options.contracts?.get(change.contract);
      if (contract !== undefined && contract.node !== node) {
        throw new Error(`contract_write: ${contract.id} belongs to another node`);
      }
      assertChildren(streams, node, change.parties, 'contract_write');
    }
  }

  /** The Director is above every tree: its changes name their nodes, which must exist. */
  private checkDirector(change: CoordinatorChange): void {
    const { streams, store } = this.options;
    switch (change.action) {
      case 'create_tree':
        if (change.tree.project !== undefined) store.getProject(change.tree.project);
        else store.assertProjectNameFree(change.tree.new_project ?? '');
        return;
      case 'create_project':
        store.assertProjectNameFree(change.name);
        return;
      case 'create_node':
        if (change.node.parent !== undefined) streams.get(change.node.parent);
        else store.getProject(change.node.project ?? '');
        return;
      case 'start_node':
      case 'restart_node':
        streams.get(change.node);
        return;
      case 'add_waits_on':
        streams.get(change.child);
        streams.get(change.on);
        return;
      default:
        throw new Error(`${change.action}: not a Director change`);
    }
  }

  /** The Director's draft, built: the project (if new), the node, its parts and their waits. */
  private async createTree(
    principal: 'human' | 'coordinator' | 'director',
    change: Extract<CoordinatorChange, { action: 'create_tree' }>,
  ): Promise<unknown> {
    const { streams, store } = this.options;
    const t = change.tree;
    const project =
      t.project !== undefined
        ? store.getProject(t.project)
        : await this.projects().create({ name: t.new_project }, principal);
    const node = await streams.create(principal, {
      title: t.title,
      goal: t.goal,
      parent: project.root,
      ...(t.repo !== undefined ? { repo: t.repo } : {}),
    });
    const parts = [];
    for (const part of t.parts) {
      parts.push(
        await streams.create(principal, {
          title: part.title,
          goal: part.goal,
          parent: node.id,
          ...(part.repo !== undefined ? { repo: part.repo } : {}),
        }),
      );
    }
    for (const [i, part] of t.parts.entries()) {
      for (const after of part.after ?? []) {
        const [child, on] = [parts[i], parts[after]];
        if (child !== undefined && on !== undefined) await streams.wait(principal, child.id, on.id);
      }
    }
    return { project: project.id, node: node.id, parts: parts.map((p) => p.id) };
  }

  private projects(): ProjectService {
    if (this.options.projects === undefined) throw new Error('projects are not available');
    return this.options.projects;
  }

  private nodeAgents(): NodeAgents {
    if (this.agents === undefined) throw new Error('agents are not available');
    return this.agents;
  }

  private async perform(
    node: string,
    principal: 'human' | 'coordinator' | 'director',
    by: string,
    change: CoordinatorChange,
  ): Promise<unknown> {
    const { streams, plans, contracts } = this.options;
    switch (change.action) {
      case 'add_child':
        // Created idle: starting its agent stays the human's (or a later ticket's) call.
        return streams.create(principal, {
          title: change.title,
          goal: change.goal,
          parent: node,
          ...(change.repo !== undefined ? { repo: change.repo } : {}),
        });
      case 'add_waits_on':
        return streams.wait(principal, change.child, change.on);
      case 'set_owner':
        if (plans === undefined) throw new Error('set_owner: plans are not available');
        return plans.setOwner(node, change.child, change.owns, principal);
      case 'approve_contract': {
        if (contracts === undefined) throw new Error('contract_write: contracts are not available');
        const { contract, action: _action, routine: _routine, ...fields } = change;
        return contracts.write(node, { id: contract, ...fields }, by);
      }
      case 'create_tree':
        return this.createTree(principal, change);
      case 'create_project':
        return this.projects().create({ name: change.name, repos: change.repos ?? [] }, principal);
      case 'create_node': {
        const { parent, project, ...fields } = change.node;
        // Created idle; `start_node` starts it.
        return streams.create(principal, {
          ...fields,
          parent: parent ?? this.projects().get(project ?? '').root,
        });
      }
      case 'start_node':
        return this.nodeAgents().start(change.node);
      case 'restart_node':
        return this.nodeAgents().restart(change.node);
    }
  }
}
