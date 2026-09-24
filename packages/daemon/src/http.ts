/**
 * Localhost HTTP + WebSocket: `GET /health`, the cockpit bundle at `/`,
 * and, with a `StateStore` + `GateService`, the cockpit's JSON routes
 * (snapshot, inbox, streams, rules, questions, gates, settings) plus a
 * `/ws` that sends `hello` + snapshot and then tails `log/events.jsonl` as
 * `{type:'event'}` frames. Every write route is same-origin only
 * (`isSameOriginRequest`) and records the actor as `human`. Without a
 * store the feed routes 503 and `/ws` sends only the hello frame.
 */

import { join } from 'node:path';
import {
  ClassifierKeyInputSchema,
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
  StreamAddRepoRequestSchema,
  StreamAttachRequestSchema,
  StreamCreateInputSchema,
  StreamSayInputSchema,
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
import type { ContractService } from './coordination/contracts';
import { PlanNotDraftError, type PlanService } from './coordination/plans';
import { type DeliveryService, LandRefusedError } from './delivery';
import type { DocsService } from './docs';
import type { RoutedEventService } from './events';
import {
  type EventTailerHandle,
  buildCockpitFrame,
  buildSnapshot,
  buildStreamPage,
  startEventTailer,
} from './feed';
import { GateAlreadyResolvedError, GateNotFoundError, type GateService } from './gates';
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
  NotFoundError,
  type StateStore,
  buildStateRpcMethods,
  resolveMainBranch,
  setRepoSettings,
} from './store';
import type { RepoInPlaceService, StreamService } from './streams';

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
  /** The rules routes (`/api/rules...`). */
  rules?: KnowledgeService;
  /** "Test examples": `rule.test`'s evals through the configured classifier. */
  ruleEvals?: RuleRpcEvalDeps;
  /** The classifier key behind Settings, and whether evals can run (without it, whenever `ruleEvals` is given). */
  classifierKey?: ClassifierKeyService;
  /** `POST /api/streams/:id/land`. */
  landing?: DeliveryService;
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
  /** Test hook: the tailer's poll interval (default 250ms). */
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
  questions?: QuestionService;
  inbox?: InboxService;
  rules?: KnowledgeService;
  ruleEvals?: RuleRpcEvalDeps;
  classifierKey?: ClassifierKeyService;
  landing?: DeliveryService;
  attach?: AttachService;
  repoInPlace?: RepoInPlaceService;
  docs?: DocsService;
  /** T222: the pr refusal's GitHub auth check; absent reads as unavailable. */
  githubAuth?: () => Promise<boolean>;
  events?: RoutedEventService;
  plans?: PlanService;
  contracts?: ContractService;
}

