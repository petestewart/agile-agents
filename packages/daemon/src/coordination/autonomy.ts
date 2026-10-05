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
import type { EmitRouted } from '../events/producers';
import type { ProjectService } from '../projects/service';
import type { StateStore } from '../store/store';
import type { StreamService } from '../streams/service';
import { type ContractService, assertChildren } from './contracts';
import { type PlanService, WAITING_FOR_PLAN } from './plans';

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
  /** T446: records each applied change as an `autonomy_applied` event. */
  emit?: EmitRouted;
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

/** "1 part", "2 parts". */
function parts(n: number): string {
  return `${n} part${n === 1 ? '' : 's'}`;
}

/** A contract body as the head of a sentence: no trailing full stop, so ". Why:" never doubles it. */
function sentence(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}

/**
 * One line for the card and the thread: the change as a proposal, in words
 * (T446, audit r7 #6: "Add a part "Document sale prices" on docs: …", not
 * "add child … on docs").
 */
export function describeChange(change: CoordinatorChange, titleOf: (id: string) => string): string {
  switch (change.action) {
    case 'add_child':
      return `Add a ${change.repo !== undefined ? 'part' : 'node'} "${change.title}"${change.repo !== undefined ? ` on ${change.repo}` : ''}: ${change.goal}`;
    case 'add_waits_on':
      return `Make ${titleOf(change.child)} wait on ${titleOf(change.on)}`;
    case 'set_owner':
      return `Let ${titleOf(change.child)} own ${change.owns.join(', ') || 'nothing'}`;
    case 'approve_contract':
      return `Approve a ${change.routine === true ? 'routine ' : ''}change to ${change.title}: ${sentence(change.body)}${
        change.reason ? `. Why: ${change.reason}` : ''
      }`;
    case 'create_tree': {
      const t = change.tree;
      const where =
        t.new_project !== undefined ? `a new project, ${t.new_project}` : titleOf(t.project ?? '');
      return `Create "${t.title}" in ${where} with ${parts(t.parts.length)}: ${t.parts.map((p) => p.title).join(', ')}`;
    }
    case 'create_project':
      return `Create the project ${change.name}`;
    case 'create_node':
      return `Create "${change.node.title}" under ${titleOf(change.node.parent ?? change.node.project ?? '')}${change.node.goal !== undefined ? `: ${change.node.goal}` : ''}`;
    case 'start_node':
      return `Start ${titleOf(change.node)}`;
    case 'restart_node':
      return `Restart ${titleOf(change.node)}`;
  }
}

/** T446: an applied change in words, and what it made. */
export interface AppliedWords {
  /** The thread line, without who did it: 'Added a part: "RSS field" (web)'. */
  line: string;
  /** What changed, for Events and Activity: "RSS field (web)". */
  what: string;
  /** The nodes it created (links, Undo), in order. */
  nodes: string[];
  /** The node the line links to: the first created, or the one it changed. */
  ref?: string;
}

