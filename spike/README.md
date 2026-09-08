# spike/

The vendor spike that produced `design/spike-findings.md`. Kept for re-runs (T009 hook check, T014 plan-mode check, T022 Pi).

- `permission-matrix.ts` — Bun script; hand-rolled ACP JSON-RPC client over stdio. Presets `claude | gemini | cursor | grok | codex | pi`; scenarios `perm | cancel | resume | auth`; flags `--mode`, `--deny <regex>`, `--fs-deny <regex>`, `--auth <methodId>`, `--hooks` (installs a Claude PreToolUse hook / Cursor hooks.json / Pi extension in the fixture), `--keep`, `--out`, `--verbose`. Needs the vendor CLI installed and logged in — **not runnable in a cloud session**.
- `runner.sh` — runs `queue/*.cmd` in order, logs to `spike-out/<name>.log`; used to batch runs on a machine with the vendor logins.
- `queue/` — the command files that were run.
- `spike-out/` — raw JSON reports per `<vendor>-<mode>-<scenario>[-hooks]`. These are the evidence behind the findings doc.

Example: `bun spike/permission-matrix.ts --vendor claude --mode default --scenario perm --hooks`
