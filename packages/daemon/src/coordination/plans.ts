/**
 * Plans (projects-design §14.4, §9.1, T281): one `plans/<node-id>.yaml` per
 * coordinating node — who owns which paths, and the contracts between them.
 *
 * The coordinator writes it with `plan_write`; every write lands `draft`
 * (a changed plan is a changed decision about what gets built). The human
 * approves it from an inbox card at every level; approval bumps the
 * version and tells each child its paths with `plan_changed`. A child's
 * brief carries its owned paths and the contracts it is a party to, once
 * its parent's plan is approved.
 */

import {
  type Contract,
  type Plan,
  type PlanOwner,
  type Stream,
  UlidSchema,
  validatePlan,
} from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import { NotFoundError, type StateStore } from '../store/store';
import type { StreamService } from '../streams/service';
import { type ContractService, assertChildren } from './contracts';

export interface PlanServiceOptions {
  store: StateStore;
  streams: StreamService;
  contracts: ContractService;
  emit?: EmitRouted;
  /** T338: the parts' questions that went to this coordinator first. */
  questions?: { supersedeByPlan(node: string, version: number): Promise<unknown> };
  now?: () => Date;
}

/** A plan that cannot be approved as asked (none, or already approved). */
export class PlanNotDraftError extends Error {
  constructor(node: string) {
    super(`no draft plan to approve on ${node}`);
    this.name = 'PlanNotDraftError';
  }
}

function planPath(node: string): string {
  const parsed = UlidSchema.safeParse(node);
  if (!parsed.success) throw new Error(`invalid plan node: ${node}`);
  return `plans/${parsed.data}.yaml`;
}

/** What a child is told about its part of an approved plan. */
export interface ChildPlanView {
  version: number;
  owns: string[];
  /** Siblings' owned paths, so the child knows whose files are whose. */
  siblings: { child: string; title: string; owns: string[] }[];
  contracts: Contract[];
}

