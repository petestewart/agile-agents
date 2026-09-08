import { describe, it, expect } from "vitest";
import { parseAcpEvent } from "../../main/lib/terminal-host/acp-events";

/**
 * `parseAcpEvent` sits on the hot path between the daemon's data channel and
 * the ACP pane. A malformed or future-shaped frame must be dropped, never
 * thrown — a bridge upgrade should degrade a card, not kill the session.
 */
describe("parseAcpEvent", () => {
  it("parses an initialized event", () => {
    expect(parseAcpEvent(JSON.stringify({ acp: "initialized", result: { x: 1 } }))).toEqual({
      acp: "initialized",
      result: { x: 1 },
    });
  });

  it("parses a notification event", () => {
    const message = { jsonrpc: "2.0", method: "session/update", params: { sessionUpdate: "plan" } };
    expect(parseAcpEvent(JSON.stringify({ acp: "notification", message }))).toEqual({
      acp: "notification",
      message,
    });
  });

  it("parses a request event with a numeric id", () => {
    expect(
      parseAcpEvent(
        JSON.stringify({
          acp: "request",
          id: 9001,
          method: "session/request_permission",
          params: { options: [] },
        }),
      ),
    ).toEqual({
      acp: "request",
      id: 9001,
      method: "session/request_permission",
      params: { options: [] },
    });
  });

  // The real bridge used id 0 for its first permission request, so a
  // truthiness check anywhere on this path would drop a live approval prompt.
  it("parses a request event with id 0", () => {
    expect(
      parseAcpEvent(
        JSON.stringify({ acp: "request", id: 0, method: "session/request_permission" }),
      ),
    ).toEqual({
      acp: "request",
      id: 0,
      method: "session/request_permission",
      params: undefined,
    });
  });

  it("parses a request event with a string id", () => {
    const parsed = parseAcpEvent(
      JSON.stringify({ acp: "request", id: "req-1", method: "fs/read_text_file" }),
    );
    expect(parsed).toMatchObject({ acp: "request", id: "req-1" });
  });

  /**
   * `seq` is the only thing tying the live stream to a replay, so dropping it
   * here would make de-duplication impossible. Both zero-valued cases are
   * covered deliberately: a truthiness test would discard the truncation notice
   * (`seq: 0`) — the one event whose loss is unrecoverable, because it is the
   * event that announces loss.
   */
  it("carries seq through when the daemon stamped one", () => {
    expect(
      parseAcpEvent(JSON.stringify({ acp: "notification", message: { method: "x" }, seq: 12 })),
    ).toEqual({ acp: "notification", message: { method: "x" }, seq: 12 });
  });

  it("carries seq: 0 through", () => {
    const parsed = parseAcpEvent(JSON.stringify({ acp: "truncated", dropped: 3, seq: 0 }));
    expect(parsed).toEqual({ acp: "truncated", dropped: 3, seq: 0 });
    expect(parsed).toHaveProperty("seq", 0);
  });

  it("leaves seq absent rather than undefined when the frame carried none", () => {
    const parsed = parseAcpEvent(JSON.stringify({ acp: "initialized", result: {} }));
    expect(parsed).not.toHaveProperty("seq");
  });

  it("parses a truncated notice with dropped: 0", () => {
    expect(parseAcpEvent(JSON.stringify({ acp: "truncated", dropped: 0 }))).toEqual({
      acp: "truncated",
      dropped: 0,
    });
  });

  it.each([
    ["invalid json", "not json at all"],
    ["a truncated notice with no dropped count", JSON.stringify({ acp: "truncated" })],
    [
      "a truncated notice with a non-numeric dropped count",
      JSON.stringify({ acp: "truncated", dropped: "3" }),
    ],
    ["a json primitive", "42"],
    ["null", "null"],
    ["an unknown acp discriminator", JSON.stringify({ acp: "future_kind" })],
    ["a missing discriminator", JSON.stringify({ hello: "world" })],
    ["a notification with no message", JSON.stringify({ acp: "notification" })],
    ["a request with no method", JSON.stringify({ acp: "request", id: 1 })],
    ["a request with no id", JSON.stringify({ acp: "request", method: "x" })],
    ["a request with an object id", JSON.stringify({ acp: "request", id: {}, method: "x" })],
  ])("returns null for %s", (_label, input) => {
    expect(parseAcpEvent(input)).toBeNull();
  });
});
