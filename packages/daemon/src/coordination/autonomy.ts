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
  HUMAN_ONLY_ACTIONS,
  type HumanOnlyAction,
  ulid,
  validateAutonomyProposal,
} from '@agile-agents/shared';
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
  now?: () => Date;
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
  }
}

export class AutonomyService {
  constructor(private readonly options: AutonomyServiceOptions) {}

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

  /** The gate plus the effect: applied now, or held as a proposal for the inbox. */
  async act(
    node: string,
    principal: 'coordinator' | 'director',
    by: string,
    change: CoordinatorChange,
  ): Promise<ActOutcome> {
    const level = this.levelFor(node, principal);
    const routine = change.action === 'approve_contract' ? change.routine : undefined;
    const verdict = allowed(principal, change.action, level, { routine: routine === true });
    if (verdict === 'refuse') throw new Error(`${change.action}: not allowed to a ${principal}`);
    this.check(node, change);
    const summary = describeChange(change, (id) => this.titleOf(id));
    if (verdict === 'apply') {
      const result = await this.perform(node, principal, by, change);
      await this.options.streams.appendThread(principal, node, {
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
    await this.options.streams.appendThread(principal, node, {
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
    await this.options.streams.appendThread('human', proposal.node, {
      kind: 'event',
      body: `${status}: ${proposal.summary}`.slice(0, 800),
      ref: proposalPath(proposal.id),
    });
    return saved;
  }

  private titleOf(id: string): string {
    try {
      return this.options.streams.get(id).title;
    } catch {
      return id;
    }
  }

  /** Refuses a change that could never apply, before anything is held. */
  private check(node: string, change: CoordinatorChange): void {
    const { streams } = this.options;
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
    }
  }
}
