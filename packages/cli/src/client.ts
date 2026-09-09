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

export interface CallRpcOptions {
  /** Milliseconds to wait for a connection + response before failing. Default 5000. */
  timeoutMs?: number;
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
  const timeoutMs = options.timeoutMs ?? 5000;
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
      finish(() =>
        reject(new RpcConnectionError(`timed out after ${timeoutMs}ms waiting for ${method}`)),
      );
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
