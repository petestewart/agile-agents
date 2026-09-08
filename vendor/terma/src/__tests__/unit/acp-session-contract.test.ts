import { describe, it, expect } from "vitest";
import {
  applyFinalMessageEvent,
  INITIAL_FINAL_MESSAGE,
  replyFromFinalMessage,
  turnEndFromError,
  turnEndFromEvent,
  turnEndFromExit,
  turnEndFromStopReason,
  type FinalMessageState,
} from "../../main/lib/terminal-host/acp-session-contract";
import { ACP_TURN_ENDED_METHOD, type WireAcpEvent } from "@shared/acp-types";
import { REPLY_TEXT_MAX_CHARS } from "@shared/agent-session-contract";

/**
 * The ACP → session-contract boundary (spec §6.4 "Option C"): turn-end
 * mapping and §5.2 final-assistant-message extraction. Pure folds — these
 * tests drive them with hand-built event streams shaped like the daemon's
 * real frames (nested SessionNotification envelope, `_terma/turn_ended`
 * marker, seq/gen stamps).
 */

let seqCounter = 0;

function update(sessionUpdate: string, content?: unknown): WireAcpEvent {
  return {
    acp: "notification",
    message: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate, ...(content !== undefined ? { content } : {}) } },
    },
    seq: ++seqCounter,
    gen: 1,
  };
}

function agentChunk(text: string): WireAcpEvent {
  return update("agent_message_chunk", { type: "text", text });
}

function turnEnded(stopReason: string | null): WireAcpEvent {
  return {
    acp: "notification",
    message: {
      jsonrpc: "2.0",
      method: ACP_TURN_ENDED_METHOD,
      params: { sessionId: "s1", stopReason },
    },
    seq: ++seqCounter,
    gen: 1,
  };
}

function fold(events: WireAcpEvent[], initial: FinalMessageState = INITIAL_FINAL_MESSAGE) {
  return events.reduce(applyFinalMessageEvent, initial);
}

describe("turnEndFromStopReason", () => {
  it("maps end_turn to completed with no error", () => {
    expect(turnEndFromStopReason("end_turn")).toEqual({ status: "completed", error: null });
  });

  it("maps cancelled to cancelled with no error — an outcome, not a fault", () => {
    expect(turnEndFromStopReason("cancelled")).toEqual({ status: "cancelled", error: null });
  });

  it("maps null (rejected round trip) to failed with a structured error", () => {
    const end = turnEndFromStopReason(null);
    expect(end.status).toBe("failed");
    expect(end.error).not.toBeNull();
    expect(end.error?.code).toBe("turn_failed");
    expect(typeof end.error?.message).toBe("string");
  });

  it("maps harness-specific early stops (max_tokens, refusal) to completed", () => {
    // Vendor stop vocabulary stays below the boundary: the round trip
    // settled, so the contract reports a completed turn with the text as-is.
    expect(turnEndFromStopReason("max_tokens").status).toBe("completed");
    expect(turnEndFromStopReason("refusal").status).toBe("completed");
    expect(turnEndFromStopReason("max_turn_requests").status).toBe("completed");
  });
});

describe("turn-end from lifecycle signals", () => {
  it("exit mid-turn is a failed turn carrying the exit code", () => {
    const end = turnEndFromExit(137);
    expect(end.status).toBe("failed");
    expect(end.error?.code).toBe("session_exited");
    expect(end.error?.message).toContain("137");
  });

  it("a zero exit code is still a failed turn — the turn never ended", () => {
    // Exit code 0 must not be truthiness-tested into success: a clean agent
    // exit mid-turn still means no turn-end marker will ever arrive.
    const end = turnEndFromExit(0);
    expect(end.status).toBe("failed");
    expect(end.error?.code).toBe("session_exited");
  });

  it("a transport error mid-turn is a failed turn carrying the message", () => {
    const end = turnEndFromError("daemon connection lost");
    expect(end.status).toBe("failed");
    expect(end.error).toEqual({ code: "session_error", message: "daemon connection lost" });
  });
});

describe("turnEndFromEvent", () => {
  it("reads the _terma/turn_ended marker", () => {
    expect(turnEndFromEvent(turnEnded("end_turn"))).toEqual({
      status: "completed",
      error: null,
    });
    expect(turnEndFromEvent(turnEnded(null))?.status).toBe("failed");
  });

  it("returns null for every non-marker frame", () => {
    expect(turnEndFromEvent(agentChunk("hi"))).toBeNull();
    expect(turnEndFromEvent(update("session_info_update"))).toBeNull();
    expect(turnEndFromEvent({ acp: "initialized", result: {} })).toBeNull();
    expect(
      turnEndFromEvent({ acp: "request", id: 0, method: "session/request_permission", params: {} })
    ).toBeNull();
  });

  it("treats a marker with a malformed stopReason as failed, not completed", () => {
    const marker: WireAcpEvent = {
      acp: "notification",
      message: { jsonrpc: "2.0", method: ACP_TURN_ENDED_METHOD, params: { stopReason: 42 } },
    };
    expect(turnEndFromEvent(marker)?.status).toBe("failed");
  });
});

