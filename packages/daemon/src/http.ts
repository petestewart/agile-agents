/**
 * Localhost HTTP + WebSocket: `GET /health`, the cockpit bundle at `/`,
 * and, with a `StateStore` + `GateService`, the cockpit's JSON routes
 * (snapshot, inbox, streams, rules, questions, gates, settings) plus a
 * `/ws` that sends `hello` + snapshot and then tails `log/events.jsonl` as
 * `{type:'event'}` frames. Every write route is same-origin only
 * (`isSameOriginRequest`) and records the actor as `human`. Without a
 * store the feed routes 503 and `/ws` sends only the hello frame.
 */

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClassifierKeyInputSchema,
  DIRECTOR_NODE,
  type HilDecision,
  HilIdSchema,
  KnowledgeCreateInputSchema,
  KnowledgeIdSchema,
  KnowledgePatchSchema,
  KnowledgeTestInputSchema,
  MESSAGE_BODY_MAX_CHARS,
  type QuestionId,
  QuestionIdSchema,
  SessionDefaultsPatchSchema,
  type Stream,
  StreamAddRepoRequestSchema,
  StreamAttachRequestSchema,
  StreamAutonomyRequestSchema,
  StreamCreateInputSchema,
  StreamMoveRequestSchema,
  StreamSayInputSchema,
  StreamUpdateRequestSchema,
  StreamWaitRequestSchema,
  UlidSchema,
  formatZodError,
  validatePolicy,
} from '@agile-agents/shared';
import { CONTROL_ROOM_DIST_DIR, FEED_HTML_PATH } from '@agile-agents/ui';
import {
  type AttachService,
  SessionDefaultsService,
  StreamBusyError,
  UnknownVendorError,
  UnregisteredRepoError,
} from './attach';
import type { ClassifierKeyService } from './classifier';
import {
  type AutonomyService,
  ProposalClosedError,
  StaleProposalError,
} from './coordination/autonomy';
import type { ContractService } from './coordination/contracts';
import { PlanNotDraftError, type PlanService } from './coordination/plans';
import { type DeliveryService, LandRefusedError } from './delivery';
import type { DirectorService } from './director/service';
import type { DocsService } from './docs';
import type { RoutedEventService } from './events';
import { EVENT_PAGE_MAX, type EventPageQuery, UnknownEventError } from './events/service';
import {
  type CockpitFrame,
  type EventTailerHandle,
  NothingToMergeCache,
  buildCockpitFrame,
  buildSnapshot,
  buildStreamPage,
  startEventTailer,
} from './feed';
import { GateAlreadyResolvedError, GateNotFoundError, type GateService } from './gates';
import { isLoopbackUrl } from './github/rest';
import type { InboxService } from './inbox';
import {
  KnowledgeAlreadyDecidedError,
  type KnowledgeService,
  type RuleRpcEvalDeps,
  buildRuleReport,
  testRules,
} from './knowledge';
import type { ProjectService } from './projects';
import {
  QuestionAlreadyAnsweredError,
  QuestionNotFoundError,
  type QuestionService,
  parseAnswerParams,
  sayAndAnswer,
} from './questions';
import {
  CloneError,
  DirListError,
  NotFoundError,
  RepoRemoteCache,
  type StateStore,
  buildStateRpcMethods,
  cloneRepo,
  listDirs,
  resolveMainBranch,
  setRepoSettings,
} from './store';
import type { RepoInPlaceService, StreamService } from './streams';
import type { TrackerLinks } from './trackers/link';
import { TrackerError } from './trackers/port';
import {
  TRACKER_INPUT_ERROR,
  applyTrackerSettings,
  parseTrackerSettings,
  readTrackerSettings,
} from './trackers/settings';

/** The installable-app files served at site root, with their content types. */
const INSTALLABLE_FILES: Record<string, string> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icons/icon-192.png': 'image/png',
  '/icons/icon-512.png': 'image/png',
  '/icons/maskable-512.png': 'image/png',
  '/icons/apple-touch-icon.png': 'image/png',
};

/**
 * The configured port is taken: one actionable line (the address, how to
 * find the holder, how to pick another port) instead of Bun's bare
 * "Failed to start server".
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
  /** Repo root for the snapshot's repo block; absent in practice (the daemon serves every registered repo). */
  repoRoot?: string;
  startedAt: number;
  /** The state home, named in a `PortInUseError` so the operator finds the right `config.yaml`. */
  home?: string;
  /** When present (i.e. the state home exists), enables the feed routes and `/ws` live tail. */
  store?: StateStore;
  /** Required alongside `store` to serve the HIL attention-queue snapshot + approve/delegate actions. */
  gates?: GateService;
  /** `/api/questions` and the snapshot's open questions; without it those routes 503. */
  questions?: QuestionService;
  /** `GET /api/inbox` (§3); without it the route 503s. */
  inbox?: InboxService;
  streams?: StreamService;
  /** T208: `GET/POST /api/projects` and the cockpit frame's projects. */
  projects?: ProjectService;
  /** T300: `GET /api/director`, `POST /api/director/say`. */
  director?: DirectorService;
  /** The rules routes (`/api/rules...`). */
  rules?: KnowledgeService;
  /** "Test examples": `rule.test`'s evals through the configured classifier. */
  ruleEvals?: RuleRpcEvalDeps;
  /** The classifier key behind Settings, and whether evals can run (without it, whenever `ruleEvals` is given). */
  classifierKey?: ClassifierKeyService;
  /** `POST /api/streams/:id/land`. */
  landing?: DeliveryService;
  /** T340: `POST /api/streams/:id/pr-check`, the Delivery panel's Check now (`PrPoller.pollNow`). */
  prCheck?: (id: string) => Promise<Stream>;
  /** The stream page's sessions strip and composer. */
  attach?: AttachService;
  /** T205: the stream page's + Repo (projects-design §7). */
  repoInPlace?: RepoInPlaceService;
  /** The stream page's docs tab. */
  docs?: DocsService;
  /** T222: the pr refusal's GitHub auth check; absent reads as unavailable. */
  githubAuth?: () => Promise<boolean>;
  /** T245: the node Activity tab and the repo view's events. */
  events?: RoutedEventService;
  /** T281: the stream page's Plan tab and the plan approval card. */
  plans?: PlanService;
  contracts?: ContractService;
  /** T282: the Apply/Dismiss on a coordinator's proposal card. */
  autonomy?: AutonomyService;
  /** T321: the stream page's Link field. */
  trackerLinks?: TrackerLinks;
  /** Test hook: the tailer's poll interval (default 250ms). */
  feedPollIntervalMs?: number;
  /** Test hook: the operator's home folder for the folder picker and clone destinations (default `os.homedir()`). */
  userHome?: string;
  /** Test hook: the repo remote cache (default: one reading `git remote get-url`, 60s TTL). */
  repoRemotes?: RepoRemoteCache;
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

