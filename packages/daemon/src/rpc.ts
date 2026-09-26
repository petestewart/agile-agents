/**
 * JSON-RPC 2.0 over the unix socket, newline-delimited (one object per
 * line). `daemon.ping` and `daemon.status` are built in; everything else
 * arrives as `extraMethods`. An unknown method in the `bus`, `state`,
 * `hook` or `gate` namespace gets a structured "not implemented" error.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import type { ClassifierKeyStatus, TrackerStatus } from '@agile-agents/shared';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

// -32001 is in the implementation-defined server-error range.
const NOT_IMPLEMENTED_CODE = -32001;
const METHOD_NOT_FOUND_CODE = -32601;
const PARSE_ERROR_CODE = -32700;
const INVALID_REQUEST_CODE = -32600;
const INTERNAL_ERROR_CODE = -32603;

const STUB_NAMESPACES = ['bus', 'state', 'hook', 'gate'] as const;

export type RpcMethodHandler = (params: unknown) => unknown | Promise<unknown>;

export interface DaemonStatus {
  version: string;
  stateRoot: string;
  pid: number;
  uptime: number;
  /** Where the classifier key comes from and whether it is loaded; never the key. */
  classifier?: ClassifierKeyStatus;
  /** T221: whether `gh auth token` yields a token; never the token. */
  github?: { auth: 'available' | 'unavailable' };
  /** T320 (D31): each tracker configured or not; never a token. */
  trackers?: TrackerStatus;
}

export interface RpcServerOptions {
  socketPath: string;
  version: string;
  stateRoot: string;
  startedAt: number;
  /** Method handlers beyond daemon.ping/daemon.status. */
  extraMethods?: Record<string, RpcMethodHandler>;
  /** Reported under `classifier` by `daemon.status`. */
  classifierStatus?: () => ClassifierKeyStatus;
  /** Reported under `github` by `daemon.status`. */
  githubAuth?: () => Promise<boolean>;
  /** Reported under `trackers` by `daemon.status`. */
  trackerStatus?: () => TrackerStatus;
}

function namespaceOf(method: string): string | undefined {
  const dot = method.indexOf('.');
  return dot === -1 ? undefined : method.slice(0, dot);
}

export function buildMethods(options: RpcServerOptions): Record<string, RpcMethodHandler> {
  return {
    'daemon.ping': () => 'pong',
    'daemon.status': async (): Promise<DaemonStatus> => ({
      version: options.version,
      stateRoot: options.stateRoot,
      pid: process.pid,
      uptime: (Date.now() - options.startedAt) / 1000,
      ...(options.classifierStatus ? { classifier: options.classifierStatus() } : {}),
      ...(options.githubAuth
        ? { github: { auth: (await options.githubAuth()) ? 'available' : 'unavailable' } }
        : {}),
      ...(options.trackerStatus ? { trackers: options.trackerStatus() } : {}),
    }),
    ...options.extraMethods,
  };
}

/** `undefined` means send no response: a notification (no `id` member; `null` is a real id) gets none. */
export async function dispatch(
  methods: Record<string, RpcMethodHandler>,
  request: unknown,
): Promise<JsonRpcResponse | undefined> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: INVALID_REQUEST_CODE, message: 'invalid JSON-RPC 2.0 request' },
    };
  }

  const req = request as JsonRpcRequest;
  const isNotification = !('id' in req);
  const id = req.id ?? null;
  const reply = (response: JsonRpcResponse): JsonRpcResponse | undefined =>
    isNotification ? undefined : response;

  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return reply({
      jsonrpc: '2.0',
      id,
      error: { code: INVALID_REQUEST_CODE, message: 'invalid JSON-RPC 2.0 request' },
    });
  }

  const handler = methods[req.method];
  if (handler) {
    try {
      const result = await handler(req.params);
      return reply({ jsonrpc: '2.0', id, result });
    } catch (err) {
      // A structured error carries its own code (e.g. -32602); anything else is internal.
      const structured =
        err instanceof Error && typeof (err as { code?: unknown }).code === 'number'
          ? (err as Error & { code: number; data?: unknown })
          : undefined;
      return reply({
        jsonrpc: '2.0',
        id,
        error: {
          code: structured ? structured.code : INTERNAL_ERROR_CODE,
          message: err instanceof Error ? err.message : String(err),
          ...(structured?.data !== undefined ? { data: structured.data } : {}),
        },
      });
    }
  }

  const ns = namespaceOf(req.method);
  if (ns && (STUB_NAMESPACES as readonly string[]).includes(ns)) {
    return reply({
      jsonrpc: '2.0',
      id,
      error: {
        code: NOT_IMPLEMENTED_CODE,
        message: `${req.method} is not implemented yet (${ns}.* is a T004 stub namespace)`,
        data: { namespace: ns },
      },
    });
  }

  return reply({
    jsonrpc: '2.0',
    id,
    error: { code: METHOD_NOT_FOUND_CODE, message: `unknown method: ${req.method}` },
  });
}

export interface RpcServerHandle {
  socketPath: string;
  /**
   * Resolves once the socket is bound: `listen()` is async, and a client
   * spawned right after `startRpcServer` returns once got `ENOENT`.
   */
  listening: Promise<void>;
  close(): Promise<void>;
}

/** Handles one connection: newline-delimited JSON in, newline-delimited JSON out. */
function handleConnection(socket: Socket, methods: Record<string, RpcMethodHandler>): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {
    // Abrupt disconnects surface here; the socket is going away anyway.
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;

      void (async () => {
        let response: JsonRpcResponse | undefined;
        try {
          const parsed: unknown = JSON.parse(line);
          response = await dispatch(methods, parsed);
        } catch {
          response = {
            jsonrpc: '2.0',
            id: null,
            error: { code: PARSE_ERROR_CODE, message: 'invalid JSON' },
          };
        }
        if (response) socket.write(`${JSON.stringify(response)}\n`);
      })();
    }
  });
}

export function startRpcServer(options: RpcServerOptions): RpcServerHandle {
  // A stale socket from an unclean shutdown blocks bind. The lock (taken
  // first) is the single-instance guard, so clearing it is safe.
  if (existsSync(options.socketPath)) {
    unlinkSync(options.socketPath);
  }

  const methods = buildMethods(options);
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, methods);
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  listening.catch(() => {});
  server.listen(options.socketPath);

  return {
    socketPath: options.socketPath,
    listening,
    close(): Promise<void> {
      return new Promise((resolve) => {
        // `server.close()` waits for open connections, and hook clients
        // would hang shutdown forever: destroy them first.
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          if (existsSync(options.socketPath)) {
            unlinkSync(options.socketPath);
          }
          resolve();
        });
      });
    },
  };
}
