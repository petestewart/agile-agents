/**
 * T457: the permission posture's pieces — where it comes from, the read
 * scope it widens, the "Always" roots, the ACP tier's route for a held read
 * — against a real temp state home. No git, no vendor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, ReposConfig } from '@agile-agents/shared';
import { GateService } from '../gates';
import { acpReadRouter } from '../hook/route-band';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  CREDENTIAL_PATHS,
  alwaysReadRoot,
  isCredentialPath,
  nodeReadScope,
  readRootRefusal,
} from './policy-tables';
import { NotAReadGateError, answerReadAlways, projectReadSettings } from './posture';
import { type PermissionResponderSession, buildPermissionResponder } from './responder';

const WORKER = '01ARZ3NDEKTSV4RRFFQ69G5FA1' as AgentId;

let root: string;
let store: StateStore;
let streams: StreamService;
let projects: ProjectService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agile-posture-'));
  store = StateStore.open(runInit(join(root, 'home')).stateRoot);
  streams = new StreamService(store);
  projects = new ProjectService(store, streams);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the posture: the project, else the home, else Ask', () => {
  test('resolves in that order, and the project adds its Always roots', async () => {
    const project = await projects.create({ name: 'Cents' });
    const settings = projectReadSettings(store);
    expect(settings(project.id)).toEqual({});
    expect(nodeReadScope({ project: project.id }, () => ({}), undefined, settings).posture).toBe(
      'ask',
    );

    await store.setPermissionPosture('trusted');
    expect(store.getHomeConfig().permissions).toBe('trusted');
    expect(settings(project.id).posture).toBe('trusted');
    expect(settings(undefined).posture).toBe('trusted');

    await projects.update(project.id, { permissions: 'ask', read_roots: [join(root, 'extra')] });
    expect(settings(project.id)).toEqual({ posture: 'ask', readRoots: [join(root, 'extra')] });
    const scope = nodeReadScope({ project: project.id }, () => ({}), undefined, settings);
    expect(scope.posture).toBe('ask');
    expect(scope.readRoots).toEqual([join(root, 'extra')]);

    // `null` inherits again; Ask, the default, leaves no key in config.yaml.
    await projects.update(project.id, { permissions: null });
    await store.setPermissionPosture('ask');
    expect(store.getHomeConfig().permissions).toBeUndefined();
    expect(settings(project.id).posture).toBeUndefined();
  });

  test('an unreadable config or project falls back to Ask with no extra roots', () => {
    writeFileSync(join(root, 'home', 'config.yaml'), 'permissions: [::bad\n');
    const scope = nodeReadScope(
      { project: 'P-01ARZ3NDEKTSV4RRFFQ69G5FA1' },
      () => ({}),
      undefined,
      projectReadSettings(store),
    );
    expect(scope).toEqual({ readRoots: [], hiddenRoots: [], posture: 'ask' });
  });

  test('an Always root inside a hidden one (the agile home, a private repo) is dropped', () => {
    const home = join(root, 'agile');
    const secret = join(root, 'secret');
    const repos: ReposConfig = {
      secret: {
        path: secret,
        protected_branches: ['main'],
        visibility: { mode: 'private', projects: ['P-01ARZ3NDEKTSV4RRFFQ69G5FA9'] },
      },
    };
    const scope = nodeReadScope(
      { project: 'P-01ARZ3NDEKTSV4RRFFQ69G5FA1' },
      () => repos,
      home,
      () => ({
        readRoots: [join(home, 'threads'), join(secret, 'src'), join(root, 'ok')],
      }),
    );
    expect(scope.readRoots).toEqual([join(root, 'ok')]);
    expect(scope.hiddenRoots).toEqual([secret, home]);
  });
});

describe('Always roots and credentials', () => {
  test('a read root is a dir below /, never the home dir or one above it', () => {
    expect(readRootRefusal('/')).toBeDefined();
    expect(readRootRefusal(homedir())).toBeDefined();
    expect(readRootRefusal(join(homedir(), '..'))).toBeDefined();
    expect(readRootRefusal('relative/dir')).toBeDefined();
    expect(readRootRefusal(join(root, 'code'))).toBeUndefined();
    expect(alwaysReadRoot(join(homedir(), 'notes.txt'))).toBeUndefined();
    expect(alwaysReadRoot('/etc/hosts')).toBe('/etc');
    mkdirSync(join(root, 'code', 'app'), { recursive: true });
    expect(alwaysReadRoot(join(root, 'code', 'app'))).toBe(join(root, 'code', 'app'));
    expect(alwaysReadRoot(join(root, 'code', 'app', 'missing.ts'))).toBe(join(root, 'code', 'app'));
  });

  test('the credential list covers the named locations, `*` entries by prefix', () => {
    for (const entry of ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.docker/config.json']) {
      expect(CREDENTIAL_PATHS).toContain(entry);
    }
    const home = join(root, 'user');
    expect(isCredentialPath(join(home, '.ssh', 'id_rsa'), home)).toBe(true);
    expect(isCredentialPath(join(home, '.claude', '.credentials.json'), home)).toBe(true);
    expect(isCredentialPath(join(home, '.claude', '.credentials.bak'), home)).toBe(true);
    expect(isCredentialPath(join(home, '.claude', 'settings.json'), home)).toBe(false);
    expect(isCredentialPath(join(home, '.config', 'gh', 'hosts.yml'), home)).toBe(true);
    expect(isCredentialPath(join(home, '.config', 'other'), home)).toBe(false);
    expect(isCredentialPath('/proc/1/environ', home)).toBe(true);
    expect(isCredentialPath(join(home, 'code', '.ssh-notes'), home)).toBe(false);
  });

  test('ProjectService: addReadRoot dedupes and refuses a too-wide root; update validates the list', async () => {
    const project = await projects.create({ name: 'Cents' });
    await projects.addReadRoot(project.id, join(root, 'code'));
    await projects.addReadRoot(project.id, join(root, 'code', 'app'));
    await projects.addReadRoot(project.id, join(root, 'code'));
    expect(store.getProject(project.id).read_roots).toEqual([join(root, 'code')]);
    await expect(projects.addReadRoot(project.id, homedir())).rejects.toThrow('too wide');
    await expect(projects.update(project.id, { read_roots: ['/'] })).rejects.toThrow();
    await expect(projects.update(project.id, { read_roots: ['/a/../b'] })).rejects.toThrow();
    await projects.update(project.id, { read_roots: [] });
    expect(store.getProject(project.id).read_roots).toBeUndefined();
  });
});

describe('answerReadAlways', () => {
  test('refuses a gate that is not a held read', async () => {
    const gates = new GateService(store);
    const project = await projects.create({ name: 'Cents' });
    const node = await streams.create('human', { title: 'n', goal: 'g', project: project.id });
    const gate = await gates.request('classifier_review', {
      policy: {
        gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
        breaker_signals: [],
      },
      stream: node.id,
      summary: 'a push',
    });
    await expect(answerReadAlways({ gates, streams, projects }, gate.id, 'human')).rejects.toThrow(
      NotAReadGateError,
    );
    expect(gates.get(gate.id).status).toBe('pending');
  });
});

describe('the ACP tier routes a held read like the hook (T457)', () => {
  function fakeSession(): PermissionResponderSession & { answers: unknown[] } {
    const answers: unknown[] = [];
    return {
      answers,
      respondPermission(_id, result) {
        answers.push(result);
        return true;
      },
    };
  }

  test('Ask: a card and a deny; approved, the retry is allowed once; Trusted allows at once', async () => {
    const gates = new GateService(store);
    const project = await projects.create({ name: 'Cents' });
    const node = await streams.create('human', { title: 'n', goal: 'g', project: project.id });
    const worktree = join(root, 'wt');
    const outside = join(root, 'other');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const session = fakeSession();
    const respond = (posture: 'ask' | 'trusted') =>
      buildPermissionResponder(store, {
        role: 'engineer',
        agent: WORKER,
        worktreePath: worktree,
        session,
        readRoots: [],
        hiddenRoots: [],
        posture,
        routeRead: acpReadRouter({
          gates,
          store,
          session: WORKER,
          stream: node.id,
          worktreePath: worktree,
        }),
      });
    const req = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc', kind: 'execute', rawInput: { command: `ls ${outside}` } },
      options: [
        { optionId: 'yes', kind: 'allow_once' as const },
        { optionId: 'no', kind: 'reject_once' as const },
      ],
    };

    const first = await respond('ask').handleRequest(1, req);
    expect(first.kind).toBe('deny');
    expect(session.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    const gate = gates.list()[0];
    expect(gate?.read_root).toBe(outside);
    expect(gate?.call).toMatchObject({ tool: 'Bash', command: `ls ${outside}` });

    if (gate === undefined) throw new Error('no gate');
    await gates.respond(gate.id, 'approve', 'human');
    expect((await respond('ask').handleRequest(2, req)).kind).toBe('allow');
    expect(session.answers.at(-1)).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect((await respond('ask').handleRequest(3, req)).kind).toBe('deny');

    expect((await respond('trusted').handleRequest(4, req)).kind).toBe('allow');
  });
});
