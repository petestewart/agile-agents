/**
 * JSON-RPC 2.0 over the unix socket (design/agile-agents-design.md §5 "Comms
 * bus": "Clients ... use a unix-socket API: bus.send, bus.poll, ..."; §18
 * "Technical shape": "JSON-RPC over unix socket for hooks/adapters").
 *
 * v0 stubs the `bus.*`, `state.*`, `hook.*`, `gate.*` namespaces with a
 * structured "not implemented" error (later tickets fill these in) and
 * implements two real methods: `daemon.ping` and `daemon.status`.
 *
 * Framing: newline-delimited JSON, one request/response object per line —
 * the simplest thing that works over a raw stream socket without a length
 * prefix or an HTTP-in-front dependency.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';

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

// Reserved range for implementation-defined server errors (JSON-RPC 2.0 spec).
const NOT_IMPLEMENTED_CODE = -32001;
const METHOD_NOT_FOUND_CODE = -32601;
const PARSE_ERROR_CODE = -32700;
const INVALID_REQUEST_CODE = -32600;

const STUB_NAMESPACES = ['bus', 'state', 'hook', 'gate'] as const;

export type RpcMethodHandler = (params: unknown) => unknown | Promise<unknown>;

export interface DaemonStatus {
  version: string;
  stateRoot: string;
  pid: number;
  uptime: number;
}

export interface RpcServerOptions {
  socketPath: string;
  version: string;
  stateRoot: string;
  startedAt: number;
  /** Extra method handlers beyond daemon.ping/daemon.status, for tests. */
  extraMethods?: Record<string, RpcMethodHandler>;
}

function namespaceOf(method: string): string | undefined {
  const dot = method.indexOf('.');
  return dot === -1 ? undefined : method.slice(0, dot);
}

export function buildMethods(options: RpcServerOptions): Record<string, RpcMethodHandler> {
  return {
    'daemon.ping': () => 'pong',
    'daemon.status': (): DaemonStatus => ({
      version: options.version,
      stateRoot: options.stateRoot,
      pid: process.pid,
      uptime: (Date.now() - options.startedAt) / 1000,
    }),
    ...options.extraMethods,
  };
}

export async function dispatch(
  methods: Record<string, RpcMethodHandler>,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;

  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: INVALID_REQUEST_CODE, message: 'invalid JSON-RPC 2.0 request' },
    };
  }

  const handler = methods[request.method];
  if (handler) {
    try {
      const result = await handler(request.params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: NOT_IMPLEMENTED_CODE,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  const ns = namespaceOf(request.method);
  if (ns && (STUB_NAMESPACES as readonly string[]).includes(ns)) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: NOT_IMPLEMENTED_CODE,
        message: `${request.method} is not implemented yet (${ns}.* is a T004 stub namespace)`,
        data: { namespace: ns },
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: METHOD_NOT_FOUND_CODE, message: `unknown method: ${request.method}` },
  };
}

export interface RpcServerHandle {
  socketPath: string;
  close(): Promise<void>;
}

/** Handles one connection: newline-delimited JSON in, newline-delimited JSON out. */
function handleConnection(socket: Socket, methods: Record<string, RpcMethodHandler>): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;

      void (async () => {
        let response: JsonRpcResponse;
        try {
          const parsed = JSON.parse(line) as JsonRpcRequest;
          response = await dispatch(methods, parsed);
        } catch {
          response = {
            jsonrpc: '2.0',
            id: null,
            error: { code: PARSE_ERROR_CODE, message: 'invalid JSON' },
          };
        }
        socket.write(`${JSON.stringify(response)}\n`);
      })();
    }
  });
}

export function startRpcServer(options: RpcServerOptions): RpcServerHandle {
  // A stale socket file from a previous unclean shutdown blocks bind; the
  // lock file is the real single-instance guard (acquired before this is
  // called), so it's safe to clear a leftover socket here.
  if (existsSync(options.socketPath)) {
    unlinkSync(options.socketPath);
  }

  const methods = buildMethods(options);
  const server: Server = createServer((socket) => {
    handleConnection(socket, methods);
  });
  server.listen(options.socketPath);

  return {
    socketPath: options.socketPath,
    close(): Promise<void> {
      return new Promise((resolve) => {
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
