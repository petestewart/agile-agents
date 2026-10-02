#!/usr/bin/env bun
/**
 * Agile Agents spike: per-vendor ACP permission / cancel / resume / auth matrix.
 *
 * Drives any ACP agent over stdio (hand-rolled JSON-RPC, no SDK) and records,
 * for one (vendor, mode, scenario):
 *   - every tool_call the agent announces (kind, title, vendor tool name)
 *   - which of those raised session/request_permission (and the options offered)
 *   - what happened when we denied one (did the model see a reason?)
 *   - cancel behaviour, session/load behaviour, and whether auth works with no API key
 *
 * Usage:
 *   bun permission-matrix.ts --vendor claude --mode default --scenario perm
 *   bun permission-matrix.ts --cmd "gemini --experimental-acp" --scenario perm
 *   bun permission-matrix.ts --vendor claude --scenario cancel|resume|auth
 * Options:
 *   --deny <regex>     title/toolName regex to answer reject_once (default: Edit|Write)
 *   --fs-deny <regex>  refuse fs/read_text_file for matching paths with a reason (tests the client-fs gate, e.g. grok)
 *   --auth <methodId>  ACP authenticate method to use if session/new says auth required (default: try each advertised)
 *   --hooks            claude: PreToolUse deny hook in fixture · cursor: .cursor/hooks.json · pi: gate extension in ~/.pi/agent/extensions (removed after)
 *                      · codex (T506): PreToolUse hook in the fixture's .codex/hooks.json (a project hook)
 *   --user-hooks       codex (T506): the same hook in ~/.codex/hooks.json instead (merged into yours, your file restored byte for byte after;
 *                      the hook is a no-op outside the fixture)
 *   --bypass-hook-trust codex (T506): run Codex with --dangerously-bypass-hook-trust (--bypass-at front|end: where the flag
 *                      goes, default front). Every codex run goes through a CODEX_PATH wrapper that logs how codex-acp
 *                      invokes Codex and keeps Codex's stderr (report: codexInvokedAs, codexStderrTail)
 *   --worktree         codex (T506 live check): run the agent in a git worktree of the fixture (<fixture>/.worktrees/w1),
 *                      as the daemon does; --hooks-at worktree|main says where the project hook goes (default worktree)
 *   --codex-path <p>   codex: the Codex CLI the bridge runs (CODEX_PATH, as the daemon sets it since T480; default: `codex` on PATH)
 *   --fixture <dir>    use (and keep) this fixture dir instead of a new temp one, e.g. after trusting it in an interactive `codex`
 *   --matcher <m>      codex: the hook entry's matcher (default "Bash", the docs' example; C5's runs used "" and saw nothing)
 *   --scenario exec    codex only: run `codex exec` directly in the fixture (no codex-acp), with the same hook and flags, to tell
 *                      a hook that never fires under the bridge from one that never matches
 *   --keep             keep the temp project dir
 *   --out <dir>        report dir (default ./spike-out)
 *   --verbose          print every frame
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);

const PRESETS: Record<string, { cmd: string; note: string }> = {
  claude: { cmd: "npx -y @agentclientprotocol/claude-agent-acp@0.75.1", note: "Zed-maintained adapter over Claude Code" },
  gemini: { cmd: "gemini --experimental-acp", note: "native ACP" },
  cursor: { cmd: "cursor-agent acp", note: "native ACP (cursor-agent login first)" },
  grok:   { cmd: "grok agent stdio", note: "native ACP; needs ACP authenticate" },
  codex:  { cmd: "npx -y @agentclientprotocol/codex-acp@1.10.0", note: "Zed-maintained adapter over Codex (the daemon's pin); modes read-only | agent | agent-full-access" },
  pi:     { cmd: "npx -y pi-acp", note: "community ACP bridge over `pi --mode rpc`; gating via a pi extension (--hooks)" },
};
const vendor = opt("vendor", "claude")!;
const cmd = opt("cmd", PRESETS[vendor]?.cmd)!;
if (!cmd) { console.error("unknown vendor; pass --cmd"); process.exit(2); }
const mode = opt("mode");
const scenario = opt("scenario", "perm")!;
const denyRe = new RegExp(opt("deny", "Edit|Write|write|search_replace|Editing")!, "i");
const fsDenyRe = opt("fs-deny") ? new RegExp(opt("fs-deny")!, "i") : null; // refuse client fs/read_text_file for matching paths (grok-style gate)
const outDir = resolve(opt("out", "./spike-out")!);
const verbose = flag("verbose");
mkdirSync(outDir, { recursive: true });

// ---------- fixture project ----------
const fixtureOpt = opt("fixture");
const cwd = fixtureOpt ? resolve(fixtureOpt) : mkdtempSync(join(tmpdir(), "agile-spike-"));
// A kept fixture is reused across runs: start each run's logs empty, so counts are this run's only.
if (fixtureOpt) for (const f of ["hook-calls.jsonl", "codex-argv.log", "codex-stderr.log"]) rmSync(join(cwd, f), { force: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "small.txt"), "alpha\nbeta\ngamma\n");
writeFileSync(join(cwd, "big.txt"), Array.from({ length: 1500 }, (_, i) => `line ${i} lorem ipsum dolor sit amet consectetur`).join("\n"));
writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "spike", version: "0.0.0", scripts: { test: "node -e \"console.log('1 passing'); process.exit(0)\"" } }, null, 2));
writeFileSync(join(cwd, "README.md"), "# spike fixture\n");
if (flag("hooks") && vendor === "cursor") {
  // Cursor project-level hooks (.cursor/hooks.json): beforeReadFile can deny with an agent-facing message. Schema per Cursor docs — verify.
  mkdirSync(join(cwd, ".cursor"), { recursive: true });
  const hook = join(cwd, ".cursor", "agile-before-read.js");
  writeFileSync(hook, `#!/usr/bin/env node
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(join(cwd, "hook-calls.jsonl"))}, JSON.stringify(input) + "\\n");
const p = input.file_path || (input.attachments && input.attachments[0] && input.attachments[0].file_path) || "";
if (/big\\.txt$/.test(p)) {
  process.stdout.write(JSON.stringify({ permission: "deny", user_message: "AGILE-GATE blocked a raw read of big.txt", agent_message: "AGILE-GATE: big.txt is 60KB; raw Read is not allowed. Use read_summary(path, question) instead." }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ permission: "allow" }));
`);
  require("node:fs").chmodSync(hook, 0o755);
  writeFileSync(join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: hook }], beforeShellExecution: [{ command: hook }] } }, null, 2));
}
let piExtPath: string | null = null;
if (flag("hooks") && vendor === "pi") {
  // Pi has no hook config; it loads TS extensions from ~/.pi/agent/extensions (global, no trust prompt).
  // Install a self-guarding gate extension there for the duration of the run; it is a no-op unless AGILE_SPIKE_FIXTURE is set.
  const extDir = join(require("node:os").homedir(), ".pi", "agent", "extensions");
  mkdirSync(extDir, { recursive: true });
  piExtPath = join(extDir, "agile-spike-gate.ts");
  writeFileSync(piExtPath, `// Agile Agents spike gate — auto-installed by permission-matrix.ts --hooks; removed when the run ends.
import * as fs from "node:fs";
export default function (pi: any) {
  const fixture = process.env.AGILE_SPIKE_FIXTURE;
  if (!fixture) return;
  const log = (o: any) => { try { fs.appendFileSync(fixture + "/hook-calls.jsonl", JSON.stringify(o) + "\\n"); } catch {} };
  pi.on("tool_call", async (event: any) => {
    log({ ev: "tool_call", tool: event.toolName, input: event.input });
    const p = String(event.input?.path ?? event.input?.file_path ?? "");
    if (event.toolName === "read" && /big\\.txt$/.test(p)) {
      return { block: true, reason: "AGILE-GATE: big.txt is 60KB; raw read is not allowed. Use read_summary(path, question) instead." };
    }
  });
  pi.on("tool_result", async (event: any) => {
    log({ ev: "tool_result", tool: event.toolName, isError: event.isError });
    const cmd = String(event.input?.command ?? "");
    if (event.toolName === "bash" && /npm test/.test(cmd)) {
      return { content: [{ type: "text", text: "AGILE-SUMMARY: tests passed (1 passing); raw output withheld by tool_result rewrite." }] };
    }
  });
}
`);
  process.on("exit", () => { try { if (piExtPath) rmSync(piExtPath, { force: true }); } catch {} });
}
if (flag("hooks") && vendor === "claude") {
  // Claude Code project-level hook: deny Read on big files with a reason, and stamp every tool call in a log.
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const hook = join(cwd, ".claude", "agile-pre-tool-use.js");
  writeFileSync(hook, `#!/usr/bin/env node
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(join(cwd, "hook-calls.jsonl"))}, JSON.stringify({ tool: input.tool_name, input: input.tool_input }) + "\\n");
const p = (input.tool_input && input.tool_input.file_path) || "";
if (input.tool_name === "Read" && /big\\.txt$/.test(p)) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "AGILE-GATE: big.txt is 60KB; raw Read is not allowed. Use read_summary(path, question) instead." } }));
  process.exit(0);
}
process.exit(0);
`);
  require("node:fs").chmodSync(hook, 0o755);
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: hook }] }] } }, null, 2));
}
// T506: Codex's own PreToolUse hook (learn.chatgpt.com/docs/hooks). Logs every call it sees and denies
// any shell command that uses curl (step 9) with exit 2 and a reason on stderr. A no-op outside the fixture.
const codexEnv: Record<string, string> = {};
const earlyNotes: string[] = [];
const report_note_early = (note: string) => { earlyNotes.push(note); };
let codexUserHooks: { path: string; before: Buffer | null } | null = null;
let deferredProjectHooks: unknown = null;
if (vendor === "codex") {
  const which = require("node:child_process").spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8" });
  const realCodex = opt("codex-path") ?? (which.stdout ?? "").trim();
  if (realCodex) codexEnv.CODEX_PATH = realCodex;
  else report_note_early("no `codex` on PATH: codex-acp runs its bundled Codex");
  const wantsHook = flag("hooks") || flag("user-hooks");
  if (wantsHook) {
    const hook = join(cwd, "agile-codex-pre-tool-use.js");
    writeFileSync(hook, `#!/usr/bin/env node
const fs = require("node:fs");
const fixture = ${JSON.stringify(cwd)};
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = {};
try { input = JSON.parse(raw); } catch {}
// Every call is logged first: C5's first runs compared raw paths, and on macOS a temp dir
// (/var/folders/...) is /private/var/folders/... once resolved, so calls may have been dropped.
const real = (p) => { try { return fs.realpathSync(p); } catch { return String(p); } };
const inside = !input.cwd || real(input.cwd).startsWith(real(fixture));
fs.appendFileSync(fixture + "/hook-calls.jsonl", JSON.stringify({ event: input.hook_event_name, tool: input.tool_name, input: input.tool_input, cwd: input.cwd, inside, keys: Object.keys(input) }) + "\\n");
// A user-level hook runs for every Codex session: it only denies inside the spike's fixture.
if (!inside) process.exit(0);
const command = String((input.tool_input && input.tool_input.command) || "");
if (/curl/.test(command)) {
  process.stderr.write("AGILE-GATE: network commands need the operator's approval");
  process.exit(2);
}
process.exit(0);
`);
    require("node:fs").chmodSync(hook, 0o755);
    const entry = { matcher: opt("matcher", "Bash")!, hooks: [{ type: "command", command: hook, statusMessage: "agile spike gate" }] };
    if (flag("user-hooks")) {
      const dir = join(require("node:os").homedir(), ".codex");
      const path = join(dir, "hooks.json");
      mkdirSync(dir, { recursive: true });
      const before = existsSync(path) ? readFileSync(path) : null;
      let cfg: any = { hooks: {} };
      if (before) { try { cfg = JSON.parse(before.toString("utf8")); } catch { console.error(`~/.codex/hooks.json isn't JSON; not touching it`); process.exit(2); } }
      cfg.hooks ??= {}; cfg.hooks.PreToolUse = [...(cfg.hooks.PreToolUse ?? []), entry];
      codexUserHooks = { path, before };
      writeFileSync(path, JSON.stringify(cfg, null, 2));
      const restore = () => { try { if (!codexUserHooks) return; if (codexUserHooks.before) writeFileSync(codexUserHooks.path, codexUserHooks.before); else rmSync(codexUserHooks.path, { force: true }); codexUserHooks = null; } catch {} };
      process.on("exit", restore); process.on("SIGINT", () => { restore(); process.exit(130); });
    } else if (flag("worktree")) {
      deferredProjectHooks = { hooks: { PreToolUse: [entry] } }; // written after the worktree exists (below)
    } else {
      mkdirSync(join(cwd, ".codex"), { recursive: true });
      writeFileSync(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2));
    }
  }
  if (flag("bypass-hook-trust") && !codexEnv.CODEX_PATH) { console.error("--bypass-hook-trust needs an installed codex (--codex-path)"); process.exit(2); }
  if (codexEnv.CODEX_PATH) {
    // Every codex run goes through a wrapper that logs how codex-acp invokes Codex and keeps Codex's stderr,
    // and with --bypass-hook-trust it adds --dangerously-bypass-hook-trust.
    const wrapper = join(cwd, "codex-wrapper.sh");
    const bypass = flag("bypass-hook-trust");
    const atEnd = opt("bypass-at", "front") === "end";
    const args = !bypass ? '"$@"' : atEnd ? '"$@" --dangerously-bypass-hook-trust' : '--dangerously-bypass-hook-trust "$@"';
    writeFileSync(wrapper, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(join(cwd, "codex-argv.log"))}
exec ${JSON.stringify(codexEnv.CODEX_PATH)} ${args} 2>>${JSON.stringify(join(cwd, "codex-stderr.log"))}
`);
    require("node:fs").chmodSync(wrapper, 0o755);
    codexEnv.CODEX_PATH = wrapper;
  }
}
if (flag("worktree")) writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n.codex/\n*.log\nhook-calls.jsonl\n");
spawnSyncQuiet("git", ["init", "-q"], cwd); spawnSyncQuiet("git", ["add", "."], cwd);
spawnSyncQuiet("git", ["-c", "user.email=s@s", "-c", "user.name=s", "commit", "-qm", "init"], cwd);
// T506 (live check, 2026-10-02): the daemon runs Codex in a git worktree (<repo>/.worktrees/<id>) with the hook in the
// worktree's .codex/. --worktree does the same: the agent runs in <fixture>/.worktrees/w1, and --hooks-at says where the
// project hook goes: `worktree` (default, as the daemon writes it) or `main` (the repo root, untracked), to see which
// one Codex reads for a worktree.
let agentCwd = cwd;
if (flag("worktree")) {
  const wt = join(cwd, ".worktrees", "w1");
  if (!existsSync(wt)) spawnSyncQuiet("git", ["worktree", "add", "-q", wt, "-b", "w1"], cwd);
  if (!existsSync(join(wt, "small.txt"))) { console.error(`--worktree: couldn't create the git worktree at ${wt}`); process.exit(2); }
  agentCwd = wt;
  if (deferredProjectHooks !== null) {
    const at = opt("hooks-at", "worktree") === "main" ? cwd : wt;
    mkdirSync(join(at, ".codex"), { recursive: true });
    writeFileSync(join(at, ".codex", "hooks.json"), JSON.stringify(deferredProjectHooks, null, 2));
    for (const other of [cwd, wt]) if (other !== at) rmSync(join(other, ".codex", "hooks.json"), { force: true });
    report_note_early(`worktree run: agent in ${wt}, project hook in ${at}/.codex`);
  }
}
function spawnSyncQuiet(c: string, a: string[], d: string) { try { require("node:child_process").spawnSync(c, a, { cwd: d, stdio: "ignore" }); } catch {} }

// ---------- report ----------
type ToolRec = { id: string; kind?: string; title?: string; toolName?: string; status?: string; permissionRaised: boolean; options?: any[]; ourAnswer?: string; rawInput?: any };
const report: any = {
  vendor, cmd, mode, scenario, cwd, startedAt: new Date().toISOString(),
  codex: vendor === "codex" ? { codexPath: codexEnv.CODEX_PATH ?? null, projectHooks: flag("hooks"), userHooks: flag("user-hooks"), bypassHookTrust: flag("bypass-hook-trust"), matcher: opt("matcher", "Bash") } : undefined,
  env: { ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, GEMINI_API_KEY: !!process.env.GEMINI_API_KEY },
  initialize: null as any, session: null as any, tools: [] as ToolRec[], permissionRequests: [] as any[], fsRequests: [] as any[],
  agentText: "", stopReasons: [] as any[], usage: [] as any[], errors: [] as any[], notes: [...earlyNotes] as string[], result: {} as any,
};
const tools = new Map<string, ToolRec>();

// ---------- JSON-RPC over stdio ----------
let proc: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const waiters: Array<(msg: any) => boolean> = []; // predicate consumers for notifications
let buf = "";
let bridgeStderr = ""; // T506: the tail goes in the report, so a run shows what the bridge (and Codex) said

function start(env = process.env) {
  const [c, ...a] = cmd.split(" ");
  proc = spawn(c, a, { cwd: agentCwd, env: { ...env, ...codexEnv, AGILE_SPIKE_FIXTURE: cwd }, stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => { bridgeStderr = (bridgeStderr + d.toString()).slice(-4000); if (verbose) process.stderr.write(`[agent stderr] ${d}`); });
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { report.notes.push(`non-JSON stdout: ${line.slice(0, 120)}`); continue; }
      onMessage(msg);
    }
  });
  proc.on("exit", (code, sig) => { report.notes.push(`agent exited code=${code} sig=${sig}`); });
}
function send(obj: any) { const s = JSON.stringify(obj); if (verbose) console.log("→", s.slice(0, 400)); proc.stdin.write(s + "\n"); }
function request(method: string, params: any): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ jsonrpc: "2.0", id, method, params }); });
}
function notify(method: string, params: any) { send({ jsonrpc: "2.0", method, params }); }
function respond(id: any, result: any) { send({ jsonrpc: "2.0", id, result }); }
function respondError(id: any, code: number, message: string) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function waitFor(pred: (m: any) => boolean, ms = 120000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error("timeout waiting")); }, ms);
    const w = (m: any) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; };
    waiters.push(w);
  });
}

function onMessage(msg: any) {
  if (verbose) console.log("←", JSON.stringify(msg).slice(0, 400));
  // response to our request
  if ("id" in msg && !("method" in msg)) {
    const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id);
    if (msg.error) { report.errors.push({ id: msg.id, error: msg.error }); p.reject(msg.error); } else p.resolve(msg.result);
    return;
  }
  // agent → client request (has id + method)
  if ("id" in msg && "method" in msg) { onAgentRequest(msg); return; }
  // notification
  if (msg.method === "session/update") onUpdate(msg.params?.update ?? msg.params);
  for (const w of [...waiters]) if (w(msg)) waiters.splice(waiters.indexOf(w), 1);
}

function onUpdate(u: any) {
  if (!u) return;
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk" && u.content?.type === "text") report.agentText += u.content.text;
  else if (kind === "tool_call") {
    const rec: ToolRec = { id: u.toolCallId, kind: u.kind, title: u.title, toolName: u._meta?.claudeCode?.toolName ?? u._meta?.toolName, status: u.status, permissionRaised: false, rawInput: u.rawInput };
    tools.set(u.toolCallId, rec); report.tools.push(rec);
  } else if (kind === "tool_call_update") {
    const rec = tools.get(u.toolCallId); if (rec) { if (u.status) rec.status = u.status; if (u.title && !rec.title) rec.title = u.title; if (u.kind && !rec.kind) rec.kind = u.kind; }
  } else if (kind === "usage_update") report.usage.push(u);
  else if (kind === "current_mode_update") report.notes.push(`mode → ${u.currentModeId}`);
}

function onAgentRequest(msg: any) {
  const { id, method, params } = msg;
  if (method === "session/request_permission") {
    const tc = params.toolCall ?? {};
    const options = params.options ?? [];
    const rec = tools.get(tc.toolCallId) ?? (() => { const r: ToolRec = { id: tc.toolCallId, kind: tc.kind, title: tc.title, toolName: tc._meta?.claudeCode?.toolName, permissionRaised: false, rawInput: tc.rawInput }; tools.set(tc.toolCallId, r); report.tools.push(r); return r; })();
    rec.permissionRaised = true; rec.options = options; if (!rec.kind) rec.kind = tc.kind; if (!rec.title) rec.title = tc.title;
    const probe = `${rec.title ?? ""} ${rec.toolName ?? ""} ${JSON.stringify(rec.rawInput ?? {}).slice(0, 200)}`;
    const deny = scenario === "perm" && denyRe.test(probe) && !report.result.deniedOnce;
    const pick = options.find((o: any) => o.kind === (deny ? "reject_once" : "allow_once")) ?? options[0];
    rec.ourAnswer = deny ? "reject_once" : "allow_once";
    if (deny) report.result.deniedOnce = { toolCallId: rec.id, title: rec.title, toolName: rec.toolName };
    report.permissionRequests.push({ toolCallId: tc.toolCallId, title: tc.title, kind: tc.kind, toolName: rec.toolName, options: options.map((o: any) => `${o.kind}:${o.optionId}`), answered: rec.ourAnswer, hasReasonField: false });
    respond(id, { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } });
    return;
  }
  if (method === "fs/read_text_file") {
    report.fsRequests.push({ method, path: params.path, line: params.line, limit: params.limit });
    if (fsDenyRe && fsDenyRe.test(params.path ?? "")) {
      report.result.fsDenied = (report.result.fsDenied ?? 0) + 1;
      respondError(id, -32000, "AGILE-GATE: this file is too large for a raw read. Use read_summary(path, question) instead.");
      return;
    }
    try { const text = readFileSync(params.path, "utf8"); respond(id, { content: text }); } catch (e: any) { respondError(id, -32000, e.message); }
    return;
  }
  if (method === "fs/write_text_file") {
    report.fsRequests.push({ method, path: params.path, bytes: params.content?.length });
    try { writeFileSync(params.path, params.content); respond(id, null); } catch (e: any) { respondError(id, -32000, e.message); }
    return;
  }
  if (method === "terminal/create" || method.startsWith("terminal/")) {
    report.notes.push(`agent requested ${method} though we did not advertise terminal`); respondError(id, -32601, "terminal not supported by client"); return;
  }
  report.notes.push(`unhandled agent request ${method}`); respondError(id, -32601, "unhandled");
}

// ---------- session helpers ----------
async function initialize() {
  const r = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "agile-agents-spike", version: "0.0.1" },
  });
  report.initialize = { protocolVersion: r.protocolVersion, agentCapabilities: r.agentCapabilities, authMethods: r.authMethods, agentInfo: r.agentInfo };
  return r;
}
async function authenticateIfNeeded(err: any) {
  // Some agents (cursor, grok) refuse session/new until the client calls `authenticate` with one of initialize.authMethods.
  const methods: any[] = report.initialize?.authMethods ?? [];
  const wanted = opt("auth");
  const order = wanted ? methods.filter((m) => m.id === wanted) : methods;
  if (!order.length) throw err;
  for (const m of order) {
    try { await request("authenticate", { methodId: m.id }); report.notes.push(`authenticate(${m.id}) ok`); report.result.authMethodUsed = m.id; return; }
    catch (e: any) { report.notes.push(`authenticate(${m.id}) failed: ${e.message ?? JSON.stringify(e)}`); }
  }
  throw err;
}
async function newSession() {
  let r: any;
  try { r = await request("session/new", { cwd: agentCwd, mcpServers: [] }); }
  catch (e: any) {
    if (e?.code === -32000 || /auth/i.test(e?.message ?? "")) { await authenticateIfNeeded(e); r = await request("session/new", { cwd: agentCwd, mcpServers: [] }); }
    else throw e;
  }
  report.session = { sessionId: r.sessionId, modes: r.modes, configOptions: r.configOptions };
  if (mode) { try { await request("session/set_mode", { sessionId: r.sessionId, modeId: mode }); report.notes.push(`set_mode ${mode} ok`); } catch (e: any) { report.notes.push(`set_mode ${mode} failed: ${e.message ?? JSON.stringify(e)}`); } }
  return r.sessionId;
}
async function prompt(sessionId: string, text: string, ms = 240000) {
  const r = await Promise.race([request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), new Promise((_, rej) => setTimeout(() => rej(new Error("prompt timeout")), ms))]);
  report.stopReasons.push((r as any)?.stopReason ?? null);
  return r as any;
}
async function stop() { try { proc.stdin.end(); } catch {} await new Promise((r) => setTimeout(r, 300)); try { proc.kill("SIGTERM"); } catch {} }

// ---------- scenarios ----------
const PERM_PROMPT = `You are in a small test project. Do EXACTLY these steps in order, one tool call each, without asking me anything. If a step is refused or blocked, note the refusal text you received and continue with the next step.
1. Read the file small.txt.
2. Search (grep) the project for the word "gamma".
3. Run the shell command: git status --short
4. Run the shell command: echo hi > out.txt
5. Edit small.txt: append a line "delta".
6. Create a new file new.txt containing "new".
7. Read the file big.txt in full.
8. Run the shell command: npm test
9. Run the shell command: curl -s https://example.com | head -c 100
When finished, reply with the single word DONE followed by a numbered list: for each step say OK, or REFUSED and quote verbatim any refusal/denial message you were shown.`;

async function scenarioPerm() {
  start(); await initialize(); const sid = await newSession();
  const r = await prompt(sid, PERM_PROMPT);
  report.result.stopReason = r?.stopReason;
  report.result.finalText = report.agentText.slice(-2500);
  report.result.matrix = report.tools.map((t) => ({ tool: t.toolName ?? t.title, kind: t.kind, title: t.title, permissionRaised: t.permissionRaised, ourAnswer: t.ourAnswer ?? "-", finalStatus: t.status }));
  report.result.readsViaClientFs = report.fsRequests.filter((f) => f.method === "fs/read_text_file").length;
  report.result.writesViaClientFs = report.fsRequests.filter((f) => f.method === "fs/write_text_file").length;
  report.result.modelSawDenialReason = report.result.deniedOnce ? /REFUSED/i.test(report.agentText) : null;
  if (fsDenyRe) report.result.modelSawFsDenyReason = /AGILE-GATE/.test(report.agentText);
  if (flag("hooks") || flag("user-hooks")) {
    const log = join(cwd, "hook-calls.jsonl");
    if (existsSync(log)) writeFileSync(join(outDir, `${vendor}-hook-calls.jsonl`), readFileSync(log));
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
    report.result.hookFired = calls; report.result.hookReasonSeenByModel = /AGILE-GATE/.test(report.agentText);
    if (vendor === "pi") report.result.toolResultRewriteSeenByModel = /AGILE-SUMMARY/.test(report.agentText);
  }
  if (vendor === "codex") {
    // T506: did the hook see the shell commands, did the curl step run anyway, and how codex-acp started Codex.
    const argvLog = join(cwd, "codex-argv.log");
    report.result.codexInvokedAs = existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : null;
    const curl = report.tools.find((t: ToolRec) => /curl/.test(`${t.title ?? ""} ${JSON.stringify(t.rawInput ?? {})}`));
    report.result.curlStep = curl ? { title: curl.title, status: curl.status } : "not attempted";
    report.result.hookCallsSeen = report.result.hookFired ?? 0;
    // Codex's own stderr under the bridge (the wrapper redirects it): "hook: PreToolUse" lines, trust and feature warnings.
    const codexStderr = join(cwd, "codex-stderr.log");
    report.result.codexStderrTail = existsSync(codexStderr) ? readFileSync(codexStderr, "utf8").slice(-3000) : null;
    report.result.bridgeStderrTail = bridgeStderr;
    report.result.toolCallsSeenOverAcp = report.tools.length;
  }
  await stop();
}

async function scenarioCancel() {
  start(); await initialize(); const sid = await newSession();
  const p = prompt(sid, "Run the shell command `sleep 25` and then reply with the word FINISHED.");
  try {
    await waitFor((m) => m.method === "session/update" && (m.params?.update?.sessionUpdate === "tool_call"), 90000);
    const t0 = Date.now(); notify("session/cancel", { sessionId: sid });
    const r = await p; report.result.cancelStopReason = r?.stopReason; report.result.cancelLatencyMs = Date.now() - t0;
  } catch (e: any) { report.result.cancelError = e.message; }
  await new Promise((r) => setTimeout(r, 1500));
  report.result.toolStatusAfterCancel = report.tools.map((t) => ({ title: t.title, status: t.status }));
  report.result.processAliveAfterCancel = proc.exitCode === null;
  try { const r2 = await prompt(sid, "Reply with the single word ALIVE.", 60000); report.result.sessionUsableAfterCancel = /ALIVE/.test(report.agentText) && r2?.stopReason === "end_turn"; } catch (e: any) { report.result.sessionUsableAfterCancel = false; report.result.afterCancelError = e.message; }
  await stop();
}

async function scenarioResume() {
  start(); await initialize(); const sid = await newSession();
  await prompt(sid, "Remember the secret word PINEAPPLE. Reply only OK.");
  await stop(); report.notes.push("first process stopped; starting fresh process for session/load");
  await new Promise((r) => setTimeout(r, 800));
  buf = ""; pending.clear(); report.agentText = "";
  start(); await initialize();
  try {
    await request("session/load", { sessionId: sid, cwd: agentCwd, mcpServers: [] });
    report.result.loadOk = true;
    const r = await prompt(sid, "What was the secret word? Reply with only the word.");
    report.result.recalled = /PINEAPPLE/i.test(report.agentText); report.result.stopReason = r?.stopReason;
  } catch (e: any) { report.result.loadOk = false; report.result.loadError = e.message ?? JSON.stringify(e); }
  await stop();
}

async function scenarioAuth() {
  // Strip API keys so only the harness's own login can work.
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/API_KEY|_TOKEN$/.test(k) && /ANTHROPIC|OPENAI|GEMINI|GOOGLE|XAI|CURSOR/.test(k)) delete env[k];
  report.result.strippedKeys = Object.keys(process.env).filter((k) => !(k in env));
  start(env); await initialize();
  try {
    const sid = await newSession();
    const r = await prompt(sid, "Reply with the single word AUTHOK.", 90000);
    report.result.promptWorkedWithoutApiKey = /AUTHOK/.test(report.agentText) && !!r;
  } catch (e: any) { report.result.promptWorkedWithoutApiKey = false; report.result.authError = e.message ?? JSON.stringify(e); }
  await stop();
}

async function scenarioExec() {
  // T506: Codex without the bridge. `codex exec` in the fixture, the same hook installed, so a hook that
  // fires here but not under codex-acp means the bridge's `app-server` path skips hooks.
  if (vendor !== "codex") { console.error("--scenario exec is for --vendor codex"); process.exit(2); }
  const codex = codexEnv.CODEX_PATH;
  if (!codex) { report.errors.push({ fatal: "no codex CLI found (--codex-path)" }); return; }
  const prompt = "Run these shell commands one at a time, then reply DONE with OK or REFUSED for each, quoting any refusal: 1) echo hi > out.txt 2) curl -s https://example.com | head -c 100";
  const r = require("node:child_process").spawnSync(codex, ["exec", "--skip-git-repo-check", prompt], {
    cwd: agentCwd, env: { ...process.env, AGILE_SPIKE_FIXTURE: cwd }, encoding: "utf8", timeout: 240000,
  });
  report.result.execExit = r.status;
  report.result.execStdoutTail = String(r.stdout ?? "").slice(-2500);
  const errLog = join(cwd, "codex-stderr.log"); // the wrapper sends Codex's stderr there
  report.result.execStderrTail = (String(r.stderr ?? "") + (existsSync(errLog) ? readFileSync(errLog, "utf8") : "")).slice(-1500);
  const log = join(cwd, "hook-calls.jsonl");
  report.result.hookCallsSeen = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
  if (existsSync(log)) writeFileSync(join(outDir, "codex-exec-hook-calls.jsonl"), readFileSync(log));
  report.result.hookReasonSeenByModel = /AGILE-GATE/.test(report.result.execStdoutTail + report.result.execStderrTail);
  const argvLog = join(cwd, "codex-argv.log");
  report.result.codexInvokedAs = existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : null;
}

// ---------- main ----------
(async () => {
  const run = { perm: scenarioPerm, cancel: scenarioCancel, resume: scenarioResume, auth: scenarioAuth, exec: scenarioExec }[scenario];
  if (!run) { console.error("scenario must be perm|cancel|resume|auth|exec"); process.exit(2); }
  try { await run(); } catch (e: any) { report.errors.push({ fatal: e.message ?? String(e) }); try { await stop(); } catch {} }
  if (vendor === "codex") {
    // Also when the run died early (e.g. Codex refused a flag): what Codex and the bridge said is the finding.
    const argvLog = join(cwd, "codex-argv.log");
    const codexStderr = join(cwd, "codex-stderr.log");
    report.result.codexInvokedAs ??= existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : null;
    report.result.codexStderrTail ??= existsSync(codexStderr) ? readFileSync(codexStderr, "utf8").slice(-3000) : null;
    report.result.bridgeStderrTail ??= bridgeStderr;
  }
  report.finishedAt = new Date().toISOString();
  const variant = vendor === "codex"
    ? `${flag("hooks") ? "-hooks" : ""}${flag("user-hooks") ? "-userhooks" : ""}${flag("bypass-hook-trust") ? `-bypass${opt("bypass-at", "front") === "end" ? "end" : ""}` : ""}${fixtureOpt ? "-fixture" : ""}${flag("worktree") ? `-wt${opt("hooks-at", "worktree") === "main" ? "main" : ""}` : ""}`
    : flag("hooks") ? "-hooks" : "";
  const matcherTag = vendor === "codex" && opt("matcher") !== undefined ? `-m${(opt("matcher") || "empty").replace(/[^A-Za-z0-9]/g, "")}` : "";
  // A --cmd bridge other than the preset (e.g. a newer codex-acp) gets its version in the name, so runs don't overwrite.
  const cmdTag = opt("cmd") !== undefined && opt("cmd") !== PRESETS[vendor]?.cmd ? `-${(opt("cmd")!.match(/@(\d[\w.-]*)/)?.[1] ?? "cmd").replace(/[^A-Za-z0-9.]/g, "")}` : "";
  const file = join(outDir, `${vendor}-${mode ?? "defaultmode"}-${scenario}${variant}${matcherTag}${cmdTag}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n== ${vendor} · mode=${mode ?? "(agent default)"} · ${scenario} ==`);
  if (report.session?.modes) console.log("modes:", (report.session.modes.availableModes ?? []).map((m: any) => m.id).join(", "), "| current:", report.session.modes.currentModeId);
  if (report.initialize?.authMethods) console.log("authMethods:", JSON.stringify(report.initialize.authMethods));
  if (scenario === "perm") {
    console.table(report.result.matrix ?? []);
    console.log("reads via client fs:", report.result.readsViaClientFs, "| writes via client fs:", report.result.writesViaClientFs);
    console.log("denied once:", JSON.stringify(report.result.deniedOnce), "| model reported REFUSED:", report.result.modelSawDenialReason);
    if (fsDenyRe) console.log("client-fs reads denied:", report.result.fsDenied ?? 0, "| model saw fs deny reason:", report.result.modelSawFsDenyReason);
    if (flag("hooks") || flag("user-hooks")) console.log("hook/extension fired:", report.result.hookFired, "times | model saw hook reason:", report.result.hookReasonSeenByModel, vendor === "pi" ? "| model saw tool_result rewrite: " + report.result.toolResultRewriteSeenByModel : "");
    if (vendor === "codex") {
      console.log("codex: tool calls over ACP:", report.result.toolCallsSeenOverAcp, "| hook calls:", report.result.hookCallsSeen, "| curl step:", JSON.stringify(report.result.curlStep));
      if (report.result.codexInvokedAs) console.log("codex-acp ran Codex as:", report.result.codexInvokedAs.join(" ;; "));
      if (report.result.codexStderrTail) console.log("--- Codex stderr (tail) ---\n" + String(report.result.codexStderrTail).slice(-800).trim());
    }
    console.log("--- agent final text ---\n" + (report.result.finalText ?? "").trim());
  } else if (scenario === "exec") {
    console.log("codex exec (no bridge): exit", report.result.execExit, "| hook calls:", report.result.hookCallsSeen, "| refusal seen:", report.result.hookReasonSeenByModel);
    if (report.result.codexInvokedAs) console.log("ran Codex as:", report.result.codexInvokedAs.join(" ;; "));
    console.log("--- codex exec output (tail) ---\n" + String(report.result.execStdoutTail ?? "").trim());
  } else console.log(JSON.stringify(report.result, null, 2));
  if (report.errors.length) {
    console.log("errors:", JSON.stringify(report.errors));
    if (report.result.codexInvokedAs) console.log("Codex was run as:", report.result.codexInvokedAs.join(" ;; "));
    if (report.result.codexStderrTail) console.log("--- Codex stderr (tail) ---\n" + String(report.result.codexStderrTail).slice(-800).trim());
    else if (report.result.bridgeStderrTail) console.log("--- bridge stderr (tail) ---\n" + String(report.result.bridgeStderrTail).slice(-800).trim());
  }
  if (report.notes.length) console.log("notes:", report.notes.join(" | "));
  console.log("report:", file);
  if (!flag("keep") && !fixtureOpt) rmSync(cwd, { recursive: true, force: true }); else console.log("fixture kept at", cwd);
  process.exit(0);
})();
