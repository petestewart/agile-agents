/**
 * The mailbox (specs/agent-control-channel.md §5, §11 step 6): `send` /
 * `await` / `wake-on` over the durable operations table (§7.2), with
 * queue-for-next-turn delivery (§5.3), coalesced wake-if-idle wake-on
 * delivery (§5.4), retain-while-pending (§6.3), wait-graph cycle rejection
 * (§9.3), and a timeout ceiling with an explicit expiry status (§5.1).
 *
 * The service consumes ONLY the `MessageableSession` contract
 * (`@shared/agent-session-contract`) via a session hub — never ACP types —
 * and is fully drivable in plain vitest with an in-memory store and a fake
 * hub. Durable state lives in the store; everything in memory here (wait
 * graph, delivery queues, wake queues, timers, holds) is rebuilt from the
 * table by `start()` after a crash or restart (§9.3).
 *
 * Retain-while-pending (§6.3) is COMPOSED with the contract, not folded into
 * it: the hub's `acquire`/`release` holds pin the underlying session (daemon
 * retain + frame attach) for exactly as long as an operation is outstanding.
 * Extending `MessageableSession` with retain semantics would push daemon
 * lifecycle into a protocol-neutral interface every future transport would
 * then have to fake; a hold at the hub boundary keeps the contract narrow.
 */
import type { MessageableSession, SessionReply } from "@shared/agent-session-contract";
import {
  MAILBOX_DEFAULT_TIMEOUT_MS,
  MAILBOX_MAX_TIMEOUT_MS,
  MAILBOX_BODY_PREVIEW_CHARS,
  MAILBOX_RETENTION_MS,
  formatMessageId,
  type MailboxBlockedReason,
  type MailboxDeliveryMode,
  type MailboxOperationView,
} from "@shared/mailbox-types";
import type { MailboxOpRow, MailboxStore } from "./mailbox-store";
import { SessionAddressError } from "./session-address-error";
import { composeDeliveryText, composeWakeText } from "./mailbox-envelope";
import { WaitGraph, type WaitCycle } from "./wait-graph";

/** Ceiling on a wake turn before its flush gives up and retries (§5.4). */
const WAKE_TURN_DEADLINE_MS = 10 * 60 * 1000;

/** Resolve to null when `promise` does not settle within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * The slice of a messageable handle the blocked-reason diagnosis reads
 * (GH-129). `blockedOnPermission` is deliberately probed off the handle
 * rather than added to `MessageableSession`: the shared contract (#123)
 * stays transport-neutral and untouched, and a transport that cannot
 * observe permission prompts simply never reports the state.
 */
interface BlockedStateProbe {
  blockedOnPermission?: boolean;
}

/** The hub contract the mailbox needs (AcpSessionHub satisfies it). */
export interface MailboxSessionHub {
  /** Resolve + pin a session (§6.3). Throws on unknown/PTY/exited targets. */
  acquire(sessionId: string): Promise<MessageableSession>;
  release(sessionId: string): Promise<void>;
  /**
   * Optional synchronous, non-owning look at an already-open handle, used
   * only to annotate unsettled operations with a blocked reason (GH-129).
   * Absence of the method — or of the handle — just means "no diagnosis".
   */
  peek?(sessionId: string): MessageableSession | undefined;
}

/** Typed mailbox failure — verbs translate these into agent-facing errors. */
export class MailboxError extends Error {
  constructor(
    public readonly code:
      | "recipient_busy"
      | "wait_cycle"
      | "not_sender"
      | "message_not_found"
      | "not_wakeable",
    message: string,
    public readonly cycle?: WaitCycle,
  ) {
    super(message);
    this.name = "MailboxError";
  }
}

export interface MailboxPrincipalRef {
  id: string;
  kind: "pane" | "session";
  workspaceId: string;
}

export interface MailboxSendOptions {
  sender: MailboxPrincipalRef;
  recipientSessionId: string;
  body: string;
  mode: MailboxDeliveryMode;
  /** §5.3 mid-turn policy: queue (default) or reject when the recipient is busy. */
  ifBusy?: "queue" | "reject";
  correlationId?: string | null;
  timeoutMs?: number;
}

export interface AwaitResult {
  done: boolean;
  op: MailboxOperationView;
}

