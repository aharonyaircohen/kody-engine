import { describe, expect, it } from "vitest"
import {
  codexThreadStartParams,
  codexTurnStartParams,
  translateCodexNotification,
} from "../../src/chat/codex-app-server.js"

describe("Codex app-server protocol", () => {
  it("starts a thread in the Brain workspace with the Brain instructions", () => {
    expect(
      codexThreadStartParams({
        cwd: "/workspace/repos/acme/widgets",
        developerInstructions: "You are Kody Brain.",
      }),
    ).toEqual({
      cwd: "/workspace/repos/acme/widgets",
      developerInstructions: "You are Kody Brain.",
    })
  })

  it("starts a turn with the user's message", () => {
    expect(
      codexTurnStartParams({
        threadId: "thread-1",
        message: "Inspect the failing test.",
      }),
    ).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Inspect the failing test." }],
    })
  })

  it("translates assistant deltas into Brain text events", () => {
    expect(
      translateCodexNotification(
        {
          method: "item/agentMessage/delta",
          params: { delta: "hello", itemId: "item-1", threadId: "t", turnId: "u" },
        },
        "chat-1",
      ),
    ).toEqual([{ type: "text", text: "hello", chatId: "chat-1" }])
  })

  it("translates turn completion into a Brain done event", () => {
    expect(
      translateCodexNotification({ method: "turn/completed", params: { threadId: "t", turn: { id: "u" } } }, "chat-1"),
    ).toEqual([{ type: "done", chatId: "chat-1" }])
  })

  it("translates command execution items into Brain tool events", () => {
    expect(
      translateCodexNotification(
        {
          method: "item/started",
          params: {
            threadId: "t",
            turnId: "u",
            item: { type: "commandExecution", id: "item-1", command: "pnpm test" },
          },
        },
        "chat-1",
      ),
    ).toEqual([
      {
        type: "tool_use",
        name: "commandExecution",
        input: { type: "commandExecution", id: "item-1", command: "pnpm test" },
        chatId: "chat-1",
      },
    ])
  })
})
