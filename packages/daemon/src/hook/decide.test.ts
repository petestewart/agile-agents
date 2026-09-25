import { describe, expect, test } from 'bun:test';
import type { AgentMessage, ReposConfig } from '@agile-agents/shared';
import { decidePreToolUse } from './decide';
import { DEFAULT_MAX_READ_BYTES, type HookDecisionContext } from './types';

function baseCtx(overrides: Partial<HookDecisionContext> = {}): HookDecisionContext {
  return {
    session: '01J9AAAAAAAAAAAAAAAAAAAAAA',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    role: 'worker',
    worktreePath: '/repo/.worktrees/TKT-0001',
    inbox: [],
    limits: { maxReadBytes: DEFAULT_MAX_READ_BYTES },
    fileSize: () => undefined,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: '01J9000000000000000000000',
    ts: '2026-09-09T00:00:00Z',
    from: 'human',
    to: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    kind: 'hil_response',
    priority: 'normal',
    body: 'use the JWT approach',
    refs: [],
    ...overrides,
  } as AgentMessage;
}

describe('decidePreToolUse — normal inbox is additive, never overrides the gate verdict (review round fix, blocker 1)', () => {
  const normal = makeMessage({ id: 'norm-1', priority: 'normal', body: 'use the JWT approach' });

  test('a pending normal message does NOT turn a big-read denial into an allow', () => {
    const ctx = baseCtx({ inbox: [normal], fileSize: () => 100 * 1024 });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: 'big.txt' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/read_summary/);
    // Still delivered: attached to the deny output, and acked.
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });

  test('a pending normal message does NOT turn a never-without-human ask into an allow', () => {
    const ctx = baseCtx({ inbox: [normal] });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
    });
    expect(result.decision).toBe('ask');
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });

  test('with nothing else to gate, a pending normal message still just allows + injects context', () => {
    const ctx = baseCtx({ inbox: [normal] });
    const result = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'x.txt' } });
    expect(result.decision).toBe('allow');
    expect(result.additionalContext).toContain('use the JWT approach');
    expect(result.ack).toEqual(['norm-1']);
  });
});

// Review round 3 (opus item 1): role × tool policy now reuses T010's whole
// `decidePermission` pipeline for edit-kind tools and `Bash`, for every
// role — not just a Bash-only `checkNeverWithoutHuman` branch that never
// consulted the role table at all. Every assertion below is a real
// `decision`/`reason` check, not a `void`d call.
describe('decidePreToolUse — role × tool policy (review round 3, reuses decidePermission)', () => {
  test('reviewer Edit/Write/MultiEdit/NotebookEdit all deny — reviewers are read-only', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const result = decidePreToolUse(ctx, {
        tool_name: tool,
        tool_input: { file_path: '/repo/.worktrees/TKT-0001/a.ts' },
      });
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/reviewer role denies all writes/);
    }
  });

  test('a generic tool reporting tool_input.kind === "edit" is gated the same as a named edit tool', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'SomeMcpEditTool',
      tool_input: { kind: 'edit', file_path: '/repo/.worktrees/TKT-0001/a.ts' },
    });
    expect(result.decision).toBe('deny');
  });

  test('worker Edit inside its own worktree allows', () => {
    const ctx = baseCtx({ role: 'worker', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/.worktrees/TKT-0001/a.ts' },
    });
    expect(result).toEqual({ decision: 'allow' });
  });

  test('worker Edit outside its own worktree denies', () => {
    const ctx = baseCtx({ role: 'worker', worktreePath: '/repo/.worktrees/TKT-0001' });
    const result = decidePreToolUse(ctx, {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/other-ticket/a.ts' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/outside the worktree/);
  });

  test('reviewer Bash: read-only allow-list (git diff) allows, everything else (rm -rf) denies', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const readOnly = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'git diff' },
    });
    expect(readOnly).toEqual({ decision: 'allow' });

    const destructive = decidePreToolUse(ctx, {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf src' },
    });
    expect(destructive.decision).toBe('deny');
    expect(destructive.reason).toMatch(/reviewer role denies all exec/);
  });

  test('a Read/Grep/Glob is never routed through the role table — untouched by this round', () => {
    const ctx = baseCtx({ role: 'reviewer', worktreePath: '/repo/.worktrees/TKT-0001' });
    const read = decidePreToolUse(ctx, {
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
    });
    expect(read).toEqual({ decision: 'allow' });
    const glob = decidePreToolUse(ctx, { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
    expect(glob).toEqual({ decision: 'allow' });
  });
});