function resolveFeedContext(options: HttpServerOptions): FeedContext | undefined {
  if (!options.store || !options.gates) return undefined;
  return {
    store: options.store,
    gates: options.gates,
    streams: options.streams,
    projects: options.projects,
    questions: options.questions,
    inbox: options.inbox,
    rules: options.rules,
    ruleEvals: options.ruleEvals,
    classifierKey: options.classifierKey,
    landing: options.landing,
    attach: options.attach,
    repoInPlace: options.repoInPlace,
    docs: options.docs,
    githubAuth: options.githubAuth,
    events: options.events,
    plans: options.plans,
    contracts: options.contracts,
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
 * T245 (projects-design §8): read-only event views.
 *
 *   GET /api/streams/:id/activity  every event routed to the node: reason, delivery status, session or digest
 *   GET /api/repos/:name/events    every event on the repo
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

/**
 * T281 (projects-design §9.1, §14.4): the Plan tab and its approval.
 *
 *   GET  /api/streams/:id/plan          `{plan, contracts}`: the node's plan (or null) and its contracts
 *   POST /api/streams/:id/plan/approve  the human approves the draft plan (the inbox card's button)
 */
async function handlePlanRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/streams\/([^/]+)\/plan(\/approve)?$/);
  if (!match) return undefined;
  const approve = match[2] !== undefined;
  if (req.method !== (approve ? 'POST' : 'GET')) return undefined;
  if (!feed?.plans || !feed.contracts) return errorResponse(503, 'plans not available');
  const id = UlidSchema.safeParse(decodeURIComponent(match[1] ?? ''));
  if (!id.success) return errorResponse(400, `invalid stream id: ${match[1]}`);
  if (approve && !sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  try {
    if (approve) return jsonResponse(await feed.plans.approve(id.data, 'human'));
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
 * T206: Settings → Repos, over the same `state.repo_add` RPC as `agile repo add`:
 *
 *   GET  /api/repos   every registered repo with its resolved `main_branch`
 *   POST /api/repos   `{name, path, protected_branches?}`; a bad path is the RPC's one-line 400
 *   POST /api/repos/:name  T222: delivery settings (`RepoSettingsPatchSchema`), same checks as `agile repo set`
 */
async function handleRepoRoute(
  req: Request,
  url: URL,
  feed: FeedContext | undefined,
  sameOrigin: () => boolean,
): Promise<Response | undefined> {
  const one = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
  if (url.pathname !== '/api/repos' && !one) return undefined;
  if (req.method !== 'GET' && req.method !== 'POST') return undefined;
  if (one && req.method !== 'POST') return undefined;
  if (!feed) return errorResponse(503, 'state store not initialised (run `agile init`)');
  const list = () =>
    Object.entries(feed.store.getRepos()).map(([name, entry]) => ({
      name,
      path: entry.path,
      protected_branches: entry.protected_branches,
      main_branch: resolveMainBranch(entry),
      delivery: entry.delivery ?? 'direct',
      auto_merge: entry.auto_merge ?? false,
      visibility: entry.visibility ?? { mode: 'public' },
      ...(entry.github ? { github: entry.github } : {}),
    }));
  if (one?.[1] !== undefined) {
    if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
    let patch: unknown;
    try {
      patch = await readJsonBody(req);
    } catch {
      return errorResponse(400, 'invalid repo settings: body must be JSON');
    }
    try {
      await setRepoSettings(feed.store, decodeURIComponent(one[1]), patch, {
        by: 'human',
        ...(feed.githubAuth ? { githubAuth: feed.githubAuth } : {}),
      });
      return jsonResponse({ repos: list() });
    } catch (err) {
      return errorResponse(400, messageOf(err));
    }
  }
  if (req.method === 'GET') return jsonResponse({ repos: list() });
  if (!sameOrigin()) return errorResponse(403, 'cross-origin request rejected');
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return errorResponse(400, 'invalid repo: body must be JSON {name, path, protected_branches?}');
  }
  try {
    await buildStateRpcMethods(feed.store)['state.repo_add']?.(body);
    return jsonResponse({ repos: list() });
  } catch (err) {
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
 *   POST /api/streams/:id/say     the composer: a human line, and a prompt to the attached worker
 *   POST /api/streams/:id/attach  the sessions strip's attach / review (`role: reviewer`)
 *   POST /api/streams/:id/stop    the sessions strip's stop (a human detach)
 *   POST /api/streams/:id/close   the page's Close
 *   POST /api/streams/:id/mark-landed  merged outside `land`
 *   POST /api/streams/:id/add-repo     + Repo in place (T205): `{repo, switch?}`
 *   POST /api/streams/:id/wait         Link (T228, P8): `{on, remove?}` a `waits_on` edge
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
    /^\/api\/streams\/([^/]+)(?:\/(diff|say|attach|resolve|stop|close|mark-landed|add-repo|wait))?$/,
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

    // Close and Mark landed take no body.
    if (action === 'close') return jsonResponse(await feed.streams.close('human', id));
    if (action === 'mark-landed') {
      if (!feed.landing) return errorResponse(503, 'landing not available');
      return jsonResponse(await feed.landing.markLanded(id));
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
    if (action === 'say') {
      const input = StreamSayInputSchema.safeParse(body);
      if (!input.success) return errorResponse(400, formatZodError('say', input.error));
      if (feed.attach) {
        // The same path as `agile stream say` (`sayAndAnswer`).
        const attach = feed.attach;
        const said = await sayAndAnswer(
          {
            say: (streamId, text) => attach.say(streamId, text),
            ...(feed.questions ? { questions: feed.questions } : {}),
          },
          id,
          input.data.body,
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
          return jsonResponse(
            buildCockpitFrame(feed.streams, feed.inbox, feed.projects, feed.store.getRepos()),
          );
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

        const settingsRoute = await handleSettingsRoute(req, url, feed, sameOrigin);
        if (settingsRoute) return settingsRoute;

        const sessionSettingsRoute = await handleSessionSettingsRoute(req, url, feed, sameOrigin);
        if (sessionSettingsRoute) return sessionSettingsRoute;

        const planRoute = await handlePlanRoute(req, url, feed, sameOrigin);
        if (planRoute) return planRoute;

        const activityRoute = handleActivityRoute(req, url, feed);
        if (activityRoute) return activityRoute;

        const repoRoute = await handleRepoRoute(req, url, feed, sameOrigin);
        if (repoRoute) return repoRoute;

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
            ws.send(
              JSON.stringify(
                buildSnapshot(feed.store, feed.gates, undefined, feed.questions, options.repoRoot),
              ),
            );
            if (feed.streams) {
              ws.send(
                JSON.stringify(
                  buildCockpitFrame(feed.streams, feed.inbox, feed.projects, feed.store.getRepos()),
                ),
              );
            }
          }
        },
        message() {
          // No client -> server protocol: tail only.
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
        // Any new batch may change the inbox or a status pair: re-derive and
        // push the cockpit frame once per batch (§3.3 "push, do not poll").
        if (feed.streams && newEvents.length > 0) {
          try {
            server.publish(
              FEED_WS_TOPIC,
              JSON.stringify(
                buildCockpitFrame(feed.streams, feed.inbox, feed.projects, feed.store.getRepos()),
              ),
            );
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
      server.stop(true);
    },
  };
}