interface OpRuntime {
  recipientHeld: boolean;
  senderHeld: boolean;
  timer: NodeJS.Timeout | null;
  edgeWaiter: string | null;
  waiters: Set<() => void>;
}

export class MailboxService {
  readonly graph = new WaitGraph();

  private runtime = new Map<number, OpRuntime>();
  /** recipient session id → queued op ids, in arrival order. */
  private queues = new Map<string, number[]>();
  private deliveryInFlight = new Set<string>();
  /**
   * Turn-end subscriptions used to flush queues. Each entry OWNS one hub
   * hold: the hub disposes a handle (clearing its listeners) at zero holds,
   * so a subscription without a hold of its own could silently die the
   * moment the last per-op hold is released.
   */
  private recipientSubs = new Map<string, () => void>();
  private wakeSubs = new Map<string, () => void>();
  /** waiter session id → resolved wake-on op ids awaiting a wake turn. */
  private wakeQueues = new Map<string, number[]>();
  private wakeInFlight = new Set<string>();
  /** Wake delivery attempts per op — bounded retries on transient failure. */
  private wakeAttempts = new Map<number, number>();
  private started = false;

  constructor(
    private readonly store: MailboxStore,
    private readonly hub: MailboxSessionHub,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Rebuild in-memory state from the operations table (§9.3) and resume:
   *
   * - `delivering` rows lost their turn binding with the process — resolved
   *   as failed (`delivery_interrupted`) rather than risking double delivery.
   * - `queued` rows re-arm holds, wait edges, expiry timers, and delivery.
   * - resolved `wake-on` rows that never delivered their wake turn do so now.
   * - settled rows past the retention age are pruned (§7.2).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const row of this.store.listUnsettled()) {
      if (row.status === "delivering") {
        this.store.update(row.id, {
          status: "resolved",
          replyStatus: "failed",
          replyText: "",
          replyErrorCode: "delivery_interrupted",
          replyErrorMessage:
            "Terma restarted while this message's delivery turn was running; the reply was lost.",
          resolvedAt: this.now(),
        });
        if (row.deliveryMode === "wake-on") {
          const settled = this.store.get(row.id);
          if (settled) this.enqueueWake(settled);
        }
        continue;
      }
      // queued
      if (row.expiresAt <= this.now()) {
        this.store.update(row.id, { status: "expired", resolvedAt: this.now() });
        // §5.1: expiry is an explicit status, not silence — a wake-on waiter
        // still gets its wake turn even when the ceiling passed while the
        // app was down. (listUndeliveredWakes would also pick this row up,
        // but only because it now includes expired rows; enqueue directly so
        // the invariant does not depend on scan ordering.)
        if (row.deliveryMode === "wake-on") {
          const expired = this.store.get(row.id);
          if (expired) this.enqueueWake(expired);
        }
        continue;
      }
      const rt = this.ensureRuntime(row.id);
      if (row.deliveryMode === "await") {
        // Rebuild the wait edge. A cycle on rebuild means the table already
        // contains mutually-waiting ops (written before a crash mid-check);
        // expire this one rather than deadlock silently.
        const cycle = this.graph.tryAddEdge(row.senderPrincipalId, row.recipientSessionId, row.id);
        if (cycle) {
          this.store.update(row.id, { status: "expired", resolvedAt: this.now() });
          this.runtime.delete(row.id);
          continue;
        }
        rt.edgeWaiter = row.senderPrincipalId;
      }
      this.armExpiry(row.id, row.expiresAt);
      await this.takeHolds(row, rt);
      this.enqueueDelivery(row.recipientSessionId, row.id);
    }

    for (const row of this.store.listUndeliveredWakes()) {
      this.enqueueWake(row);
    }

    this.prune();

