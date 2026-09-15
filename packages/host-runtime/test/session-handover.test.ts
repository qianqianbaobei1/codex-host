import { describe, expect, it } from "vitest";

import { expandHandoverMessages, formatHandoverContext } from "../src/session-handover.js";

describe("session handover context", () => {
  it("round-trips Host-generated history envelopes into individual messages", () => {
    const encoded = formatHandoverContext(
      [
        { id: "user-1", turnId: "turn-1", role: "user", text: "remember 42" },
        { id: "agent-1", turnId: "turn-1", role: "agent", text: "I remember 42" },
      ],
      "what did I ask you to remember?",
    );
    expect(
      expandHandoverMessages([{ id: "wrapped", turnId: "turn-2", role: "user", text: encoded }]),
    ).toMatchObject([
      { role: "user", text: "remember 42" },
      { role: "agent", text: "I remember 42" },
      { role: "user", text: "what did I ask you to remember?" },
    ]);
  });

  it("leaves ordinary user messages untouched", () => {
    const message = { id: "user-1", turnId: "turn-1", role: "user" as const, text: "hello" };
    expect(expandHandoverMessages([message])).toEqual([message]);
  });

  it("omits overflowing early history when budget is exceeded but keeps initial anchor and recent tail", () => {
    const messages = [
      { id: "u-0", turnId: "t-0", role: "user" as const, text: "initial goal: build app" },
      { id: "a-0", turnId: "t-0", role: "agent" as const, text: "very old response 1" },
      { id: "u-1", turnId: "t-1", role: "user" as const, text: "very old prompt 2" },
      { id: "a-1", turnId: "t-1", role: "agent" as const, text: "very old response 2" },
      { id: "u-2", turnId: "t-2", role: "user" as const, text: "recent prompt" },
      { id: "a-2", turnId: "t-2", role: "agent" as const, text: "recent response" },
    ];
    // Small budget allowing only anchor + latest 2 messages
    const encoded = formatHandoverContext(messages, "next question", 250);
    const roundTripped = expandHandoverMessages([
      { id: "wrapped", turnId: "t-3", role: "user", text: encoded },
    ]);
    expect(roundTripped).toEqual([
      {
        id: "handover-wrapped-prior-0",
        turnId: "handover-wrapped",
        role: "user",
        text: "initial goal: build app",
      },
      {
        id: "handover-wrapped-prior-1",
        turnId: "handover-wrapped",
        role: "user",
        text: "recent prompt",
      },
      {
        id: "handover-wrapped-prior-2",
        turnId: "handover-wrapped",
        role: "agent",
        text: "recent response",
      },
      {
        id: "handover-wrapped-current",
        turnId: "handover-wrapped",
        role: "user",
        text: "next question",
      },
    ]);
  });
});
