/**
 * The cockpit's writes (T160). Every one goes through the same daemon
 * endpoints the CLI's verbs reach, so it lands in the event log, and none
 * of them sends an actor — the daemon stamps `human` at the HTTP edge
 * (cockpit design §2.2).
 */

import type {
  Autonomy,
  AutonomyProposal,
  ClassifierKeyStatus,
  Contract,
  Plan,
  Policy,
  Project,
  RoutedEvent,
  KnowledgeItem as Rule,
  KnowledgeCreateInput as RuleCreateInput,
  KnowledgePatch as RulePatch,
  SessionDefaultsPatch,
  SessionDefaultsStatus,
  Stream,
  StreamCreateInput,
  ThreadEntry,
  TrackerSettingsInput,
  TrackerSettingsStatus,
} from '@agile-agents/shared';
import type {
  ActivityEntry,
  LandOutcome,
  RuleEvalReport,
  RulesPayload,
  StreamDiff,
  StreamPagePayload,
} from './feed-types';

async function post(path: string, body: unknown = {}, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} failed (${res.status})`);
  return payload;
}

/** T162: "New stream" and the top bar's quick capture. */
export function createStream(input: StreamCreateInput): Promise<Stream> {
  return post('/api/streams', input) as Promise<Stream>;
}

/** T208: the rail's "New project". */
export function createProject(name: string): Promise<Project> {
  return post('/api/projects', { name }) as Promise<Project>;
}

/** A question card: the typed text reaches the asking session verbatim (§3.3). */
export function answerQuestion(id: string, answer: string): Promise<unknown> {
  return post(`/api/questions/${encodeURIComponent(id)}/answer`, { answer });
}

/** A gate card (`classifier_review`, `land`): allow/deny, optionally with the typed reason. */
export function decideGate(
  id: string,
  decision: 'approve' | 'deny',
  note?: string,
): Promise<unknown> {
  return post(`/api/hil/${encodeURIComponent(id)}/${decision}`, note ? { note } : {});
}

/** A gate card's free text with no decision — recorded on the pending gate. */
export function noteGate(id: string, note: string): Promise<unknown> {
  return post(`/api/hil/${encodeURIComponent(id)}/note`, { note });
}

/** T167: the rules screen's "New rule" — always a proposal (§5.1). */
export function createRule(input: RuleCreateInput): Promise<Rule> {
  return post('/api/rules', input) as Promise<Rule>;
}

/** T167: Settings — where the classifier key comes from. Never the key. */
export async function getClassifierKey(): Promise<ClassifierKeyStatus> {
  const res = await fetch('/api/settings/classifier');
  const payload = (await res.json()) as ClassifierKeyStatus & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `classifier settings read failed (${res.status})`);
  return payload;
}

/** T167: Settings' Save — write-only; the reply is the status, not the key. */
export function saveClassifierKey(apiKey: string): Promise<ClassifierKeyStatus> {
  return post('/api/settings/classifier/key', { api_key: apiKey }) as Promise<ClassifierKeyStatus>;
}

/** T167: Settings' Remove — deletes the config key; an env key still applies. */
export function removeClassifierKey(): Promise<ClassifierKeyStatus> {
  return post('/api/settings/classifier/key/remove') as Promise<ClassifierKeyStatus>;
}

/** T326: Settings → Trackers — Jira's base URL/email and whether each token is set. Never a token. */
export async function getTrackerSettings(): Promise<TrackerSettingsStatus> {
  const res = await fetch('/api/settings/trackers');
  const payload = (await res.json()) as TrackerSettingsStatus & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `tracker settings read failed (${res.status})`);
  return payload;
}

/** T326: one tracker write (`null` removes a field); the reply is the status, not the token. */
export function saveTrackerSettings(input: TrackerSettingsInput): Promise<TrackerSettingsStatus> {
  return post('/api/settings/trackers', input) as Promise<TrackerSettingsStatus>;
}

/** T163: the rules screen's edit (`RulePatchSchema` on the daemon side). */
export function updateRule(id: string, patch: RulePatch): Promise<Rule> {
  return post(`/api/rules/${encodeURIComponent(id)}/update`, patch) as Promise<Rule>;
}

/**
 * T163: "Test examples" — `rule.test {id}`. One classifier call per
 * example, so the caller sizes the deadline (`evalDeadlineMs`); past it the
 * request is abandoned with a message saying so.
 */
export async function testRule(id: string, deadlineMs: number): Promise<RuleEvalReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return (await post('/api/rules/test', { id }, controller.signal)) as RuleEvalReport;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`no answer within ${Math.round(deadlineMs / 1000)} s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A `rule_accept` card, and the rules screen's Accept/Retire (one rule at a time, bulk included). */
export function decideRule(id: string, decision: 'accept' | 'retire'): Promise<unknown> {
  return post(`/api/rules/${encodeURIComponent(id)}/${decision}`);
}

