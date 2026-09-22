/**
 * `LessonsService` — the retro, per stream, with the human as the only
 * decider (design/cockpit-design.md §5.5, T141).
 *
 * On land or close the daemon calls `onStreamEnd(streamId)`. If the stream
 * had **any** findings, hook denials or answered questions, one short
 * one-shot session runs over exactly that material (`briefs/lessons.md`,
 * the worker vendor, the reviewer's read-only policy) and is asked for at
 * most three proposed rules, each with two example actions. The proposals
 * go through the ordinary `propose_rule` verb, so they land as §5.1 records
 * with `status: 'proposed'` and provenance pointing at this stream — and
 * appear in the inbox as `rule_accept` items (T140). Only the human accepts.
 *
 * If there were no findings, no denials and no questions, no session runs:
 * "a stream that went smoothly teaches nothing, and a system that proposes
 * a rule after every stream trains the human to click accept without
 * reading". That path writes one `daemon` thread line and costs nothing.
 *
 * The three-proposal cap is enforced here rather than in the brief, because
 * a sentence in a brief is not a gate (CLAUDE.md): `assertCanPropose` is
 * consulted by the `propose_rule` verb for a `lessons` caller, and the
 * fourth call is refused with the reason the model reads.
 *
 * Fire-and-forget by design: `onStreamEnd` never throws at its callers
 * (`landing/service.ts`, `streams/service.ts` `close`). A retro that cannot
 * start is a thread line, never a failed land.
 */

import type { Question, Rule, Stream } from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { AttachOptions, AttachResult } from '../attach/service';
import { liveSession } from '../attach/service';
import type { VerbCaller } from '../attach/verbs';
import type { RulesService } from '../rules/service';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';

/** §5.5: "at most three" proposed rules out of one retro. */
export const MAX_LESSON_PROPOSALS = 3;

/** How much material one retro carries — a pointer-sized brief, not a dump. */
export const MAX_MATERIAL_ITEMS = 20;

/** The fourth `propose_rule` call from one lessons session (§5.5's cap). */
export class LessonQuotaError extends Error {
  constructor(session: string) {
    super(
      `propose_rule refused: this lessons session (${session}) has already proposed ${MAX_LESSON_PROPOSALS} rules, which is the most one retro may propose — end your turn`,
    );
    this.name = 'LessonQuotaError';
  }
}

/** The slice of `AttachService` a retro needs: start one session. */
export interface LessonsAttachSource {
  attach(streamId: string, options?: AttachOptions): Promise<AttachResult>;
}

/** The read side of `QuestionService` the material is drawn from. */
export interface LessonsQuestionsSource {
  list(): Question[];
}

export interface LessonsServiceOptions {
  store: StateStore;
  streams: StreamService;
  attach: LessonsAttachSource;
  rules: RulesService;
  questions?: LessonsQuestionsSource;
}

/** What one stream taught, as the retro is given it. */
export interface LessonsMaterial {
  findings: string[];
  denials: string[];
  questions: string[];
}

