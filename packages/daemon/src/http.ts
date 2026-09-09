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

import { join } from 'node:path';
import {
  HaltIdSchema,
  type HilDecision,
  HilIdSchema,
  KbIdSchema,
  OracleIdSchema,
  TicketIdSchema,
  ulid,
} from '@agile-agents/shared';
import { CONTROL_ROOM_DIST_DIR, FEED_HTML_PATH } from '@agile-agents/ui';
import type { Bus } from './bus';
import { type EventTailerHandle, buildSnapshot, startEventTailer } from './feed';
import { GateAlreadyResolvedError, GateNotFoundError, type GateService } from './gates';
import { createHalt, releaseHalt } from './halts';
import type { QuotaService } from './quota/records';
import { NotFoundError } from './store';
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
  /** T023: live quota/barometer data for the feed header; optional (empty `quota` array without it). */
  quota?: QuotaService;
  /**
   * T025: lets the control room's chat/propose-edit POSTs land on the bus
   * (`bus.send`) so every write still goes through the same path an agent's
   * RPC call would and appears in the event log. Optional — without it
   * those two routes 503 rather than silently no-op; see
   * `.pipeline-report.md` for the one-line `daemon.ts` wiring this needs.
   */
  bus?: Bus;
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
      // T032: the actor is always `human` for a browser write, never taken
      // from the request body (a page could otherwise forge another actor) —
      // same hardcode `raised_by`/`from` already use on the halt/chat/propose
      // routes below.
      const updated = await gates.respond(parsedId.data, decision, 'human');
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
  quota?: QuotaService;
  bus?: Bus;
}

function resolveFeedContext(options: HttpServerOptions): FeedContext | undefined {
  if (!options.store || !options.gates) return undefined;
  return { store: options.store, gates: options.gates, quota: options.quota, bus: options.bus };
}

