/**
 * T143: one checker per `pattern.kind` (§5.2's pattern tier). The push
 * detector has its own table (`push-detector.test.ts`) — this covers the
 * dispatch, the `path_deny` worktree boundary and glob half, and
 * `command_deny`'s atom matching (never a substring of the raw line).
 */

import { describe, expect, test } from 'bun:test';
import { type Rule, type RuleInput, type RulePattern, ulid, validateRule } from '@agile-agents/shared';
import { type RuleCheckContext, checkPatternRule } from './rule-checks';

const WORKTREE = '/tmp/agile-worktree-fixture';

function rule(pattern: RulePattern, over: Partial<RuleInput> = {}): Rule {
  return validateRule({
    id: `R-${ulid()}`,
    text: 'fixture',
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'pattern',
    pattern,
    critical: true,
    provenance: { by: 'builtin' },
    stats: {},
    created_at: new Date().toISOString(),
    ...over,
  });
}

function ctx(over: Partial<RuleCheckContext> = {}): RuleCheckContext {
  return {
    worktreePath: WORKTREE,
    protectedBranches: ['main', 'master'],
    upstream: () => 'origin/T143-x',
    head: () => 'T143-x',
    ...over,
  };
}

describe('dispatch', () => {
  test('a guidance rule is never a pattern check, even carrying a pattern', () => {
    const guidance = rule({ kind: 'no_push', args: {} }, { enforcement: 'guidance' });
    expect(checkPatternRule(guidance, ctx({ command: 'git push origin main' }))).toBeUndefined();
  });

  test('no_push_protected says nothing about a tool call with no command', () => {
    expect(
      checkPatternRule(rule({ kind: 'no_push_protected', args: {} }), ctx({ paths: ['a.ts'] })),
    ).toBeUndefined();
  });

  test('no_push_protected denies a push to a protected branch and names the branch', () => {
    const reason = checkPatternRule(
      rule({ kind: 'no_push_protected', args: {} }),
      ctx({ command: 'git push origin main' }),
    );
    expect(reason).toContain('main');
  });

  test('the protected branches come from the context, not the rule', () => {
    const detector = rule({ kind: 'no_push_protected', args: {} });
    const trunkOnly = ctx({ command: 'git push origin main', protectedBranches: ['trunk'] });
    expect(checkPatternRule(detector, trunkOnly)).toBeUndefined();
    expect(
      checkPatternRule(detector, { ...trunkOnly, command: 'git push origin trunk' }),
    ).toBeString();
  });
});

describe('path_deny (no_worktree_escape)', () => {
  const worktreeEscape = rule({ kind: 'path_deny', args: { globs: [] } });

  test('a write outside the worktree is denied', () => {
    const reason = checkPatternRule(
      worktreeEscape,
      ctx({ paths: ['/etc/hosts'], writes: true }),
    );
    expect(reason).toContain('/etc/hosts');
  });

  test('a write inside the worktree is allowed', () => {
    expect(
      checkPatternRule(worktreeEscape, ctx({ paths: [`${WORKTREE}/src/a.ts`], writes: true })),
    ).toBeUndefined();
  });

  test('a read outside the worktree is not what §5.4 prohibits', () => {
    expect(
      checkPatternRule(worktreeEscape, ctx({ paths: ['/etc/hosts'], writes: false })),
    ).toBeUndefined();
  });

  test('every path is checked, not just the first', () => {
    const reason = checkPatternRule(
      worktreeEscape,
      ctx({ paths: [`${WORKTREE}/ok.ts`, '/etc/hosts'], writes: true }),
    );
    expect(reason).toContain('/etc/hosts');
  });

  test('git -C outside the worktree is an escape even with no path in tool_input', () => {
    const reason = checkPatternRule(
      worktreeEscape,
      ctx({ command: 'git -C /somewhere/else commit -m x' }),
    );
    expect(reason).toContain('/somewhere/else');
  });

  test('git -C inside the worktree is ordinary work', () => {
    expect(
      checkPatternRule(worktreeEscape, ctx({ command: `git -C ${WORKTREE}/sub status` })),
    ).toBeUndefined();
  });

  test('a rule-supplied glob denies a path inside the worktree too', () => {
    const noSecrets = rule({ kind: 'path_deny', args: { globs: ['**/*.pem'] } });
    expect(
      checkPatternRule(noSecrets, ctx({ paths: [`${WORKTREE}/certs/key.pem`], writes: false })),
    ).toContain('*.pem');
    expect(
      checkPatternRule(noSecrets, ctx({ paths: [`${WORKTREE}/src/a.ts`], writes: true })),
    ).toBeUndefined();
  });
});

describe('command_deny', () => {
  const noCurl = rule({ kind: 'command_deny', args: { patterns: ['curl', 'npm publish'] } });

  test('matches on the parsed atoms of a chain', () => {
    expect(checkPatternRule(noCurl, ctx({ command: 'bun test && curl https://x' }))).toContain(
      'curl',
    );
  });

  test('a multi-token pattern matches contiguous tokens only', () => {
    expect(checkPatternRule(noCurl, ctx({ command: 'npm publish --dry-run' }))).toContain(
      'npm publish',
    );
    expect(checkPatternRule(noCurl, ctx({ command: 'npm run publish' }))).toBeUndefined();
  });

  test('never a substring of the raw line', () => {
    expect(
      checkPatternRule(noCurl, ctx({ command: 'echo "do not use curlicues"' })),
    ).toBeUndefined();
    expect(checkPatternRule(noCurl, ctx({ command: 'grep -rn curlybrace src' }))).toBeUndefined();
  });

  test('no patterns means nothing is denied', () => {
    const empty = rule({ kind: 'command_deny', args: { patterns: [] } });
    expect(checkPatternRule(empty, ctx({ command: 'curl https://x' }))).toBeUndefined();
  });
});