export class PlanService {
  constructor(private readonly options: PlanServiceOptions) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  get(node: string): Plan | undefined {
    try {
      return this.options.store.getEntity(planPath(node), validatePlan);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  list(): Plan[] {
    return this.options.store.listEntities('plans', validatePlan);
  }

  /** Every plan waiting on its approval, for the inbox. */
  listDraft(): Plan[] {
    return this.list().filter((p) => p.status === 'draft');
  }

  /** The coordinator's write: owners must be children, contracts this node's own. Always `draft`. */
  async write(node: string, owners: PlanOwner[], contracts?: string[]): Promise<Plan> {
    const { streams, store } = this.options;
    streams.get(node);
    assertChildren(
      streams,
      node,
      owners.map((o) => o.child),
      'plan_write',
    );
    const before = this.get(node);
    const ids = contracts ?? before?.contracts ?? [];
    for (const id of ids) {
      const contract = this.options.contracts.get(id);
      if (contract.node !== node) throw new Error(`plan_write: ${id} belongs to another node`);
    }
    const plan = validatePlan({
      node,
      version: before?.version ?? 0,
      owners,
      contracts: ids,
      status: 'draft',
      ...(before?.approved !== undefined ? { approved: before.approved } : {}),
      updated_at: this.now(),
    });
    const saved = await store.putEntity(planPath(node), validatePlan, plan);
    await streams.appendThread('daemon', node, {
      kind: 'event',
      body: `plan drafted (${owners.length} ${owners.length === 1 ? 'child' : 'children'}, ${ids.length} ${ids.length === 1 ? 'contract' : 'contracts'}); waiting for approval`,
      ref: planPath(node),
    });
    return saved;
  }

  /** The human's approval (an inbox card, §9): bumps the version and tells every child. */
  async approve(node: string, by: 'human' | 'coordinator' | 'director' = 'human'): Promise<Plan> {
    const before = this.get(node);
    if (before === undefined || before.status !== 'draft') throw new PlanNotDraftError(node);
    const plan = validatePlan({
      ...before,
      version: before.version + 1,
      status: 'approved',
      approved_by: by,
      approved: {
        version: before.version + 1,
        owners: before.owners,
        contracts: before.contracts,
      },
      updated_at: this.now(),
    });
    const saved = await this.options.store.putEntity(planPath(node), validatePlan, plan);
    await this.options.streams.appendThread('daemon', node, {
      kind: 'event',
      body: `plan v${saved.version} approved by ${by}`,
      ref: planPath(node),
    });
    const contracts = saved.contracts.map((id) => this.options.contracts.find(id));
    await this.options.questions?.supersedeByPlan(node, saved.version);
    for (const owner of saved.owners) {
      // T338: each part reads its share on its own thread too.
      await this.options.streams.appendThread('daemon', owner.child, {
        kind: 'event',
        body: `plan v${saved.version} approved: you own ${owner.owns.join(', ') || 'no paths'}`.slice(
          0,
          800,
        ),
        ref: planPath(node),
      });
      const relies = contracts
        .filter((c): c is Contract => c?.parties.includes(owner.child) === true)
        .map((c) => c.title);
      await this.options.emit?.({
        type: 'plan_changed',
        subject: node,
        payload: {
          summary:
            `v${saved.version}${relies.length > 0 ? `; you rely on ${relies.join(', ')}` : ''}`.slice(
              0,
              200,
            ),
          paths: owner.owns.slice(0, 20),
        },
        ref: planPath(node),
        by: by === 'coordinator' ? 'daemon' : by,
        parties: [owner.child],
      });
    }
    return saved;
  }

  /**
   * T282 `set_owner`, once the autonomy gate let it through: `child` owns
   * `owns`, and no sibling keeps those exact globs. An approved plan stays
   * approved at the next version (the change was authorised by the gate)
   * and the child hears `plan_changed`; a draft just changes.
   */
  async setOwner(
    node: string,
    child: string,
    owns: string[],
    by: 'human' | 'coordinator' | 'director',
  ): Promise<Plan> {
    assertChildren(this.options.streams, node, [child], 'set_owner');
    const before = this.get(node);
    const taken = new Set(owns);
    const owners = [
      ...(before?.owners ?? [])
        .filter((o) => o.child !== child)
        .map((o) => ({ ...o, owns: o.owns.filter((g) => !taken.has(g)) })),
      { child, owns },
    ];
    const approved = before?.status === 'approved';
    const version = approved ? (before?.version ?? 0) + 1 : (before?.version ?? 0);
    const plan = validatePlan({
      node,
      version,
      owners,
      contracts: before?.contracts ?? [],
      status: approved ? 'approved' : 'draft',
      ...(approved
        ? {
            approved_by: by,
            approved: { version, owners, contracts: before?.contracts ?? [] },
          }
        : before?.approved !== undefined
          ? { approved: before.approved }
          : {}),
      updated_at: this.now(),
    });
    const saved = await this.options.store.putEntity(planPath(node), validatePlan, plan);
    if (approved) {
      await this.options.emit?.({
        type: 'plan_changed',
        subject: node,
        payload: {
          summary: `v${saved.version}: you now own ${owns.join(', ')}`.slice(0, 200),
          paths: owns.slice(0, 20),
        },
        ref: planPath(node),
        by: by === 'coordinator' ? 'daemon' : by,
        parties: [child],
      });
    }
    return saved;
  }

  /** A child's part of its parent's approved plan, or nothing (no parent, no plan, still draft). */
  childView(child: Stream): ChildPlanView | undefined {
    if (child.parent === undefined) return undefined;
    // A revision in draft never reaches the children: they keep the last approved version.
    const plan = this.get(child.parent)?.approved;
    if (plan === undefined) return undefined;
    const mine = plan.owners.find((o) => o.child === child.id);
    const titles = new Map(
      this.options.streams.list({ include_archived: true }).map((s) => [s.id, s.title]),
    );
    const contracts = plan.contracts
      .map((id) => this.options.contracts.find(id))
      .filter((c): c is Contract => c?.parties.includes(child.id) === true);
    if (mine === undefined && contracts.length === 0) return undefined;
    return {
      version: plan.version,
      owns: mine?.owns ?? [],
      siblings: plan.owners
        .filter((o) => o.child !== child.id)
        .map((o) => ({ child: o.child, title: titles.get(o.child) ?? o.child, owns: o.owns })),
      contracts,
    };
  }
}
