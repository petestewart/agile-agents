// bun test preload (see bunfig.toml): make git-driven tests hermetic.
// Fixture repos must not inherit the host's global/system git config
// (commit signing helpers, hooks paths, author identity), so every
// `git` the tests spawn sees a clean environment. Daemon-authored commits
// already pass `-c commit.gpgsign=false`; this covers the fixtures' own
// plain `git commit` calls.
// Identity lives in a hermetic global config rather than `GIT_AUTHOR_*` /
// `GIT_COMMITTER_*` env vars: env identity outranks `git -c user.name=...`,
// which would defeat the daemon's own per-command identity (`store/git.ts`
// commits as `agiled`) and the tests that assert it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hermeticGitConfig = join(mkdtempSync(join(tmpdir(), 'agile-test-git-')), 'gitconfig');
writeFileSync(
  hermeticGitConfig,
  [
    '[user]',
    '\tname = agile-test',
    '\temail = agile-test@localhost',
    '[commit]',
    '\tgpgsign = false',
    '',
  ].join('\n'),
);
process.env.GIT_CONFIG_GLOBAL = hermeticGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]) {
  delete process.env[key];
}

// Bun 1.3.x snapshots the process environment at startup for `Bun.spawn` /
// `Bun.spawnSync` when no `env` option is given, so the mutations above never
// reached the git subprocesses the fixtures spawn (measured: a child saw an
// empty `GIT_CONFIG_GLOBAL` while `process.env` said `/dev/null`). Default the
// `env` option to the live `process.env` so every child sees the hermetic
// settings; an explicit `env` from a test or from production code still wins.
{
  const origSpawn = Bun.spawn;
  const origSpawnSync = Bun.spawnSync;
  const withEnv = <T extends { env?: unknown } | undefined>(opts: T): T =>
    (opts && typeof opts === 'object' && 'env' in opts && opts.env !== undefined
      ? opts
      : { ...(opts ?? {}), env: process.env }) as T;
  // biome-ignore lint/suspicious/noExplicitAny: thin pass-through over Bun's overloaded signatures
  (Bun as any).spawn = (cmd: any, opts?: any) =>
    Array.isArray(cmd) ? origSpawn(cmd, withEnv(opts)) : origSpawn(withEnv(cmd));
  // biome-ignore lint/suspicious/noExplicitAny: thin pass-through over Bun's overloaded signatures
  (Bun as any).spawnSync = (cmd: any, opts?: any) =>
    Array.isArray(cmd) ? origSpawnSync(cmd, withEnv(opts)) : origSpawnSync(withEnv(cmd));
}
