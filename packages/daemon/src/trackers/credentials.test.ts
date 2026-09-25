/**
 * T320 (D31): tracker tokens live in `config.yaml` (0600, written through
 * the store), `daemon.status` says only configured-or-not, and no token
 * reaches a log, an event, an error message or any other home file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerStatus, validateHomeConfig } from '@agile-agents/shared';
import { type DaemonHandle, startDaemon } from '../daemon';
import { runInit } from '../init';
import { StateStore } from '../store';
import { trackerFromConfig } from './create';
import { type FakeJira, startFakeJira } from './fake-jira';
import { type FakeLinear, startFakeLinear } from './fake-linear';

const JIRA_TOKEN = 'jira-secret-tok-9f3a7c';
const LINEAR_TOKEN = 'lin_api_secret-tok-2b8e1d';

let root: string;
let home: string;
let jira: FakeJira;
let linear: FakeLinear;
let handle: DaemonHandle | undefined;
let previousHome: string | undefined;
const captured: string[] = [];
const restore: Array<() => void> = [];

function capture() {
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[name];
    console[name] = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    restore.push(() => {
      console[name] = orig;
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => {
      stream.write = orig;
    });
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p);
    return e.isFile() ? [p] : [];
  });
}

function rpc(socketPath: string, method: string): Promise<{ result?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method })}\n`),
    );
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.on('error', reject);
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agile-trackers-'));
  home = runInit(join(root, 'home')).stateRoot;
  previousHome = process.env.AGILE_HOME;
  process.env.AGILE_HOME = home;
  jira = await startFakeJira({ token: JIRA_TOKEN });
  linear = await startFakeLinear({ token: LINEAR_TOKEN });
  jira.addIssue({ key: 'SHOP-1', title: 'Checkout' });
  linear.addIssue({ key: 'ENG-1', title: 'Checkout' });
  captured.length = 0;
});

afterEach(async () => {
  for (const r of restore.splice(0)) r();
  await handle?.stop();
  handle = undefined;
  await jira.stop();
  await linear.stop();
  if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
  else process.env.AGILE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('tracker credentials (T320, D31)', () => {
  test('set through the store at 0600; status says configured; the token appears nowhere else', async () => {
    capture();
    const configPath = join(home, 'config.yaml');
    const before = (() => {
      try {
        return readFileSync(configPath, 'utf8');
      } catch {
        return '';
      }
    })();
    // The operator's connection settings (no secret) are seeded as a hand edit would.
    writeFileSync(
      configPath,
      `${before}\ngithub:\n  gh_command: /nonexistent/gh\ntrackers:\n  jira:\n    base_url: ${jira.baseUrl}\n    email: ${jira.email}\n  linear:\n    api_url: ${linear.apiUrl}\n`,
    );
    const store = StateStore.open(home);
    expect(trackerStatus(store.getHomeConfig().trackers)).toEqual({
      jira: 'not configured',
      linear: 'not configured',
    });
    await store.setTrackerToken('jira', JIRA_TOKEN);
    await store.setTrackerToken('linear', LINEAR_TOKEN);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const cfg = store.getHomeConfig();
    expect(cfg.trackers?.jira?.token).toBe(JIRA_TOKEN);
    expect(trackerStatus(cfg.trackers)).toEqual({ jira: 'configured', linear: 'configured' });

    // Adapters from config work, and their failures name no token.
    expect((await trackerFromConfig('jira', cfg.trackers).getIssue('SHOP-1')).title).toBe(
      'Checkout',
    );
    expect((await trackerFromConfig('linear', cfg.trackers).getIssue('ENG-1')).title).toBe(
      'Checkout',
    );
    const errors: string[] = [];
    for (const system of ['jira', 'linear'] as const) {
      const port = trackerFromConfig(system, cfg.trackers);
      errors.push(String(await port.getIssue('NOPE-9').catch((e) => `${e.message} ${e.stack}`)));
    }
    const wrong = validateHomeConfig({
      trackers: {
        jira: { base_url: jira.baseUrl, token: `${JIRA_TOKEN}x` },
        linear: { api_url: linear.apiUrl, token: `${LINEAR_TOKEN}x` },
      },
    }).trackers;
    for (const system of ['jira', 'linear'] as const) {
      const e = await trackerFromConfig(system, wrong)
        .getIssue('SHOP-1')
        .catch((x) => x);
      expect(e.kind).toBe('auth');
      errors.push(`${e.message} ${e.stack}`);
    }
    // A bad token value is refused without echoing it.
    const refused = await store.setTrackerToken('linear', 'x'.repeat(5000)).catch((e) => e.message);
    expect(refused).toMatch(/nothing written/);

    // The daemon reports configured-or-not only.
    handle = await startDaemon({
      port: 0,
      socketPath: join(root, 'agiled.sock'),
      githubAuth: async () => false,
    });
    const status = await rpc(join(root, 'agiled.sock'), 'daemon.status');
    expect(status.result?.trackers).toEqual({ jira: 'configured', linear: 'configured' });
    await store.setTrackerToken('linear', undefined);
    const after = await rpc(join(root, 'agiled.sock'), 'daemon.status');
    expect(after.result?.trackers).toEqual({ jira: 'configured', linear: 'not configured' });
    await handle.stop();
    handle = undefined;

    const events = readFileSync(join(home, 'log', 'events.jsonl'), 'utf8');
    expect(events).toContain('home_config_put');
    const haystacks = [
      events,
      JSON.stringify(status),
      JSON.stringify(after),
      ...errors,
      ...captured,
      JSON.stringify(jira.requests),
      JSON.stringify(linear.requests),
      ...filesUnder(home)
        .filter((p) => p !== configPath)
        .map((p) => readFileSync(p, 'utf8')),
    ];
    for (const token of [JIRA_TOKEN, LINEAR_TOKEN]) {
      for (const h of haystacks) expect(h.includes(token)).toBe(false);
    }
  });

  test('an unconfigured tracker is a clear auth error, naming the config key only', () => {
    expect(() => trackerFromConfig('jira', undefined)).toThrow(/trackers\.jira\.token/);
    expect(() => trackerFromConfig('linear', { linear: { api_url: linear.apiUrl } })).toThrow(
      /not configured/,
    );
  });
});