/** T385: a "goal changed" thread line carries the new goal on one line, clipped. */
const GOAL_LINE_MAX = 400;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Guards the human's write routes against a drive-by POST from another
 * page in the same browser. A present `Origin` must be this server's; a
 * present `Sec-Fetch-Site` must be `same-origin` or `none`. Both headers
 * are optional, so only a value naming another origin is rejected.
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

/**
 * T362: the request's `Host` names this machine (or is absent). The
 * filesystem routes add this to the same-origin check: a page that
 * DNS-rebinds its own name to 127.0.0.1 is same-origin to the browser, but
 * its requests still carry that name as `Host`.
 */
function isLoopbackHost(req: Request): boolean {
  const host = req.headers.get('host');
  return host === null || isLoopbackUrl(`http://${host}`);
}

/** `/api/hil/<id>/<action>`, action approve|deny|note. */
type HilAction = 'approve' | 'deny' | 'note';

function matchHilAction(pathname: string): { id: string; action: HilAction } | undefined {
  const match = pathname.match(/^\/api\/hil\/([^/]+)\/(approve|deny|note)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return {
    id: decodeURIComponent(match[1]),
    action: match[2] as HilAction,
  };
}

/** The optional note on a gate card, capped here so an over-long one is a 400. */
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
    return errorResponse(400, messageOf(err));
  }

  const note = readNote(body);
  if (note !== undefined && typeof note !== 'string') {
    return errorResponse(400, note.error);
  }

  try {
    if (action === 'approve' || action === 'deny') {
      const decision: HilDecision = action === 'approve' ? 'approve' : 'deny';
      // The actor is always `human` for a browser write, never read from the body.
      const updated = await gates.respond(parsedId.data, decision, 'human', note);
      return jsonResponse(updated);
    }

    // A note with no button press resolves nothing: it is recorded on the request.
    if (note === undefined) return errorResponse(400, 'note is required');
    const updated = await gates.addNote(parsedId.data, note, 'human');
    return jsonResponse(updated);
  } catch (err) {
    if (err instanceof GateNotFoundError) return errorResponse(404, err.message);
    if (err instanceof GateAlreadyResolvedError) return errorResponse(409, err.message);
    return errorResponse(400, messageOf(err));
  }
}

/** `/api/questions/<id>/answer`. */
function matchQuestionAnswer(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/questions\/([^/]+)\/answer$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** Free text on a question, capped here so an over-long body is a 400. */
function readQuestionText(value: unknown, field: string): string | { error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: `${field} is required` };
  if (trimmed.length > MESSAGE_BODY_MAX_CHARS) {
    return { error: `${field} exceeds the ${MESSAGE_BODY_MAX_CHARS}-char cap` };
  }
  return trimmed;
}

/** `POST /api/questions`: the operator raising a question. `raised_by` is always `human`. */
async function handleQuestionRaise(req: Request, questions: QuestionService): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return errorResponse(400, messageOf(err));
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
    return errorResponse(400, messageOf(err));
  }
}

/**
 * `POST /api/questions/<id>/answer` `{ answer }`, parsed by the same
 * `parseAnswerParams` as the RPC so browser and CLI cannot disagree; `by`
 * is forced to `human`.
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
    return errorResponse(400, messageOf(err));
  }
  try {
    const input = parseAnswerParams({ ...body, by: 'human' });
    const result = await questions.answer(parsedId.data as QuestionId, input);
    return jsonResponse(result);
  } catch (err) {
    if (err instanceof QuestionNotFoundError) return errorResponse(404, err.message);
    if (err instanceof QuestionAlreadyAnsweredError) return errorResponse(409, err.message);
    return errorResponse(400, messageOf(err));
  }
}

/** `store` + `gates` bundled once both are present, plus the optional services. */
interface FeedContext {
  store: StateStore;
  gates: GateService;
  streams?: StreamService;
  projects?: ProjectService;
  director?: DirectorService;
  questions?: QuestionService;
  inbox?: InboxService;
  rules?: KnowledgeService;
  ruleEvals?: RuleRpcEvalDeps;
  classifierKey?: ClassifierKeyService;
  landing?: DeliveryService;
  prCheck?: (id: string) => Promise<Stream>;
  attach?: AttachService;
  repoInPlace?: RepoInPlaceService;
  docs?: DocsService;
  /** T222: the pr refusal's GitHub auth check; absent reads as unavailable. */
  githubAuth?: () => Promise<boolean>;
  events?: RoutedEventService;
  plans?: PlanService;
  contracts?: ContractService;
  autonomy?: AutonomyService;
  trackerLinks?: TrackerLinks;
  /** T362: each repo's remote for the repo rows, never read on the frame's path. */
  remotes: RepoRemoteCache;
  /** T380: which finished nodes have nothing to merge, never read on the frame's path. */
  mergeState?: NothingToMergeCache;
  userHome?: string;
}

/** The cockpit frame (§9), as `/api/cockpit` and the `/ws` push send it. */
function cockpitFrame(feed: FeedContext, streams: StreamService): CockpitFrame {
  return buildCockpitFrame(
    streams,
    feed.inbox,
    feed.projects,
    feed.store.getRepos(),
    (id) => feed.store.getCard(id),
    feed.contracts,
    (s) => feed.plans?.waitingForPlan(s) === true,
    (entry) => feed.remotes.peek(entry),
    feed.mergeState ? (s) => feed.mergeState?.peek(s) === true : undefined,
    (id) => feed.store.threadUpdatedAt(id),
  );
}

function resolveFeedContext(options: HttpServerOptions): FeedContext | undefined {
  if (!options.store || !options.gates) return undefined;
  return {
    store: options.store,
    gates: options.gates,
    streams: options.streams,
    projects: options.projects,
    director: options.director,
    questions: options.questions,
    inbox: options.inbox,
    rules: options.rules,
    ruleEvals: options.ruleEvals,
    classifierKey: options.classifierKey,
    landing: options.landing,
    prCheck: options.prCheck,
    attach: options.attach,
    repoInPlace: options.repoInPlace,
    docs: options.docs,
    githubAuth: options.githubAuth,
    events: options.events,
    plans: options.plans,
    contracts: options.contracts,
    autonomy: options.autonomy,
    trackerLinks: options.trackerLinks,
    remotes: options.repoRemotes ?? new RepoRemoteCache(),
    ...(options.landing
      ? {
          mergeState: new NothingToMergeCache({
            preflight: (id) => options.landing?.preflight(id) ?? {},
          }),
        }
      : {}),
    userHome: options.userHome,
  };
}

/** "Test examples" runs only when the daemon holds a key, not merely because a classifier object exists. */
function evalsAvailable(feed: FeedContext): boolean {
  if (!feed.ruleEvals) return false;
  return feed.classifierKey ? feed.classifierKey.status().loaded : true;
}

