/**
 * Localhost HTTP + WebSocket (design/agile-agents-design.md §18 "Technical
 * shape": "HTTP + WebSocket on localhost for UI/CLI"; T004 acceptance:
 * `GET /health` returns daemon version and state root).
 *
 * v0: `/health` only, plus a WebSocket endpoint that accepts connections and
 * sends a hello frame — later tickets make it tail the event log.
 */

export interface HealthPayload {
  version: string;
  stateRoot: string;
  pid: number;
  uptime: number;
}

export interface HttpServerOptions {
  port: number;
  hostname?: string;
  version: string;
  stateRoot: string;
  startedAt: number;
}

export interface HttpServerHandle {
  port: number;
  hostname: string;
  stop(): Promise<void>;
}

interface WsHelloFrame {
  type: 'hello';
  version: string;
  stateRoot: string;
}

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
  const hostname = options.hostname ?? '127.0.0.1';

  const server = Bun.serve({
    port: options.port,
    hostname,
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === '/health') {
        const payload: HealthPayload = {
          version: options.version,
          stateRoot: options.stateRoot,
          pid: process.pid,
          uptime: (Date.now() - options.startedAt) / 1000,
        };
        return Response.json(payload);
      }

      if (url.pathname === '/ws') {
        if (srv.upgrade(req)) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        const hello: WsHelloFrame = {
          type: 'hello',
          version: options.version,
          stateRoot: options.stateRoot,
        };
        ws.send(JSON.stringify(hello));
      },
      message() {
        // v0: no client -> server protocol yet (tail-only). Ignore inbound.
      },
    },
  });

  return {
    port: server.port ?? options.port,
    hostname,
    async stop() {
      server.stop(true);
    },
  };
}
