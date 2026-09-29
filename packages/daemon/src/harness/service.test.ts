import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HarnessId, validateInboxItem } from '@agile-agents/shared';
import { RoutedEventService } from '../events';
import { runInit } from '../init';
import { StateStore } from '../store';
import type { CommandResult, CommandRunner } from './methods';
import { type HarnessBridge, HarnessUpdateService } from './service';

/**
 * A fake machine: which commands are on PATH, where they resolve, and what
 * each argv prints. Every argv run is recorded; nothing real ever runs.
 */
interface FakeMachine {
  onPath: Record<string, string>;
  real: Record<string, string>;
  files: Record<string, string>;
  exists: string[];
  answers: Map<string, CommandResult | ((argv: readonly string[]) => CommandResult)>;
  calls: string[][];
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: '',
  stderr,
  timedOut: false,
});

function machine(): FakeMachine {
  return { onPath: {}, real: {}, files: {}, exists: [], answers: new Map(), calls: [] };
}

function runnerOf(m: FakeMachine): CommandRunner {
  return async (argv) => {
    m.calls.push([...argv]);
    const answer = m.answers.get(argv.join(' '));
    if (answer === undefined) return fail(`fake: nothing answers ${argv.join(' ')}`, 127);
    return typeof answer === 'function' ? answer(argv) : answer;
  };
}

const CLAUDE_NPM = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
const GEMINI_BREW =
  '/opt/homebrew/Cellar/gemini-cli/0.32.1/libexec/lib/node_modules/@google/gemini-cli/dist/index.js';
const NPM = '/usr/local/bin/npm';
const BREW = '/opt/homebrew/bin/brew';
const CLAUDE_UPDATE = `${NPM} install -g --prefix /usr/local @anthropic-ai/claude-code@latest`;

/** Claude Code through global npm (2.2.9, newest 2.3.1), Gemini CLI through Homebrew (current). */
function pete(m: FakeMachine, latest = '2.3.1'): void {
  m.onPath.claude = '/usr/local/bin/claude';
  m.real['/usr/local/bin/claude'] = CLAUDE_NPM;
  m.onPath.gemini = '/opt/homebrew/bin/gemini';
  m.real['/opt/homebrew/bin/gemini'] = GEMINI_BREW;
  m.exists.push(NPM, BREW);
  m.answers.set('/usr/local/bin/claude --version', ok('2.2.9 (Claude Code)\n'));
  m.answers.set(`${NPM} view @anthropic-ai/claude-code version`, ok(`${latest}\n`));
  m.answers.set('/opt/homebrew/bin/gemini --version', ok('0.32.1\n'));
  m.answers.set(
    `${BREW} info --json=v2 gemini-cli`,
    ok(JSON.stringify({ formulae: [{ versions: { stable: '0.32.1' } }], casks: [] })),
  );
}

let home: string;
let store: StateStore;
let events: RoutedEventService;
let m: FakeMachine;
let services: HarnessUpdateService[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-harness-'));
  store = StateStore.open(runInit(home).stateRoot);
  events = new RoutedEventService(store);
  m = machine();
  services = [];
});

afterEach(async () => {
  for (const s of services) {
    s.stop();
    await s.settled();
  }
  store.close();
  rmSync(home, { recursive: true, force: true });
});

