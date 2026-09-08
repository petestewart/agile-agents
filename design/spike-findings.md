# Agile Agents spike — findings (2026-09-07)

Sources: Terma's two ACP spikes (`roadmap/agent-gui/SPIKE.md`, `roadmap/native-orchestration/SPIKE.md`, `specs/agent-control-channel.md`, `src/main/terminal-host/acp-session.ts`) plus `permission-matrix.ts` runs in this folder against `@agentclientprotocol/claude-agent-acp@0.75.1` / Claude Code 2.1.263. Raw reports in `spike-out/`.

## Answers

### A. Does every tool call reach the ACP client as a permission request? — No.

Claude adapter, one prompt that exercises Read / grep / `git status` / `echo > file` / Edit / Write / big Read / `npm test` / `curl`:

| mode | Read | grep, `git status` | `echo hi > out.txt` | Edit / Write | `npm test`, `curl` |
|---|---|---|---|---|---|
| `default` | no prompt | no prompt | **prompt** | **prompt** | **prompt** |
| `acceptEdits` | no | no | no (treated as an edit) | no | **prompt** |
| `auto` | no | no | no | no | no |
| `bypassPermissions` | no | no | no | no | no |
| `plan` | (not run) | | | | |

`tool_call` notifications arrive for **every** call regardless of mode, so the client can always *observe*; it can only *gate* what the harness chooses to ask about. Read/Grep/Glob are never asked about in any mode.

### B. Can a denial carry a reason? — Not over ACP. Yes via Claude hooks.

- ACP `session/request_permission` → `reject_once`: the model sees the generic `"User refused permission to run tool"`. No reason field exists on the wire (`spike-out/claude-default-perm.json`).
- A **project-level `PreToolUse` hook** (`.claude/settings.json` in the worktree) runs under the ACP adapter, fires for every tool call (Read included), and a JSON `permissionDecision: "deny"` with `permissionDecisionReason` is delivered to the model verbatim (`spike-out/claude-default-perm-hooks.json`: model reported `REFUSED — "AGILE-GATE: … Use read_summary(path, question) instead."`).
- So for Claude the gate is: **hooks for gating-with-reason on any tool (incl. reads), ACP permission for the edit/exec subset, ACP `tool_call` stream for observation.**

### C. Cancel, resume, auth (Claude)