describe("final assistant message extraction", () => {
  it("concatenates a single streamed message", () => {
    const state = fold([agentChunk("Hello, "), agentChunk("world.")]);
    expect(state.text).toBe("Hello, world.");
  });

  it("keeps only the final message when tool calls intervene", () => {
    const state = fold([
      agentChunk("Let me check that."),
      update("tool_call", undefined),
      update("tool_call_update", undefined),
      agentChunk("The answer "),
      agentChunk("is 42."),
    ]);
    expect(state.text).toBe("The answer is 42.");
  });

  it("keeps the last message as candidate when the turn ends on a tool call", () => {
    // A closed message is replaced only if the agent speaks again — a
    // trailing tool call must not blank the reply.
    const state = fold([agentChunk("Done."), update("tool_call", undefined)]);
    expect(state.text).toBe("Done.");
  });

  it("excludes thought chunks and treats them as a message boundary", () => {
    const state = fold([
      agentChunk("First answer."),
      update("agent_thought_chunk", { type: "text", text: "hmm, reconsidering" }),
      agentChunk("Final answer."),
    ]);
    expect(state.text).toBe("Final answer.");
  });

  it("resets on the user-prompt echo — a new turn starts fresh", () => {
    const state = fold([
      agentChunk("Previous turn's reply."),
      turnEnded("end_turn"),
      update("user_message_chunk", { type: "text", text: "next question" }),
      agentChunk("New reply."),
    ]);
    expect(state.text).toBe("New reply.");
  });

  it("a turn with no assistant message extracts empty text", () => {
    const state = fold([
      update("user_message_chunk", { type: "text", text: "do the thing" }),
      update("tool_call", undefined),
    ]);
    expect(state.text).toBe("");
  });

  it("ignores metadata updates, including a trailing session_info_update", () => {
    const state = fold([
      agentChunk("Reply."),
      update("usage_update", undefined),
      update("session_info_update", undefined),
      update("available_commands_update", undefined),
    ]);
    // Metadata is not boundary evidence: a following chunk still appends.
    expect(fold([agentChunk(" More."), agentChunk("!")], state).text).toBe("Reply. More.!");
  });

  it("ignores non-text chunks and frames that are not session updates", () => {
    const state = fold([
      { acp: "initialized", result: {} },
      { acp: "truncated", dropped: 3 },
      update("agent_message_chunk", { type: "image", data: "…" }),
      agentChunk("Text only."),
    ]);
    expect(state.text).toBe("Text only.");
  });
});

describe("replyFromFinalMessage", () => {
  it("assembles a completed reply without error or truncated fields", () => {
    const reply = replyFromFinalMessage(fold([agentChunk("Done.")]), {
      status: "completed",
      error: null,
    });
    expect(reply).toEqual({ status: "completed", text: "Done." });
    expect("error" in reply).toBe(false);
    expect("truncated" in reply).toBe(false);
  });

  it("carries the structured error and pre-failure text on a failed turn", () => {
    const end = turnEndFromStopReason(null);
    const reply = replyFromFinalMessage(fold([agentChunk("Partial…")]), end);
    expect(reply.status).toBe("failed");
    expect(reply.text).toBe("Partial…");
    expect(reply.error).toEqual(end.error);
  });

  it("caps text at REPLY_TEXT_MAX_CHARS and sets truncated", () => {
    const big = "x".repeat(REPLY_TEXT_MAX_CHARS + 5000);
    const reply = replyFromFinalMessage(fold([agentChunk(big)]), {
      status: "completed",
      error: null,
    });
    expect(reply.text.length).toBe(REPLY_TEXT_MAX_CHARS);
    expect(reply.truncated).toBe(true);
  });

  it("clamps state growth while folding an oversized stream", () => {
    let state = INITIAL_FINAL_MESSAGE;
    const chunk = agentChunk("y".repeat(10_000));
    for (let i = 0; i < 50; i++) state = applyFinalMessageEvent(state, chunk);
    // The fold keeps at most one char past the cap — enough to detect
    // truncation, no unbounded growth.
    expect(state.text.length).toBe(REPLY_TEXT_MAX_CHARS + 1);
    const reply = replyFromFinalMessage(state, { status: "completed", error: null });
    expect(reply.text.length).toBe(REPLY_TEXT_MAX_CHARS);
    expect(reply.truncated).toBe(true);
  });

  it("a reply exactly at the cap is not truncated", () => {
    const exact = "z".repeat(REPLY_TEXT_MAX_CHARS);
    const reply = replyFromFinalMessage(fold([agentChunk(exact)]), {
      status: "completed",
      error: null,
    });
    expect(reply.text.length).toBe(REPLY_TEXT_MAX_CHARS);
    expect("truncated" in reply).toBe(false);
  });
});