/** An id from a `perform` result that holds one (`{id}`), else `undefined`. */
function idOf(result: unknown, key = 'id'): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * T446 (audit r7 #6, #7): what an applied change did, in words, from its
 * `perform` result: "Added a part: "Add an RSS field" (web)", "Linked web
 * to wait on api", "Approved a routine change to Key file (v2)", "Created
 * "Newsletter signup" in Blog with 2 parts". The caller says who ("You …").
 */
export function appliedWords(
  change: CoordinatorChange,
  result: unknown,
  titleOf: (id: string) => string,
): AppliedWords {
  const created = (ids: (string | undefined)[]): string[] =>
    ids.filter((id): id is string => id !== undefined);
  switch (change.action) {
    case 'add_child': {
      const repo = change.repo !== undefined ? ` (${change.repo})` : '';
      const id = idOf(result);
      return {
        line: `Added a ${change.repo !== undefined ? 'part' : 'node'}: "${change.title}"${repo}`,
        what: `${change.title}${repo}`,
        nodes: created([id]),
        ...(id !== undefined ? { ref: id } : {}),
      };
    }
    case 'add_waits_on': {
      const [child, on] = [titleOf(change.child), titleOf(change.on)];
      return {
        line: `Linked ${child} to wait on ${on}`,
        what: `${child} waits on ${on}`,
        nodes: [],
        ref: change.child,
      };
    }
    case 'set_owner': {
      const child = titleOf(change.child);
      const owns = change.owns.join(', ') || 'nothing';
      return {
        line: `Set ${child} to own ${owns}`,
        what: `${child} owns ${owns}`,
        nodes: [],
        ref: change.child,
      };
    }
    case 'approve_contract': {
      const version =
        typeof result === 'object' && result !== null && 'version' in result
          ? ` (v${String((result as { version: unknown }).version)})`
          : '';
      return {
        line: `Approved a ${change.routine === true ? 'routine ' : ''}change to ${change.title}${version}`,
        what: `${change.title}${version}`,
        nodes: [],
      };
    }
    case 'create_tree': {
      const t = change.tree;
      const where =
        t.new_project !== undefined ? `a new project, ${t.new_project}` : titleOf(t.project ?? '');
      const node = idOf(result, 'node');
      const partIds =
        typeof result === 'object' &&
        result !== null &&
        Array.isArray((result as { parts?: unknown }).parts)
          ? ((result as { parts: unknown[] }).parts.filter(
              (p) => typeof p === 'string',
            ) as string[])
          : [];
      const what = `"${t.title}" in ${where} with ${parts(t.parts.length)}`;
      return {
        line: `Created ${what}`,
        what: what.replace(/"/g, ''),
        nodes: created([node, ...partIds]),
        ...(node !== undefined ? { ref: node } : {}),
      };
    }
    case 'create_project': {
      const root = idOf(result, 'root');
      return {
        line: `Created the project ${change.name}`,
        what: change.name,
        nodes: [],
        ...(root !== undefined ? { ref: root } : {}),
      };
    }
    case 'create_node': {
      const id = idOf(result);
      const under = titleOf(change.node.parent ?? change.node.project ?? '');
      return {
        line: `Created "${change.node.title}" under ${under}`,
        what: `${change.node.title} under ${under}`,
        nodes: created([id]),
        ...(id !== undefined ? { ref: id } : {}),
      };
    }
    case 'start_node':
    case 'restart_node': {
      const verb = change.action === 'start_node' ? 'Started' : 'Restarted';
      return {
        line: `${verb} "${titleOf(change.node)}"`,
        what: titleOf(change.node),
        nodes: [],
        ref: change.node,
      };
    }
  }
}

/** "You added a part: …": the line as the human's own. */
function asYou(line: string): string {
  return `You ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
}

export class AutonomyService {
  private agents: NodeAgents | undefined;
  /** T443: starts under way (off the verb's path); `settled()` waits for them. */
  private readonly starting = new Set<Promise<void>>();

  constructor(private readonly options: AutonomyServiceOptions) {}

  setAgents(agents: NodeAgents): void {
    this.agents = agents;
  }

  /** T443: resolves once every start begun so far has finished (tests). */
  async settled(): Promise<void> {
    while (this.starting.size > 0) await Promise.allSettled([...this.starting]);
  }

  /**
   * T443 (§12, audit r7 #1): a node an applied change created runs, as a
   * node you create does. While its parent's plan waits for the operator
   * (a draft, or parts still waiting for it), it waits too and starts when
   * the plan is approved (the `WAITING_FOR_PLAN` line, T336); otherwise it
   * starts now. Off the caller's path: a coordinator's turn never waits on a
   * vendor starting, and a failed start is the attach service's thread line.
   */
  private async run(ids: readonly string[], parent: string | undefined): Promise<void> {
    const agents = this.agents;
    if (agents === undefined || ids.length === 0) return;
    const { streams } = this.options;
    const waits = parent !== undefined && this.planPending(parent);
    for (const id of ids) {
      // A part (it has a repo) waits for the plan; a conversation is never one (D42).
      if (waits && streams.get(id).repo !== undefined) {
        await streams.appendThread('daemon', id, {
          kind: 'event',
          body: `${WAITING_FOR_PLAN}this part starts when "${this.titleOf(parent)}"'s plan is approved`,
        });
        continue;
      }
      const started = agents
        .start(id)
        .then(() => undefined)
        .catch((err) => {
          console.error(
            `autonomy: could not start ${id}:`,
            err instanceof Error ? err.message : err,
          );
        })
        .finally(() => this.starting.delete(started));
      this.starting.add(started);
    }
  }

  /** The node's plan waits for the operator: a draft, or parts still waiting for one. */
  private planPending(node: string): boolean {
    const plans = this.options.plans;
    if (plans === undefined) return false;
    try {
      if (plans.get(node)?.status === 'draft') return true;
      return plans.waitingParts(node).length > 0;
    } catch {
      return false;
    }
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
      // T446 (audit r7 #6, #7): a line in words, linked to what it made, and a record of it.
      const words = appliedWords(change, result, (id) => this.titleOf(id));
      await this.note(principal, node, {
        kind: 'event',
        body: words.line.slice(0, 800),
        ...(words.ref !== undefined ? { ref: words.ref } : {}),
      });
      await this.record(node, principal, by, level, change, words);
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
      // T381: the thread reads in words; the level is the card's business.
      body: `Proposed, waiting for your approval: ${summary}`.slice(0, 800),
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
    const level =
      before.node === DIRECTOR_NODE
        ? this.directorLevelFor(before.change)
        : this.levelFor(before.node, 'coordinator');
    const result = await this.perform(before.node, 'human', 'human', before.change);
    const words = appliedWords(before.change, result, (id) => this.titleOf(id));
    const closed = await this.close(before, 'applied', words);
    await this.record(before.node, 'human', 'human', level, before.change, words, before);
    return closed;
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
    words?: AppliedWords,
  ): Promise<AutonomyProposal> {
    const saved = await this.options.store.putEntity(
      proposalPath(proposal.id),
      validateAutonomyProposal,
      validateAutonomyProposal({ ...proposal, status, decided_at: this.now() }),
    );
    // T446 (audit r7 #6): "You added a part: …" (linked to it); "You dismissed: …".
    await this.note(
      'human',
      proposal.node,
      words !== undefined
        ? {
            kind: 'event',
            body: asYou(words.line).slice(0, 800),
            ref: words.ref ?? proposalPath(proposal.id),
          }
        : {
            kind: 'event',
            body: `You dismissed: ${proposal.summary}`.slice(0, 800),
            ref: proposalPath(proposal.id),
          },
    );
    return saved;
  }

  /**
   * T446 (audit r7 #7): an applied change as an `autonomy_applied` event, on
   * the node it changed and its ancestors (the Director's feed too, for the
   * Director's own). A record: it wakes and prompts nobody. Never fails the change.
   */
  private async record(
    node: string,
    principal: 'human' | 'coordinator' | 'director',
    by: string,
    level: Autonomy,
    change: CoordinatorChange,
    words: AppliedWords,
    proposal?: AutonomyProposal,
  ): Promise<void> {
    const emit = this.options.emit;
    if (emit === undefined) return;
    const director = node === DIRECTOR_NODE;
    const subject = director ? (words.ref ?? words.nodes[0]) : node;
    let project: string | undefined;
    try {
      project = subject === undefined ? undefined : this.options.streams.get(subject).project;
    } catch {
      project = undefined;
    }
    const author =
      principal === 'human'
        ? 'human'
        : principal === 'director'
          ? 'director'
          : /^agent:[0-9A-HJKMNP-TV-Z]{26}$/.test(by)
            ? by
            : 'daemon';
    await emit({
      type: 'autonomy_applied',
      ...(subject !== undefined ? { subject } : {}),
      ...(project !== undefined ? { project } : {}),
      payload: {
        principal,
        level,
        action: change.action,
        summary: words.what.slice(0, 200) || change.action,
        nodes: words.nodes.slice(0, 20),
        ...(proposal !== undefined ? { proposal: proposal.id } : {}),
      },
      ...(proposal !== undefined ? { ref: proposalPath(proposal.id) } : {}),
      by: author,
      ...(director || proposal?.principal === 'director' ? { director: true } : {}),
    });
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
    // T443: a coordinator starts (or restarts) its own children only.
    if (change.action === 'start_node' || change.action === 'restart_node') {
      assertChildren(streams, node, [change.node], change.action);
    }
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
    // T443 (§12's worked example): the node's coordinator starts and plans; its parts wait
    // for that plan (T336) and start when it is approved. A node without parts just runs.
    if (parts.length > 0 && this.agents !== undefined) {
      for (const part of parts) {
        await streams.appendThread('daemon', part.id, {
          kind: 'event',
          body: `${WAITING_FOR_PLAN}this part starts when "${node.title}"'s plan is approved`,
        });
      }
    }
    await this.run([node.id], undefined);
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
      case 'add_child': {
        const child = await streams.create(principal, {
          title: change.title,
          goal: change.goal,
          parent: node,
          ...(change.repo !== undefined ? { repo: change.repo } : {}),
        });
        // T443: it runs, now or once the plan it waits for is approved.
        await this.run([child.id], node);
        return child;
      }
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
        const under = parent ?? this.projects().get(project ?? '').root;
        const created = await streams.create(principal, { ...fields, parent: under });
        // T443: it runs, as a node you create does.
        await this.run([created.id], under);
        return created;
      }
      case 'start_node': {
        // T443: already running (started when it was created) is done, not an error.
        const target = streams.get(change.node);
        if (target.sessions.some((s) => s.status === 'starting' || s.status === 'running')) {
          return { node: target.id, already: true };
        }
        return this.nodeAgents().start(change.node);
      }
      case 'restart_node':
        return this.nodeAgents().restart(change.node);
    }
  }
}
