/**
 * Localhost HTTP + WebSocket (design/agile-agents-design.md §18 "Technical
 * shape": "HTTP + WebSocket on localhost for UI/CLI"; T004 acceptance:
 * `GET /health` returns daemon version and state root).
 *
 * With a `StateStore` + `GateService` supplied this also serves the cockpit
 * bundle and the v0 feed page, their JSON snapshot (`GET /api/snapshot`),
 * the HIL approve/deny/note actions the Needs-you cards call
 * (`POST /api/hil/:id/approve` · `/deny` · `/note` — a present
 * `Origin`/`Sec-Fetch-Site` naming a different origin/site is rejected with
 * 403, see `isSameOriginRequest`), the inbox (`GET /api/inbox`), the
 * questions store (`GET`/`POST /api/questions`, `POST
 * /api/questions/:id/answer`), and tails `log/events.jsonl` to broadcast
 * `{type:'event', event}` frames to every `/ws` subscriber after its initial
 * `{type:'hello'}` + `{type:'snapshot', ...}`. Without a store the feed
 * routes 503 and `/ws` still sends only the hello frame.
 *
 * T122 deleted the ticket/oracle/kb/halt/policy/plan/review/chat and
 * Jira route families along with the subsystems behind them.
 */

import { join } from 'node:path';
import {
  type HilDecision,
  HilIdSchema,
  MESSAGE_BODY_MAX_CHARS,
  type QuestionId,
  QuestionIdSchema,
  RuleIdSchema,
  StreamAttachRequestSchema,
  StreamCreateInputSchema,
  StreamSayInputSchema,
  UlidSchema,
  formatZodError,
  validatePolicy,
} from '@agile-agents/shared';
import { CONTROL_ROOM_DIST_DIR, FEED_HTML_PATH } from '@agile-agents/ui';
import {
  type AttachService,
  StreamBusyError,
  UnknownVendorError,
  UnregisteredRepoError,
} from './attach';
import type { Bus } from './bus';
import type { DocsService } from './docs';
import {
  type EventTailerHandle,
  buildCockpitFrame,
  buildSnapshot,
  buildStreamPage,
  startEventTailer,
} from './feed';
import { GateAlreadyResolvedError, GateNotFoundError, type GateService } from './gates';
import type { InboxService } from './inbox';
import { LandRefusedError, type LandingService } from './landing';
import {
  QuestionAlreadyAnsweredError,
  QuestionNotFoundError,
  type QuestionService,
  parseAnswerParams,
} from './questions';
import { RuleAlreadyDecidedError, type RulesService } from './rules';
import { NotFoundError, type StateStore } from './store';
import type { StreamService } from './streams';

/** T165: the installable-app files served at site root, with their content types. */
const INSTALLABLE_FILES: Record<string, string> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icons/icon-192.png': 'image/png',
  '/icons/icon-512.png': 'image/png',
  '/icons/maskable-512.png': 'image/png',
  '/icons/apple-touch-icon.png': 'image/png',
};