/**
 * Settings' classifier key:
 *
 *   GET  /api/settings/classifier             where the key comes from (never the key)
 *   POST /api/settings/classifier/key         save `{api_key}` to config.yaml, live
 *   POST /api/settings/classifier/key/remove  delete it from config.yaml (an env key still applies)
 *
 * Writes are same-origin only and the human's. No response, error or event
 * ever carries the key: a bad body gets a fixed message, never zod's.
 */
async function handleSettingsRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith('/api/settings/classifier')) return undefined;
  const path = url.pathname;
  if (path === '/api/settings/classifier' && req.method === 'GET') {
    if (!feed?.classifierKey) return errorResponse(503, 'classifier settings not available');
    return jsonResponse(feed.classifierKey.status());
  }
  const isSave = path === '/api/settings/classifier/key';
  const isRemove = path === '/api/settings/classifier/key/remove';
  if ((!isSave && !isRemove) || req.method !== 'POST') return undefined;
  if (!feed?.classifierKey) return errorResponse(503, 'classifier settings not available');
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  try {
    if (isRemove) return jsonResponse(await feed.classifierKey.remove());
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return errorResponse(400, 'invalid classifier key request: body must be JSON {api_key}');
    }
    const input = ClassifierKeyInputSchema.safeParse(body);
    if (!input.success) {
      return errorResponse(
        400,
        'invalid classifier key request: send exactly {api_key: "<non-empty string, at most 512 chars>"}',
      );
    }
    return jsonResponse(await feed.classifierKey.set(input.data.api_key));
  } catch {
    // Store errors are generic already; this keeps any future one from quoting the key.
    return errorResponse(500, 'could not save the classifier key');
  }
}

/**
 * T326 (D31): Settings' trackers:
 *
 *   GET  /api/settings/trackers  Jira's base URL and email, and whether each token is set (never a token)
 *   POST /api/settings/trackers  `{system, base_url?, email?, token?}` (`null` removes), live at once
 *
 * Writes are same-origin only and stamped `human`. No response, error or
 * event ever carries a token: a bad body gets a fixed message, never zod's.
 */
async function handleTrackerSettingsRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  if (url.pathname !== '/api/settings/trackers') return undefined;
  if (req.method !== 'GET' && req.method !== 'POST') return undefined;
  if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
  if (req.method === 'GET') {
    try {
      return jsonResponse(readTrackerSettings(feed.store));
    } catch {
      return errorResponse(500, 'could not read the tracker settings');
    }
  }
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return errorResponse(400, TRACKER_INPUT_ERROR);
  }
  const input = parseTrackerSettings(body);
  if (!input) return errorResponse(400, TRACKER_INPUT_ERROR);
  try {
    return jsonResponse(await applyTrackerSettings(feed.store, input, 'human'));
  } catch (err) {
    // The store's messages never quote a value; anything else gets a fixed one.
    const message = messageOf(err);
    return errorResponse(
      400,
      message.startsWith('config.yaml would not validate')
        ? message
        : 'could not save the tracker settings',
    );
  }
}

/**
 * D17: Settings' session defaults:
 *
 *   GET  /api/settings/session              every step of the order and what it resolves to
 *   POST /api/settings/session              home `default_vendor|model|effort` (`SessionDefaultsPatchSchema`)
 *   POST /api/settings/session/repos/:name  one repo's `vendor|model|effort` in `repos.yaml`
 *
 * Writes are same-origin only and stamped `human`; each applies to the
 * next session without a restart (attach reads both files per session).
 */
async function handleSessionSettingsRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/settings\/session(?:\/repos\/([^/]+))?$/);
  if (!match) return undefined;
  const repo = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
  if (req.method === 'GET' && repo === undefined) {
    if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
    try {
      return jsonResponse(new SessionDefaultsService(feed.store).status());
    } catch (err) {
      return errorResponse(500, messageOf(err));
    }
  }
  if (req.method !== 'POST') return undefined;
  if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return errorResponse(400, 'invalid session defaults: body must be JSON');
  }
  const input = SessionDefaultsPatchSchema.safeParse(body);
  if (!input.success) return errorResponse(400, formatZodError('session defaults', input.error));
  const service = new SessionDefaultsService(feed.store);
  try {
    return jsonResponse(
      repo === undefined
        ? await service.setHome('human', input.data)
        : await service.setRepo('human', repo, input.data),
    );
  } catch (err) {
    const message = messageOf(err);
    if (err instanceof NotFoundError) return errorResponse(404, message);
    return errorResponse(400, message);
  }
}

/**
 * T300 (projects-design §12, P16): the Director page.
 *
 *   GET  /api/director      `{record, thread, live, activity, proposals}`
 *   POST /api/director/say  `{body}`: a human line and `director_request`
 */
async function handleDirectorRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  if (url.pathname !== '/api/director' && url.pathname !== '/api/director/say') return undefined;
  if (!feed?.director) return errorResponse(503, 'director not available');
  if (url.pathname === '/api/director' && req.method === 'GET') {
    return jsonResponse({
      ...feed.director.view(),
      activity: feed.events?.activityFor(DIRECTOR_NODE) ?? [],
      // T301: the Director's held changes (drafts), each with Create/Apply.
      proposals: feed.autonomy?.listOpen().filter((p) => p.node === DIRECTOR_NODE) ?? [],
    });
  }
  if (url.pathname === '/api/director/say' && req.method === 'POST') {
    if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
    try {
      const body = (await readJsonBody(req)) as { body?: unknown };
      if (typeof body?.body !== 'string') return errorResponse(400, 'body must be a string');
      return jsonResponse(await feed.director.say(body.body));
    } catch (err) {
      return errorResponse(400, messageOf(err));
    }
  }
  return undefined;
}

/**
 * T245 (projects-design §8): read-only event views.
 *
 *   GET /api/streams/:id/activity  every event routed to the node: reason, delivery status, session or digest
 *   GET /api/repos/:name/events    every event on the repo
 *   GET /api/events                T338: the event log, every routed event, newest first.
 *                                  T383: a page of it, `{events, more, total}`: `?before=<event id>`
 *                                  (only older ones), `?limit=` (1–500, default 200), `?repo=<name>`
 *   GET /api/repos/:name/knowledge T265: the repo's accepted standards and architecture
 */
function handleActivityRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
): Response | undefined {
  if (req.method !== 'GET') return undefined;
  const node = url.pathname.match(/^\/api\/streams\/([^/]+)\/activity$/);
  const repo = url.pathname.match(/^\/api\/repos\/([^/]+)\/events$/);
  if (url.pathname === '/api/events') {
    if (!feed?.events) return errorResponse(503, 'events not available');
    const query = eventPageQuery(url.searchParams);
    if (typeof query === 'string') return errorResponse(400, query);
    try {
      return jsonResponse(feed.events.page(query));
    } catch (err) {
      if (err instanceof UnknownEventError) {
        return errorResponse(
          400,
          `no event ${quoted(err.id)} in the log: before must be the id of an event a page listed`,
        );
      }
      return errorResponse(500, messageOf(err));
    }
  }
  const norms = url.pathname.match(/^\/api\/repos\/([^/]+)\/knowledge$/);
  if (norms) {
    if (!feed?.rules) return errorResponse(503, 'knowledge not available');
    const name = decodeURIComponent(norms[1] ?? '');
    return jsonResponse({
      knowledge: feed.rules
        .list({ status: 'accepted', scope: `repo:${name}` })
        .filter((k) => k.kind !== 'decision'),
    });
  }
  if (!node && !repo) return undefined;
  if (!feed?.events) return errorResponse(503, 'events not available');
  try {
    if (node) {
      const id = UlidSchema.safeParse(decodeURIComponent(node[1] ?? ''));
      if (!id.success) return errorResponse(400, `invalid stream id: ${node[1]}`);
      return jsonResponse({ activity: feed.events.activityFor(id.data) });
    }
    return jsonResponse({ events: feed.events.forRepo(decodeURIComponent(repo?.[1] ?? '')) });
  } catch (err) {
    return errorResponse(500, messageOf(err));
  }
}

/** A query value as it reads in an error: quoted, and cut short when long. */
function quoted(value: string): string {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
}

/** T383: `/api/events`'s query, or what is wrong with it in words. */
function eventPageQuery(params: URLSearchParams): EventPageQuery | string {
  const query: EventPageQuery = {};
  const limit = params.get('limit');
  if (limit !== null) {
    const n = /^\d{1,6}$/.test(limit) ? Number(limit) : Number.NaN;
    if (!(n >= 1 && n <= EVENT_PAGE_MAX)) {
      return `limit must be a whole number from 1 to ${EVENT_PAGE_MAX}, not ${quoted(limit)}`;
    }
    query.limit = n;
  }
  const before = params.get('before');
  if (before !== null) {
    if (before.trim() === '') return 'before must be the id of an event, not empty';
    query.before = before;
  }
  const repo = params.get('repo');
  if (repo !== null) {
    if (repo.trim() === '') return 'repo must be a repo name, not empty';
    query.repo = repo;
  }
  return query;
}

/**
 * T281 (projects-design §9.1, §14.4): the Plan tab and its approval.
 *
 *   GET  /api/streams/:id/plan          `{plan, contracts}`: the node's plan (or null) and its contracts
 *   POST /api/streams/:id/plan/approve  the human approves the draft plan (the inbox card's button)
 *   POST /api/streams/:id/plan/start-parts  T344: "Start parts anyway": the parts waiting for the plan start without one
 */
async function handlePlanRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/streams\/([^/]+)\/plan(?:\/(approve|start-parts))?$/);
  if (!match) return undefined;
  const write = match[2] !== undefined;
  const approve = match[2] === 'approve';
  if (req.method !== (write ? 'POST' : 'GET')) return undefined;
  if (!feed?.plans || !feed.contracts) return errorResponse(503, 'plans not available');
  const id = UlidSchema.safeParse(decodeURIComponent(match[1] ?? ''));
  if (!id.success) return errorResponse(400, `invalid stream id: ${match[1]}`);
  if (write && !sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  try {
    if (approve) return jsonResponse(await feed.plans.approve(id.data, 'human'));
    if (write) return jsonResponse({ started: await feed.plans.startWaitingParts(id.data) });
    return jsonResponse({
      plan: feed.plans.get(id.data) ?? null,
      contracts: feed.contracts.forNode(id.data),
    });
  } catch (err) {
    if (err instanceof PlanNotDraftError) return errorResponse(409, err.message);
    if (err instanceof NotFoundError) return errorResponse(404, messageOf(err));
    return errorResponse(400, messageOf(err));
  }
}

/**
 * T282 (projects-design §9 Autonomy):
 *
 *   POST /api/proposals/:id/apply|dismiss  the human decides a coordinator's proposal card
 *   POST /api/streams/:id/autonomy         `{autonomy: level|null}`: the node's override
 *   POST /api/projects/:id                 `{autonomy?: {coordinator?, director?}, tracker?: {…} | null, name?, repos?}`: the project's levels, (T338) tracker settings, (T372) name and repos, and (T379) `session` defaults
 */
async function handleAutonomyRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  if (req.method !== 'POST') return undefined;
  const proposal = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(apply|dismiss)$/);
  const node = url.pathname.match(/^\/api\/streams\/([^/]+)\/autonomy$/);
  const project = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (!proposal && !node && !project) return undefined;
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  try {
    if (proposal) {
      if (!feed?.autonomy) return errorResponse(503, 'proposals not available');
      const id = decodeURIComponent(proposal[1] ?? '');
      return jsonResponse(
        proposal[2] === 'apply' ? await feed.autonomy.apply(id) : await feed.autonomy.dismiss(id),
      );
    }
    if (node) {
      if (!feed?.streams) return errorResponse(503, 'streams not available');
      const id = UlidSchema.safeParse(decodeURIComponent(node[1] ?? ''));
      if (!id.success) return errorResponse(400, `invalid stream id: ${node[1]}`);
      const input = StreamAutonomyRequestSchema.safeParse(await readJsonBody(req));
      if (!input.success) return errorResponse(400, formatZodError('autonomy', input.error));
      return jsonResponse(await feed.streams.setAutonomy(id.data, input.data.autonomy));
    }
    if (!feed?.projects) return errorResponse(503, 'projects not available');
    const body = await readJsonBody(req);
    // T372: the cockpit also renames a project and changes its repos.
    return jsonResponse(
      await feed.projects.update(decodeURIComponent(project?.[1] ?? ''), {
        autonomy: body.autonomy,
        ...(body.tracker !== undefined ? { tracker: body.tracker } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.repos !== undefined ? { repos: body.repos } : {}),
        // T379: the project's session defaults (P5); `null` clears them.
        ...(body.session !== undefined ? { session: body.session } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof ProposalClosedError || err instanceof StaleProposalError) {
      return errorResponse(409, err.message);
    }
    if (err instanceof NotFoundError) return errorResponse(404, messageOf(err));
    return errorResponse(400, messageOf(err));
  }
}

/**
 * T321: `POST /api/streams/:id/link` `{key: "SHOP-11" | null}` links (or unlinks) the node.
 * T324: `POST /api/streams/:id/issue` `{project?: "SHOP"}` creates an issue and links it.
 */
async function handleLinkRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/api\/streams\/([^/]+)\/(link|issue|import-children)$/);
  if (!m || req.method !== 'POST') return undefined;
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  if (!feed?.trackerLinks) return errorResponse(503, 'tracker links not available');
  const id = UlidSchema.safeParse(decodeURIComponent(m[1] ?? ''));
  if (!id.success) return errorResponse(400, `invalid stream id: ${m[1]}`);
  try {
    // T323: `POST /api/streams/:id/import-children` creates one linked child per epic issue.
    if (m[2] === 'import-children')
      return jsonResponse(await feed.trackerLinks.importChildren(id.data));
    const body = await readJsonBody(req);
    if (m[2] === 'issue') {
      // T324: "Create issue", a human click only (no RPC, so no agent path).
      const project = body.project;
      if (project !== undefined && typeof project !== 'string') {
        return errorResponse(400, 'invalid issue: project is a key (SHOP)');
      }
      return jsonResponse(await feed.trackerLinks.createIssue(id.data, project ? { project } : {}));
    }
    const key = body.key;
    if (key !== null && (typeof key !== 'string' || key.trim() === '')) {
      return errorResponse(400, 'invalid link: key is an issue key (SHOP-11) or null');
    }
    return jsonResponse(await feed.trackerLinks.link(id.data, key));
  } catch (err) {
    if (err instanceof NotFoundError) return errorResponse(404, messageOf(err));
    if (err instanceof TrackerError) return errorResponse(400, err.message);
    return errorResponse(400, messageOf(err));
  }
}

