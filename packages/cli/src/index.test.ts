import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_NAME, runCli, runCliInit, usageBlocks } from './index';

test('PACKAGE_NAME identifies the package', () => {
  expect(PACKAGE_NAME).toBe('@agile-agents/cli');
});

let repo: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-cli-init-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  // T111: the state home is never inside the repo. Point `AGILE_HOME` at a
  // temp dir so `agile init` cannot touch the operator's real `~/.agile/`.
  home = join(mkdtempSync(join(tmpdir(), 'agile-cli-home-')), 'home');
  previousHome = process.env.AGILE_HOME;
  process.env.AGILE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
  else process.env.AGILE_HOME = previousHome;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('runCliInit', () => {
  test('creates the state home and never a .agile/ inside the repo', () => {
    const result = runCliInit();
    expect(result.message).toContain(home);
    expect(result.alreadyInitialised).toBe(false);
    expect(existsSync(join(home, 'repos.yaml'))).toBe(true);
    expect(existsSync(join(repo, '.agile'))).toBe(false);
  });

  test('a second call is an idempotent no-op', () => {
    runCliInit();
    const result = runCliInit();
    expect(result.alreadyInitialised).toBe(true);
  });
});

describe('runCli init exit code', () => {
  const originalCwd = process.cwd();

  test('a fresh init exits 0', async () => {
    process.chdir(repo);
    try {
      expect(await runCli(['init'])).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('re-init is idempotent and still exits 0', async () => {
    process.chdir(repo);
    try {
      expect(await runCli(['init'])).toBe(0);
      expect(await runCli(['init'])).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

/** stdout and stderr of one `runCli`, with its exit code. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => out.push(args.join(' '));
  console.error = (...args: unknown[]) => err.push(args.join(' '));
  try {
    const code = await runCli(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** T523 (CLI audit C2): asking for help is an answer, not a usage error. */
describe('help', () => {
  for (const argv of [['--help'], ['help'], ['-h'], [], ['--json', '--help']]) {
    test(`agile ${argv.join(' ')} prints the usage to stdout and exits 0`, async () => {
      const { code, out, err } = await run(argv);
      expect(code).toBe(0);
      expect(out).toStartWith('usage: agile <command> [options]');
      expect(out).toContain('  node say <id> <text>');
      expect(out).toContain('--help, -h');
      expect(err).toBe('');
    });
  }

  test('agile <command> --help prints that command\u2019s usage only, aliases included', async () => {
    const node = await run(['node', '--help']);
    expect(node.code).toBe(0);
    expect(node.err).toBe('');
    expect(node.out).toStartWith('usage:');
    expect(node.out).toContain('  node new --title');
    expect(node.out).toContain('  node say <id> <text>');
    expect(node.out).toContain('  stream …');
    expect(node.out).not.toContain('  knowledge');
    // `stream` is `node`; `agile help node` is the same.
    expect((await run(['stream', '-h'])).out).toBe(node.out);
    expect((await run(['help', 'node'])).out).toBe(node.out);

    const land = await run(['land', '--help']);
    expect(land.out).toContain('  deliver <stream>');
    expect(land.out).toContain('  land <stream>');
  });

  test('agile <command> <subcommand> --help prints that subcommand\u2019s block', async () => {
    const say = await run(['node', 'say', '--help']);
    expect(say.code).toBe(0);
    expect(say.out).toContain('  node say <id> <text>');
    expect(say.out).not.toContain('  node new');
    expect((await run(['node', 'say', '-h'])).out).toBe(say.out);
    expect((await run(['help', 'node', 'say'])).out).toBe(say.out);
    // `--help` anywhere before `--` is help.
    expect((await run(['node', 'say', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'hi', '--help'])).out).toBe(
      say.out,
    );
  });

  test('agile init --help creates nothing', async () => {
    const { code, out } = await run(['init', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('  init ');
    expect(existsSync(home)).toBe(false);
  });

  test('an unknown command or subcommand is a usage error: stderr, exit 1, saying which', async () => {
    const unknown = await run(['frobnicate']);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toBe('');
    expect(unknown.err).toStartWith('agile: unknown command frobnicate\nusage: agile <command>');

    const sub = await run(['node', 'frobnicate']);
    expect(sub.code).toBe(1);
    expect(sub.err).toStartWith('agile node: unknown subcommand frobnicate\nusage:');
    expect(sub.err).toContain('  node say <id> <text>');

    const helpForNothing = await run(['help', 'frobnicate']);
    expect(helpForNothing.code).toBe(1);
    expect(helpForNothing.err).toStartWith('agile: unknown command frobnicate');

    const none = await run(['gate']);
    expect(none.code).toBe(1);
    expect(none.err).toStartWith('agile gate: name a subcommand');
  });

  test('-h after the first argument of a verb with no subcommands is text, not help', async () => {
    // Refused at the socket (no daemon here), not printed as help.
    const { code, out } = await run(['answer', 'Q-1', 'ls', '-h', 'shows', 'sizes']);
    expect(code).toBe(1);
    expect(out).not.toContain('usage');
  });

  /**
   * The usage lists only commands that exist: every command and subcommand
   * it names reaches the dispatcher (here it fails on the missing daemon or
   * a missing argument, never on "unknown"). Skipped: those that would
   * start a daemon or wait on stdin.
   */
  test('every command the usage names is dispatched', async () => {
    const skip = new Set(['daemon', 'hook', 'mcp', 'tracker set']);
    const seen = new Set<string>();
    for (const block of usageBlocks()) {
      const argv = block.sub !== undefined ? [block.command, block.sub] : [block.command];
      const name = argv.join(' ');
      if (seen.has(name) || skip.has(block.command) || skip.has(name)) continue;
      seen.add(name);
      // `stream …`/`rules …` are aliases: one of their subcommands stands for them.
      if (block.command === 'stream' || block.command === 'rules') argv.push('list');
      const { err } = await run(argv);
      expect({ name, err }).not.toMatchObject({
        err: expect.stringMatching(/unknown (sub)?command|name a subcommand/),
      });
    }
    expect(seen.size).toBeGreaterThan(50);
  });
});

/** T523 (CLI audit C3): refused before anything reaches the daemon. */
describe('free text', () => {
  test('agile director say refuses an option-shaped word by name and suggests --', async () => {
    const { code, err } = await run(['director', 'say', 'ship', 'it', '--force', 'today']);
    expect(code).toBe(1);
    expect(err).toBe(
      'agile director say: unknown option --force. If it is part of the text, quote the text or put -- before it',
    );
  });

  test('agile policy try keeps --project, refuses any other --word', async () => {
    const { code, err } = await run([
      'policy',
      'try',
      'add',
      '--dry-run',
      'mode',
      '--project',
      'P-1',
    ]);
    expect(code).toBe(1);
    expect(err).toContain(
      'agile policy try: unknown option --dry-run (its options: --project, --node)',
    );
  });

  test('agile question raise refuses the words an unquoted --text lost', async () => {
    const { code, err } = await run([
      'question',
      'raise',
      '--stream',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      '--text',
      'which',
      'branch?',
    ]);
    expect(code).toBe(1);
    expect(err).toContain('agile question raise: "branch?" belongs to no option');
  });
});
