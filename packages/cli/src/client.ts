/**
 * Unix-socket JSON-RPC 2.0 client (design/agile-agents-design.md §18
 * "Technical shape": "`agile` CLI: same client lib"; §5/§9 "Comms bus" for
 * the socket wire format). Newline-delimited JSON per `packages/daemon/src/
 * rpc.ts` — one request object per line, one response object per line.
 *
 * Every CLI verb goes through `callRpc`, which opens a short-lived
 * connection, sends one request, waits for the matching response (or a
 * timeout), and closes. No connection pooling: CLI invocations are one-shot
 * processes, so there is nothing to reuse across calls within a single verb,
 * and `tail --follow`/`hook` (the two verbs that need repeat round-trips)
 * open one connection per attempt to stay simple and never leak a socket
 * across a daemon restart.
 */

import { connect } from 'node:net';

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** Thrown by `callRpc` when the daemon replies with a JSON-RPC error object. */
export class RpcCallError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

/** Thrown by `callRpc` on transport failure: no daemon listening, or no reply in time. */
export class RpcConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcConnectionError';
  }
}

/**
 * T523 (CLI audit C5): the daemon took the call and did not answer in time.
 * Still an `RpcConnectionError` for every caller that only needs "no
 * answer" (the hook's fail-open/closed, `status`), but `agile status` tells
 * it apart from no daemon at all: a busy daemon is not a dead one.
 */
export class RpcTimeoutError extends RpcConnectionError {
  constructor(
    message: string,
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'RpcTimeoutError';
  }
}

/** How long a verb waits for the daemon by default: a read or a store write is far quicker. */
export const DEFAULT_RPC_TIMEOUT_MS = 5000;

/**
 * T523 (CLI audit C1): how long a verb waits when the daemon's work can run
 * long, as T155 did for `knowledge test`. `deliver`/`land` (and an approval
 * that lands) runs ship checks through the classifier (each up to 25 s),
 * `git push` with the repo's own pre-push hooks, the GitHub API and settle;
 * starting an agent (`attach`, `review`, `resolve`, `node new`, `node
 * add-repo`, a `node say` that restarts one) cuts a worktree, asks Jev for
 * the model (25 s) and opens the vendor (its ACP initialize alone may take
 * 120 s); `node link`/`import-children` wait on the tracker's API; `policy
 * try` on Jev. Past 5 s the CLI used to exit 1 "timed out" while the daemon
 * went on and merged.
 */
export const LONG_RPC_TIMEOUT_MS = 10 * 60 * 1000;

/** T523: where a long verb on a node says to look once it stopped waiting. */
export function nodeCheck(id: string): string {
  return `\`agile node show ${id}\` (or \`agile tail --stream ${id}\`)`;
}

/** `800 ms`, `5 s`, `10 min`: a wait in words. */
export function formatWait(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export interface CallRpcOptions {
  /** Milliseconds to wait for a connection + response before failing. Default `DEFAULT_RPC_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * T523: for a verb whose daemon work goes on after the CLI stops waiting,
   * where to look to see whether it finished (`agile node show <id>`). A
   * timeout then says the daemon may still finish it and names this, rather
   * than only "timed out", so nobody retries a merge that went through.
   */
  check?: string;
}

let nextId = 1;

/**
 * Sends one JSON-RPC 2.0 request over `socketPath` and resolves with the
 * `result` field, or rejects with `RpcCallError` (daemon-reported error) or
 * `RpcConnectionError` (couldn't connect / no reply in time).
 */
export function callRpc<T = unknown>(
  socketPath: string,
  method: string,
  params?: unknown,
  options: CallRpcOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const id = nextId++;

  return new Promise<T>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      const message =
        options.check === undefined
          ? `timed out after ${timeoutMs}ms waiting for ${method}`
          : `agiled did not answer ${method} within ${formatWait(timeoutMs)}; it may still finish the work. Check with ${options.check} before trying again`;
      finish(() => reject(new RpcTimeoutError(message, method, timeoutMs)));
    }, timeoutMs);

    socket.on('error', (err) => {
      finish(() =>
        reject(new RpcConnectionError(`could not reach daemon at ${socketPath}: ${err.message}`)),
      );
    });

    // Review fix (independent review, "client.ts" item 4): without this, a
    // daemon that accepts the connection and then closes it without ever
    // writing a reply (crash mid-request, graceful shutdown racing a
    // client) left `finish` waiting on the full `timeoutMs` even though the
    // socket had already told us no response is coming. `'close'` fires
    // after `'end'`/`'error'` either way, so this only ever does anything
    // when nothing else already settled the promise — a clean response
    // (which calls `socket.destroy()` in `finish`) or a transport error
    // both mark `settled` first.
    socket.on('close', () => {
      finish(() =>
        reject(
          new RpcConnectionError(
            `daemon closed the connection at ${socketPath} before replying to ${method}`,
          ),
        ),
      );
    });

    socket.on('connect', () => {
      const request = { jsonrpc: '2.0' as const, id, method, params };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;

        let parsed: { id?: unknown; result?: unknown; error?: RpcErrorBody };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id !== id) continue; // not our response; ignore (shouldn't happen on a fresh connection)

        finish(() => {
          if (parsed.error) {
            reject(new RpcCallError(parsed.error.code, parsed.error.message, parsed.error.data));
          } else {
            resolve(parsed.result as T);
          }
        });
        return;
      }
    });
  });
}