/**
 * T206: Settings → Repos, over the same `state.repo_add` RPC as `agile repo add`:
 *
 *   GET  /api/repos        every registered repo with its resolved `main_branch`, and (T362)
 *                          its `remote` (`RepoRemote`, absent for a local-only repo)
 *   POST /api/repos        `{name, path, protected_branches?}`; a bad path is the RPC's one-line 400
 *   POST /api/repos/clone  T362: `{url, dest?, name?}` (`RepoCloneInputSchema`): `git clone`, then
 *                          `state.repo_add`; `{repos, repo, path}`. A taken name or a non-empty
 *                          destination is 409, a git failure 400 with its stderr's last lines
 *   POST /api/repos/:name  T222: delivery settings (`RepoSettingsPatchSchema`), same checks as `agile repo set`
 *
 * `/api/repos/clone` is a repo's settings only when a repo named `clone` is
 * registered and the body has no `url` (a settings patch never has one).
 * Clone is same-origin and loopback-`Host` only, and may run for minutes, so
 * its request has no idle timeout.
 */
async function handleRepoRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
  noTimeout: () => void,
): Promise<Response | undefined> {
  const one = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
  if (url.pathname !== '/api/repos' && !one) return undefined;
  if (req.method !== 'GET' && req.method !== 'POST') return undefined;
  if (one && req.method !== 'POST') return undefined;
  if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
  const list = () =>
    Promise.all(
      Object.entries(feed.store.getRepos()).map(async ([name, entry]) => {
        const remote = await feed.remotes.get(entry);
        return {
          name,
          path: entry.path,
          protected_branches: entry.protected_branches,
          main_branch: resolveMainBranch(entry),
          delivery: entry.delivery ?? 'direct',
          auto_merge: entry.auto_merge ?? false,
          visibility: entry.visibility ?? { mode: 'public' },
          ...(entry.github ? { github: entry.github } : {}),
          ...(remote !== undefined ? { remote } : {}),
        };
      }),
    );
  const forget = (name: unknown) => {
    const entry = typeof name === 'string' ? feed.store.getRepos()[name] : undefined;
    if (entry !== undefined) feed.remotes.invalidate(entry.path);
  };
  if (one?.[1] !== undefined) {
    if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
    const name = decodeURIComponent(one[1]);
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return errorResponse(
        400,
        name === 'clone'
          ? 'invalid clone request: body must be JSON {url, dest?, name?}'
          : 'invalid repo settings: body must be JSON',
      );
    }
    if (name === 'clone' && ('url' in body || !Object.hasOwn(feed.store.getRepos(), 'clone'))) {
      return handleRepoClone(req, feed, body, list, noTimeout);
    }
    try {
      await setRepoSettings(feed.store, name, body, {
        by: 'human',
        ...(feed.githubAuth ? { githubAuth: feed.githubAuth } : {}),
      });
      forget(name);
      return jsonResponse({ repos: await list() });
    } catch (err) {
      return errorResponse(400, messageOf(err));
    }
  }
  if (req.method === 'GET') return jsonResponse({ repos: await list() });
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return errorResponse(400, 'invalid repo: body must be JSON {name, path, protected_branches?}');
  }
  // T378: from the cockpit, a name already registered for another folder is a
  // clash, not a replace (the CLI keeps `agile repo add` re-registering).
  const taken =
    typeof body.name === 'string' && typeof body.path === 'string'
      ? feed.store.getRepos()[body.name]
      : undefined;
  if (taken !== undefined && !samePath(taken.path, body.path as string)) {
    return errorResponse(
      409,
      `a repository named ${String(body.name)} is already registered (${taken.path}); pick another name`,
    );
  }
  try {
    await buildStateRpcMethods(feed.store)['state.repo_add']?.(body);
    forget(body.name);
    return jsonResponse({ repos: await list() });
  } catch (err) {
    return errorResponse(400, messageOf(err));
  }
}

/** T378: two spellings of one folder (symlinks, a trailing slash) are the same path. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}

/** T362: `POST /api/repos/clone`, after the same-origin check. */
async function handleRepoClone(
  req: Request,
  feed: FeedContext,
  body: Record<string, unknown>,
  list: () => Promise<unknown[]>,
  noTimeout: () => void,
): Promise<Response> {
  if (!isLoopbackHost(req)) return errorResponse(403, 'cross-origin request rejected');
  noTimeout();
  try {
    const cloned = await cloneRepo(feed.store, body, {
      ...(feed.userHome !== undefined ? { home: feed.userHome } : {}),
    });
    feed.remotes.invalidate(cloned.path);
    return jsonResponse({ repos: await list(), repo: cloned.name, path: cloned.path });
  } catch (err) {
    if (err instanceof CloneError) return errorResponse(err.status, err.message);
    return errorResponse(400, messageOf(err));
  }
}

/**
 * T362: Settings' folder picker:
 *
 *   GET /api/fs/dirs?path=&hidden=1&prefix=  the child folders of `path` (absolute or `~/…`;
 *       default the home folder), each flagged `git` when it is a git toplevel, with `parent`
 *       and `home` to navigate by (`DirListing`); a missing folder is 404, any other refusal 400
 *
 * A read, but it shows the filesystem: same-origin only, and only on a
 * loopback `Host` (a DNS-rebound page is same-origin to the browser and a
 * GET carries no `Origin`).
 */