/** A `done` card's Land button, and the stream page's (§8.2). A refusal rejects with the daemon's reason. */
export function landStream(id: string): Promise<LandOutcome> {
  return post(`/api/streams/${encodeURIComponent(id)}/land`) as Promise<LandOutcome>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `${path} failed (${res.status})`);
  return payload;
}

/** T163: the rules screen's one read. */
export function getRules(): Promise<RulesPayload> {
  return get('/api/rules');
}

/** T161: the stream page's one read. */
export function getStreamPage(id: string): Promise<StreamPagePayload> {
  return get(`/api/streams/${encodeURIComponent(id)}`);
}

/** T161: the diff tab. */
export function getStreamDiff(id: string): Promise<StreamDiff> {
  return get(`/api/streams/${encodeURIComponent(id)}/diff`);
}

/** T245: the Activity tab. */
/** T281: the Plan tab's read — the node's plan (null before one is written) and its contracts. */
export function getStreamPlan(id: string): Promise<{ plan: Plan | null; contracts: Contract[] }> {
  return get(`/api/streams/${encodeURIComponent(id)}/plan`);
}

/** T281: a `plan_approve` card's Approve, and the Plan tab's. */
export function approvePlan(id: string): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/plan/approve`);
}

/** T282: a coordinator's `proposal` card: Apply performs it as you, Dismiss drops it. */
export function decideProposal(id: string, decision: 'apply' | 'dismiss'): Promise<unknown> {
  return post(`/api/proposals/${encodeURIComponent(id)}/${decision}`);
}

/** T282: the node's coordinator autonomy override; `null` inherits the project's. */
export function setNodeAutonomy(id: string, autonomy: Autonomy | null): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/autonomy`, { autonomy });
}

/** T282: the project's coordinator (or Director) autonomy. */
export function setProjectAutonomy(
  id: string,
  autonomy: { coordinator?: Autonomy; director?: Autonomy },
): Promise<unknown> {
  return post(`/api/projects/${encodeURIComponent(id)}`, { autonomy });
}

/** T300: the Director page (projects-design §12): its thread, session and activity. */
export interface DirectorPayload {
  record?: {
    created_at: string;
    session?: { id: string; status: string; vendor: string; model: string };
  };
  thread: ThreadEntry[];
  live: boolean;
  activity: ActivityEntry[];
  /** T301: the Director's held changes; Create/Apply goes through `decideProposal`. */
  proposals: AutonomyProposal[];
}

export function getDirector(): Promise<DirectorPayload> {
  return get<DirectorPayload>('/api/director');
}

/** T300: a line to the Director (`agile director say`). */
export function sayToDirector(body: string): Promise<unknown> {
  return post('/api/director/say', { body });
}

export async function getStreamActivity(id: string): Promise<ActivityEntry[]> {
  const out = await get<{ activity: ActivityEntry[] }>(
    `/api/streams/${encodeURIComponent(id)}/activity`,
  );
  return out.activity;
}

/** T245: the repo view's events. */
export async function getRepoEvents(repo: string): Promise<RoutedEvent[]> {
  const out = await get<{ events: RoutedEvent[] }>(`/api/repos/${encodeURIComponent(repo)}/events`);
  return out.events;
}

/** T265: the repo's accepted standards and architecture. */
export async function getRepoKnowledge(repo: string): Promise<Rule[]> {
  const res = await get<{ knowledge: Rule[] }>(`/api/repos/${encodeURIComponent(repo)}/knowledge`);
  return res.knowledge;
}

