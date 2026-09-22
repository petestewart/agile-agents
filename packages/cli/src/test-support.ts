/**
 * Test-only helper: spins up a real in-process daemon RPC server (same
 * wiring as `packages/daemon/src/daemon.ts`'s `startDaemon`, built from
 * public `@agile-agents/daemon` exports only) against a freshly `agile
 * init`-ed temp repo. Used by every command test in `commands/*.test.ts`
 * that needs a live socket to round-trip against, per the ticket's
 * validation step ("CLI tests against an in-process daemon").
 *
 * Not `startDaemon` itself: that also binds an HTTP server and acquires the
 * repo lock, neither of which any CLI test needs, and binding two extra
 * listeners per test would slow the suite for no coverage gained.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttachService,
  Bus,
  FakeClassifier,
  GateService,
  InboxService,
  QuestionService,
  type RpcServerHandle,
  RulesService,
  StateStore,
  StreamService,
  VerbService,
  buildAttachRpcMethods,
  buildBusRpcMethods,
  buildGateRpcMethods,
  buildInboxRpcMethods,
  buildQuestionRpcMethods,
  buildRuleRpcMethods,
  buildStateRpcMethods,
  buildStreamRpcMethods,
  createFakeSpawn,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
  DEFAULT_CLASSIFIER_DENY_AT,
} from '@agile-agents/shared';
import { RpcConnectionError, callRpc } from './client';

/**
 * A port nothing is listening on right now: bind `0`, read what the OS
 * handed out, close. Test-only.
 *
 * T125: an e2e that starts a **real** `agiled` has to override the built-in
 * default port (4600), or two suites running at once on one machine — a
 * second worker's `test:integration`, or an operator's own daemon — collide
 * on the bind and the test fails for a reason that has nothing to do with
 * what it is testing.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not resolve a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Writes `port: <free port>` into `<home>/config.yaml` and returns it, so a
 * real daemon started against that home binds somewhere nothing else is
 * (T125). Creates the home if it does not exist yet — this runs before
 * `agile init`.
 */
export async function writeFreePortConfig(home: string): Promise<number> {
  const port = await freePort();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `port: ${port}\n`);
  return port;
}

export interface TestDaemon {
  repo: string;
  /** The temp state home this daemon serves (T111) — `AGILE_HOME` for its lifetime. */
  home: string;
  stateRoot: string;
  socketPath: string;
  store: StateStore;
  rpc: RpcServerHandle;
  /** Same instance wired into `gate.*` RPC methods — tests use this to seed
   * a pending `HilRequest` the way `packages/daemon/src/gates/rpc.test.ts`
   * does, since there is no `gate.request` RPC for an external client to
   * create one through. */
  gateService: GateService;
  attachService: AttachService;
  /** Same instance wired into `question.*` RPC (T040) — tests seed an open question through it. */
  questionService: QuestionService;
  streamService: StreamService;
  /** Same instance wired into `rule.*` RPC (T140) — tests seed a rule through it. */
  rulesService: RulesService;
  /**
   * T153: the classifier behind `rule.test` (§5.6). Always the fake — the
   * suite never calls the real API — and re-scriptable per test through
   * `setScript`, so one daemon can answer differently in two evals.
   */
  classifier: FakeClassifier;
  cleanup(): Promise<void>;
}

