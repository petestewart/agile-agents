/**
 * Localhost HTTP + WebSocket (design/agile-agents-design.md §18 "Technical
 * shape": "HTTP + WebSocket on localhost for UI/CLI"; T004 acceptance:
 * `GET /health` returns daemon version and state root).
 *
 * T020 (§17 "Human UI": "v0 scope: ... CLI + event feed as the only UI"):
 * when a `StateStore` + `GateService` are supplied, this also serves the
 * static feed page (`GET /` and `GET /feed`), its JSON snapshot
 * (`GET /api/snapshot`), the HIL approve/delegate actions the page's buttons
 * call (`POST /api/hil/:id/approve` / `POST /api/hil/:id/delegate` — a
 * present `Origin`/`Sec-Fetch-Site` naming a different origin/site is
 * rejected with 403, see `isSameOriginRequest`), and
 * tails `log/events.jsonl` to broadcast `{type:'event', event}` frames to
 * every `/ws` subscriber after its initial `{type:'hello'}` +
 * `{type:'snapshot', ...}`. Without a store (pre-`agile init`, or a caller
 * that only wants `/health`), the feed routes 503 and `/ws` still sends only
 * the hello frame, matching pre-T020 behaviour.
 */

import { type HilDecision, HilIdSchema } from '@agile-agents/shared';
import { FEED_HTML_PATH } from '@agile-agents/ui';
import { type EventTailerHandle, buildSnapshot, startEventTailer } from './feed';
import { GateAlreadyResolvedError, GateNotFoundError, type GateService } from './gates';
import type { StateStore } from './store';

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
  /** When present (i.e. `.agile/` exists), enables the feed routes and `/ws` live tail. */
  store?: StateStore;
  /** Required alongside `store` to serve the HIL attention-queue snapshot + approve/delegate actions. */
  gates?: GateService;
  /** Test hook: overrides the tailer's poll interval (default 250ms — see `feed/tailer.ts`). */
  feedPollIntervalMs?: number;
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

const FEED_WS_TOPIC = 'feed';

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * Review nit (opus, non-blocking): the HIL POSTs are the human gate, so a
 * page in the user's browser drive-by POSTing an approve at the default
 * daemon port is worth guarding against even though today's exploitability
 * is low (ids are ULIDs, `/api/snapshot` sends no CORS headers). A present
 * `Origin` must match this server's own origin; a present `Sec-Fetch-Site`
 * (most modern browsers, always absent from same-process test/CLI clients)
 * must be `same-origin` or `none`. Both headers are optional on the wire, so
 * their *absence* is not itself rejected — only a value that actively names
 * a different origin/site is.
 */
function isSameOriginRequest(req: Request, port: number): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null) {
    const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (!allowed.has(origin)) return false;
  }
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite !== null && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false;
  }
  return true;
}

/** `/api/hil/<id>/<action>` — `<id>` is everything between the two fixed segments, `<action>` one of approve|delegate. */
function matchHilAction(
  pathname: string,
): { id: string; action: 'approve' | 'delegate' } | undefined {
  const match = pathname.match(/^\/api\/hil\/([^/]+)\/(approve|delegate)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return {
    id: decodeURIComponent(match[1]),
    action: match[2] as 'approve' | 'delegate',
  };
}

async function handleHilAction(
  req: Request,
  gates: GateService,
  id: string,
  action: 'approve' | 'delegate',
): Promise<Response> {
  const parsedId = HilIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, `invalid hil request id: ${id}`);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }

  try {
    if (action === 'approve') {
      const decision: HilDecision = 'approve';
      const by = typeof body.by === 'string' && body.by.length > 0 ? body.by : 'human';
      const updated = await gates.respond(parsedId.data, decision, by);
      return jsonResponse(updated);
    }

    const to = body.to === 'architect' ? 'architect' : 'em';
    const updated = await gates.delegateRequest(parsedId.data, to);
    return jsonResponse(updated);
  } catch (err) {
    if (err instanceof GateNotFoundError) return errorResponse(404, err.message);
    if (err instanceof GateAlreadyResolvedError) return errorResponse(409, err.message);
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
}

/** Bundles `store`+`gates` once both are present, so every call site gets one non-optional pair instead of re-checking two optionals. */
interface FeedContext {
  store: StateStore;
  gates: GateService;
}

function resolveFeedContext(options: HttpServerOptions): FeedContext | undefined {
  if (!options.store || !options.gates) return undefined;
  return { store: options.store, gates: options.gates };
}

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
  const hostname = options.hostname ?? '127.0.0.1';
  const feed = resolveFeedContext(options);

  let tailer: EventTailerHandle | undefined;

  const server = Bun.serve({
    port: options.port,
    hostname,
    async fetch(req, srv) {
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

      if (url.pathname === '/' || url.pathname === '/feed') {
        return new Response(Bun.file(FEED_HTML_PATH), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (url.pathname === '/api/snapshot') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(buildSnapshot(feed.store, feed.gates));
      }

      const hilMatch = matchHilAction(url.pathname);
      if (hilMatch && req.method === 'POST') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        if (!isSameOriginRequest(req, srv.port ?? options.port)) {
          return errorResponse(403, 'cross-origin request rejected');
        }
        return handleHilAction(req, feed.gates, hilMatch.id, hilMatch.action);
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

        if (feed) {
          ws.subscribe(FEED_WS_TOPIC);
          ws.send(JSON.stringify(buildSnapshot(feed.store, feed.gates)));
        }
      },
      message() {
        // v0: no client -> server protocol yet (tail-only). Ignore inbound.
      },
    },
  });

  if (feed) {
    tailer = startEventTailer({
      path: `${options.stateRoot}/log/events.jsonl`,
      pollIntervalMs: options.feedPollIntervalMs,
      onEvents: (newEvents) => {
        for (const event of newEvents) {
          server.publish(FEED_WS_TOPIC, JSON.stringify({ type: 'event', event }));
        }
      },
      onError: (err) => {
        console.error(err.message);
      },
    });
  }

  return {
    port: server.port ?? options.port,
    hostname,
    async stop() {
      tailer?.stop();
      server.stop(true);
    },
  };
}
