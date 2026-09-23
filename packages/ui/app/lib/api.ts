/**
 * The cockpit's writes (T160). Every one goes through the same daemon
 * endpoints the CLI's verbs reach, so it lands in the event log, and none
 * of them sends an actor — the daemon stamps `human` at the HTTP edge
 * (cockpit design §2.2).
 */

import type { Policy, Rule, RulePatch, Stream, StreamCreateInput } from '@agile-agents/shared';
import type {
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

/** T161: the composer — a human line on the thread, and a prompt to the attached worker if there is one. */
export function sayOnStream(id: string, body: string): Promise<{ prompted?: string }> {
  return post(`/api/streams/${encodeURIComponent(id)}/say`, { body }) as Promise<{
    prompted?: string;
  }>;
}

/** T161: the sessions strip's Attach (a worker) and Review (a reviewer). */
export function attachSession(id: string, role: 'worker' | 'reviewer'): Promise<unknown> {
  return post(`/api/streams/${encodeURIComponent(id)}/attach`, { role });
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

export async function getPolicy(): Promise<Policy> {
  const res = await fetch('/api/policy');
  const payload = (await res.json()) as Policy & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `policy read failed (${res.status})`);
  return payload;
}