// T229 (P13): the visibility deny rides the hook's path checks.
describe('decidePreToolUse — repo visibility (T229)', () => {
  const SHOP = 'P-01J9SHOPSHOPSHOPSHOPSHOPSH';
  const BLOG = 'P-01J9BLOGBLOGBLOGBLOGBLOGBL';
  const repos: ReposConfig = {
    api: {
      path: '/src/api',
      protected_branches: [],
      visibility: { mode: 'private' as const, projects: [SHOP] },
    },
    blog: { path: '/src/blog', protected_branches: [] },
    shop: { path: '/src/shop', protected_branches: [] },
  };
  const read = { tool_name: 'Read', tool_input: { file_path: '/src/api/prices.ts' } };

  test('a Blog node reading the private api listed only for Shop is denied with the reason', () => {
    const d = decidePreToolUse(
      baseCtx({
        worktreePath: '/src/blog/.worktrees/n1',
        visibility: {
          repos,
          ownRepo: 'blog',
          project: BLOG,
          worktreePath: '/src/blog/.worktrees/n1',
        },
      }),
      read,
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('private');
    expect(d.reason).toContain('api');
    expect(d.reason).toContain(BLOG);
  });

  test('a Shop node reading the same file is allowed', () => {
    const d = decidePreToolUse(
      baseCtx({
        worktreePath: '/src/shop/.worktrees/n2',
        // T213: the service also hands over the roots Shop may read.
        readRoots: ['/src/api', '/src/blog', '/src/shop'],
        visibility: {
          repos,
          ownRepo: 'shop',
          project: SHOP,
          worktreePath: '/src/shop/.worktrees/n2',
        },
      }),
      read,
    );
    expect(d.decision).toBe('allow');
  });

  test('a Shop node may not write into api: changes stay in its own repo', () => {
    const d = decidePreToolUse(
      baseCtx({
        worktreePath: '/src/shop/.worktrees/n2',
        visibility: {
          repos,
          ownRepo: 'shop',
          project: SHOP,
          worktreePath: '/src/shop/.worktrees/n2',
        },
      }),
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/src/blog/a.ts', old_string: 'a', new_string: 'b' },
      },
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('own repo (shop)');
  });

  test('Bash `cat` of a private api file: Blog denied, Shop allowed', () => {
    const cat = { tool_name: 'Bash', tool_input: { command: 'cat /src/api/prices.ts | head' } };
    const blog = decidePreToolUse(
      baseCtx({
        worktreePath: '/src/blog/.worktrees/n1',
        visibility: {
          repos,
          ownRepo: 'blog',
          project: BLOG,
          worktreePath: '/src/blog/.worktrees/n1',
        },
      }),
      cat,
    );
    expect(blog.decision).toBe('deny');
    expect(blog.reason).toContain('private');
    const shop = decidePreToolUse(
      baseCtx({
        worktreePath: '/src/shop/.worktrees/n2',
        visibility: {
          repos,
          ownRepo: 'shop',
          project: SHOP,
          worktreePath: '/src/shop/.worktrees/n2',
        },
      }),
      cat,
    );
    // The role policy already confines Bash reads to the worktree; visibility itself passes.
    expect(shop.reason ?? '').not.toMatch(/private|own repo/);
  });

  test('an unreadable repos.yaml fails closed outside the worktree', () => {
    const ctx = baseCtx({
      worktreePath: '/src/blog/.worktrees/n1',
      visibility: {
        repos: {},
        reposError: '/home/repos.yaml:3: bad',
        worktreePath: '/src/blog/.worktrees/n1',
      },
    });
    const out = decidePreToolUse(ctx, read);
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('repos.yaml');
    const inside = decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
    expect(inside.decision).toBe('allow');
  });
});

// T213 (projects-design §4.4, P20): reads reach every repo the node can see;
// writes stay in the node's own worktree (a coordinator's: its session dir).
describe('decidePreToolUse — T213 read scope', () => {
  const ledger = '/repos/ledger-lite';
  const shop = '/repos/shop-private';
  const scope = { readRoots: ['/repos/app', ledger], hiddenRoots: [shop] };
  const part = `${ledger}/.worktrees/01part-ledger-lite-part`;
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

  for (const [role, worktreePath] of [
    ['coordinator', '/home/.agile/sessions/01coord'],
    ['worker', '/repos/app/.worktrees/01sib-app-part'],
  ] as const) {
    test(`a ${role} reads a sibling part's worktree and another public repo`, () => {
      const ctx = baseCtx({ role: 'worker', worktreePath, ...scope });
      for (const command of [`ls -la ${part}`, `cat ${part}/src/a.ts`, `grep -rn sale ${ledger}`]) {
        expect(decidePreToolUse(ctx, bash(command)).decision).toBe('allow');
      }
      expect(
        decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path: `${part}/a.ts` } })
          .decision,
      ).toBe('allow');
    });

    test(`a ${role} still cannot write outside its own worktree`, () => {
      const ctx = baseCtx({ role: 'worker', worktreePath, ...scope });
      expect(decidePreToolUse(ctx, bash(`touch ${part}/x`)).decision).toBe('deny');
      expect(decidePreToolUse(ctx, bash(`cp ${part}/a ${part}/b`)).decision).toBe('deny');
      expect(decidePreToolUse(ctx, bash(`echo hi > ${part}/x`)).decision).toBe('deny');
      expect(
        decidePreToolUse(ctx, { tool_name: 'Write', tool_input: { file_path: `${part}/x.ts` } })
          .decision,
      ).toBe('deny');
    });
  }

  test('a Blog node cannot read a private repo listed for Shop', () => {
    const ctx = baseCtx({ worktreePath: '/repos/app/.worktrees/01blog', ...scope });
    expect(decidePreToolUse(ctx, bash(`cat ${shop}/secret.ts`)).decision).toBe('deny');
    for (const tool_name of ['Read', 'Grep', 'Glob']) {
      const result = decidePreToolUse(ctx, { tool_name, tool_input: { path: `${shop}/src` } });
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/private repo/);
    }
  });

  test('built-in reads are an allow-list: the agile home and ~/.ssh are denied', () => {
    const home = '/home/pete/.agile';
    for (const worktreePath of [`${home}/sessions/01coord`, '/repos/app/.worktrees/01w']) {
      const ctx = baseCtx({ worktreePath, readRoots: scope.readRoots, hiddenRoots: [shop, home] });
      const read = (file_path: string) =>
        decidePreToolUse(ctx, { tool_name: 'Read', tool_input: { file_path } }).decision;
      expect(read(`${home}/config.yaml`)).toBe('deny');
      expect(read('/home/pete/.ssh/id_rsa')).toBe('deny');
      expect(read(`${ledger}/src/a.ts`)).toBe('allow');
      expect(read(`${worktreePath}/notes.md`)).toBe('allow');
      expect(decidePreToolUse(ctx, bash(`cat ${home}/config.yaml`)).decision).toBe('deny');
      expect(
        decidePreToolUse(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x', path: '/etc' } })
          .decision,
      ).toBe('deny');
    }
  });

  test('rg --pre runs a command, so it is not a read', () => {
    const ctx = baseCtx({ ...scope });
    for (const command of [
      `rg --pre ./x sale ${ledger}`,
      'rg --pre=./x sale',
      'rg --pre-glob "*" x',
    ]) {
      expect(decidePreToolUse(ctx, bash(command)).decision).toBe('deny');
      expect(decidePreToolUse({ ...ctx, role: 'reviewer' }, bash(command)).decision).toBe('deny');
    }
  });

  test('without a read scope, Bash reads stay in the worktree', () => {
    expect(decidePreToolUse(baseCtx(), bash(`ls ${part}`)).decision).toBe('deny');
  });
});

