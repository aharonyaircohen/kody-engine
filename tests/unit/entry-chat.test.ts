import { describe, expect, it } from "vitest"
import { parseArgs } from "../../src/entry.js"

describe("entry: chat command routing", () => {
  it("routes `chat` to the chat command with its argv", () => {
    const a = parseArgs(["chat", "--session", "s1", "--verbose"])
    expect(a.command).toBe("chat")
    expect(a.chatArgv).toEqual(["--session", "s1", "--verbose"])
    expect(a.errors).toEqual([])
  })

  it("routes bare `chat` (no args — SESSION_ID from env)", () => {
    const a = parseArgs(["chat"])
    expect(a.command).toBe("chat")
    expect(a.chatArgv).toEqual([])
  })
})
