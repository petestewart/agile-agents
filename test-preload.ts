// bun test preload (see bunfig.toml): make git-driven tests hermetic.
// Fixture repos must not inherit the host's global/system git config
// (commit signing helpers, hooks paths, author identity), so every
// `git` the tests spawn sees a clean environment. Daemon-authored commits
// already pass `-c commit.gpgsign=false`; this covers the fixtures' own
// plain `git commit` calls.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME ??= 'agile-test';
process.env.GIT_AUTHOR_EMAIL ??= 'agile-test@localhost';
process.env.GIT_COMMITTER_NAME ??= 'agile-test';
process.env.GIT_COMMITTER_EMAIL ??= 'agile-test@localhost';