- `session/cancel` → `stopReason: "cancelled"` in ~20 ms; process stays alive; the in-flight `tool_call` is left `pending` (no closing update — matches Terma's finding); the session accepts the next prompt normally.
- `session/load` in a fresh process restores real context (secret word recalled). ACP `sessionId` == Claude Code session id.
- Adapter used Claude Code's ambient login with **no API-key env var present** (`claude-defaultmode-auth.json`). In this container the ambient auth is host-managed, so this proves "adapter inherits the CLI's login", not "Max OAuth specifically" — run `--scenario auth` on a machine logged in via `claude login` to close that.
- Adapter never calls client `fs/*` or `terminal/*`; Claude Code's own tools do the I/O. Advertise `fs` (harmless), don't advertise `terminal`.
- Modes at 0.75.1: `default, acceptEdits, plan, auto, bypassPermissions` (Terma's 0.62 also listed `dontAsk`; gone).

### C2. Results from Pete's machine (2026-09-07)

- **Claude + Max login confirmed**: `--scenario auth` passed with `claude login` and no API-key env var.
- **Cursor** (`cursor-agent acp`, modes `agent | plan | ask`, ACP `authenticate(cursor_login)` required): in `agent` mode raises a permission request for **every exec** (even `git status`), **none for edits or reads**. Cancel/resume untested.
- **Codex** (`@agentclientprotocol/codex-acp`, modes `read-only | agent | agent-full-access`, `authMethods` api-key | chat-gpt): raised **zero** permission requests in `agent` *and* `read-only` (`set_mode read-only ok`, yet writes and `curl` ran). Cancel: `cancelled` in 7 ms, session usable. `session/load` restores context. No client fs.
- **Grok** (`grok agent stdio`, no modes, `authMethods` cached_token | grok.com): **zero** permission requests; but all file I/O goes through **client fs** (`fs/read_text_file` ×6, `fs/write_text_file` ×2) so the client can gate reads/writes there. Exec ungated. Cancel: 9 ms, session usable.
- **Gemini**: skipped — Gemini CLI now needs a paid Code Assist/Workspace account, not a personal Google login.

Per-vendor gating, as measured:

| vendor | reads | edits | exec | hook layer | client fs |
|---|---|---|---|---|---|
| claude `default` | PreToolUse hook | ACP + hook | ACP (non-allowlisted) + hook | yes, verified | no |
| cursor `agent` | — | — | ACP (all) | `.cursor/hooks.json` — untested (`--hooks`) | no |
| codex-acp any mode | — | — | — | none known | no |
| grok | client fs | client fs | — | none | yes |

Implication: outside Claude, ACP permission requests are not a reliable gate. Add **tier 0 — OS sandbox** (read-only mounts for reviewers/QA, no network for engineers, container or `sandbox-exec` profile per worktree) as the vendor-neutral floor, and route roles by gateability: a vendor with ungated exec is fine as an engineer only inside a sandbox; reviewers on such a vendor get a read-only checkout at the filesystem level.

### C3. Runner batch on Pete's machine (2026-09-07 evening, 9 runs, all exit 0)

- **Cursor `ask` mode**: writes refused by the *model* citing its system prompt ("Ask mode is active… MUST NOT make any edits"); exec still raises ACP permission requests. Prompt-level restriction, not enforcement — useful for reviewers as a nudge, not a gate.
- **Cursor hooks**: `.cursor/hooks.json` in the project (beforeReadFile + beforeShellExecution) fired **0 times** under `cursor-agent acp`. Either project-level hooks aren't honored by the headless agent or the schema/location differs; user-level `~/.cursor/hooks.json` untested. Cursor stays tier 2 for exec only.
- **Cursor cancel/resume**: `cancelled` in 6 ms, session usable after; `session/load` restores context.
- **Codex with `approval_policy = "untrusted"`** (fresh `~/.codex/config.toml`, restored after): still **zero** permission requests; writes, `npm test`, `curl` all ran. Notably Codex read files via `sed -n '1,$p'` (exec) rather than a read tool, so even a read gate would have to be an exec gate. `agent-full-access`: nothing gated either. Conclusion: **codex-acp never asks**, regardless of mode or approval policy. If Codex needs approvals, the adapter is the native `codex app-server` (which has approval request kinds) — otherwise Codex lives on tier 0 + observation.
- **Grok client-fs gate**: refusing `fs/read_text_file` with an error message works — the model reported `REFUSED "…IO Error: AGILE-GATE: this file is too large for a raw read. Use read_summary(path, question) instead."` Reasoned read/write denial on Grok is real. `session/load` works.
- **Claude `plan` mode**: writes/exec are refused by the model at prompt level, then `ExitPlanMode` arrives as an ACP permission request titled **"Approve Plan"** (`kind: switch_mode`); after `allow_once` the session behaves as `default` (edits/exec prompt again). This is a natural fit for the `approve_plan` gate: run the architect/EM planning turn in `plan` mode and the daemon's answer to "Approve Plan" *is* the gate.

Final per-vendor matrix:

| vendor | reads | edits | exec | reasoned deny | cancel | resume |
|---|---|---|---|---|---|---|
| claude `default` | PreToolUse hook | ACP + hook | ACP (non-allowlisted) + hook | hook | ✓ | ✓ |
| cursor `agent` | — | — | ACP (every exec) | — (hooks not honored) | ✓ | ✓ |
| codex-acp (any mode/policy) | — | — | — | — | ✓ | ✓ |
| grok | client fs | client fs | — | client fs error text | ✓ | ✓ |

### C4. Pi (pi-mono 0.85.1, researched 2026-09-08)

Terma's spec deferred Pi (§12.3, 2026-08-18) on three grounds: hand-rolled RPC framing, *no permission model*, nothing depended on it. The permission-model premise is now wrong, and the other two are cheap.

- **Tool gating with reasons, in-process.** Pi extensions (`~/.pi/agent/extensions/*.ts`, project `.pi/extensions/`, or `pi -e file.ts`) get a `tool_call` event; returning `{ block: true, reason }` makes the agent loop emit an **error tool result carrying the reason** (`agent-loop.ts`: `createErrorToolResult(beforeResult.reason || "Tool execution was blocked")`; `execution/tools.ts` `applyBeforeToolDecision`). So the model sees the reason — the docs' line that the reason is "displayed to the user, not the model" describes the TUI, not the tool result. The event's `input` is mutable (argument rewriting), and `tool_result` handlers can **replace tool output** before the LLM sees it — i.e. signal-over-volume (test_run → failures only) enforced at the source, on every tool, not just our MCP ones. This is strictly more than Claude hooks offer.
- **RPC mode** (`pi --mode rpc`, strict JSONL over stdio): `prompt`, **`steer`** (queue a message mid-turn, delivered before the next LLM call), `follow_up`, `abort`, `new_session`, `switch_session`, `fork`, `get_entries --since` (incremental replay), `get_state`, `set_model`, `compact`, `bash`; events `agent_start/agent_end/agent_settled`, `turn_start/turn_end`, `tool_execution_start/update/end`, `message_update`; `extension_ui_request` (`confirm`/`select`/`input`) blocks until the client answers — a real agent→daemon round-trip. Terma's note stands: don't import `RpcClient` from the 15 MB package; ~200 lines of framing (Node `readline` is not compliant — split on `\n` only).
- **ACP**: no native support; discussion earendil-works/pi#4444 open, no maintainer commitment. Community adapters: `pi-acp` 0.0.33 (svkozak, 2026-07-30; spawns `pi --mode rpc`, maps `extension_ui_request` confirm/select → ACP `request_permission`, session/load via a side map file, structured diffs) and fork `@geohar/pi-acp` 0.3.1 (2026-08-31). Zed lists Pi through pi-acp.
- **Auth**: `/login` supports **Claude Pro/Max** (note: "third-party harness usage draws from *extra usage* and is billed per token, not against Claude plan limits"), **ChatGPT Plus/Pro** (Codex OAuth), **xAI/Grok subscription**, OpenRouter OAuth, plus API keys in `~/.pi/agent/auth.json`. So Pi on Claude is a *different quota record* from Claude Code on Max — pay-per-token extra usage, not the Max window.
- **Terma today**: `src/main/lib/hooks/pi-integration.ts` already writes a self-guarding extension into `~/.pi/agent/extensions/` (before_agent_start / agent_settled / session_shutdown → hook listener over HTTP). The same install mechanism carries an Agile Agents gating extension.

Recommendation: **support Pi via its RPC mode plus an `agile` extension, not via ACP.** Two options for the daemon: (a) a thin `pi-rpc` shim that speaks ACP inward (what pi-acp does, ~200 lines we own — keeps the daemon single-protocol), or (b) run `pi-acp` unmodified and put all gating in the extension. Either way the extension is where Pi's enforcement lives, and it's the strongest tier-1 of any vendor: block-with-reason on every tool, argument rewriting, and tool-result rewriting.

| vendor | reads | edits | exec | reasoned deny | result rewriting | steer mid-turn |
|---|---|---|---|---|---|---|
| pi (extension) | ext | ext | ext | ext (error tool result) | ext `tool_result` | RPC `steer` |

**Verified on Pete's machine (2026-09-08, pi 0.85.0, default provider opencode-go / glm-5.3, 7 runs, all exit 0, ~1 min total):**

- `pi-acp` raises **zero** ACP permission requests (grep/git/npm/curl run as `bash`, edit/write native). Its ACP "modes" are pi's thinking levels (`off … xhigh`), not permission modes. `authMethods` is a terminal-login stub; `--scenario auth` passed with no API-key env vars (creds from `~/.pi/agent/auth.json`).
- **Extension gate works end-to-end**: a global `~/.pi/agent/extensions/agile-spike-gate.ts` fired 17 times (every `tool_call` + `tool_result`), blocked `read` on big.txt (ACP status `failed`), and the model reported `7. REFUSED — "AGILE-GATE: …"` — the reason reaches the model as the error tool result, exactly as the source said. Same result through `pi-acp` 0.0.33 and `@geohar/pi-acp` 0.3.1.
- **`tool_result` rewrite works**: the `npm test` output was replaced in-process by the extension; under `@geohar/pi-acp` the model quoted the replacement (`AGILE-SUMMARY …`), under `pi-acp` it just said OK — same mechanism, the model simply didn't echo it. This is the only vendor where the *harness* can enforce signal-over-volume on every tool.
- **Cancel**: `cancelled` in 11 ms, in-flight `sleep 25` closed as `failed` (cleaner than Claude's dangling `pending`), session usable after. **Resume**: `session/load` restored context via pi-acp's session map.
- Noise: pi-acp injects a "startup info" block (skills, extensions, version nag) into the first turn — set `quietStartup: true` in `~/.pi/agent/settings.json` for agent use. The existing Terma `terma-notify.ts` extension coexisted fine.

| vendor | reads | edits | exec | reasoned deny | result rewrite | cancel | resume |
|---|---|---|---|---|---|---|---|
| pi + extension | ext | ext | ext | ✓ (verified) | ✓ (verified) | ✓ 11 ms | ✓ |

Pi is in. Decision: adapter = `pi-acp` (or fork) as the ACP shim, all enforcement in an `agile` extension installed to `~/.pi/agent/extensions/` (the Terma install mechanism), self-guarding on an env var the daemon sets.

### D. Vendor status

| vendor | ACP surface | verified | notes |
|---|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` (Zed-maintained) | here + Terma | everything above |
| Codex | `@agentclientprotocol/codex-acp` 1.10.0 exists (resolves Terma's PLAN-vs-spec conflict); native alt is `codex app-server` JSON-RPC (`turn/steer`, `turn/interrupt`, `thread/resume`) | not run | needs ChatGPT login on a real machine |
| Gemini CLI | native `gemini --experimental-acp` | Terma: handshake only | reports no modes; `session/load` unverified |
| Cursor | native `cursor-agent acp` | never executed | `cursor-agent login` |
| Grok | native `grok agent stdio` | Terma: handshake | needs ACP `authenticate` (OAuth) |
| Pi | `pi-acp` / `@geohar/pi-acp` over `pi --mode rpc` + `agile` extension | verified — see C4 | strongest tier-1 of any vendor: block-with-reason on every tool, tool_result rewrite, cancel, resume, subscription/auth.json |

### E. What to lift from Terma

Node-only, Electron-free: `src/main/terminal-host/acp-session.ts` (861 lines: spawn, JSON-RPC framing, fs methods, request forwarding, turn markers, kill escalation), `src/shared/acp-types.ts` + `acp-providers.ts`, `src/main/lib/terminal-host/acp-events.ts` + `acp-session-contract.ts`, `src/shared/agent-session-contract.ts` (the vendor-neutral `MessageableSession` seam), `src/main/lib/control/messageable-acp-session.ts`, `src/main/lib/control/mailbox.ts` + `wait-graph.ts` (store is Drizzle — swap). `orchestration2/triage.ts`'s safe-command classifier is pure. Do **not** lift orchestration2's model: its oracle is the DB, it has two roles (orchestrator/worker + judge), and its review gate defaulted to off — all things Agile Agents deliberately does differently.

## Still open (small)

1. Cursor: try user-level `~/.cursor/hooks.json` and the documented hook schema against the headless agent; if hooks never fire headless, Cursor is tier 2 (exec) + tier 0.
2. Codex: prototype the native `codex app-server` client to confirm approval requests actually flow (`exec_command_approval`, `apply_patch_approval`) and whether a rejection can carry a reason.
3. Tier 0 sandbox: pick the mechanism per OS (macOS `sandbox-exec` profile vs. container) and confirm each vendor CLI runs inside it with its login intact.

## Answered in this round

Cursor ask/hooks/cancel/resume, Codex untrusted/full-access, Grok fs-deny/resume, Claude plan — see C3.

## Earlier list (superseded by the above)

1. `bun permission-matrix.ts --vendor claude --scenario auth` with a `claude login` Max session and no API key → closes the subscription question definitively.
2. Same four scenarios for `gemini`, `cursor`, `grok`, and `--cmd "npx -y @agentclientprotocol/codex-acp"`. The perm table above is the deliverable per vendor. Expect: no `_meta.toolName` on non-Claude vendors (use `kind`/`title`), Gemini with no modes, Grok needing `authenticate`.
3. Whether non-Claude vendors have any hook equivalent for reasoned denials on reads. If not, the read gate for them is: MCP `read_summary` offered + observation (count raw reads, cancel the turn and re-prompt with the reason after N).
4. Claude `plan` mode behaviour (untested; probably irrelevant for engineers, maybe useful for spikes).
