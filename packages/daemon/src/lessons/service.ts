/**
 * `LessonsService`: the retro, per stream, with the human as the only
 * decider (§5.5). On land or close, a stream with any findings, hook
 * denials or answered questions gets one short read-only session over
 * exactly that material, asked for at most three proposed rules (two
 * examples each, each with a kind) through the ordinary `propose_knowledge` verb; they reach the
 * inbox as `rule_accept` items. A stream with none runs nothing ("a system
 * that proposes a rule after every stream trains the human to click
 * accept"). The cap is a gate (`assertCanPropose`), not a brief sentence.
 * `onStreamEnd` never throws: a retro that can't start is a thread line.
 */

import type { KnowledgeItem, Question, Stream } from '@agile-agents/shared';
import { MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import type { AttachOptions, AttachResult } from '../attach/service';
import { liveSession } from '../attach/service';
import type { VerbCaller } from '../attach/verbs';
import type { KnowledgeService } from '../knowledge/service';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';

/** §5.5: "at most three" proposed rules out of one retro. */
export const MAX_LESSON_PROPOSALS = 3;

/** How much material one retro carries. */
export const MAX_MATERIAL_ITEMS = 20;

/** The fourth `propose_knowledge` call from one lessons session. */
export class LessonQuotaError extends Error {
  constructor(session: string) {
    super(
      `propose_knowledge refused: this lessons session (${session}) has already proposed ${MAX_LESSON_PROPOSALS} items, which is the most one retro may propose — end your turn`,
    );
    this.name = 'LessonQuotaError';
  }
}

/** The slice of `AttachService` a retro needs. */
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
  rules: KnowledgeService;
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
      `Propose **at most ${MAX_LESSON_PROPOSALS}** items with \`propose_knowledge\`, and only items this`,
      'material actually supports. Each call carries:',
      '',
      '- `text` — the item as the operator would say it;',
      '- `kind` — `standard` (how work is done; the default), `architecture`',
      '  (where something lives, when the finding names a place) or `decision`',
      '  (a choice made, with its reason);',
      '- `examples` — exactly two `{action, violates}` actions, one that',
      '  violates the item and one that does not;',
      '- `scope` — `repo` or `subtree`, never global;',
      '- `enforcement` — your guess of `tell`, `action`, `ship` or `review`,',
      '  with the one-line reason in the text if it is not obvious.',
      '  `action` and `ship` see only tool calls and diffs: an item about',
      '  what an agent says (messages, replies) is `tell`;',
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

  /** Everything the retro reads: findings (record and thread), hook denials for its sessions, answered questions. */
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
      // Named by stream (the hook) or by session (the ACP responder).
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

  /** The land/close hook: starts the retro, or says on the thread why not. Never throws. */
  async onStreamEnd(streamId: string): Promise<void> {
    try {
      const stream = this.options.streams.get(streamId);
      // One retro at a time.
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
          // The stream is gone.
        });
    }
  }

  /** Rules this session has proposed (by provenance). */
  proposedBy(session: string): KnowledgeItem[] {
    return this.options.rules.list().filter((rule) => rule.source.session === session);
  }

  /** §5.5's cap for a lessons session; other roles propose uncapped. */
  assertCanPropose(caller: Pick<VerbCaller, 'session' | 'role'>): void {
    if (caller.role !== 'lessons') return;
    if (this.proposedBy(caller.session).length >= MAX_LESSON_PROPOSALS) {
      throw new LessonQuotaError(caller.session);
    }
  }
}