describe('T280: a coordinator writes only in its scratch session dir (P20)', () => {
  const home = '/home/u/.agile';
  const dir = `${home}/sessions/01J9AAAAAAAAAAAAAAAAAAAAAA`;
  const ctx = baseCtx({ role: 'coordinator', worktreePath: dir });
  const decide = (tool_name: string, tool_input: Record<string, unknown>) =>
    decidePreToolUse(ctx, { tool_name, tool_input }).decision;

  test('Write/Edit inside the session dir are allowed', () => {
    expect(decide('Write', { file_path: `${dir}/notes.md` })).toBe('allow');
    expect(decide('Edit', { file_path: `${dir}/plan.md` })).toBe('allow');
  });

  test('a write outside it is denied: the repo, and .agile state elsewhere', () => {
    expect(decide('Write', { file_path: '/repo/src/a.ts' })).toBe('deny');
    expect(decide('Edit', { file_path: `${home}/config.yaml` })).toBe('deny');
    expect(decide('Write', { file_path: `${home}/sessions/01J9OTHER/notes.md` })).toBe('deny');
  });

  test('Bash writes follow the same line; reads are allowed', () => {
    expect(decide('Bash', { command: `echo x > ${dir}/notes.md` })).toBe('allow');
    expect(decide('Bash', { command: `echo x > ${home}/config.yaml` })).toBe('deny');
    expect(decide('Bash', { command: 'echo x > /repo/a.ts' })).toBe('deny');
    expect(decide('Bash', { command: 'rm -rf /repo' })).toBe('deny');
    expect(decide('Read', { file_path: `${dir}/brief.md` })).toBe('allow');
  });
});

