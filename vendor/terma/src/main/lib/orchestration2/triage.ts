/**
 * Trust dial + triage policy (PLAN Phase 4, Key Design Decision 6's "question
 * routing is deterministic service code").
 *
 * Trust levels gate what the service may do without a human:
 * - `low`    — everything escalates to the user (the v1 default).
 * - `medium` — questions route through the orchestrator wake (it may answer
 *              from recorded decisions); permission requests still user-only.
 * - `high`   — questions route as at medium, AND clearly-safe non-destructive
 *              permission requests are auto-approved with the allow-once
 *              option.
 *
 * The permission classifier is the safety boundary. It is a pure allowlist:
 * only commands every segment of which is a known-safe read/build/test may
 * classify `safe`; anything unrecognized, compound-shell, or matching a
 * destructive pattern classifies `destructive` and escalates regardless of
 * the dial.
 */
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../local-db";
import { agentQuestions, orchestrationMeta } from "../local-db/schema";
import type { AcpEvent } from "../terminal-host/types";
import type { FrameRouter } from "./frame-router";
import type { OrchestrationDaemon } from "./session-driver";
import { mintOrchSessionId } from "./session-driver";

export type TrustLevel = "low" | "medium" | "high";

const TRUST_LEVELS = new Set<string>(["low", "medium", "high"]);

function trustOf(db: AppDatabase, issueId: string): TrustLevel | null {
  const row = db
    .select({ trustDial: orchestrationMeta.trustDial })
    .from(orchestrationMeta)
    .where(eq(orchestrationMeta.issueId, issueId))
    .get();
  const dial = row?.trustDial;
  return dial != null && TRUST_LEVELS.has(dial) ? (dial as TrustLevel) : null;
}

/** Per-ticket dial → project-level dial (the epic's meta row) → 'low'. */
export function resolveTrustDial(
  db: AppDatabase,
  issueId: string,
  projectIssueId: string
): TrustLevel {
  return trustOf(db, issueId) ?? trustOf(db, projectIssueId) ?? "low";
}

export type PermissionClassification = "safe" | "destructive";

interface PermissionPayload {
  kind: string | null;
  command: string | null;
  title: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

/** SPIKE Q3 request shape: params.toolCall {kind, rawInput.command, title}. */
export function extractPermissionPayload(params: unknown): PermissionPayload {
  const root = asRecord(params);
  const toolCall = asRecord(root?.toolCall);
  const rawInput = asRecord(toolCall?.rawInput);
  return {
    kind: stringField(toolCall, "kind") ?? stringField(root, "kind"),
    command: stringField(rawInput, "command"),
    title: stringField(toolCall, "title") ?? stringField(root, "title"),
  };
}

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bdd\b/,
  /\bmv\b/,
  /\bsudo\b/i,
  /\bdoas\b/,
  /\bkill\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bshred\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/,
  /\bgit\b[^\n]*\bclean\b/,
  /\bgit\b[^\n]*\bbranch\b[^\n]*\s-[dD]\b/,
  /\bdrop\s+(table|database|index|view)\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\b/i,
  /\bfind\b[^\n]*(-delete\b|-exec\b)/,
];

