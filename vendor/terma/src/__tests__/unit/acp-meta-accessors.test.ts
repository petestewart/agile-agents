import { describe, it, expect } from "vitest";
import {
  acpStructuredPatch,
  acpTerminalExit,
  acpTerminalInfo,
  acpTerminalOutput,
  acpToolName,
} from "../../shared/acp-types";

/**
 * `_meta.terminal_output`, `_meta.terminal_info` and `_meta.claudeCode.*` are
 * vendor extensions on a 0.x bridge (SPIKE Q5). Every read of them goes through
 * these accessors so an upgrade that changes or drops one degrades a card
 * rather than throwing inside a timeline render.
 *
 * The payloads below are the shapes the spike actually captured.
 */
describe("acpTerminalOutput", () => {
  it("reads a captured terminal_output frame", () => {
    expect(
      acpTerminalOutput({
        terminal_output: { terminal_id: "toolu_017QjkFr6AYQutskYsMyAkXZ", data: "gone" },
      }),
    ).toEqual({ terminalId: "toolu_017QjkFr6AYQutskYsMyAkXZ", data: "gone" });
  });

  it("reads an empty data payload rather than treating it as absent", () => {
    expect(acpTerminalOutput({ terminal_output: { terminal_id: "t1", data: "" } })).toEqual({
      terminalId: "t1",
      data: "",
    });
  });

  it.each([
    ["undefined meta", undefined],
    ["null meta", null],
    ["a meta with no terminal_output", { claudeCode: {} }],
    ["a non-object terminal_output", { terminal_output: "gone" }],
    ["a missing terminal_id", { terminal_output: { data: "x" } }],
    ["a non-string data", { terminal_output: { terminal_id: "t1", data: 3 } }],
  ])("returns null for %s", (_label, meta) => {
    expect(acpTerminalOutput(meta)).toBeNull();
  });
});

describe("acpTerminalInfo", () => {
  it("reads a captured terminal_info frame", () => {
    expect(acpTerminalInfo({ terminal_info: { terminal_id: "toolu_017Q" } })).toEqual({
      terminalId: "toolu_017Q",
    });
  });

  it.each([
    ["null meta", null],
    ["a missing terminal_id", { terminal_info: {} }],
    ["a numeric terminal_id", { terminal_info: { terminal_id: 1 } }],
  ])("returns null for %s", (_label, meta) => {
    expect(acpTerminalInfo(meta)).toBeNull();
  });
});

describe("acpTerminalExit", () => {
  // No terminal_exit frame was ever captured live (GH-40 amendment); this is
  // the exact shape claude-agent-acp@0.62.0 constructs in dist/tools.js:
  // { terminal_id, exit_code: <number>, signal: null }.
  it("reads the bridge-source terminal_exit shape", () => {
    expect(
      acpTerminalExit({
        terminal_exit: { terminal_id: "toolu_017QjkFr6AYQutskYsMyAkXZ", exit_code: 1, signal: null },
      }),
    ).toEqual({ terminalId: "toolu_017QjkFr6AYQutskYsMyAkXZ", exitCode: 1, signal: null });
  });

  it("preserves exit_code 0, the success case a truthiness test would drop", () => {
    expect(acpTerminalExit({ terminal_exit: { terminal_id: "t1", exit_code: 0, signal: null } })).toEqual({
      terminalId: "t1",
      exitCode: 0,
      signal: null,
    });
  });

  it("reads a signal-terminated exit with a null exit code (codex-acp lifecycle)", () => {
    expect(
      acpTerminalExit({ terminal_exit: { terminal_id: "t1", exit_code: null, signal: "SIGKILL" } }),
    ).toEqual({ terminalId: "t1", exitCode: null, signal: "SIGKILL" });
  });

  it("degrades an unrecognised exit_code type to null rather than rejecting the frame", () => {
    expect(acpTerminalExit({ terminal_exit: { terminal_id: "t1", exit_code: "0" } })).toEqual({
      terminalId: "t1",
      exitCode: null,
      signal: null,
    });
  });

  it.each([
    ["undefined meta", undefined],
    ["null meta", null],
    ["a meta with no terminal_exit", { terminal_output: { terminal_id: "t1", data: "x" } }],
    ["a non-object terminal_exit", { terminal_exit: "done" }],
    ["a missing terminal_id", { terminal_exit: { exit_code: 0 } }],
  ])("returns null for %s", (_label, meta) => {
    expect(acpTerminalExit(meta)).toBeNull();
  });
});

describe("acpToolName", () => {
  it("reads the concrete tool behind a generic kind", () => {
    expect(acpToolName({ claudeCode: { toolName: "Edit" } })).toBe("Edit");
  });

  it.each([
    ["null meta", null],
    ["a meta with no claudeCode", { terminal_info: {} }],
    ["a claudeCode with no toolName", { claudeCode: {} }],
    ["a non-string toolName", { claudeCode: { toolName: 7 } }],
  ])("returns null for %s", (_label, meta) => {
    expect(acpToolName(meta)).toBeNull();
  });
});

describe("acpStructuredPatch", () => {
  const hunk = {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 7,
    lines: [" export function add(a,b){", "+", "+export function subtract(a,b){"],
  };

  it("reads the captured structuredPatch hunks", () => {
    expect(
      acpStructuredPatch({ claudeCode: { toolResponse: { structuredPatch: [hunk] } } }),
    ).toEqual([hunk]);
  });

  it("reads an empty patch as an empty list, not as absent", () => {
    expect(
      acpStructuredPatch({ claudeCode: { toolResponse: { structuredPatch: [] } } }),
    ).toEqual([]);
  });

  // A half-decoded patch would render as a wrong diff, which is worse than
  // rendering none, so one bad hunk rejects the whole patch.
  it("returns null when any hunk is malformed", () => {
    expect(
      acpStructuredPatch({
        claudeCode: { toolResponse: { structuredPatch: [hunk, { oldStart: 1 }] } },
      }),
    ).toBeNull();
  });

  it("returns null when a hunk's lines are not all strings", () => {
    expect(
      acpStructuredPatch({
        claudeCode: { toolResponse: { structuredPatch: [{ ...hunk, lines: ["ok", 2] }] } },
      }),
    ).toBeNull();
  });

  it.each([
    ["null meta", null],
    ["a meta with no claudeCode", {}],
    ["a claudeCode with no toolResponse", { claudeCode: {} }],
    ["a non-array structuredPatch", { claudeCode: { toolResponse: { structuredPatch: {} } } }],
  ])("returns null for %s", (_label, meta) => {
    expect(acpStructuredPatch(meta)).toBeNull();
  });
});