function handleFsRoute(
  req: Request,
  url: URL,
  userHome: string | undefined,
  sameOrigin: () => boolean,
): Response | undefined {
  if (url.pathname !== '/api/fs/dirs' || req.method !== 'GET') return undefined;
  if (!sameOrigin() || !isLoopbackHost(req)) {
    return errorResponse(403, 'cross-origin request rejected');
  }
  const prefix = url.searchParams.get('prefix');
  try {
    return jsonResponse(
      listDirs(url.searchParams.get('path') ?? undefined, {
        hidden: url.searchParams.get('hidden') === '1',
        ...(prefix ? { prefix } : {}),
        ...(userHome !== undefined ? { home: userHome } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof DirListError) return errorResponse(err.status, err.message);
    return errorResponse(400, messageOf(err));
  }
}

/**
 * The rules routes (§5, §9):
 *
 *   GET  /api/rules               every rule, §5.7's pruning report, and whether evals can run
 *   POST /api/rules/:id/accept    the inbox card's and the rules screen's Accept
 *   POST /api/rules/:id/retire    …and Retire
 *   POST /api/rules/:id/update    the rules screen's edit (`KnowledgePatchSchema`, strict)
 *   POST /api/rules               the rules screen's "New rule" (`KnowledgeCreateInputSchema`, strict; proposed)
 *   POST /api/rules/test          "Test examples": `rule.test {id}`'s evals (`KnowledgeTestInputSchema`)
 *
 * The same `KnowledgeService` calls the `rule.*` RPC makes; every write is
 * same-origin only and stamped `human` (§2.2), never read from the body.
 * Returns `undefined` for a path that is not one of these.
 */
async function handleRuleRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
  noIdleTimeout: () => void,
): Promise<Response | undefined> {
  if (url.pathname === '/api/rules' && req.method === 'GET') {
    if (!feed?.rules) return errorResponse(503, 'rules not available');
    return jsonResponse({
      rules: feed.rules.list(),
      report: buildRuleReport(feed.rules),
      evals: evalsAvailable(feed)
        ? {
            available: true,
            ...(feed.ruleEvals?.timeout_ms !== undefined
              ? { timeout_ms: feed.ruleEvals.timeout_ms }
              : {}),
          }
        : { available: false },
    });
  }
  // "New rule": a proposal, like every create (§5.1).
  if (url.pathname === '/api/rules' && req.method === 'POST') {
    if (!feed?.rules) return errorResponse(503, 'rules not available');
    if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
    try {
      const input = KnowledgeCreateInputSchema.safeParse(await readJsonBody(req));
      if (!input.success) return errorResponse(400, formatZodError('new rule', input.error));
      return jsonResponse(
        await feed.rules.create('human', { ...input.data, source: { by: 'human' } }),
      );
    } catch (err) {
      return errorResponse(400, messageOf(err));
    }
  }
  const isTest = url.pathname === '/api/rules/test';
  const match = isTest
    ? undefined
    : url.pathname.match(/^\/api\/rules\/([^/]+)\/(accept|retire|update)$/);
  if ((!isTest && !match) || req.method !== 'POST') return undefined;
  if (!feed?.rules) return errorResponse(503, 'rules not available');
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');

  try {
    if (isTest) {
      const input = KnowledgeTestInputSchema.safeParse(await readJsonBody(req));
      if (!input.success) return errorResponse(400, formatZodError('rule test', input.error));
      if (!feed.ruleEvals || !evalsAvailable(feed)) {
        return errorResponse(
          503,
          'no classifier key loaded: set one in Settings, classifier.api_key in config.yaml, or TYPESAFE_API_KEY (§6.2)',
        );
      }
      // One classifier call per example: a real suite outlives Bun's 10 s
      // idle timeout, so this request waits as long as it takes.
      noIdleTimeout();
      return jsonResponse(await testRules(feed.rules, feed.ruleEvals, input.data.id));
    }
    const id = KnowledgeIdSchema.safeParse(decodeURIComponent(match?.[1] ?? ''));
    if (!id.success) return errorResponse(400, `invalid rule id: ${match?.[1]}`);
    const action = match?.[2];
    if (action === 'update') {
      const patch = KnowledgePatchSchema.safeParse(await readJsonBody(req));
      if (!patch.success) return errorResponse(400, formatZodError('rule edit', patch.error));
      return jsonResponse(await feed.rules.update('human', id.data, patch.data));
    }
    return jsonResponse(
      action === 'accept'
        ? await feed.rules.accept(id.data, 'human')
        : await feed.rules.retire(id.data, 'human'),
    );
  } catch (err) {
    if (err instanceof KnowledgeAlreadyDecidedError) return errorResponse(409, err.message);
    if (err instanceof NotFoundError) return errorResponse(404, err.message);
    return errorResponse(400, messageOf(err));
  }
}

/**
 * The stream page's routes (§9.3):
 *
 *   GET  /api/streams/:id         the page read (`feed/stream-page.ts`)
 *   GET  /api/streams/:id/diff    the diff tab
 *   POST /api/streams/:id/say     the composer: a human line, and a prompt to the attached worker;
 *                                 `{body, start?}`: `start` (T361) starts an agent on a node with none live
 *   POST /api/streams/:id/attach  the sessions strip's attach / review (`role: reviewer`)
 *   POST /api/streams/:id/stop    the sessions strip's stop (a human detach)
 *   POST /api/streams/:id/close   the page's Close
 *   POST /api/streams/:id/mark-landed  merged outside `land`
 *   POST /api/streams/:id/pr-check     Check now (T340): poll the node's open PR at once
 *   POST /api/streams/:id/add-repo     + Repo in place (T205): `{repo, switch?}`
 *   POST /api/streams/:id/wait         Link (T228, P8): `{on, remove?}` a `waits_on` edge
 *   POST /api/streams/:id/move         Move (T333, D34): `{parent}` a node or a project id
 *   POST /api/streams/:id/update       Rename (T365): `{title?, goal?}`, as `stream.update`
 *   POST /api/streams/:id/archive      Delete (T361): stops the subtree's sessions, archives it
 *                                      → `{node, archived: [ids], stopped: [session ids]}`
 *   POST /api/streams/:id/unarchive    Restore (T361): the node and what its delete archived
 *                                      → `{node, restored: [ids]}`; no agent is started
 *
 * `land` is matched before this. Every write is same-origin only
 * and stamps `human`; no principal is ever read from the body (§2.2).
 * Returns `undefined` for a path that is not one of these.
 */
async function handleStreamRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const match = url.pathname.match(
    /^\/api\/streams\/([^/]+)(?:\/(diff|say|attach|resolve|stop|close|mark-landed|pr-check|add-repo|wait|move|update|archive|unarchive))?$/,
  );
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

    // Close, Mark landed, Check now, Delete and Restore take no body.
    if (action === 'close') return jsonResponse(await feed.streams.close('human', id));
    if (action === 'pr-check') {
      if (!feed.prCheck) return errorResponse(503, 'PR polling not available');
      return jsonResponse(await feed.prCheck(id));
    }
    if (action === 'mark-landed') {
      if (!feed.landing) return errorResponse(503, 'landing not available');
      return jsonResponse(await feed.landing.markLanded(id));
    }
    if (action === 'archive') {
      // T361: Delete. The human pulls the plug on every agent in the subtree first.
      const attach = feed.attach;
      const stopped: string[] = [];
      const archived = await feed.streams.archiveTree('human', id, async (ids) => {
        if (attach === undefined) return;
        const each = await Promise.all(ids.map((n) => attach.stop(n, undefined, { detach: true })));
        stopped.push(...each.flat());
      });
      return jsonResponse({
        node: archived[0] ?? feed.streams.get(id),
        archived: archived.map((s) => s.id),
        stopped,
      });
    }
    if (action === 'unarchive') {
      const restored = await feed.streams.unarchiveTree('human', id);
      return jsonResponse({
        node: restored[0] ?? feed.streams.get(id),
        restored: restored.map((s) => s.id),
      });
    }
    const body = await readJsonBody(req);
    if (action === 'add-repo') {
      if (!feed.repoInPlace) return errorResponse(503, 'sessions not available');
      const input = StreamAddRepoRequestSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('add-repo', input.error));
      const { repo } = input.data;
      const result = input.data.switch
        ? await feed.repoInPlace.switchRepo(id, repo)
        : await feed.repoInPlace.addRepo(id, repo);
      return jsonResponse(result, 201);
    }
    if (action === 'wait') {
      const input = StreamWaitRequestSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('wait', input.error));
      const { on, remove } = input.data;
      return jsonResponse(await feed.streams.wait('human', id, on, remove ? { remove } : {}));
    }
    if (action === 'move') {
      const input = StreamMoveRequestSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('move', input.error));
      return jsonResponse(await feed.streams.move(id, input.data.parent));
    }
    if (action === 'update') {
      // T365: the same `StreamService.update` as the RPC's `stream.update`, title and goal only.
      const input = StreamUpdateRequestSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('update', input.error));
      const before = feed.streams.get(id);
      const updated = await feed.streams.update('human', id, input.data);
      // T385: a new goal is news for the agent: its next turn reads it on the thread.
      if (input.data.goal !== undefined && input.data.goal.trim() !== before.goal.trim()) {
        await feed.streams.appendThread('human', id, {
          kind: 'event',
          body: `goal changed: ${clip(updated.goal, GOAL_LINE_MAX)}`,
        });
      }
      return jsonResponse(updated);
    }
    if (action === 'say') {
      const input = StreamSayInputSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('say', input.error));
      if (feed.attach) {
        // The same path as `agile stream say` (`sayAndAnswer`).
        const attach = feed.attach;
        const said = await sayAndAnswer(
          {
            say: (streamId, text, opts) => attach.say(streamId, text, opts),
            ...(feed.questions ? { questions: feed.questions } : {}),
          },
          id,
          input.data.body,
          input.data.start === true ? { start: true } : {},
        );
        return jsonResponse(said, 201);
      }
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
      // The handle is in-process only; the wire carries the record.
      return jsonResponse({ session: result.session, stream: result.stream }, 201);
    }
    if (action === 'resolve') {
      // T176: the attach path, with the conflict instruction after the brief.
      if (!feed.landing) return errorResponse(503, 'landing not available');
      const input = StreamAttachRequestSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('resolve', input.error));
      const { vendor, model, effort } = input.data;
      const result = await feed.attach.attach(id, {
        ...(vendor ? { vendor } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        briefAppendix: feed.landing.resolvePrompt(id),
      });
      return jsonResponse({ session: result.session, stream: result.stream }, 201);
    }
    const sessions = await feed.attach.stop(id, undefined, { detach: true });
    return jsonResponse({ stopped: sessions.length > 0, sessions });
  } catch (err) {
    const message = messageOf(err);
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

/** Runs `bind`, retyping Bun's `EADDRINUSE` as `PortInUseError` (generic, to keep Bun's inferred server type). */
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

  const server = rethrowPortInUse(options, hostname, () =>
    Bun.serve({
      port: options.port,
      hostname,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const sameOrigin = () => isSameOriginRequest(req, srv.port ?? options.port);

        if (url.pathname === '/health') {
          const payload: HealthPayload = {
            version: options.version,
            stateRoot: options.stateRoot,
            pid: process.pid,
            uptime: (Date.now() - options.startedAt) / 1000,
          };
          return Response.json(payload);
        }

        // The cockpit is served at `/`; the v0 static feed page keeps `/feed`.
        if (url.pathname === '/') {
          return new Response(Bun.file(join(CONTROL_ROOM_DIST_DIR, 'index.html')), {
            // Revalidate on every load so a rebuild is never masked by a cached page.
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
          });
        }

        // The installable-app files are served from site root: a service
        // worker only controls pages under its own path, and the cockpit is `/`.
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

        // The cockpit's assets keep Vite's `/control-room/` base. The old
        // `/control-room` URL redirects to `/`, keeping `?view=` deep links.
        if (url.pathname === '/control-room' || url.pathname === '/control-room/') {
          // A relative `Location` is legal (RFC 7231 §7.1.2); `Response.redirect` needs an absolute URL.
          return new Response(null, { status: 302, headers: { location: `/${url.search}` } });
        }
        if (url.pathname.startsWith('/control-room/')) {
          const rel = url.pathname.slice('/control-room/'.length);
          const file = Bun.file(join(CONTROL_ROOM_DIST_DIR, rel));
          if (!(await file.exists())) return new Response('not found', { status: 404 });
          // Vite rewrites index.html's manifest/icon links onto this prefix.
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

        // Inbox (§3): one list, oldest first, across every stream.
        if (url.pathname === '/api/inbox' && req.method === 'GET') {
          if (!feed?.inbox) return errorResponse(503, 'inbox not available');
          return jsonResponse({ items: feed.inbox.list() });
        }

        // The cockpit frame (§9): the stream tree and the inbox.
        if (url.pathname === '/api/cockpit' && req.method === 'GET') {
          if (!feed?.streams) return errorResponse(503, 'streams not available');
          return jsonResponse(cockpitFrame(feed, feed.streams));
        }

        if (url.pathname === '/api/policy' && req.method === 'GET') {
          if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
          try {
            return jsonResponse(feed.store.getPolicy());
          } catch (err) {
            return errorResponse(404, messageOf(err));
          }
        }

        if (url.pathname === '/api/policy' && req.method === 'PUT') {
          if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
          if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
          try {
            const policy = validatePolicy(await readJsonBody(req));
            return jsonResponse(await feed.store.putPolicy(policy, { by: 'human' }));
          } catch (err) {
            return errorResponse(400, messageOf(err));
          }
        }

        const trackerRoute = await handleTrackerSettingsRoute(req, url, feed, sameOrigin);
        if (trackerRoute) return trackerRoute;
        const settingsRoute = await handleSettingsRoute(req, url, feed, sameOrigin);
        if (settingsRoute) return settingsRoute;

        const sessionSettingsRoute = await handleSessionSettingsRoute(req, url, feed, sameOrigin);
        if (sessionSettingsRoute) return sessionSettingsRoute;

        const autonomyRoute = await handleAutonomyRoute(req, url, feed, sameOrigin);
        if (autonomyRoute) return autonomyRoute;

        const linkRoute = await handleLinkRoute(req, url, feed, sameOrigin);
        if (linkRoute) return linkRoute;

        const planRoute = await handlePlanRoute(req, url, feed, sameOrigin);
        if (planRoute) return planRoute;

        const activityRoute = handleActivityRoute(req, url, feed);
        if (activityRoute) return activityRoute;

        const directorRoute = await handleDirectorRoute(req, url, feed, sameOrigin);
        if (directorRoute) return directorRoute;

        const repoRoute = await handleRepoRoute(req, url, feed, sameOrigin, () =>
          srv.timeout(req, 0),
        );
        if (repoRoute) return repoRoute;

        const fsRoute = handleFsRoute(req, url, options.userHome, sameOrigin);
        if (fsRoute) return fsRoute;

        const ruleRoute = await handleRuleRoute(req, url, feed, sameOrigin, () =>
          srv.timeout(req, 0),
        );
        if (ruleRoute) return ruleRoute;

        const landMatch = url.pathname.match(/^\/api\/streams\/([^/]+)\/land$/);
        if (landMatch && req.method === 'POST') {
          if (!feed?.landing) return errorResponse(503, 'landing not available');
          if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
          const id = UlidSchema.safeParse(decodeURIComponent(landMatch[1] ?? ''));
          if (!id.success) return errorResponse(400, `invalid stream id: ${landMatch[1]}`);
          try {
            return jsonResponse(await feed.landing.land(id.data));
          } catch (err) {
            if (err instanceof LandRefusedError) return errorResponse(409, err.message);
            return errorResponse(400, messageOf(err));
          }
        }

        // T208: the rail's switcher and "New project" (the same service as `project.*`).
        if (url.pathname === '/api/projects') {
          if (!feed?.projects) return errorResponse(503, 'projects not available');
          if (req.method === 'GET') return jsonResponse(feed.projects.list());
          if (req.method === 'POST') {
            if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
            try {
              return jsonResponse(await feed.projects.create(await readJsonBody(req)), 201);
            } catch (err) {
              return errorResponse(400, messageOf(err));
            }
          }
        }

        // "New stream" and quick capture (§9.1): the same `StreamService.create` as the RPC.
        if (url.pathname === '/api/streams' && req.method === 'POST') {
          if (!feed?.streams) return errorResponse(503, 'streams not available');
          if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
          try {
            const input = StreamCreateInputSchema.safeParse(await readJsonBody(req));
            if (!input.success) return errorResponse(400, formatZodError('stream', input.error));
            // T208: every node the cockpit makes belongs to a project.
            // T204: and starts its agent unless "Start later" was ticked.
            const create = feed.attach
              ? feed.attach.createNode.bind(feed.attach)
              : feed.streams.create.bind(feed.streams);
            return jsonResponse(await create('human', input.data, { requireProject: true }), 201);
          } catch (err) {
            // An unknown parent or repo, or a bad body: the human's to fix.
            return errorResponse(400, messageOf(err));
          }
        }

        const streamRoute = await handleStreamRoute(req, url, feed, sameOrigin);
        if (streamRoute) return streamRoute;

        // Questions: read, raise, answer.
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
          if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
          return handleQuestionRaise(req, feed.questions);
        }

        const questionAnswerMatch = matchQuestionAnswer(url.pathname);
        if (questionAnswerMatch && req.method === 'POST') {
          if (!feed?.questions) return errorResponse(503, 'questions store not available');
          if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
          return handleQuestionAnswer(req, feed.questions, questionAnswerMatch);
        }

        const hilMatch = matchHilAction(url.pathname);
        if (hilMatch && req.method === 'POST') {
          if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
          if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
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
            // The snapshot's events stop where the tailer has read to: a line
            // past that seam reaches this socket as a live `event` frame on the
            // next poll, so reading it here too would deliver it twice.
            ws.send(
              JSON.stringify(
                buildSnapshot(
                  feed.store,
                  feed.gates,
                  undefined,
                  feed.questions,
                  options.repoRoot,
                  tailer?.getOffset(),
                ),
              ),
            );
            if (feed.streams) {
              ws.send(JSON.stringify(cockpitFrame(feed, feed.streams)));
            }
          }
        },
        message() {
          // No client -> server protocol: tail only.
        },
      },
    }),
  );

  // T362: a repo's remote is read in the background; when one changes, re-push the frame once.
  // T380: the same for a finished node's "nothing to merge".
  let remotePush: ReturnType<typeof setTimeout> | undefined;
  if (feed?.streams) {
    const streams = feed.streams;
    const repush = (): void => {
      if (remotePush !== undefined) return;
      remotePush = setTimeout(() => {
        remotePush = undefined;
        try {
          server.publish(FEED_WS_TOPIC, JSON.stringify(cockpitFrame(feed, streams)));
        } catch (err) {
          console.error(messageOf(err));
        }
      }, 50);
    };
    feed.remotes.onChange = repush;
    if (feed.mergeState) feed.mergeState.onChange = repush;
    try {
      feed.remotes.warm(Object.values(feed.store.getRepos()));
    } catch {
      // A corrupt repos.yaml is refused, with its path, wherever it is read.
    }
  }

  if (feed) {
    tailer = startEventTailer({
      path: `${options.stateRoot}/log/events.jsonl`,
      pollIntervalMs: options.feedPollIntervalMs,
      onEvents: (newEvents) => {
        for (const event of newEvents) {
          server.publish(FEED_WS_TOPIC, JSON.stringify({ type: 'event', event }));
        }
        // Any new batch may change the inbox or a status pair: re-derive and
        // push the cockpit frame once per batch (§3.3 "push, do not poll").
        if (feed.streams && newEvents.length > 0) {
          try {
            server.publish(FEED_WS_TOPIC, JSON.stringify(cockpitFrame(feed, feed.streams)));
          } catch (err) {
            console.error(messageOf(err));
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
      if (feed) feed.remotes.onChange = undefined;
      if (feed?.mergeState) feed.mergeState.onChange = undefined;
      clearTimeout(remotePush);
      server.stop(true);
    },
  };
}