/** Anything enabling chaining, substitution, or redirection is not clearly safe. */
const UNSAFE_SHELL_RE = /[;&`$<>\\\n]/;

/** First-token allowlist for standalone safe reads. */
const SAFE_BARE_COMMANDS = new Set([
  "ls",
  "cat",
  "grep",
  "rg",
  "head",
  "tail",
  "wc",
  "pwd",
  "which",
  "whoami",
  "file",
  "stat",
  "du",
  "df",
  "echo",
  "date",
  "env",
  "printenv",
  "tsc",
  "vitest",
  "jest",
  "pytest",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show"]);
const SAFE_PKG_RUNNERS = new Set(["npm", "bun", "yarn", "pnpm"]);
const SAFE_PKG_SCRIPTS = new Set(["build", "test", "tests", "typecheck", "lint", "check"]);

function isSafeSegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return false;
  const [head, ...rest] = tokens;

  if (SAFE_BARE_COMMANDS.has(head)) return true;
  if (head === "git") return rest.length > 0 && SAFE_GIT_SUBCOMMANDS.has(rest[0]);
  if (SAFE_PKG_RUNNERS.has(head)) {
    if (rest[0] === "test") return true;
    if (rest[0] === "run") return rest.length > 1 && SAFE_PKG_SCRIPTS.has(rest[1]);
    return false;
  }
  if (head === "cargo") return rest.length > 0 && ["build", "test", "check"].includes(rest[0]);
  if (head === "go") return rest.length > 0 && ["build", "test", "vet"].includes(rest[0]);
  if (head === "make") {
    return rest.every((t) => SAFE_PKG_SCRIPTS.has(t) || t.startsWith("-j"));
  }
  return false;
}

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (UNSAFE_SHELL_RE.test(trimmed)) return false;
  // `&&` and `||` are caught by UNSAFE_SHELL_RE; single pipes between safe
  // segments are allowed (e.g. `grep foo file | head`).
  return trimmed.split("|").every(isSafeSegment);
}

/**
 * Conservative classification of a `session/request_permission` payload.
 * Only clearly-safe reads/builds/tests classify `safe`; every unclassifiable
 * shape is `destructive` (escalate).
 */
export function classifyPermissionRequest(
  params: unknown
): PermissionClassification {
  const { kind, command, title } = extractPermissionPayload(params);

  if (kind !== null && /delete|remove/i.test(kind)) return "destructive";

  for (const haystack of [command, title]) {
    if (haystack === null) continue;
    if (DESTRUCTIVE_PATTERNS.some((re) => re.test(haystack))) {
      return "destructive";
    }
  }

  if (command !== null) {
    return isSafeCommand(command) ? "safe" : "destructive";
  }
  if (kind === "read") return "safe";
  return "destructive";
}

/** The allow-ONCE option's id, or null. `allow_always` is never selected. */
export function findAllowOnceOptionId(params: unknown): string | null {
  const options = asRecord(params)?.options;
  if (!Array.isArray(options)) return null;
  for (const raw of options) {
    const option = asRecord(raw);
    if (option?.kind !== "allow_once") continue;
    const optionId = stringField(option, "optionId");
    if (optionId !== null) return optionId;
  }
  return null;
}

/** A permission request the trust dial cleared for auto-approval. */
export interface AutoApprovablePermission {
  issueId: string;
  projectIssueId: string;
  event: AcpEvent & { acp: "request" };
  /** The allow_once optionId the policy selected. */
  optionId: string;
}

/** Decide, synchronously, whether a permission request may be auto-approved. */
export function evaluatePermissionRequest(
  db: AppDatabase,
  issueId: string,
  projectIssueId: string,
  event: AcpEvent & { acp: "request" }
): { autoApprove: true; optionId: string } | { autoApprove: false } {
  if (resolveTrustDial(db, issueId, projectIssueId) !== "high") {
    return { autoApprove: false };
  }
  if (classifyPermissionRequest(event.params) !== "safe") {
    return { autoApprove: false };
  }
  const optionId = findAllowOnceOptionId(event.params);
  if (optionId === null) return { autoApprove: false };
  return { autoApprove: true, optionId };
}

function describePermission(event: AcpEvent & { acp: "request" }): string {
  const { command, title } = extractPermissionPayload(event.params);
  return title ?? command ?? `Permission request: ${event.method}`;
}

export interface AutoApprovalDeps {
  db: AppDatabase;
  manager: OrchestrationDaemon;
  frameRouter: FrameRouter;
}

/**
 * Answer an auto-approvable permission on the wire and record the approval in
 * `agent_questions` for audit. A failed respond falls back to the standard
 * user escalation — the request is still pending on the daemon.
 */
export async function executeAutoApproval(
  deps: AutoApprovalDeps,
  permission: AutoApprovablePermission
): Promise<void> {
  const mintedId = mintOrchSessionId(permission.projectIssueId, permission.issueId);
  try {
    await deps.manager.acpRespond(mintedId, permission.event.id, {
      result: { outcome: { outcome: "selected", optionId: permission.optionId } },
    });
  } catch {
    deps.frameRouter.setAttention(
      permission.issueId,
      permission.projectIssueId,
      "permission"
    );
    return;
  }
  const now = Date.now();
  deps.db
    .insert(agentQuestions)
    .values({
      issueId: permission.issueId,
      sessionId: mintedId,
      question: describePermission(permission.event),
      answer: `auto-approved (allow_once: ${permission.optionId})`,
      answeredBy: "orchestrator",
      disposition: "answered",
      createdAt: now,
      answeredAt: now,
    })
    .run();
  deps.frameRouter.setAttention(permission.issueId, permission.projectIssueId, "none");
}