export async function startTestDaemon(prefix = 'agile-cli-test-'): Promise<TestDaemon> {
  // T153: the only classifier any test ever gets (§6.2). Unscripted it
  // answers nothing, which is what `rule.test` reports as an error.
  const classifier = new FakeClassifier();
  const repo = mkdtempSync(join(tmpdir(), prefix));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });

  // T111: the state home lives outside the repo. `AGILE_HOME` is exported
  // for the duration so `discoverConfig` (and any CLI subprocess this test
  // daemon spawns) resolves the same home, never the operator's `~/.agile/`.
  const home = join(repo, 'home');
  const previousHome = process.env.AGILE_HOME;
  process.env.AGILE_HOME = home;
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  // T112 (D9): the socket belongs to the home, which is where every CLI
  // verb now looks for it (`resolveHomePaths`) — never a repo cwd.
  const socketPath = join(home, 'agiled.sock');

  // A no-op delegate (never auto-approves) matches production's default —
  // tests that need auto-delegation pass their own `GateService` instead of
  // using this helper.
  const gateService = new GateService(store);
  const streamService = new StreamService(store);
  // `createFakeSpawn` (the `fake-agent.ts` transport) so an `attach` in a
  // CLI test never spawns a real vendor and never needs a login. The
  // script hangs inside its first turn: T137 ends a session whose turn
  // ends with no open question, and these tests want a live session to
  // look at (and to `detach`).
  const fakeScript = join(home, 'fake-agent-script.json');
  writeFileSync(
    fakeScript,
    JSON.stringify({
      steps: [
        { type: 'usage_update', used: 10, size: 1000 },
        { type: 'tool_call', toolCallId: 'fake-1', title: 'fake work' },
        { type: 'hang' },
      ],
    }),
  );
  const attachService = new AttachService({
    store,
    streams: streamService,
    home,
    socketPath,
    spawn: createFakeSpawn({ scriptPath: fakeScript }),
    questions: { listOpen: () => questionService.listOpen() },
    // T138: same wiring as `daemon.ts` — an open routed call keeps a
    // session alive at turn end.
    gates: gateService,
  });
  // T137: an answer is delivered by prompting the live session, exactly as
  // `daemon.ts` wires it.
  const questionService: QuestionService = new QuestionService(store, streamService, {
    deliver: async (sessionId, question): Promise<void> => {
      await attachService.deliverAnswer(sessionId, question);
    },
  });
  // T130: attach + the eight verbs. Nothing here spawns a vendor — a test
  // that wants a live session injects its own `spawn` seam.
  // T140: rules (cockpit design §5) — the same service behind `rule.*` RPC,
  // the inbox's `rule_accept` items and the `propose_rule` verb.
  const rulesService = new RulesService({ store, streams: streamService });
  const verbService = new VerbService({
    store,
    streams: streamService,
    questions: questionService,
    rules: rulesService,
  });

  const rpc = startRpcServer({
    socketPath,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    extraMethods: {
      ...buildStateRpcMethods(store),
      ...buildStreamRpcMethods(streamService),
      ...buildInboxRpcMethods(
        new InboxService({
          streams: streamService,
          questions: questionService,
          gates: gateService,
          rules: rulesService,
        }),
      ),
      ...buildRuleRpcMethods(rulesService, {
        classifier,
        events: store,
        bands: {
          deny_at: DEFAULT_CLASSIFIER_DENY_AT,
          allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
          confidence_floor: DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
        },
      }),
      ...buildBusRpcMethods(new Bus(store, init.stateRoot)),
      ...buildGateRpcMethods(gateService),
      ...buildQuestionRpcMethods(questionService),
      ...buildAttachRpcMethods(attachService, verbService),
    },
  });
  await rpc.listening;
  // `listening` says the server bound its path; a client still saw
  // `connect ENOENT` on it once on a loaded CI runner (the `mcp --socket`
  // bridge test, 2026-09-11, twin run green, no local reproduction in 8
  // runs under load). Prove the socket connectable from this process before
  // handing it to a test that spawns a real CLI subprocess against it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await callRpc(socketPath, 'daemon.ping', {}, { timeoutMs: 1000 });
      break;
    } catch (err) {
      if (!(err instanceof RpcConnectionError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return {
    repo,
    stateRoot: init.stateRoot,
    socketPath,
    store,
    rpc,
    gateService,
    attachService,
    questionService,
    streamService,
    rulesService,
    classifier,
    home,
    async cleanup() {
      await attachService.stopAll();
      await rpc.close();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
      else process.env.AGILE_HOME = previousHome;
      rmSync(repo, { recursive: true, force: true });
    },
  };
}