    // Kick delivery/wakes for everything queued above.
    for (const recipient of [...this.queues.keys()]) {
      void this.flushDeliveries(recipient);
    }
    for (const waiter of [...this.wakeQueues.keys()]) {
      void this.flushWakes(waiter);
    }
  }

  /** §7.2 retention: prune settled rows past the documented age. */
  prune(retentionMs: number = MAILBOX_RETENTION_MS): number {
    return this.store.pruneSettledBefore(this.now() - retentionMs);
  }

  /**
   * Accept a message (§5). Resolves once the operation is durably recorded
   * and delivery is scheduled; returns the operation view (with its
   * `messageId`). Throws `MailboxError` / hub address errors on refusal.
   */
  async send(opts: MailboxSendOptions): Promise<MailboxOperationView> {
    const mode = opts.mode;
    // Cycle pre-check (§9.3) before anything is created: reject the edge
    // that would close a cycle, naming both parties.
    if (mode === "await") {
      const cycle = this.graph.wouldCycle(opts.sender.id, opts.recipientSessionId);
      if (cycle) throw this.cycleError(cycle);
    }

    // Resolve + pin the recipient (§6.3). Address errors propagate.
    const recipient = await this.hub.acquire(opts.recipientSessionId);

    if ((opts.ifBusy ?? "queue") === "reject" && recipient.busy) {
      await this.hub.release(opts.recipientSessionId);
      throw new MailboxError(
        "recipient_busy",
        `Session "${opts.recipientSessionId}" is mid-turn and the message was sent with if-busy=reject.`,
      );
    }

    const createdAt = this.now();
    const timeoutMs = Math.min(
      Math.max(1, opts.timeoutMs ?? MAILBOX_DEFAULT_TIMEOUT_MS),
      MAILBOX_MAX_TIMEOUT_MS,
    );
    const row = this.store.insert({
      workspaceId: opts.sender.workspaceId,
      senderPrincipalId: opts.sender.id,
      senderPrincipalKind: opts.sender.kind,
      recipientSessionId: opts.recipientSessionId,
      body: opts.body,
      correlationId: opts.correlationId ?? null,
      deliveryMode: mode,
      status: "queued",
      replyStatus: null,
      replyText: null,
      replyErrorCode: null,
      replyErrorMessage: null,
      replyTruncated: false,
      wakeDelivered: false,
      createdAt,
      deliveredAt: null,
      resolvedAt: null,
      expiresAt: createdAt + timeoutMs,
    });

    const rt = this.ensureRuntime(row.id);
    rt.recipientHeld = true; // acquired above
    if (mode === "await") {
      const cycle = this.graph.tryAddEdge(opts.sender.id, opts.recipientSessionId, row.id);
      if (cycle) {
        // Raced by a concurrent edge between the pre-check and here.
        this.store.update(row.id, { status: "cancelled", resolvedAt: this.now() });
        await this.releaseHolds(row.id, rt);
        this.runtime.delete(row.id);
        throw this.cycleError(cycle);
      }
      rt.edgeWaiter = opts.sender.id;
    }
    await this.takeSenderHold(row, rt);
    this.armExpiry(row.id, row.expiresAt);
    this.enqueueDelivery(opts.recipientSessionId, row.id);
    void this.flushDeliveries(opts.recipientSessionId);
    return this.view(this.store.get(row.id)!);
  }

  /**
   * Attach to an operation and wait for its resolution (§5.1). Re-attachable:
   * the record is durable, so a dropped CLI call re-attaches with the same
   * message id. Returns `{done: false}` after `waitMs` so callers long-poll
   * in bounded slices (the CLI loops; the operation itself is bounded by its
   * expiry ceiling, so a forgotten wait always settles).
   */
  async awaitReply(
    caller: MailboxPrincipalRef,
    messageId: number,
    waitMs: number,
  ): Promise<AwaitResult> {
    const row = this.requireOwnOp(caller, messageId);

    // Upgrading a plain send to a blocking await adds the wait edge now —
    // with the same cycle rejection as `ask`.
    if (this.isUnsettled(row) && row.deliveryMode !== "await") {
      const rt = this.ensureRuntime(row.id);
      if (rt.edgeWaiter === null) {
        const cycle = this.graph.tryAddEdge(caller.id, row.recipientSessionId, row.id);
        if (cycle) throw this.cycleError(cycle);
        rt.edgeWaiter = caller.id;
      }
      this.store.update(row.id, { deliveryMode: "await" });
    }

    const settled = await this.waitForSettle(row.id, waitMs);
    const latest = this.store.get(messageId);
    if (!latest) {
      throw new MailboxError("message_not_found", `Message ${formatMessageId(messageId)} no longer exists.`);
    }
    return { done: settled && !this.isUnsettled(latest), op: this.view(latest) };
  }

  /** `ask` = `send` + wait until the operation settles (bounded by expiry). */
  async ask(opts: MailboxSendOptions): Promise<MailboxOperationView> {
    const sent = await this.send({ ...opts, mode: "await" });
    const id = Number(sent.messageId.slice(4));
    // The expiry ceiling guarantees settlement; wait as long as it takes.
    for (;;) {
      const result = await this.awaitReply(opts.sender, id, 60_000);
      if (result.done) return result.op;
    }
  }

  /**
   * Subscribe the sender to a wake turn when the operation settles (§5.4).
   * The waiter must itself be a messageable session — a terminal-pane
   * principal has no turn to wake into.
   */
  async wakeOn(caller: MailboxPrincipalRef, messageId: number): Promise<MailboxOperationView> {
    const row = this.requireOwnOp(caller, messageId);

    // Verify the waiter is wakeable before recording the subscription.
    try {
      await this.hub.acquire(caller.id);
      await this.hub.release(caller.id);
    } catch (err) {
      throw new MailboxError(
        "not_wakeable",
        `Your session cannot receive wake turns (${err instanceof Error ? err.message : String(err)}).`,
      );
    }

    if (this.isUnsettled(row)) {
      // A blocking await downgraded to wake-on stops blocking: drop the edge.
      const rt = this.ensureRuntime(row.id);
      if (rt.edgeWaiter !== null) {
        this.graph.removeEdge(rt.edgeWaiter, row.id);
        rt.edgeWaiter = null;
      }
      this.store.update(row.id, { deliveryMode: "wake-on" });
    } else if (!row.wakeDelivered) {
      this.store.update(row.id, { deliveryMode: "wake-on" });
      const latest = this.store.get(row.id);
      if (latest) {
        this.enqueueWake(latest);
        void this.flushWakes(latest.senderPrincipalId);
      }
    }
    return this.view(this.store.get(messageId)!);
  }

  /**
   * Explicit cancel (§5.1). Idempotent: cancelling a settled operation is
   * success. A queued message is withdrawn (never delivered); a delivering
   * one keeps running on the recipient, but its reply is discarded.
   */
  async cancel(caller: MailboxPrincipalRef, messageId: number): Promise<MailboxOperationView> {
    const row = this.requireOwnOp(caller, messageId);
    if (this.isUnsettled(row)) {
      if (row.status === "queued") {
        this.dequeueDelivery(row.recipientSessionId, row.id);
      }
      this.store.update(row.id, { status: "cancelled", resolvedAt: this.now() });
      await this.settleCleanup(row.id);
    }
    return this.view(this.store.get(messageId)!);
  }

  /** Workspace-scoped operations listing (`terma agent ops`, monitor v2). */
  list(workspaceId: string, limit = 100): MailboxOperationView[] {
    // Reply texts are previewed like bodies: hundreds of settled ops at the
    // 64KB reply cap would otherwise turn one listing into a multi-megabyte
    // payload. The full stored reply stays reachable via `agent await <id>`.
    return this.store.listByWorkspace(workspaceId, limit).map((row) => {
      const view = this.view(row);
      if (view.replyText !== null && view.replyText.length > MAILBOX_BODY_PREVIEW_CHARS) {
        view.replyText = `${view.replyText.slice(0, MAILBOX_BODY_PREVIEW_CHARS)}…`;
      }
      return view;
    });
  }

  /** One operation, sender-scoped (used by verbs for reads). */
  getOwn(caller: MailboxPrincipalRef, messageId: number): MailboxOperationView {
    return this.view(this.requireOwnOp(caller, messageId));
  }

  // ---- internals ----------------------------------------------------------

  private cycleError(cycle: WaitCycle): MailboxError {
    return new MailboxError(
      "wait_cycle",
      `This wait would deadlock: ${cycle.waiter} would wait on ${cycle.holder}, but ${cycle.holder} is already waiting on ${cycle.waiter}${
        cycle.path.length > 2 ? ` (wait path: ${cycle.path.join(" → ")})` : ""
      }.`,
      cycle,
    );
  }

  private requireOwnOp(caller: MailboxPrincipalRef, messageId: number): MailboxOpRow {
    const row = this.store.get(messageId);
    if (!row || row.workspaceId !== caller.workspaceId) {
      // Cross-workspace reads are indistinguishable from missing ids (§9.2).
      throw new MailboxError(
        "message_not_found",
        `No message ${formatMessageId(messageId)} exists in this workspace.`,
      );
    }
    if (row.senderPrincipalId !== caller.id) {
      throw new MailboxError(
        "not_sender",
        `Message ${formatMessageId(messageId)} was sent by another principal; only its sender can operate on it.`,
      );
    }
    return row;
  }

  private isUnsettled(row: MailboxOpRow): boolean {
    return row.status === "queued" || row.status === "delivering";
  }

  private ensureRuntime(opId: number): OpRuntime {
    let rt = this.runtime.get(opId);
    if (!rt) {
      rt = { recipientHeld: false, senderHeld: false, timer: null, edgeWaiter: null, waiters: new Set() };
      this.runtime.set(opId, rt);
    }
    return rt;
  }

  private async takeHolds(row: MailboxOpRow, rt: OpRuntime): Promise<void> {
    if (!rt.recipientHeld) {
      try {
        await this.hub.acquire(row.recipientSessionId);
        rt.recipientHeld = true;
      } catch {
        // Recipient no longer addressable (killed while we were down): the
        // delivery attempt will settle the op as failed.
      }
    }
    await this.takeSenderHold(row, rt);
  }

  /**
   * §6.3: the sender side of retain-while-pending. Best-effort — a pane
   * principal's id is a PTY session with nothing messageable to pin, and
   * that is fine: the daemon pins PTY sessions through their pane already.
   */
  private async takeSenderHold(row: MailboxOpRow, rt: OpRuntime): Promise<void> {
    if (rt.senderHeld || row.senderPrincipalKind !== "session") return;
    try {
      await this.hub.acquire(row.senderPrincipalId);
      rt.senderHeld = true;
    } catch {
      // Not a messageable session — no hold to take.
    }
  }

  private async releaseHolds(opId: number, rt: OpRuntime): Promise<void> {
    const row = this.store.get(opId);
    if (rt.recipientHeld && row) {
      rt.recipientHeld = false;
      await this.hub.release(row.recipientSessionId).catch(() => {});
    }
    if (rt.senderHeld && row) {
      rt.senderHeld = false;
      await this.hub.release(row.senderPrincipalId).catch(() => {});
    }
  }

  private armExpiry(opId: number, expiresAt: number): void {
    const rt = this.ensureRuntime(opId);
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = setTimeout(() => {
      void this.expire(opId);
    }, Math.max(0, expiresAt - this.now()));
    // Never keep the process alive for an expiry timer.
    rt.timer.unref?.();
  }

  private async expire(opId: number): Promise<void> {
    const row = this.store.get(opId);
    if (!row || !this.isUnsettled(row)) return;
    if (row.status === "queued") {
      this.dequeueDelivery(row.recipientSessionId, row.id);
    }
    this.store.update(opId, { status: "expired", resolvedAt: this.now() });
    await this.settleCleanup(opId);
    // A wake-on waiter learns about the expiry through a wake turn — an
    // explicit expiry status, not silence (§5.1).
    const latest = this.store.get(opId);
    if (latest && latest.deliveryMode === "wake-on" && !latest.wakeDelivered) {
      this.enqueueWake(latest);
      void this.flushWakes(latest.senderPrincipalId);
    }
  }

  /** Common teardown once a row left the unsettled states. */
  private async settleCleanup(opId: number): Promise<void> {
    const rt = this.runtime.get(opId);
    if (!rt) return;
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = null;
    }
    if (rt.edgeWaiter !== null) {
      this.graph.removeEdge(rt.edgeWaiter, opId);
      rt.edgeWaiter = null;
    }
    await this.releaseHolds(opId, rt);
    for (const wake of [...rt.waiters]) wake();
    rt.waiters.clear();
    this.runtime.delete(opId);
  }

  private waitForSettle(opId: number, waitMs: number): Promise<boolean> {
    const row = this.store.get(opId);
    if (!row || !this.isUnsettled(row)) return Promise.resolve(true);
    const rt = this.ensureRuntime(opId);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        rt.waiters.delete(onSettle);
        resolve(false);
      }, waitMs);
      timer.unref?.();
      const onSettle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      rt.waiters.add(onSettle);
    });
  }

  // ---- delivery (§5.3: queue-for-next-turn; §5.4: one delivery rule) ------

  private enqueueDelivery(recipient: string, opId: number): void {
    const queue = this.queues.get(recipient) ?? [];
    if (!queue.includes(opId)) queue.push(opId);
    this.queues.set(recipient, queue);
  }

  private dequeueDelivery(recipient: string, opId: number): void {
    const queue = this.queues.get(recipient);
    if (!queue) return;
    const idx = queue.indexOf(opId);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) {
      this.queues.delete(recipient);
      // Cancel/expiry can drain a queue with no flush ever seeing it empty —
      // drop the flush subscription (and its hold) here too, or a later
      // handle would be blocked from re-subscribing by the stale entry.
      this.dropRecipientSub(recipient);
    }
  }

  private async flushDeliveries(recipient: string): Promise<void> {
    if (this.deliveryInFlight.has(recipient)) return;
    const queue = this.queues.get(recipient);
    if (!queue || queue.length === 0) {
      this.dropRecipientSub(recipient);
      return;
    }

    let session: MessageableSession;
    try {
      session = await this.hub.acquire(recipient);
    } catch (err) {
      // Recipient gone: settle everything queued for it as failed.
      const failed: SessionReply = {
        status: "failed",
        text: "",
        error: {
          code: "recipient_unavailable",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      const ids = [...queue];
      this.queues.delete(recipient);
      for (const id of ids) {
        const row = this.store.get(id);
        if (row && this.isUnsettled(row)) await this.resolveOp(row, failed);
      }
      return;
    }

    try {
      if (session.busy) {
        // Queue-for-next-turn: flush when the recipient settles.
        await this.ensureRecipientSub(recipient);
        return;
      }

      // Coalesce everything queued right now into one delivery turn (§5.4).
      const ids = [...queue];
      this.queues.delete(recipient);
      const batch = ids
        .map((id) => this.store.get(id))
        .filter((row): row is MailboxOpRow => row !== null && this.isUnsettled(row));
      if (batch.length === 0) return;

      this.deliveryInFlight.add(recipient);
      const deliveredAt = this.now();
      for (const row of batch) {
        this.store.update(row.id, { status: "delivering", deliveredAt });
      }
      // Timebox the delivery turn to just past the batch's expiry ceiling: a
      // hung agent that never settles its turn must not pin the flush hold
      // and wedge this recipient's queue forever. By the deadline every op
      // in the batch has been expired by its own timer, so a late settle
      // finds nothing left to resolve.
      const deadline = Math.max(...batch.map((row) => row.expiresAt)) + 30_000;
      const reply = await withDeadline(
        session.send(composeDeliveryText(batch)),
        Math.max(1_000, deadline - this.now()),
      );
      this.deliveryInFlight.delete(recipient);
      if (reply !== null) {
        for (const row of batch) {
          const latest = this.store.get(row.id);
          if (latest && this.isUnsettled(latest)) await this.resolveOp(latest, reply);
        }
      }
    } finally {
      this.deliveryInFlight.delete(recipient);
      await this.hub.release(recipient).catch(() => {});
    }

    // Messages queued while the turn ran.
    void this.flushDeliveries(recipient);
  }

  /** Subscribe to the recipient's turn ends, owning a hub hold (see field). */
  private async ensureRecipientSub(recipient: string): Promise<void> {
    if (this.recipientSubs.has(recipient)) return;
    let session: MessageableSession;
    try {
      session = await this.hub.acquire(recipient);
    } catch {
      return; // Recipient gone; the next flush settles the queue as failed.
    }
    if (this.recipientSubs.has(recipient)) {
      await this.hub.release(recipient).catch(() => {});
      return;
    }
    const unsub = session.onTurnEnded(() => {
      void this.flushDeliveries(recipient);
    });
    this.recipientSubs.set(recipient, () => {
      unsub();
      void this.hub.release(recipient).then(undefined, () => {});
    });
    // The queue may have drained (cancel/expiry) while we were acquiring —
    // nothing left to flush means nothing to subscribe for.
    if (!this.queues.has(recipient)) this.dropRecipientSub(recipient);
  }

  private dropRecipientSub(recipient: string): void {
    const drop = this.recipientSubs.get(recipient);
    if (drop) {
      this.recipientSubs.delete(recipient);
      drop();
    }
  }

  private async resolveOp(row: MailboxOpRow, reply: SessionReply): Promise<void> {
    this.store.update(row.id, {
      status: "resolved",
      replyStatus: reply.status,
      replyText: reply.text,
      replyErrorCode: reply.error?.code ?? null,
      replyErrorMessage: reply.error?.message ?? null,
      replyTruncated: reply.truncated === true,
      resolvedAt: this.now(),
    });
    await this.settleCleanup(row.id);
    const latest = this.store.get(row.id);
    if (latest && latest.deliveryMode === "wake-on" && !latest.wakeDelivered) {
      this.enqueueWake(latest);
      void this.flushWakes(latest.senderPrincipalId);
    }
  }

  // ---- wake-on delivery (§5.4: wake-if-idle, queue-if-busy, coalesced) ----

  private enqueueWake(row: MailboxOpRow): void {
    const queue = this.wakeQueues.get(row.senderPrincipalId) ?? [];
    if (!queue.includes(row.id)) queue.push(row.id);
    this.wakeQueues.set(row.senderPrincipalId, queue);
  }

  /** Give up on a wake: the durable rows still answer `agent await`. */
  private abandonWakes(waiter: string, ids: number[]): void {
    this.wakeQueues.delete(waiter);
    for (const id of ids) {
      this.store.update(id, { wakeDelivered: true });
      this.wakeAttempts.delete(id);
    }
  }

  private async flushWakes(waiter: string): Promise<void> {
    if (this.wakeInFlight.has(waiter)) return;
    const queue = this.wakeQueues.get(waiter);
    if (!queue || queue.length === 0) {
      this.dropWakeSub(waiter);
      return;
    }

    let session: MessageableSession;
    try {
      session = await this.hub.acquire(waiter);
    } catch (err) {
      // Permanently unaddressable (killed, PTY, unknown): abandon. A
      // transient failure (daemon reconnecting) retries with backoff.
      if (err instanceof SessionAddressError) {
        this.abandonWakes(waiter, [...queue]);
      } else {
        this.retryWakesLater(waiter, [...queue]);
      }
      return;
    }

    let delivered = false;
    let batch: MailboxOpRow[] = [];
    try {
      if (session.busy) {
        // Coalesce: everything resolved while the waiter is busy arrives
        // together in the next wake turn.
        await this.ensureWakeSub(waiter);
        return;
      }
      const ids = [...queue];
      this.wakeQueues.delete(waiter);
      batch = ids
        .map((id) => this.store.get(id))
        .filter((row): row is MailboxOpRow => row !== null && !row.wakeDelivered);
      if (batch.length === 0) return;
      this.wakeInFlight.add(waiter);
      // The wake turn's own reply is not a mailbox operation. Delivery is
      // recorded only once the turn actually ran — a wake lost to a daemon
      // blip must stay owed (startup recovery reads wake_delivered). The
      // deadline keeps a hung waiter from pinning the flush hold forever; a
      // timed-out wake counts as failed and goes through the bounded retry.
      const reply = await withDeadline(session.send(composeWakeText(batch)), WAKE_TURN_DEADLINE_MS);
      delivered = reply !== null && reply.status !== "failed";
    } finally {
      this.wakeInFlight.delete(waiter);
      await this.hub.release(waiter).catch(() => {});
    }

    if (delivered) {
      for (const row of batch) {
        this.store.update(row.id, { wakeDelivered: true });
        this.wakeAttempts.delete(row.id);
      }
    } else if (batch.length > 0) {
      this.retryWakesLater(waiter, batch.map((row) => row.id));
    }

    void this.flushWakes(waiter);
  }

  /** Bounded retry for wakes that failed transiently (3 attempts, 15s apart). */
  private retryWakesLater(waiter: string, ids: number[]): void {
    const retryable: number[] = [];
    const abandoned: number[] = [];
    for (const id of ids) {
      const attempts = (this.wakeAttempts.get(id) ?? 0) + 1;
      this.wakeAttempts.set(id, attempts);
      (attempts >= 3 ? abandoned : retryable).push(id);
    }
    if (abandoned.length > 0) {
      for (const id of abandoned) {
        this.store.update(id, { wakeDelivered: true });
        this.wakeAttempts.delete(id);
      }
    }
    const queue = this.wakeQueues.get(waiter) ?? [];
    for (const id of retryable) if (!queue.includes(id)) queue.push(id);
    if (queue.length === 0) {
      this.wakeQueues.delete(waiter);
      return;
    }
    this.wakeQueues.set(waiter, queue);
    const timer = setTimeout(() => {
      void this.flushWakes(waiter);
    }, 15_000);
    timer.unref?.();
  }

  /** Subscribe to the waiter's turn ends, owning a hub hold (see field). */
  private async ensureWakeSub(waiter: string): Promise<void> {
    if (this.wakeSubs.has(waiter)) return;
    let session: MessageableSession;
    try {
      session = await this.hub.acquire(waiter);
    } catch {
      return; // Next enqueue/flush handles the failure path.
    }
    if (this.wakeSubs.has(waiter)) {
      await this.hub.release(waiter).catch(() => {});
      return;
    }
    const unsub = session.onTurnEnded(() => {
      // Drop first: flushWakes re-subscribes if the waiter is still busy.
      this.dropWakeSub(waiter);
      void this.flushWakes(waiter);
    });
    this.wakeSubs.set(waiter, () => {
      unsub();
      void this.hub.release(waiter).then(undefined, () => {});
    });
    if (!this.wakeQueues.has(waiter)) this.dropWakeSub(waiter);
  }

  private dropWakeSub(waiter: string): void {
    const drop = this.wakeSubs.get(waiter);
    if (drop) {
      this.wakeSubs.delete(waiter);
      drop();
    }
  }

  // ---- views ---------------------------------------------------------------

  /**
   * Why an unsettled operation is stalled right now (GH-129) — read off the
   * live recipient handle, never stored: this is a diagnosis of the present
   * moment, and it disappears with the condition. Purely observational; no
   * delivery, expiry, or coalescing decision consults it.
   *
   * - `delivering` + the recipient's turn blocked on an unresolved
   *   permission prompt → `waiting_on_permission` (the op's own turn is the
   *   one waiting on the operator).
   * - `queued` + the recipient mid-turn → `recipient_busy` (delivery is
   *   deferred to the next turn, not lost) — even when that earlier turn is
   *   itself permission-blocked: the permission belongs to the op whose
   *   turn it is.
   */
  private blockedReason(row: MailboxOpRow): MailboxBlockedReason | null {
    if (!this.isUnsettled(row)) return null;
    const session = this.hub.peek?.(row.recipientSessionId);
    if (!session) return null;
    if (row.status === "delivering") {
      return (session as BlockedStateProbe).blockedOnPermission === true
        ? "waiting_on_permission"
        : null;
    }
    return session.busy ? "recipient_busy" : null;
  }

  private view(row: MailboxOpRow): MailboxOperationView {
    const blocked = this.blockedReason(row);
    return {
      ...(blocked !== null ? { blocked } : {}),
      messageId: formatMessageId(row.id),
      workspaceId: row.workspaceId,
      senderPrincipalId: row.senderPrincipalId,
      senderPrincipalKind: row.senderPrincipalKind,
      recipientSessionId: row.recipientSessionId,
      deliveryMode: row.deliveryMode,
      status: row.status,
      correlationId: row.correlationId,
      wakeDelivered: row.wakeDelivered,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt,
      resolvedAt: row.resolvedAt,
      expiresAt: row.expiresAt,
      replyStatus: row.replyStatus,
      replyText: row.replyText,
      replyErrorCode: row.replyErrorCode,
      replyErrorMessage: row.replyErrorMessage,
      replyTruncated: row.replyTruncated,
      bodyPreview:
        row.body.length > MAILBOX_BODY_PREVIEW_CHARS
          ? `${row.body.slice(0, MAILBOX_BODY_PREVIEW_CHARS)}…`
          : row.body,
    };
  }
}