/** T161: the composer — a human line on the thread, and a prompt to the attached worker if there is one. */
export function sayOnStream(id: string, body: string): Promise<{ prompted?: string }> {
  return post(`/api/streams/${encodeURIComponent(id)}/say`, { body }) as Promise<{
    prompted?: string;
  }>;
}

/** T161: the sessions strip's Attach (a worker) and Review (a reviewer). */
export function attachSession(
  id: string,
  role: 'worker' | 'reviewer',
  choice: { vendor?: string; model?: string; effort?: string } = {},
): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/attach`, {
    role,
    ...choice,
  });
}

/** T176: Resolve — a worker told to merge the target in and fix the last land's conflicts. */
export function resolveConflict(
  id: string,
  choice: { vendor?: string; model?: string; effort?: string } = {},
): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/resolve`, choice);
}

/** T170 (D17): every step of the session-default order, and what it resolves to. */
export async function getSessionDefaults(): Promise<SessionDefaultsStatus> {
  const res = await fetch('/api/settings/session');
  const payload = (await res.json()) as SessionDefaultsStatus & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `session defaults read failed (${res.status})`);
  return payload;
}

/** T170: Settings' home-wide defaults (`null` clears a field). */
export function saveHomeSessionDefaults(
  patch: SessionDefaultsPatch,
): Promise<SessionDefaultsStatus> {
  return post('/api/settings/session', patch) as Promise<SessionDefaultsStatus>;
}

/** T170: one repo's defaults in `repos.yaml` (`null` clears a field). */
export function saveRepoSessionDefaults(
  repo: string,
  patch: SessionDefaultsPatch,
): Promise<SessionDefaultsStatus> {
  return post(
    `/api/settings/session/repos/${encodeURIComponent(repo)}`,
    patch,
  ) as Promise<SessionDefaultsStatus>;
}

/** T161: the sessions strip's Stop — detaches whatever is live on the stream. */
export function stopSessions(id: string): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/stop`);
}

/** T166: the stream page's Close (`human.status: closed`, actor human). */
export function closeStream(id: string): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/close`);
}

/** T166: a branch merged outside `land` — record it as landed. */
export function markStreamLanded(id: string): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/mark-landed`);
}

/** T205: + Repo in place (projects-design §7); `switch` moves a work node with nothing committed. */
export function addRepoToStream(id: string, repo: string, switching = false): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/add-repo`, {
    repo,
    ...(switching ? { switch: true } : {}),
  });
}

/** T228: the stream page's Link — delivery waits until `on` is merged (P8); `remove` drops it. */
export function waitOnStream(id: string, on: string, remove = false): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/wait`, { on, ...(remove ? { remove } : {}) });
}

export async function getPolicy(): Promise<Policy> {
  const res = await fetch('/api/policy');
  const payload = (await res.json()) as Policy & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `policy read failed (${res.status})`);
  return payload;
}

/** T206: a registered repo as Settings → Repos shows it. */
export interface RepoRow {
  name: string;
  path: string;
  protected_branches: string[];
  main_branch: string;
  /** T222 (§14.8). */
  delivery: 'direct' | 'pr';
  auto_merge: boolean;
  visibility: { mode: 'public' } | { mode: 'private'; projects: string[] };
  github?: { owner: string; repo: string };
}

/** T222: one repo's delivery settings; `pr` is refused without a GitHub remote and auth. */
export async function saveRepoSettings(
  name: string,
  patch: {
    delivery?: 'direct' | 'pr';
    auto_merge?: boolean;
    visibility?: RepoRow['visibility'];
  },
): Promise<RepoRow[]> {
  return ((await post(`/api/repos/${encodeURIComponent(name)}`, patch)) as { repos: RepoRow[] })
    .repos;
}

export async function listRepos(): Promise<RepoRow[]> {
  return (await get<{ repos: RepoRow[] }>('/api/repos')).repos;
}

/** T206: the same `state.repo_add` RPC as `agile repo add`; resolves to every repo. */
export async function addRepo(input: {
  name: string;
  path: string;
  protected_branches?: string[];
}): Promise<RepoRow[]> {
  return ((await post('/api/repos', input)) as { repos: RepoRow[] }).repos;
}