describe('T336: a coordinator reads other repos with realistic Bash', () => {
  const home = '/home/u/.agile';
  const dir = `${home}/sessions/01J9AAAAAAAAAAAAAAAAAAAAAA`;
  const ledger = '/home/u/Projects/ledger-lite';
  const shop = '/home/u/Projects/shop-private';
  const ctx = baseCtx({
    role: 'coordinator',
    worktreePath: dir,
    readRoots: [ledger, '/home/u/Projects/agile-test-repo'],
    hiddenRoots: [shop, home],
  });
  const bash = (command: string) =>
    decidePreToolUse(ctx, { tool_name: 'Bash', tool_input: { command, description: 'x' } });

  test('read-only commands on a readable repo are allowed, cd included', () => {
    for (const command of [
      `ls ${ledger}`,
      `cat ${ledger}/README.md`,
      `git -C ${ledger} log --oneline -5`,
      `cd ${ledger} && git log --oneline -5`,
      `cd ${ledger} && ls -la && git status`,
      `cd ${dir} && echo draft > notes.md`,
      `cd ${ledger} && cat README.md src/a.ts`,
    ]) {
      expect([command, bash(command).decision]).toEqual([command, 'allow']);
    }
  });

  test('cd does not open a way to write or read what was closed', () => {
    for (const command of [
      // A relative redirect after cd lands in the repo, not the session dir.
      `cd ${ledger} && echo x > notes.md`,
      `cd ${ledger} && git commit -m x`,
      `cd ${ledger} && touch x`,
      `cd ${shop} && ls`,
      `cd ${home} && cat config.yaml`,
      'cd && ls',
      'cd - && ls',
      'cd $HOME && ls',
      // T305's read scope follows the cd: a relative path resolves from it.
      `cd ${ledger} && cat ../../../../etc/passwd`,
      `cd ${ledger}/.. && cat shop-private/secret.ts`,
      `git -C ${shop} log --oneline -5`,
    ]) {
      expect([command, bash(command).decision]).toEqual([command, 'deny']);
    }
  });
});

describe('T291: a coordinator has no network (P20)', () => {
  const web = (role: HookDecisionContext['role'], tool_name: string) =>
    decidePreToolUse(baseCtx({ role }), {
      tool_name,
      tool_input: { url: 'https://example.com', query: 'x' },
    });

  test('WebFetch and WebSearch are denied for a coordinator', () => {
    for (const tool of ['WebFetch', 'WebSearch']) {
      const d = web('coordinator', tool);
      expect(d.decision).toBe('deny');
      expect(d.reason).toContain('no network');
    }
  });

  test('a worker (engineer) is unchanged: both fall through to allow', () => {
    expect(web('worker', 'WebFetch').decision).toBe('allow');
    expect(web('worker', 'WebSearch').decision).toBe('allow');
  });
});
