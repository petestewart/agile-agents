/**
 * Contracts (projects-design §14.4, §9.1, T281): the seams between a
 * coordinating node's children, one `contracts/<C-id>.yaml` each, written
 * through the store's validating entity path.
 *
 * Only the owning node's coordinator writes one (`contract_write`). A body
 * or title change bumps the version, keeps the last 20 bodies in `history`,
 * and emits `contract_changed` to the owning node and the parties only.
 */

import {
  CONTRACT_HISTORY_MAX,
  type Contract,
  ContractIdSchema,
  type ContractProposal,
  ContractProposalSchema,
  type Stream,
  ulid,
  validateContract,
} from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import { NotFoundError, type StateStore } from '../store/store';
import type { StreamService } from '../streams/service';

export interface ContractWrite {
  id?: string;
  title: string;
  body: string;
  parties: string[];
  reason?: string;
  /** T285: the proposal this write approves; it leaves the open list. */
  proposal?: string;
}

/** T285: a child's (or co-signing siblings') proposal, before it has an id. */
export interface ContractProposalInput {
  body: string;
  reason: string;
  routine?: boolean;
}

export interface ContractServiceOptions {
  store: StateStore;
  streams: StreamService;
  emit?: EmitRouted;
  now?: () => Date;
}

function contractPath(id: string): string {
  const parsed = ContractIdSchema.safeParse(id);
  if (!parsed.success) throw new Error(`invalid Contract id: ${id} must look like C-<ulid>`);
  return `contracts/${parsed.data}.yaml`;
}

/** The node's direct children, archived included (a plan may name a closed child). */
export function childrenOf(streams: StreamService, node: string): Stream[] {
  return streams.list({ include_archived: true }).filter((s) => s.parent === node);
}

/** Refuses anything that is not a direct child of `node`. */
export function assertChildren(
  streams: StreamService,
  node: string,
  ids: readonly string[],
  what: string,
): void {
  const children = new Set(childrenOf(streams, node).map((s) => s.id));
  const strangers = ids.filter((id) => !children.has(id));
  if (strangers.length > 0) {
    throw new Error(`${what}: ${strangers.join(', ')} is not a child of this node`);
  }
}

/** Who decided a proposal, in the proposer's words. */
function decider(by: string): string {
  if (by === 'human') return 'the operator';
  if (by.startsWith('agent:')) return 'your coordinator';
  return by;
}

export class ContractService {
  constructor(private readonly options: ContractServiceOptions) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  get(id: string): Contract {
    return this.options.store.getEntity(contractPath(id), validateContract);
  }