/**
 * The port the daemon was told to listen on is already taken (T127). Typed,
 * so `agile daemon start` can print one actionable line instead of Bun's
 * bare "Failed to start server. Is port 4600 in use?" — it names the
 * address, how to find the holder, and both ways to pick another port.
 */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly hostname: string,
    readonly home?: string,
  ) {
    const configPath = home ? `${home}/config.yaml` : '<home>/config.yaml';
    super(
      `agiled cannot listen on ${hostname}:${port}: address in use. ` +
        `Find the holder: lsof -nP -iTCP:${port} -sTCP:LISTEN. ` +
        `Use another port: set port: in ${configPath} or AGILE_PORT=<n>.`,
    );
    this.name = 'PortInUseError';
  }
}

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
  /**
   * T111: a repo root for the routes that need one (the ticket diff, the
   * top bar's project block). T125: the daemon no longer has one — it
   * starts from any cwd and serves every registered repo — so this is
   * absent in practice and those routes simply omit the repo-derived
   * payload rather than guessing a directory. T130/T131 re-key them to the
   * stream's registered repo.
   */
  repoRoot?: string;
  startedAt: number;
  /** The state home, named in a `PortInUseError` so the operator is pointed at the right `config.yaml` (T127). */
  home?: string;
  /** When present (i.e. the state home exists), enables the feed routes and `/ws` live tail. */
  store?: StateStore;
  /** Required alongside `store` to serve the HIL attention-queue snapshot + approve/delegate actions. */
  gates?: GateService;
  /** T040: serves `/api/questions` (read + raise + answer) and the open-questions half of the attention queue. Optional — without it those routes 503 and the snapshot's `questions` array is empty. */
  questions?: QuestionService;
  /** T121: serves `GET /api/inbox` (cockpit design §3). Optional — without it the route 503s. */
  inbox?: InboxService;
  /** T120: the stream service, so a route family can be hung off it without re-opening the store. Optional. */
  streams?: StreamService;
  /** T160: the inbox's `rule_accept` cards decide through it (`POST /api/rules/:id/accept|retire`). Optional. */
  rules?: RulesService;
  /** T160: the inbox's `done` cards land through it (`POST /api/streams/:id/land`). Optional. */
  landing?: LandingService;
  /** T161: the stream page's sessions strip (attach, review, stop) and composer prompt through it. Optional. */
  attach?: AttachService;
  /** T161: the stream page's docs tab (T134's docs). Optional — without it the tab is empty. */
  docs?: DocsService;
  /**
   * T025: lets a control-room POST land on the bus (`bus.send`) so every
   * write goes through the same path an agent's RPC call would and appears
   * in the event log. Optional.
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

/** `/api/hil/<id>/<action>` — `<id>` is everything between the two fixed segments, `<action>` one of approve|deny|note (T039 adds deny + note; T122 deletes delegate with the EM). */
type HilAction = 'approve' | 'deny' | 'note';