/** `/api/tickets/<id>` — control room (T025) ticket detail (ticket + its board stanzas). */
function matchTicketId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/tickets\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** `/api/oracle/<id>` — control room (T025) Oracle entry (decision or spec). */
function matchOracleId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/oracle\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** `/api/kb/<id>` — control room (T025) knowledge-store fact. */
function matchKbId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/kb\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** `/api/halt/<id>` — control room (T025) halt release (DELETE). */
function matchHaltId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/halt\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
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

      /**
       * Control room SPA (T025 — §17 "Control room", §18 "UI: React + Vite
       * SPA ... serves the built UI as static files"). `/` and `/feed` stay
       * the T020 static page above; the React app lives at its own prefix
       * (`vite.config.ts`'s `base: '/control-room/'`) so both v0 UIs can be
       * served side by side.
       */
      if (url.pathname === '/control-room' || url.pathname === '/control-room/') {
        return new Response(Bun.file(join(CONTROL_ROOM_DIST_DIR, 'index.html')), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname.startsWith('/control-room/')) {
        const rel = url.pathname.slice('/control-room/'.length);
        const file = Bun.file(join(CONTROL_ROOM_DIST_DIR, rel));
        if (await file.exists()) return new Response(file);
        return new Response('not found', { status: 404 });
      }

      if (url.pathname === '/api/snapshot') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(buildSnapshot(feed.store, feed.gates, undefined, feed.quota));
      }

      // ---- control room (T025) reads — every one backed by an existing
      // `StateStore` getter, nothing new written to disk from a GET. ----

      if (url.pathname === '/api/agents' && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(feed.store.listAgents());
      }

      if (url.pathname === '/api/tickets' && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(feed.store.listTickets());
      }

      if (url.pathname === '/api/policy' && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(feed.store.getPolicy());
      }

      const ticketMatch = matchTicketId(url.pathname);
      if (ticketMatch && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        const parsedId = TicketIdSchema.safeParse(ticketMatch);
        if (!parsedId.success) return errorResponse(400, `invalid ticket id: ${ticketMatch}`);
        try {
          const ticket = feed.store.getTicket(parsedId.data);
          const stanzas = feed.store.listStanzas(parsedId.data);
          return jsonResponse({ ticket, stanzas });
        } catch (err) {
          if (err instanceof NotFoundError) return errorResponse(404, err.message);
          throw err;
        }
      }

      if (url.pathname === '/api/oracle' && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(feed.store.listOracleIndex());
      }

      const oracleMatch = matchOracleId(url.pathname);
      if (oracleMatch && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        const parsedId = OracleIdSchema.safeParse(oracleMatch);
        if (!parsedId.success) return errorResponse(400, `invalid oracle id: ${oracleMatch}`);
        try {
          return jsonResponse(feed.store.getOracleEntry(parsedId.data));
        } catch (err) {
          if (err instanceof NotFoundError) return errorResponse(404, err.message);
          throw err;
        }
      }

      if (url.pathname === '/api/kb' && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        return jsonResponse(feed.store.listKbIndex());
      }

      const kbMatch = matchKbId(url.pathname);
      if (kbMatch && req.method === 'GET') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        const parsedId = KbIdSchema.safeParse(kbMatch);
        if (!parsedId.success) return errorResponse(400, `invalid kb id: ${kbMatch}`);
        try {
          return jsonResponse(feed.store.getKbFact(parsedId.data));
        } catch (err) {
          if (err instanceof NotFoundError) return errorResponse(404, err.message);
          throw err;
        }
      }

      // ---- control room (T025) writes — every one an existing daemon verb
      // (`createHalt`/`releaseHalt`, `Bus.send`), so it lands on the bus/event
      // log exactly like an agent-driven call (ticket AC). ----

      if (url.pathname === '/api/halt' && req.method === 'POST') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        if (!isSameOriginRequest(req, srv.port ?? options.port)) {
          return errorResponse(403, 'cross-origin request rejected');
        }
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
        const reason =
          typeof body.reason === 'string' && body.reason.length > 0
            ? body.reason
            : 'raised from the control room';
        // T025 review round 1 (blocker 2): `raised_by` is the audit answer
        // to "who stopped the factory" (§5 quorum/standup, the retro) — a
        // browser write's actor is always `human`, never taken from the
        // request body (a page could otherwise forge `architect`). Same
        // hardcode `/api/chat/em`/`/api/oracle/propose` already use for
        // `from`.
        try {
          const halt = await createHalt(feed.store, {
            scope: 'global',
            reason,
            raised_by: 'human',
          });
          return jsonResponse(halt, 201);
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
      }

      const haltMatch = matchHaltId(url.pathname);
      if (haltMatch && req.method === 'DELETE') {
        if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
        if (!isSameOriginRequest(req, srv.port ?? options.port)) {
          return errorResponse(403, 'cross-origin request rejected');
        }
        // T025 review round 1 (blocker 1): validate before it ever reaches
        // `releaseHalt`/`store.abs()` — every sibling route already does
        // this (`TicketIdSchema`/`OracleIdSchema`/`KbIdSchema` above), this
        // one was cast instead of parsed, and a traversal id
        // (`..%2F..%2Fvictim`) reached `store.deleteHalt` unvalidated.
        const parsedHaltId = HaltIdSchema.safeParse(haltMatch);
        if (!parsedHaltId.success) {
          return errorResponse(400, `invalid halt id: ${haltMatch}`);
        }
        try {
          await releaseHalt(feed.store, parsedHaltId.data);
          return jsonResponse({ ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return errorResponse(404, err.message);
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
      }

      /**
       * EM chat send (§17 "EM chat": "steer -> action-set cards", session
       * scope: "via bus.send to em and the feed WebSocket"). A plain
       * free-text turn to the EM's inbox — `fyi` is the one `MessageKind`
       * with no extra required fields, matching a chat line rather than a
       * structured request. Rendering that turn into an actual
       * steer -> action-set card is the EM's own ACP loop, out of this
       * route's scope (documented gap, `.pipeline-report.md`).
       */
      if (url.pathname === '/api/chat/em' && req.method === 'POST') {
        if (!feed?.bus) return errorResponse(503, 'bus not wired to the control room yet');
        if (!isSameOriginRequest(req, srv.port ?? options.port)) {
          return errorResponse(403, 'cross-origin request rejected');
        }
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
        if (typeof body.body !== 'string' || body.body.length === 0) {
          return errorResponse(400, 'body is required');
        }
        try {
          const result = await feed.bus.send({
            id: ulid(),
            ts: new Date().toISOString(),
            from: 'human',
            to: ['em'],
            kind: 'fyi',
            priority: 'normal',
            body: body.body,
            ...(typeof body.ticket === 'string' ? { ticket: body.ticket } : {}),
          });
          if (!result.ok) return errorResponse(400, result.reason);
          return jsonResponse({ ok: true, message: result.message });
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
      }

      /**
       * Oracle/KB "propose edit" (§17 "Oracle / KB viewer": "Human edits are
       * *proposed*, not saved — they become a `decision` request the
       * architect processes through the write guard so graph validation and
       * the ripple walk still run"). Never writes `.agile/oracle` or
       * `.agile/knowledge` directly — only the architect's own
       * `oracleWrite` (T007) does that.
       */
      if (url.pathname === '/api/oracle/propose' && req.method === 'POST') {
        if (!feed?.bus) return errorResponse(503, 'bus not wired to the control room yet');
        if (!isSameOriginRequest(req, srv.port ?? options.port)) {
          return errorResponse(403, 'cross-origin request rejected');
        }
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
        if (typeof body.target !== 'string' || body.target.length === 0) {
          return errorResponse(400, 'target is required');
        }
        if (typeof body.body !== 'string' || body.body.length === 0) {
          return errorResponse(400, 'body is required');
        }
        try {
          const result = await feed.bus.send({
            id: ulid(),
            ts: new Date().toISOString(),
            from: 'human',
            to: ['architect'],
            kind: 'decision',
            priority: 'normal',
            body: `Proposed edit to ${body.target}: ${body.body}`,
            refs: [body.target],
          });
          if (!result.ok) return errorResponse(400, result.reason);
          return jsonResponse({ ok: true, message: result.message });
        } catch (err) {
          return errorResponse(400, err instanceof Error ? err.message : String(err));
        }
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
          ws.send(JSON.stringify(buildSnapshot(feed.store, feed.gates, undefined, feed.quota)));
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