  find(id: string): Contract | undefined {
    try {
      return this.get(id);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  list(): Contract[] {
    return this.options.store
      .listEntities('contracts', validateContract)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every contract `node` owns. */
  forNode(node: string): Contract[] {
    return this.list().filter((c) => c.node === node);
  }

  /** Every contract `child` is a party to. */
  forParty(child: string): Contract[] {
    return this.list().filter((c) => c.parties.includes(child));
  }

  /**
   * Creates (no `id`) or bumps a contract owned by `node`. `by` is the
   * writer as the history records it (`agent:<session>`, `human`). An
   * unchanged title and body is a no-op; a party change alone rewrites the
   * record without a bump.
   */
  async write(node: string, input: ContractWrite, by: string): Promise<Contract> {
    const { streams, store } = this.options;
    streams.get(node);
    assertChildren(streams, node, input.parties, 'contract_write');
    const parties = [...new Set(input.parties)];
    const at = this.now();
    if (input.id === undefined) {
      const created = validateContract({
        id: `C-${ulid()}`,
        node,
        title: input.title,
        body: input.body,
        parties,
        version: 1,
        history: [],
      });
      return store.putEntity(contractPath(created.id), validateContract, created);
    }
    const before = this.get(input.id);
    if (before.node !== node) {
      throw new Error(`contract_write: ${before.id} belongs to another node`);
    }
    const changed = before.body !== input.body.trim() || before.title !== input.title.trim();
    const proposals = before.proposals?.filter((p) => p.id !== input.proposal);
    const after = validateContract({
      ...before,
      ...(proposals !== undefined ? { proposals } : {}),
      title: input.title,
      body: input.body,
      parties,
      ...(changed
        ? {
            version: before.version + 1,
            history: [
              ...before.history,
              {
                version: before.version,
                body: before.body,
                changed_by: by,
                reason: input.reason ?? '',
                at,
              },
            ].slice(-CONTRACT_HISTORY_MAX),
          }
        : {}),
    });
    const saved = await store.putEntity(contractPath(after.id), validateContract, after);
    const approved = before.proposals?.find((p) => p.id === input.proposal);
    if (approved !== undefined)
      await this.tellSigners(saved, approved, `approved by ${decider(by)}`);
    const partiesChanged = [...before.parties].sort().join(',') !== [...parties].sort().join(',');
    // T282: a parties change is announced too, to the old and the new parties.
    if (changed || partiesChanged) await this.announce(saved, before, by);
    return saved;
  }

  /** The contract holding open proposal `id`, and the proposal. */
  findProposal(id: string): { contract: Contract; proposal: ContractProposal } {
    for (const contract of this.list()) {
      const proposal = contract.proposals?.find((p) => p.id === id);
      if (proposal !== undefined) return { contract, proposal };
    }
    throw new NotFoundError('contract proposal', id);
  }

  /**
   * T285 (§9.1): `from[0]` proposes a new body, co-signed by the rest of
   * `from`. Every signer must be a child of the owning node; the first one
   * a party. Lands open on the contract, with a thread line and a
   * `contract_proposal` event to the owning node (its coordinator wakes).
   */
  async propose(
    id: string,
    from: readonly string[],
    input: ContractProposalInput,
  ): Promise<ContractProposal> {
    const { streams, store } = this.options;
    const before = this.get(id);
    const signers = [...new Set(from)];
    assertChildren(streams, before.node, signers, 'propose_contract');
    if (!before.parties.includes(signers[0] as string)) {
      throw new Error(`propose_contract: you are not a party to ${before.id}`);
    }
    const proposal = ContractProposalSchema.parse({
      id: `CP-${ulid()}`,
      from: signers,
      body: input.body,
      reason: input.reason,
      routine: input.routine ?? false,
      status: 'open',
      at: this.now(),
    });
    await store.putEntity(
      contractPath(before.id),
      validateContract,
      validateContract({ ...before, proposals: [...(before.proposals ?? []), proposal] }),
    );
    await streams.appendThread('daemon', before.node, {
      kind: 'proposal',
      body: `contract ${before.title}: ${signers.length} child(ren) propose (${proposal.id}): ${proposal.body}. Reason: ${proposal.reason}`.slice(
        0,
        800,
      ),
      ref: contractPath(before.id),
    });
    await this.options.emit?.({
      type: 'contract_proposal',
      subject: before.node,
      payload: {
        contract: before.id,
        children: signers,
        body: proposal.body.slice(0, 200),
        reason: proposal.reason.slice(0, 200),
      },
      ref: contractPath(before.id),
      by: 'daemon',
    });
    return proposal;
  }

  /** T285: the proposal went to the operator (an autonomy proposal holds it). */
  async markAsked(id: string): Promise<ContractProposal> {
    return this.setProposal(id, (p) => ({ ...p, status: 'asked_human' }));
  }

  /** T285: drops the proposal, with a line on the owner's and every signer's thread. */
  async reject(id: string, reason: string, by: string): Promise<ContractProposal> {
    const { contract, proposal } = this.findProposal(id);
    await this.options.store.putEntity(
      contractPath(contract.id),
      validateContract,
      validateContract({
        ...contract,
        proposals: (contract.proposals ?? []).filter((p) => p.id !== id),
      }),
    );
    const body = `contract ${contract.title}: proposal ${id} rejected by ${by}${
      reason !== '' ? `: ${reason}` : ''
    }`.slice(0, 800);
    for (const node of [contract.node, ...proposal.from]) {
      await this.options.streams.appendThread('daemon', node, {
        kind: 'event',
        body,
        ref: contractPath(contract.id),
      });
    }
    await this.tellSigners(
      contract,
      proposal,
      `rejected by ${decider(by)}${reason !== '' ? `: ${reason}` : ''}`,
    );
    return { ...proposal, status: 'rejected' };
  }

  private async setProposal(
    id: string,
    change: (p: ContractProposal) => ContractProposal,
  ): Promise<ContractProposal> {
    const { contract, proposal } = this.findProposal(id);
    const next = change(proposal);
    await this.options.store.putEntity(
      contractPath(contract.id),
      validateContract,
      validateContract({
        ...contract,
        proposals: (contract.proposals ?? []).map((p) => (p.id === id ? next : p)),
      }),
    );
    return next;
  }

  /** T286: every signer of a proposal is told (a routed note) how it was decided. */
  private async tellSigners(
    contract: Contract,
    proposal: ContractProposal,
    outcome: string,
  ): Promise<void> {
    for (const node of proposal.from) {
      await this.options.emit?.({
        type: 'coordinator_note',
        subject: node,
        payload: {
          body: `Your proposal ${proposal.id} on contract ${contract.title} was ${outcome}.`.slice(
            0,
            200,
          ),
        },
        ref: contractPath(contract.id),
        by: 'daemon',
      });
    }
  }

  /** `contract_changed` to the owner and the parties (§15), and a line on the owner's thread. */
  private async announce(contract: Contract, before: Contract, by: string): Promise<void> {
    const diff =
      before.title === contract.title
        ? contract.body.slice(0, 200)
        : `${before.title} → ${contract.title}: ${contract.body}`.slice(0, 200);
    const partyNote =
      before.parties.join(',') === contract.parties.join(',')
        ? ''
        : ` (parties: ${contract.parties.length})`;
    await this.options.streams.appendThread('daemon', contract.node, {
      kind: 'event',
      body: `contract ${contract.title} is now v${contract.version}${partyNote}`,
      ref: contractPath(contract.id),
    });
    await this.options.emit?.({
      type: 'contract_changed',
      subject: contract.node,
      payload: {
        contract: contract.id,
        title: contract.title.slice(0, 200),
        version: contract.version,
        diff,
      },
      ref: contractPath(contract.id),
      by: by.startsWith('agent:') || by === 'human' || by === 'director' ? by : 'daemon',
      parties: [...new Set([...before.parties, ...contract.parties])],
    });
  }
}