export function isEmptyMaterial(material: LessonsMaterial): boolean {
  return (
    material.findings.length === 0 &&
    material.denials.length === 0 &&
    material.questions.length === 0
  );
}

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line.slice(0, MESSAGE_BODY_MAX_CHARS)}`).join('\n');
}

/** The material and the instruction, appended after `briefs/lessons.md`. */
export function renderMaterial(stream: Stream, material: LessonsMaterial): string {
  const parts: string[] = [`## What this stream (${stream.id}) produced`];
  parts.push(
    material.findings.length > 0
      ? `### Findings\n\n${bullets(material.findings)}`
      : '### Findings\n\nnone',
  );
  parts.push(
    material.denials.length > 0
      ? `### Hook denials\n\n${bullets(material.denials)}`
      : '### Hook denials\n\nnone',
  );
  parts.push(
    material.questions.length > 0
      ? `### Questions the work had to stop for\n\n${bullets(material.questions)}`
      : '### Questions the work had to stop for\n\nnone',
  );
  parts.push(
    [
      '## Your instruction',
      '',
      `Propose **at most ${MAX_LESSON_PROPOSALS}** rules with \`propose_rule\`, and only rules this`,
      'material actually supports. Each call carries:',
      '',
      '- `text` — the rule as the operator would say it;',
      '- `examples` — exactly two `{action, violates}` actions, one that',
      '  violates the rule and one that does not;',
      '- `scope` — `repo` or `stream`, never global;',
      '- `enforcement` — your guess of `pattern`, `classifier` or `guidance`,',
      '  with the one-line reason in the rule text if it is not obvious;',
      '- `critical` — only for something a human cannot cheaply undo.',
      '',
      'Then end your turn. Nothing else is expected of you: a human decides',
      'every proposal, and a fourth call is refused.',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

export class LessonsService {
  constructor(private readonly options: LessonsServiceOptions) {}

  /**
   * Everything the retro reads (§5.5's "exactly that material"): the
   * stream's findings (the structured list and the thread's `finding`
   * entries), the hook denials recorded for its sessions, and the questions
   * the work had to stop for.
   */
  material(streamId: string): LessonsMaterial {
    const stream = this.options.streams.get(streamId);
    const sessionIds = new Set(stream.sessions.map((session) => session.id));

    const findings = new Set<string>();
    for (const finding of stream.agent.findings ?? []) {
      findings.add(
        `${finding.severity} ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''} — ${finding.text}`,
      );
    }
    for (const entry of this.options.streams.readThread(streamId, { limit: 500 }).entries) {
      if (entry.kind === 'finding') findings.add(entry.body);
    }

    const denials: string[] = [];
    for (const event of this.options.store.listEvents()) {
      if (event.kind !== 'hook_decision') continue;
      const data = (event.data ?? {}) as Record<string, unknown>;
      const decision = typeof data.decision === 'string' ? data.decision : undefined;
      if (decision !== 'deny') continue;
      // The event names either the stream outright (the hook endpoint) or
      // the session it came from (the ACP responder); both are this stream's.
      const onStream = data.stream === streamId;
      const onSession = event.agent !== undefined && sessionIds.has(event.agent);
      if (!onStream && !onSession) continue;
      const what = [data.tool, data.toolClass, data.command, data.targetPath]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ');
      denials.push(
        `denied ${what.length > 0 ? what : String(data.event ?? 'tool call')}: ${String(data.reason ?? 'no reason recorded')}`,
      );
    }

    const questions = (this.options.questions?.list() ?? [])
      .filter((question) => question.stream === streamId && question.status === 'answered')
      .map((question) => `asked "${question.text}" → answered "${question.answer ?? ''}"`);

    return {
      findings: [...findings].slice(-MAX_MATERIAL_ITEMS),
      denials: denials.slice(-MAX_MATERIAL_ITEMS),
      questions: questions.slice(-MAX_MATERIAL_ITEMS),
    };
  }

  /**
   * The land/close hook (§5.5). Starts the retro, or says on the thread why
   * it did not. Never throws: the caller is a land that already happened.
   */
  async onStreamEnd(streamId: string): Promise<void> {
    try {
      const stream = this.options.streams.get(streamId);
      // A session still running on this stream would be reviewing or
      // working on material the retro has not seen the end of.
      if (liveSession(stream, 'lessons') !== undefined) return;
      const material = this.material(streamId);
      if (isEmptyMaterial(material)) {
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: 'no lessons: nothing to learn from',
        });
        return;
      }
      await this.options.streams.appendThread('daemon', streamId, {
        kind: 'event',
        body: 'lessons: session started',
      });
      await this.options.attach.attach(streamId, {
        role: 'lessons',
        briefAppendix: renderMaterial(stream, material),
      });
    } catch (err) {
      await this.options.streams
        .appendThread('daemon', streamId, {
          kind: 'event',
          body: `lessons did not run: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            800,
          ),
        })
        .catch(() => {
          // The stream is gone — nothing left to record it on.
        });
    }
  }

  /** Rules this session has already proposed (provenance is the record, §5.1). */
  proposedBy(session: string): Rule[] {
    return this.options.rules.list().filter((rule) => rule.provenance.session === session);
  }

  /**
   * §5.5's cap, as a gate rather than a sentence in a brief: the fourth
   * `propose_rule` call from one lessons session is refused, with the
   * reason the model reads. Other roles are not capped here — a worker's
   * proposal is one line in the middle of real work, not a retro budget.
   */
  assertCanPropose(caller: Pick<VerbCaller, 'session' | 'role'>): void {
    if (caller.role !== 'lessons') return;
    if (this.proposedBy(caller.session).length >= MAX_LESSON_PROPOSALS) {
      throw new LessonQuotaError(caller.session);
    }
  }
}
