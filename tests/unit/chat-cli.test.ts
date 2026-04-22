import { describe, expect, it } from "vitest"
import { parseChatArgs } from "../../src/chat-cli.js"

describe("chat-cli: parseChatArgs", () => {
  it("fails when --session and SESSION_ID are both absent", () => {
    const a = parseChatArgs([], {})
    expect(a.errors.some((e) => e.includes("--session"))).toBe(true)
  })

  it("accepts --session flag", () => {
    const a = parseChatArgs(["--session", "s1"], {})
    expect(a.sessionId).toBe("s1")
    expect(a.errors).toEqual([])
  })

  it("falls back to env for all inputs", () => {
    const a = parseChatArgs([], {
      SESSION_ID: "s2",
      INIT_MESSAGE: "hello",
      MODEL: "anthropic/claude",
      DASHBOARD_URL: "https://x/ingest?token=tk",
    })
    expect(a.sessionId).toBe("s2")
    expect(a.initMessage).toBe("hello")
    expect(a.model).toBe("anthropic/claude")
    expect(a.dashboardUrl).toBe("https://x/ingest?token=tk")
  })

  it("CLI flags override env", () => {
    const a = parseChatArgs(["--session", "cli-id", "--model", "cli/model"], {
      SESSION_ID: "env-id",
      MODEL: "env/model",
    })
    expect(a.sessionId).toBe("cli-id")
    expect(a.model).toBe("cli/model")
  })

  it("normalizes empty-string inputs from Actions to undefined", () => {
    const a = parseChatArgs([], {
      SESSION_ID: "s3",
      INIT_MESSAGE: "   ",
      MODEL: "",
      DASHBOARD_URL: "",
    })
    expect(a.initMessage).toBeUndefined()
    expect(a.model).toBeUndefined()
    expect(a.dashboardUrl).toBeUndefined()
  })

  it("rejects unknown flags", () => {
    const a = parseChatArgs(["--session", "s1", "--wat"], {})
    expect(a.errors.some((e) => e.includes("--wat"))).toBe(true)
  })

  it("captures --verbose and --quiet", () => {
    const a = parseChatArgs(["--session", "s1", "--verbose"], {})
    expect(a.verbose).toBe(true)
    const b = parseChatArgs(["--session", "s1", "--quiet"], {})
    expect(b.quiet).toBe(true)
  })

  it("captures --dashboard-url", () => {
    const a = parseChatArgs(["--session", "s1", "--dashboard-url", "https://x/i?token=t"], {})
    expect(a.dashboardUrl).toBe("https://x/i?token=t")
  })
})
