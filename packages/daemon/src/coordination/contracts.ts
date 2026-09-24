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
    const after = validateContract({
      ...before,
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
    if (changed) await this.announce(saved, before, by);
    return saved;
  }

  /** `contract_changed` to the owner and the parties (§15), and a line on the owner's thread. */
  private async announce(contract: Contract, before: Contract, by: string): Promise<void> {
    const diff =
      before.title === contract.title
        ? contract.body.slice(0, 200)
        : `${before.title} → ${contract.title}: ${contract.body}`.slice(0, 200);
    await this.options.streams.appendThread('daemon', contract.node, {
      kind: 'event',
      body: `contract ${contract.title} is now v${contract.version}`,
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
      parties: contract.parties,
    });
  }
}