function matchHilAction(pathname: string): { id: string; action: HilAction } | undefined {
  const match = pathname.match(/^\/api\/hil\/([^/]+)\/(approve|deny|note)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return {
    id: decodeURIComponent(match[1]),
    action: match[2] as HilAction,
  };
}

/**
 * T039: the optional free text a Needs-you card carries with (or instead of)
 * a button press. Capped/trimmed here so an over-long note is a 400 rather
 * than a schema throw deeper in `GateService`.
 */
function readNote(body: Record<string, unknown>): string | undefined | { error: string } {
  const raw = body.note;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return { error: 'note must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MESSAGE_BODY_MAX_CHARS) {
    return { error: `note exceeds the ${MESSAGE_BODY_MAX_CHARS}-char cap` };
  }
  return trimmed;
}

async function handleHilAction(
  req: Request,
  gates: GateService,
  id: string,
  action: HilAction,
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

  const note = readNote(body);
  if (note !== undefined && typeof note !== 'string') {
    return errorResponse(400, note.error);
  }

  try {
    if (action === 'approve' || action === 'deny') {
      const decision: HilDecision = action === 'approve' ? 'approve' : 'deny';
      // T032: the actor is always `human` for a browser write, never taken
      // from the request body (a page could otherwise forge another actor) —
      // same hardcode `raised_by`/`from` already use on the halt/chat/propose
      // routes below.
      const updated = await gates.respond(parsedId.data, decision, 'human', note);
      return jsonResponse(updated);
    }

    // T039: a note with no button press resolves nothing — it is recorded
    // on the pending request.
    if (note === undefined) return errorResponse(400, 'note is required');
    const updated = await gates.addNote(parsedId.data, note, 'human');
    return jsonResponse(updated);
  } catch (err) {
    if (err instanceof GateNotFoundError) return errorResponse(404, err.message);
    if (err instanceof GateAlreadyResolvedError) return errorResponse(409, err.message);
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * `/api/questions/<id>/answer` — T040 (§17 "Control room v2" → "Questions vs
 * Decisions"). The list/raise routes need no matcher (fixed path).
 */
function matchQuestionAnswer(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/questions\/([^/]+)\/answer$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** Free text on a question (the text asked, or the answer typed on the card) — capped here so an over-long body is a 400 rather than a schema throw deeper in `QuestionService`. */
function readQuestionText(value: unknown, field: string): string | { error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: `${field} is required` };
  if (trimmed.length > MESSAGE_BODY_MAX_CHARS) {
    return { error: `${field} exceeds the ${MESSAGE_BODY_MAX_CHARS}-char cap` };
  }
  return trimmed;
}

/**
 * `POST /api/questions` — the operator raising a question from the UI (§17
 * v2 names the operator as one of the four producers). `raised_by` is always
 * `human`, never taken from the request body: same T032 rule the halt/chat/
 * HIL routes already follow (a page could otherwise forge `architect`).
 */
async function handleQuestionRaise(req: Request, questions: QuestionService): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
  const text = readQuestionText(body.text, 'text');
  if (typeof text !== 'string') return errorResponse(400, text.error);
  const stream = UlidSchema.safeParse(body.stream);
  if (!stream.success) {
    return errorResponse(400, `invalid stream id: ${String(body.stream)}`);
  }
  let options: string[] | undefined;
  if (body.options !== undefined && body.options !== null) {
    if (
      !Array.isArray(body.options) ||
      body.options.some((o) => typeof o !== 'string' || o.length === 0)
    ) {
      return errorResponse(400, 'options must be an array of non-empty strings');
    }
    options = body.options as string[];
  }
  try {
    const raised = await questions.raise({
      stream: stream.data,
      raised_by: 'human',
      text,
      ...(options !== undefined ? { options } : {}),
    });
    return jsonResponse(raised, 201);
  } catch (err) {
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * `POST /api/questions/<id>/answer` — `{ answer }` (T121: `reply` is the
 * only resolution left). Params are parsed by the same
 * `parseAnswerParams` the `question.answer` RPC uses, so the browser and the
 * CLI cannot disagree about the shape; `by` is forced to `human` (T032).
 */
async function handleQuestionAnswer(
  req: Request,
  questions: QuestionService,
  id: string,
): Promise<Response> {
  const parsedId = QuestionIdSchema.safeParse(id);
  if (!parsedId.success) return errorResponse(400, `invalid question id: ${id}`);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
  try {
    const input = parseAnswerParams({ ...body, by: 'human' });
    const result = await questions.answer(parsedId.data as QuestionId, input);
    return jsonResponse(result);
  } catch (err) {
    if (err instanceof QuestionNotFoundError) return errorResponse(404, err.message);
    if (err instanceof QuestionAlreadyAnsweredError) return errorResponse(409, err.message);
    return errorResponse(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * An optional id from a request body, validated against its own schema
 * before any read uses it. `undefined` when absent, `{error}` when present
 * but malformed (a 400 with a readable message rather than a silent miss).
 */
function readId(
  value: unknown,
  schema: { safeParse(input: unknown): { success: boolean } },
  what: string,
): string | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !schema.safeParse(value).success) {
    return { error: `invalid ${what}: ${String(value)}` };
  }
  return value;
}

/** Who the write is attributed to. The control room is the human's own window, so `human` is the default — same as the HIL routes. */
function readActor(input: Record<string, unknown>): string {
  return typeof input.by === 'string' && input.by.length > 0 ? input.by : 'human';
}

/** Bundles `store`+`gates` once both are present, so every call site gets one non-optional pair instead of re-checking two optionals. */
interface FeedContext {
  store: StateStore;
  gates: GateService;
  bus?: Bus;
  streams?: StreamService;
  questions?: QuestionService;
  inbox?: InboxService;
  rules?: RulesService;
  landing?: LandingService;
  attach?: AttachService;
  docs?: DocsService;
}

function resolveFeedContext(options: HttpServerOptions): FeedContext | undefined {
  if (!options.store || !options.gates) return undefined;
  return {
    store: options.store,
    gates: options.gates,
    bus: options.bus,
    streams: options.streams,
    questions: options.questions,
    inbox: options.inbox,
    rules: options.rules,
    landing: options.landing,
    attach: options.attach,
    docs: options.docs,
  };
}

/**
 * T161: the stream page's routes (cockpit design §9.3) —
 *
 *   GET  /api/streams/:id         the page read (`feed/stream-page.ts`)
 *   GET  /api/streams/:id/diff    the diff tab
 *   POST /api/streams/:id/say     the composer: a human line, and a prompt to the attached worker
 *   POST /api/streams/:id/attach  the sessions strip's attach / review (`role: reviewer`)
 *   POST /api/streams/:id/stop    the sessions strip's stop (a human detach)
 *
 * `land` is matched before this (T160). Every write is same-origin only
 * and stamps `human`; no principal is ever read from the body (§2.2).
 * Returns `undefined` for a path that is not one of these.
 */
async function handleStreamRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/streams\/([^/]+)(?:\/(diff|say|attach|stop))?$/);
  if (!match) return undefined;
  const action = match[2];
  const isGet = action === undefined || action === 'diff';
  if (isGet ? req.method !== 'GET' : req.method !== 'POST') return undefined;
  if (!feed?.streams) return errorResponse(503, 'streams not available');
  const parsedId = UlidSchema.safeParse(decodeURIComponent(match[1] ?? ''));
  if (!parsedId.success) return errorResponse(400, `invalid stream id: ${match[1]}`);
  const id = parsedId.data;
  if (!isGet && !sameOrigin()) return errorResponse(403, 'cross-origin request rejected');

  try {
    if (action === undefined) {
      return jsonResponse(
        buildStreamPage(
          {
            streams: feed.streams,
            ...(feed.rules ? { rules: feed.rules } : {}),
            ...(feed.docs ? { docs: feed.docs } : {}),
            ...(feed.landing ? { landing: feed.landing } : {}),
          },
          id,
        ),
      );
    }
    if (action === 'diff') {
      if (!feed.landing) return errorResponse(503, 'landing not available');
      return jsonResponse(feed.landing.diff(id));
    }

    const body = await readJsonBody(req);
    if (action === 'say') {
      const input = StreamSayInputSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('say', input.error));
      if (feed.attach) return jsonResponse(await feed.attach.say(id, input.data.body), 201);
      // No attach service: the line is still the record.
      const entry = await feed.streams.appendThread('human', id, {
        kind: 'line',
        body: input.data.body,
      });
      return jsonResponse({ entry }, 201);
    }
    if (!feed.attach) return errorResponse(503, 'sessions not available');
    if (action === 'attach') {
      const input = StreamAttachRequestSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('attach', input.error));
      const result = await feed.attach.attach(id, input.data);
      // The handle is in-process only — the wire carries the record.
      return jsonResponse({ session: result.session, stream: result.stream }, 201);
    }
    const sessions = await feed.attach.stop(id, undefined, { detach: true });
    return jsonResponse({ stopped: sessions.length > 0, sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundError) return errorResponse(404, message);
    if (err instanceof StreamBusyError || err instanceof LandRefusedError) {
      return errorResponse(409, message);
    }
    if (err instanceof UnregisteredRepoError || err instanceof UnknownVendorError) {
      return errorResponse(400, message);
    }
    return errorResponse(400, message);
  }
}

/**
 * Runs `bind`, retyping Bun's `EADDRINUSE` as `PortInUseError` (T127).
 * Generic so the caller keeps `Bun.serve`'s own inferred server type
 * (`srv.upgrade(req)` needs the websocket data generic).
 */
function rethrowPortInUse<T>(options: HttpServerOptions, hostname: string, bind: () => T): T {
  try {
    return bind();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new PortInUseError(options.port, hostname, options.home);
    }
    throw err;
  }
}

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
  const hostname = options.hostname ?? '127.0.0.1';
  const feed = resolveFeedContext(options);

  let tailer: EventTailerHandle | undefined;

  /**
   * T127: Bun throws `EADDRINUSE` here when the home's port is already
   * taken (by a stale `agiled` from another home, or anything else). That
   * error reaches the operator through `agile daemon start`, so it is
   * retyped into one actionable line rather than Bun's bare "Failed to
   * start server".
   */
  const server = rethrowPortInUse(options, hostname, () =>
    Bun.serve({
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

        /**
         * T112: the cockpit is the product, so it is served at `/` — the one
         * URL an operator types. The v0 static feed page keeps `/feed`.
         */
        if (url.pathname === '/') {
          return new Response(Bun.file(join(CONTROL_ROOM_DIST_DIR, 'index.html')), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        /**
         * T165: what makes the cockpit installable as its own app window —
         * the manifest, its icons and the pass-through service worker — is
         * served from site root, because a service worker only controls pages
         * under its own path and the cockpit lives at `/`. The files are the
         * Vite `public/` copies in the built bundle.
         */
        const installable = INSTALLABLE_FILES[url.pathname];
        if (installable) {
          const file = Bun.file(join(CONTROL_ROOM_DIST_DIR, url.pathname.slice(1)));
          if (!(await file.exists())) return new Response('not found', { status: 404 });
          return new Response(file, {
            headers: { 'content-type': installable, 'cache-control': 'no-cache' },
          });
        }

        if (url.pathname === '/feed') {
          return new Response(Bun.file(FEED_HTML_PATH), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        /**
         * Control room SPA (T025 — §17 "Control room", §18 "UI: React + Vite
         * SPA ... serves the built UI as static files"). Its assets keep their
         * own `/control-room/` prefix (`vite.config.ts`'s `base`), which is why
         * the index.html served at `/` above resolves them correctly.
         */
        /**
         * T112: `/control-room` moved to `/`; this stays a redirect so old
         * links, bookmarks and the design docs keep working. The query string
         * is preserved — `?view=` is how the cockpit is deep-linked.
         */
        if (url.pathname === '/control-room' || url.pathname === '/control-room/') {
          // A relative `Location` is legal (RFC 7231 §7.1.2) and avoids
          // baking the host into the redirect; `Response.redirect` itself
          // requires an absolute URL, so the header is set by hand.
          return new Response(null, { status: 302, headers: { location: `/${url.search}` } });
        }
        if (url.pathname.startsWith('/control-room/')) {
          const rel = url.pathname.slice('/control-room/'.length);
          const file = Bun.file(join(CONTROL_ROOM_DIST_DIR, rel));
          if (!(await file.exists())) return new Response('not found', { status: 404 });
          // T165: Vite rewrites index.html's manifest/icon links onto this
          // prefix, so the installable files get their explicit types here too.
          const type = INSTALLABLE_FILES[`/${rel}`];
          return type
            ? new Response(file, { headers: { 'content-type': type } })
            : new Response(file);
        }

        if (url.pathname === '/api/snapshot') {
          if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
          return jsonResponse(
            buildSnapshot(feed.store, feed.gates, undefined, feed.questions, options.repoRoot),
          );
        }

        // ---- inbox (T121, cockpit design §3): one list, oldest first,
        // across every stream. Same same-origin rules as the routes above.
        if (url.pathname === '/api/inbox' && req.method === 'GET') {
          if (!feed?.inbox) return errorResponse(503, 'inbox not available');
          return jsonResponse({ items: feed.inbox.list() });
        }

        // ---- cockpit (T160, cockpit design §9): the stream tree, the
        // inbox's rule and land decisions, and the Settings read of the
        // gates block. Every write stamps `human` and is same-origin only.
        if (url.pathname === '/api/cockpit' && req.method === 'GET') {
          if (!feed?.streams) return errorResponse(503, 'streams not available');
          return jsonResponse(buildCockpitFrame(feed.streams, feed.inbox));
        }

        if (url.pathname === '/api/policy' && req.method === 'GET') {
          if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
          try {
            return jsonResponse(feed.store.getPolicy());
          } catch (err) {
            return errorResponse(404, err instanceof Error ? err.message : String(err));
          }
        }

        if (url.pathname === '/api/policy' && req.method === 'PUT') {
          if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
          if (!isSameOriginRequest(req, srv.port ?? options.port)) {
            return errorResponse(403, 'cross-origin request rejected');
          }
          try {
            const policy = validatePolicy(await readJsonBody(req));
            return jsonResponse(await feed.store.putPolicy(policy, { by: 'human' }));
          } catch (err) {
            return errorResponse(400, err instanceof Error ? err.message : String(err));
          }
        }

        const ruleMatch = url.pathname.match(/^\/api\/rules\/([^/]+)\/(accept|retire)$/);
        if (ruleMatch && req.method === 'POST') {
          if (!feed?.rules) return errorResponse(503, 'rules not available');
          if (!isSameOriginRequest(req, srv.port ?? options.port)) {
            return errorResponse(403, 'cross-origin request rejected');
          }
          const id = RuleIdSchema.safeParse(decodeURIComponent(ruleMatch[1] ?? ''));
          if (!id.success) return errorResponse(400, `invalid rule id: ${ruleMatch[1]}`);
          try {
            const rule =
              ruleMatch[2] === 'accept'
                ? await feed.rules.accept(id.data, 'human')
                : await feed.rules.retire(id.data, 'human');
            return jsonResponse(rule);
          } catch (err) {
            if (err instanceof RuleAlreadyDecidedError) return errorResponse(409, err.message);
            return errorResponse(400, err instanceof Error ? err.message : String(err));
          }
        }

        const landMatch = url.pathname.match(/^\/api\/streams\/([^/]+)\/land$/);
        if (landMatch && req.method === 'POST') {
          if (!feed?.landing) return errorResponse(503, 'landing not available');
          if (!isSameOriginRequest(req, srv.port ?? options.port)) {
            return errorResponse(403, 'cross-origin request rejected');
          }
          const id = UlidSchema.safeParse(decodeURIComponent(landMatch[1] ?? ''));
          if (!id.success) return errorResponse(400, `invalid stream id: ${landMatch[1]}`);
          try {
            return jsonResponse(await feed.landing.land(id.data));
          } catch (err) {
            if (err instanceof LandRefusedError) return errorResponse(409, err.message);
            return errorResponse(400, err instanceof Error ? err.message : String(err));
          }
        }

        // T162: "New stream" and the top bar's quick capture (§9.1) — the
        // same `StreamService.create` the `stream.create` RPC reaches,
        // stamped `human` at this edge.
        if (url.pathname === '/api/streams' && req.method === 'POST') {
          if (!feed?.streams) return errorResponse(503, 'streams not available');
          if (!isSameOriginRequest(req, srv.port ?? options.port)) {
            return errorResponse(403, 'cross-origin request rejected');
          }
          try {
            const input = StreamCreateInputSchema.safeParse(await readJsonBody(req));
            if (!input.success) return errorResponse(400, formatZodError('stream', input.error));
            return jsonResponse(await feed.streams.create('human', input.data), 201);
          } catch (err) {
            // An unknown parent or repo, or a bad body: the human's to fix.
            return errorResponse(400, err instanceof Error ? err.message : String(err));
          }
        }

        const streamRoute = await handleStreamRoute(req, url, feed, () =>
          isSameOriginRequest(req, srv.port ?? options.port),
        );
        if (streamRoute) return streamRoute;

        // ---- questions (T040, §17 "Control room v2") — read + raise + answer.
        if (url.pathname === '/api/questions' && req.method === 'GET') {
          if (!feed?.questions) return errorResponse(503, 'questions store not available');
          return jsonResponse(
            url.searchParams.get('status') === 'open'
              ? feed.questions.listOpen()
              : feed.questions.list(),
          );
        }

        if (url.pathname === '/api/questions' && req.method === 'POST') {
          if (!feed?.questions) return errorResponse(503, 'questions store not available');
          if (!isSameOriginRequest(req, srv.port ?? options.port)) {
            return errorResponse(403, 'cross-origin request rejected');
          }
          return handleQuestionRaise(req, feed.questions);
        }

        const questionAnswerMatch = matchQuestionAnswer(url.pathname);
        if (questionAnswerMatch && req.method === 'POST') {
          if (!feed?.questions) return errorResponse(503, 'questions store not available');
          if (!isSameOriginRequest(req, srv.port ?? options.port)) {
            return errorResponse(403, 'cross-origin request rejected');
          }
          return handleQuestionAnswer(req, feed.questions, questionAnswerMatch);
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
            ws.send(
              JSON.stringify(
                buildSnapshot(feed.store, feed.gates, undefined, feed.questions, options.repoRoot),
              ),
            );
            if (feed.streams) {
              ws.send(JSON.stringify(buildCockpitFrame(feed.streams, feed.inbox)));
            }
          }
        },
        message() {
          // v0: no client -> server protocol yet (tail-only). Ignore inbound.
        },
      },
    }),
  );

  if (feed) {
    tailer = startEventTailer({
      path: `${options.stateRoot}/log/events.jsonl`,
      pollIntervalMs: options.feedPollIntervalMs,
      onEvents: (newEvents) => {
        for (const event of newEvents) {
          server.publish(FEED_WS_TOPIC, JSON.stringify({ type: 'event', event }));
        }
        // T160: every batch of new lines may have changed what waits on the
        // human or a stream's status pair, so the cockpit's inbox and tree
        // are re-derived and pushed once per batch (§3.3 "push, do not poll").
        if (feed.streams && newEvents.length > 0) {
          try {
            server.publish(
              FEED_WS_TOPIC,
              JSON.stringify(buildCockpitFrame(feed.streams, feed.inbox)),
            );
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
          }
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
