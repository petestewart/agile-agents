/**
 * Wait-for graph with cycle rejection (specs/agent-control-channel.md §9.3).
 *
 * A blocking wait (`await` / `ask`) adds a directed edge waiter → holder.
 * The edge that would close a cycle is rejected immediately, naming both
 * parties — failing fast beats letting the timeout ceiling turn a diagnosable
 * bug into a mysterious multi-minute stall. Non-blocking modes (`send`,
 * `wake-on`) never add edges: the caller's turn ends, so no deadlock is
 * possible through them.
 *
 * The graph is **in-memory, rebuilt from the operations table on startup**
 * (§9.3): the algorithm is pure and unit-testable under plain `bun run test`,
 * while durability lives in the table it is rebuilt from. Edges are keyed by
 * operation id so one resolve removes exactly its own edge, and parallel
 * waits between the same pair coexist without refcount bugs.
 */

export interface WaitCycle {
  /** The waiter of the rejected edge. */
  waiter: string;
  /** The holder of the rejected edge. */
  holder: string;
  /**
   * The full wait path that would close the cycle, starting at `holder` and
   * ending back at `waiter` — `[holder, ..., waiter]`.
   */
  path: string[];
}

export class WaitGraph {
  /** waiter → (opId → holder) */
  private edges = new Map<string, Map<number, string>>();

  /**
   * Would adding `waiter → holder` close a cycle? Pure check, no mutation —
   * used to pre-validate before an operation row is inserted.
   */
  wouldCycle(waiter: string, holder: string): WaitCycle | null {
    const path = this.findPath(holder, waiter);
    return path !== null ? { waiter, holder, path } : null;
  }

  /**
   * Try to add the edge `waiter → holder` for operation `opId`.
   * Returns null on success, or the cycle (with the edge NOT added) when the
   * edge would close one. A self-wait is a cycle of length one.
   */
  tryAddEdge(waiter: string, holder: string, opId: number): WaitCycle | null {
    const path = this.findPath(holder, waiter);
    if (path !== null) {
      return { waiter, holder, path };
    }
    let out = this.edges.get(waiter);
    if (!out) {
      out = new Map();
      this.edges.set(waiter, out);
    }
    out.set(opId, holder);
    return null;
  }

  /** Remove the edge added for `opId` (resolve / cancel / expiry). */
  removeEdge(waiter: string, opId: number): void {
    const out = this.edges.get(waiter);
    if (!out) return;
    out.delete(opId);
    if (out.size === 0) this.edges.delete(waiter);
  }

  /** Every outstanding edge (session monitor v2 wait-edge display). */
  listEdges(): Array<{ waiter: string; holder: string; opId: number }> {
    const all: Array<{ waiter: string; holder: string; opId: number }> = [];
    for (const [waiter, out] of this.edges) {
      for (const [opId, holder] of out) {
        all.push({ waiter, holder, opId });
      }
    }
    return all;
  }

  clear(): void {
    this.edges.clear();
  }

  /**
   * DFS for a wait path `from → ... → to`. Returns the node path (inclusive
   * of both endpoints) or null. `from === to` is the trivial path (self-wait).
   */
  private findPath(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const visited = new Set<string>([from]);
    const stack: Array<{ node: string; path: string[] }> = [
      { node: from, path: [from] },
    ];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      const out = this.edges.get(node);
      if (!out) continue;
      for (const holder of out.values()) {
        if (holder === to) return [...path, holder];
        if (!visited.has(holder)) {
          visited.add(holder);
          stack.push({ node: holder, path: [...path, holder] });
        }
      }
    }
    return null;
  }
}