function service(
  extra: { bridges?: HarnessBridge[]; harnesses?: HarnessId[]; updateTimeoutMs?: number } = {},
): HarnessUpdateService {
  const s = new HarnessUpdateService({
    store,
    run: runnerOf(m),
    which: (command) => m.onPath[command] ?? null,
    realpath: (path) => m.real[path] ?? path,
    exists: (path) => m.exists.includes(path),
    readText: (path) => {
      const text = m.files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    events,
    bridges: extra.bridges ?? [],
    ...(extra.harnesses ? { harnesses: extra.harnesses } : {}),
    ...(extra.updateTimeoutMs !== undefined ? { updateTimeoutMs: extra.updateTimeoutMs } : {}),
  });
  services.push(s);
  return s;
}

/** Every `harness_updated` in the event log (what Events shows), oldest first. */
const harnessEvents = () => events.recent(50, (e) => e.type === 'harness_updated').reverse();

describe('T481 HarnessUpdateService', () => {
  test('Off runs no command at all: no --version, no npm view, no bridge, no item', async () => {
    pete(m);
    m.onPath.npm = NPM;
    await store.setHarnessUpdateMode('off', undefined);
    const s = service({
      bridges: [{ vendor: 'claude', label: 'b', package: '@x/bridge', pinned: '1.0.0' }],
    });
    const status = await s.check('manual');
    await s.settled();
    expect(m.calls).toEqual([]);
    expect(status.mode).toBe('off');
    expect(status.harnesses.every((h) => h.mode === 'off' && h.checked_at === undefined)).toBe(
      true,
    );
    expect(status.bridges[0]?.latest).toBeUndefined();
    expect(s.inboxItems()).toEqual([]);
    // A vendor's own mode wins: only Claude is checked.
    await store.setHarnessUpdateMode('alert', 'claude');
    await s.check('manual');
    expect(m.calls.map((c) => c.join(' ')).sort()).toEqual([
      '/usr/local/bin/claude --version',
      `${NPM} view @anthropic-ai/claude-code version`,
      `${NPM} view @x/bridge version`,
    ]);
  });

  test('Alert: one item per CLI that is behind, in words; Dismiss hides it until a newer version', async () => {
    pete(m);
    const s = service();
    const status = await s.check('scheduled');
    const claude = status.harnesses.find((h) => h.id === 'claude');
    expect(claude).toMatchObject({
      found: true,
      method: 'npm',
      package: '@anthropic-ai/claude-code',
      version: '2.2.9',
      latest: '2.3.1',
      behind: true,
      can_update: true,
      command: CLAUDE_UPDATE,
    });
    expect(status.harnesses.find((h) => h.id === 'gemini')).toMatchObject({
      method: 'brew',
      package: 'gemini-cli',
      version: '0.32.1',
      latest: '0.32.1',
      behind: false,
    });
    expect(status.harnesses.find((h) => h.id === 'codex')?.found).toBe(false);
    const items = s.inboxItems();
    expect(items.map((i) => [i.kind, i.id, i.context, i.harness])).toEqual([
      [
        'harness_update',
        'harness:claude',
        'Claude Code 2.3.1 is available (you have 2.2.9)',
        { id: 'claude', label: 'Claude Code' },
      ],
    ]);
    for (const item of items) validateInboxItem(item);
    // Nothing was installed by the check.
    expect(m.calls.some((c) => c.includes('install'))).toBe(false);

    await s.dismiss('claude');
    expect(s.inboxItems()).toEqual([]);
    expect(store.getHomeConfig().harness_updates?.dismissed?.claude).toBe('2.3.1');
    await s.check('scheduled');
    expect(s.inboxItems()).toEqual([]);
    // A newer version asks again.
    m.answers.set(`${NPM} view @anthropic-ai/claude-code version`, ok('2.3.2\n'));
    await s.check('scheduled');
    expect(s.inboxItems().map((i) => i.context)).toEqual([
      'Claude Code 2.3.2 is available (you have 2.2.9)',
    ]);
  });

  test('Update: the fixed argv, then the new version in words, and a line in Events', async () => {
    pete(m);
    let installed = '2.2.9';
    m.answers.set('/usr/local/bin/claude --version', () => ok(`${installed} (Claude Code)\n`));
    m.answers.set(CLAUDE_UPDATE, () => {
      installed = '2.3.1';
      return ok('changed 3 packages in 4s\n');
    });
    const s = service();
    await s.check('scheduled');
    const result = await s.update('claude', { by: 'human' });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Updated Claude Code to 2.3.1');
    expect(result.status).toMatchObject({ version: '2.3.1', behind: false });
    expect(result.status.updating).toBeUndefined();
    expect(m.calls).toContainEqual(CLAUDE_UPDATE.split(' '));
    expect(s.inboxItems()).toEqual([]);
    const [event] = harnessEvents();
    expect(event?.payload).toEqual({
      harness: 'claude',
      label: 'Claude Code',
      from: '2.2.9',
      to: '2.3.1',
      summary: 'Updated Claude Code to 2.3.1',
    });
    expect(event?.by).toBe('human');
    expect(event?.routing).toEqual([]);
  });

  test('a failed Update says why and how to run it by hand, and stays in Needs me until dismissed', async () => {
    pete(m);
    m.answers.set(
      CLAUDE_UPDATE,
      fail(
        'npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! Error: EACCES: permission denied',
        243,
      ),
    );
    const s = service();
    await s.check('scheduled');
    const result = await s.update('claude', { by: 'human' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      `Couldn’t update Claude Code: npm ERR! code EACCES. Run: ${CLAUDE_UPDATE}`,
    );
    // Never retried, never with sudo.
    expect(m.calls.filter((c) => c.includes('install'))).toHaveLength(1);
    expect(m.calls.some((c) => c.includes('sudo'))).toBe(false);
    const [item] = s.inboxItems();
    expect(item?.context).toBe(result.message);
    expect(item?.harness).toEqual({ id: 'claude', label: 'Claude Code', failed: true });
    expect(harnessEvents()).toEqual([]);
    await s.dismiss('claude');
    expect(s.inboxItems()).toEqual([]);
  });

  test('an update past its timeout is stopped and reported', async () => {
    pete(m);
    m.answers.set(CLAUDE_UPDATE, { code: null, stdout: '', stderr: '', timedOut: true });
    const s = service({ updateTimeoutMs: 10 * 60 * 1000 });
    await s.check('scheduled');
    const result = await s.update('claude', { by: 'human' });
    expect(result.message).toBe(
      `Couldn’t update Claude Code: it ran longer than 10 minutes and was stopped. Run: ${CLAUDE_UPDATE}`,
    );
  });

  test('Auto: updates in the background and records it in Events; nothing waits in Needs me', async () => {
    pete(m);
    await store.setHarnessUpdateMode('auto', undefined);
    let installed = '2.2.9';
    m.answers.set('/usr/local/bin/claude --version', () => ok(`${installed} (Claude Code)\n`));
    m.answers.set(CLAUDE_UPDATE, () => {
      installed = '2.3.1';
      return ok('');
    });
    const s = service();
    await s.check('scheduled');
    await s.settled();
    expect(m.calls.filter((c) => c.includes('install'))).toHaveLength(1);
    // Gemini CLI is current: nothing ran for it but the check.
    expect(m.calls.some((c) => c.includes('upgrade'))).toBe(false);
    expect(harnessEvents().map((e) => [e.by, e.payload.summary])).toEqual([
      ['daemon', 'Updated Claude Code to 2.3.1'],
    ]);
    expect(s.inboxItems()).toEqual([]);
    await s.check('scheduled');
    await s.settled();
    expect(m.calls.filter((c) => c.includes('install'))).toHaveLength(1);
  });

  test('Auto: a failure becomes a Needs me item with the command, and that version is not tried again', async () => {
    pete(m);
    await store.setHarnessUpdateMode('auto', undefined);
    m.answers.set(CLAUDE_UPDATE, fail('npm ERR! network request failed'));
    const s = service();
    await s.check('scheduled');
    await s.settled();
    expect(s.inboxItems().map((i) => [i.context, i.harness?.failed])).toEqual([
      [`Couldn’t update Claude Code: npm ERR! network request failed. Run: ${CLAUDE_UPDATE}`, true],
    ]);
    await s.check('scheduled');
    await s.settled();
    expect(m.calls.filter((c) => c.includes('install'))).toHaveLength(1);
    // Its Update, pressed, tries again.
    m.answers.set(CLAUDE_UPDATE, ok(''));
    m.answers.set('/usr/local/bin/claude --version', ok('2.3.1 (Claude Code)\n'));
    expect((await s.update('claude', { by: 'human' })).message).toBe(
      'Updated Claude Code to 2.3.1',
    );
    expect(s.inboxItems()).toEqual([]);
  });

  test('an unknown install method is reported with its path, never guessed or run', async () => {
    m.onPath['cursor-agent'] = '/Users/pete/.local/bin/cursor-agent';
    const real = '/Users/pete/.local/share/cursor-agent/versions/2026.09.20/cursor-agent';
    m.real['/Users/pete/.local/bin/cursor-agent'] = real;
    m.answers.set('/Users/pete/.local/bin/cursor-agent --version', ok('2026.09.20-abc1234\n'));
    const s = service({ harnesses: ['cursor'] });
    const [cursor] = (await s.check('manual')).harnesses;
    expect(cursor).toMatchObject({
      found: true,
      method: 'unknown',
      path: real,
      can_update: false,
      behind: false,
      manual: `Can’t check Cursor Agent automatically; update it the way you installed it (${real}).`,
    });
    expect(cursor?.latest).toBeUndefined();
    expect(cursor?.command).toBeUndefined();
    expect(s.inboxItems()).toEqual([]);
    const result = await s.update('cursor', { by: 'human' });
    expect(result).toMatchObject({ ok: false, message: cursor?.manual });
    // Only its version was read.
    expect(m.calls).toEqual([['/Users/pete/.local/bin/cursor-agent', '--version']]);
  });

  test('claude update (newest unknown): offered only on Check now, never by the daily check', async () => {
    m.onPath.claude = '/Users/pete/.local/bin/claude';
    m.real['/Users/pete/.local/bin/claude'] = '/Users/pete/.local/share/claude/versions/2.2.9';
    let installed = '2.2.9';
    m.answers.set('/Users/pete/.local/bin/claude --version', () =>
      ok(`${installed} (Claude Code)\n`),
    );
    m.answers.set('/Users/pete/.local/bin/claude update', () => {
      installed = '2.3.1';
      return ok('Successfully updated from 2.2.9 to version 2.3.1\n');
    });
    const s = service({ harnesses: ['claude'] });
    const [scheduled] = (await s.check('scheduled')).harnesses;
    expect(scheduled).toMatchObject({ method: 'native', can_update: true, behind: false });
    expect(scheduled?.latest).toBeUndefined();
    expect(s.inboxItems()).toEqual([]);
    await s.check('manual');
    const [offer] = s.inboxItems();
    expect(offer?.context).toBe(
      'Claude Code 2.2.9 may have an update: its own installer checks when you press Update (`/Users/pete/.local/bin/claude update`)',
    );
    expect((await s.update('claude', { by: 'human' })).message).toBe(
      'Updated Claude Code to 2.3.1',
    );
    expect(s.inboxItems()).toEqual([]);
    // Already current: what it printed, in words.
    m.answers.set(
      '/Users/pete/.local/bin/claude update',
      ok('Claude Code is up to date (2.3.1)\n'),
    );
    expect((await s.update('claude', { by: 'human' })).message).toBe(
      'Claude Code is at 2.3.1 (it said: Claude Code is up to date (2.3.1))',
    );
  });

  test("pi-acp's version comes from its package.json, never by starting it", async () => {
    m.onPath['pi-acp'] = '/usr/local/bin/pi-acp';
    m.real['/usr/local/bin/pi-acp'] = '/usr/local/lib/node_modules/pi-acp/dist/index.js';
    m.files['/usr/local/lib/node_modules/pi-acp/package.json'] = '{"version":"0.0.33"}';
    m.exists.push(NPM);
    m.answers.set(`${NPM} view pi-acp version`, ok('0.0.35\n'));
    const s = service({ harnesses: ['pi-acp'] });
    const [pi] = (await s.check('scheduled')).harnesses;
    expect(pi).toMatchObject({ version: '0.0.33', latest: '0.0.35', behind: true });
    expect(m.calls).toEqual([[NPM, 'view', 'pi-acp', 'version']]);
  });

  test('bridges: the pinned version and the newest published one, as information only', async () => {
    m.onPath.npm = '/usr/bin/npm';
    m.answers.set(
      '/usr/bin/npm view @agentclientprotocol/claude-agent-acp version',
      ok('0.85.0\n'),
    );
    const s = service({
      harnesses: [],
      bridges: [
        {
          vendor: 'claude',
          label: 'Claude Code bridge',
          package: '@agentclientprotocol/claude-agent-acp',
          pinned: '0.84.0',
        },
      ],
    });
    const status = await s.check('manual');
    await s.settled();
    expect(status.bridges).toEqual([
      {
        vendor: 'claude',
        label: 'Claude Code bridge',
        package: '@agentclientprotocol/claude-agent-acp',
        pinned: '0.84.0',
        latest: '0.85.0',
        checked_at: expect.any(String),
      },
    ]);
    // Never installed.
    expect(m.calls).toEqual([
      ['/usr/bin/npm', 'view', '@agentclientprotocol/claude-agent-acp', 'version'],
    ]);
  });

  test('setMode writes the home config through the store; alert is the default and removes the key', async () => {
    const s = service();
    expect(s.status().mode).toBe('alert');
    expect((await s.setMode({ mode: 'auto' })).mode).toBe('auto');
    expect((await s.setMode({ mode: 'off', vendor: 'codex' })).vendors).toEqual({ codex: 'off' });
    expect(s.status().harnesses.find((h) => h.id === 'codex')?.mode).toBe('off');
    expect(s.status().harnesses.find((h) => h.id === 'claude')?.mode).toBe('auto');
    await s.setMode({ mode: null, vendor: 'codex' });
    await s.setMode({ mode: 'alert' });
    expect(store.getHomeConfig().harness_updates).toBeUndefined();
  });

  test('the check is off the start path; start and stop leave no timer running', async () => {
    pete(m);
    const s = new HarnessUpdateService({
      store,
      run: runnerOf(m),
      which: (command) => m.onPath[command] ?? null,
      realpath: (path) => m.real[path] ?? path,
      exists: (path) => m.exists.includes(path),
      startDelayMs: 20,
    });
    services.push(s);
    s.start();
    expect(m.calls).toEqual([]);
    await Bun.sleep(150);
    await s.check('scheduled');
    expect(s.inboxItems().map((i) => i.id)).toEqual(['harness:claude']);
    s.stop();
  });
});
