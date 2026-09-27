/** T414 (D41): untitled nodes named by a cheap model. Offline: the model call is a fake. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from './service';
import {
  DRAFT_GOAL_MAX_CHARS,
  DRAFT_GOAL_USABLE_CHARS,
  NO_GOAL,
  TitleNamer,
  claudeTitleRun,
  cleanGoal,
  cleanTitle,
  draftGoalPrompt,
  draftedGoal,
  titlePrompt,
} from './titles';

describe('the title a reply makes', () => {
  test('its first line, unwrapped and trimmed', () => {
    expect(cleanTitle('Add CSV import to ledger\n')).toBe('Add CSV import to ledger');
    expect(cleanTitle('\n  "Fix rounding in totals."  \nmore')).toBe('Fix rounding in totals');
    expect(cleanTitle('Title: **Money in cents**')).toBe('Money in cents');
    expect(cleanTitle('`Retry flaky upload`')).toBe('Retry flaky upload');
  });

  test('cut at a word under 60 characters; nothing usable is no title', () => {
    const long = cleanTitle(
      'Investigate why the nightly export job sometimes writes duplicate rows into the archive',
    );
    expect(long).toBe('Investigate why the nightly export job sometimes writes');
    expect((long ?? '').length).toBeLessThanOrEqual(60);
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle('  \n "" ')).toBeUndefined();
    expect(cleanTitle(undefined)).toBeUndefined();
  });

  test('the prompt carries the goal, capped', () => {
    const prompt = titlePrompt(`  ${'x'.repeat(5000)}  `);
    expect(prompt).toContain('at most 6 words');
    expect(prompt.length).toBeLessThan(2300);
  });

  test('no model call under bun test', () => {
    expect(claudeTitleRun({ NODE_ENV: 'test' })).toBeUndefined();
  });
});

describe('TitleNamer', () => {
  let home: string;
  let streams: StreamService;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-titles-'));
    streams = new StreamService(StateStore.open(runInit(home).stateRoot));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const make = (title: string) =>
    streams.create('human', { title, goal: 'how do refunds work in the ledger?' });

  test('replaces the placeholder with the model’s title', async () => {
    const prompts: string[] = [];
    const namer = new TitleNamer({
      streams,
      run: async (prompt) => {
        prompts.push(prompt);
        return 'Refunds in the ledger\n';
      },
    });
    const node = await make('how do refunds work in the ledger?');
    namer.name(node);
    await namer.settled();
    expect(streams.get(node.id).title).toBe('Refunds in the ledger');
    expect(prompts[0]).toContain('how do refunds work in the ledger?');
  });

  test('a title you changed meanwhile, a failed call or a deleted node stay as they are', async () => {
    let answer: string | undefined = 'Better title';
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const namer = new TitleNamer({
      streams,
      run: async () => {
        await gate;
        return answer;
      },
    });
    const renamed = await make('placeholder one');
    namer.name(renamed);
    await streams.update('human', renamed.id, { title: 'Mine' });
    release();
    await namer.settled();
    expect(streams.get(renamed.id).title).toBe('Mine');

    answer = undefined;
    const failed = await make('placeholder two');
    namer.name(failed);
    await namer.settled();
    expect(streams.get(failed.id).title).toBe('placeholder two');

    answer = 'Named later';
    const deleted = await make('placeholder three');
    await streams.update('human', deleted.id, { archived: true });
    namer.name(deleted);
    await namer.settled();
    expect(streams.get(deleted.id).title).toBe('placeholder three');
  });

  test('a throwing call is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const namer = new TitleNamer({
      streams,
      run: async () => {
        throw new Error('no network');
      },
      onError: (err) => errors.push(err),
    });
    const node = await make('placeholder');
    namer.name(node);
    await namer.settled();
    expect(errors).toHaveLength(1);
    expect(streams.get(node.id).title).toBe('placeholder');
  });
});

describe('T422: the goal a conversation drafts', () => {
  test('the prompt carries the question and the newest lines, each on one line', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      who: i % 2 === 0 ? ('you' as const) : ('agent' as const),
      text: `line ${i}\nwrapped`,
    }));
    const prompt = draftGoalPrompt('  why buffer the file?  ', lines);
    expect(prompt).toContain('The question: why buffer the file?');
    expect(prompt).toContain('Agent: line 39 wrapped');
    expect(prompt).toContain('Human: line 10 wrapped');
    // Only the newest 30 lines.
    expect(prompt).not.toContain('line 9 wrapped');
  });

  test('the reply, unwrapped and capped; nothing usable is no goal', () => {
    expect(cleanGoal('Goal: Stream the upload instead of buffering it.\n')).toBe(
      'Stream the upload instead of buffering it.',
    );
    expect(cleanGoal('**Goal**: "Add retries."')).toBe('Add retries.');
    const long = cleanGoal('x'.repeat(5000)) ?? '';
    expect(long.length).toBe(DRAFT_GOAL_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(cleanGoal('  ')).toBeUndefined();
    expect(cleanGoal(undefined)).toBeUndefined();
  });

  test('T435: the prompt has an escape for a talk that concluded nothing', () => {
    expect(draftGoalPrompt('q', [])).toContain(`If no work follows from it, reply ${NO_GOAL}`);
  });

  test('T435: a goal passes; NONE, a question, the model talking to you, a list or a ramble do not', () => {
    const good =
      'Strip a leading BOM and split on CRLF in importCsv(); done when an Excel export imports.';
    expect(draftedGoal(`Goal: ${good}`)).toBe(good);
    expect(draftedGoal('Implement streaming uploads; done when a 2 GB file imports.')).toBe(
      'Implement streaming uploads; done when a 2 GB file imports.',
    );
    // A URL's query is no question.
    expect(draftedGoal('Read https://example.com/a?b=1 and fix the parser.')).toBe(
      'Read https://example.com/a?b=1 and fix the parser.',
    );
    // The prompt's escape.
    expect(draftedGoal('NONE')).toBeUndefined();
    expect(draftedGoal(' none. ')).toBeUndefined();
    // Audit r6 #6: the model talking to you.
    expect(
      draftedGoal(
        "I don't have the context of the conversation that reached this conclusion. Could you either: 1. Share the conversation 2. Tell me directly what should be done",
      ),
    ).toBeUndefined();
    expect(draftedGoal('Could you share the rest of the conversation.')).toBeUndefined();
    expect(draftedGoal('Please share what was decided.')).toBeUndefined();
    expect(draftedGoal('I need more context to write a goal.')).toBeUndefined();
    expect(draftedGoal('Add retries. I’d also check the timeout.')).toBeUndefined();
    expect(draftedGoal('Without more context this is hard to say.')).toBeUndefined();
    // A question.
    expect(draftedGoal('Should the importer stream the file?')).toBeUndefined();
    expect(draftedGoal('Decide: stream or buffer? Then build it.')).toBeUndefined();
    // A list, on lines or run together.
    expect(draftedGoal('Do these:\n- strip the BOM\n- split on CRLF')).toBeUndefined();
    expect(draftedGoal('Steps:\n1. strip the BOM\n2. split on CRLF')).toBeUndefined();
    expect(draftedGoal('Do two things: 1. strip the BOM 2. split on CRLF.')).toBeUndefined();
    // Longer than a goal.
    expect(draftedGoal(`Add retries ${'and more '.repeat(80)}`.trim())).toBeUndefined();
    expect(draftedGoal('x'.repeat(DRAFT_GOAL_USABLE_CHARS))).toBe(
      'x'.repeat(DRAFT_GOAL_USABLE_CHARS),
    );
    // Nothing usable.
    expect(draftedGoal(undefined)).toBeUndefined();
    expect(draftedGoal('  ')).toBeUndefined();
  });
});
