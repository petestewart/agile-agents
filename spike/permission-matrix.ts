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
  codex:  { cmd: "npx -y @agentclientprotocol/codex-acp", note: "Zed-maintained adapter over Codex; modes read-only | agent | agent-full-access" },
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
const cwd = mkdtempSync(join(tmpdir(), "agile-spike-"));
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
spawnSyncQuiet("git", ["init", "-q"], cwd); spawnSyncQuiet("git", ["add", "."], cwd);
spawnSyncQuiet("git", ["-c", "user.email=s@s", "-c", "user.name=s", "commit", "-qm", "init"], cwd);
function spawnSyncQuiet(c: string, a: string[], d: string) { try { require("node:child_process").spawnSync(c, a, { cwd: d, stdio: "ignore" }); } catch {} }

// ---------- report ----------
type ToolRec = { id: string; kind?: string; title?: string; toolName?: string; status?: string; permissionRaised: boolean; options?: any[]; ourAnswer?: string; rawInput?: any };
const report: any = {
  vendor, cmd, mode, scenario, cwd, startedAt: new Date().toISOString(),
  env: { ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, GEMINI_API_KEY: !!process.env.GEMINI_API_KEY },
  initialize: null as any, session: null as any, tools: [] as ToolRec[], permissionRequests: [] as any[], fsRequests: [] as any[],
  agentText: "", stopReasons: [] as any[], usage: [] as any[], errors: [] as any[], notes: [] as string[], result: {} as any,
};
const tools = new Map<string, ToolRec>();

// ---------- JSON-RPC over stdio ----------
let proc: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const waiters: Array<(msg: any) => boolean> = []; // predicate consumers for notifications
let buf = "";

function start(env = process.env) {
  const [c, ...a] = cmd.split(" ");
  proc = spawn(c, a, { cwd, env: { ...env, AGILE_SPIKE_FIXTURE: cwd }, stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => { if (verbose) process.stderr.write(`[agent stderr] ${d}`); });
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
  try { r = await request("session/new", { cwd, mcpServers: [] }); }
  catch (e: any) {
    if (e?.code === -32000 || /auth/i.test(e?.message ?? "")) { await authenticateIfNeeded(e); r = await request("session/new", { cwd, mcpServers: [] }); }
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
  if (flag("hooks")) {
    const log = join(cwd, "hook-calls.jsonl");
    if (existsSync(log)) writeFileSync(join(outDir, `${vendor}-hook-calls.jsonl`), readFileSync(log));
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
    report.result.hookFired = calls; report.result.hookReasonSeenByModel = /AGILE-GATE/.test(report.agentText);
    if (vendor === "pi") report.result.toolResultRewriteSeenByModel = /AGILE-SUMMARY/.test(report.agentText);
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
    await request("session/load", { sessionId: sid, cwd, mcpServers: [] });
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

// ---------- main ----------
(async () => {
  const run = { perm: scenarioPerm, cancel: scenarioCancel, resume: scenarioResume, auth: scenarioAuth }[scenario];
  if (!run) { console.error("scenario must be perm|cancel|resume|auth"); process.exit(2); }
  try { await run(); } catch (e: any) { report.errors.push({ fatal: e.message ?? String(e) }); try { await stop(); } catch {} }
  report.finishedAt = new Date().toISOString();
  const file = join(outDir, `${vendor}-${mode ?? "defaultmode"}-${scenario}${flag("hooks") ? "-hooks" : ""}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n== ${vendor} · mode=${mode ?? "(agent default)"} · ${scenario} ==`);
  if (report.session?.modes) console.log("modes:", (report.session.modes.availableModes ?? []).map((m: any) => m.id).join(", "), "| current:", report.session.modes.currentModeId);
  if (report.initialize?.authMethods) console.log("authMethods:", JSON.stringify(report.initialize.authMethods));
  if (scenario === "perm") {
    console.table(report.result.matrix ?? []);
    console.log("reads via client fs:", report.result.readsViaClientFs, "| writes via client fs:", report.result.writesViaClientFs);
    console.log("denied once:", JSON.stringify(report.result.deniedOnce), "| model reported REFUSED:", report.result.modelSawDenialReason);
    if (fsDenyRe) console.log("client-fs reads denied:", report.result.fsDenied ?? 0, "| model saw fs deny reason:", report.result.modelSawFsDenyReason);
    if (flag("hooks")) console.log("hook/extension fired:", report.result.hookFired, "times | model saw hook reason:", report.result.hookReasonSeenByModel, vendor === "pi" ? "| model saw tool_result rewrite: " + report.result.toolResultRewriteSeenByModel : "");
    console.log("--- agent final text ---\n" + (report.result.finalText ?? "").trim());
  } else console.log(JSON.stringify(report.result, null, 2));
  if (report.errors.length) console.log("errors:", JSON.stringify(report.errors));
  if (report.notes.length) console.log("notes:", report.notes.join(" | "));
  console.log("report:", file);
  if (!flag("keep")) rmSync(cwd, { recursive: true, force: true }); else console.log("fixture kept at", cwd);
  process.exit(0);
})();
