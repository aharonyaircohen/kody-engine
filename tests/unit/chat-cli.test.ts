import { describe, expect, it } from "vitest"
import { parseChatArgs } from "../../src/chat-cli.js"

describe("chat-cli: parseChatArgs", () => {
  it("requires both session and dashboard-url", () => {
    const a = parseChatArgs([], {})
    expect(a.errors.some((e) => e.includes("--session"))).toBe(true)
    expect(a.errors.some((e) => e.includes("--dashboard-url"))).toBe(true)
  })

  it("accepts CLI flags for all inputs", () => {
    const a = parseChatArgs(
      ["--session", "s1", "--model", "x/y", "--dashboard-url", "https://d?token=t"],
      {},
    )
    expect(a.sessionId).toBe("s1")
    expect(a.model).toBe("x/y")
    expect(a.dashboardUrl).toBe("https://d?token=t")
    expect(a.errors).toEqual([])
  })

  it("falls back to env for all inputs", () => {
    const a = parseChatArgs([], {
      SESSION_ID: "s2",
      MODEL: "anthropic/claude",
      DASHBOARD_URL: "https://x?token=tk",
    })
    expect(a.sessionId).toBe("s2")
    expect(a.model).toBe("anthropic/claude")
    expect(a.dashboardUrl).toBe("https://x?token=tk")
    expect(a.errors).toEqual([])
  })

  it("CLI flags override env", () => {
    const a = parseChatArgs(
      ["--session", "cli-id", "--model", "cli/model", "--dashboard-url", "https://cli?token=t"],
      { SESSION_ID: "env-id", MODEL: "env/model", DASHBOARD_URL: "https://env?token=t" },
    )
    expect(a.sessionId).toBe("cli-id")
    expect(a.model).toBe("cli/model")
    expect(a.dashboardUrl).toBe("https://cli?token=t")
  })

  it("normalizes empty-string inputs from Actions to undefined", () => {
    const a = parseChatArgs([], {
      SESSION_ID: "s3",
      MODEL: "",
      DASHBOARD_URL: "   ",
    })
    expect(a.model).toBeUndefined()
    expect(a.dashboardUrl).toBeUndefined()
    expect(a.errors.some((e) => e.includes("--dashboard-url"))).toBe(true)
  })

  it("rejects unknown flags", () => {
    const a = parseChatArgs(["--session", "s1", "--dashboard-url", "https://d?token=t", "--wat"], {})
    expect(a.errors.some((e) => e.includes("--wat"))).toBe(true)
  })

  it("captures --verbose and --quiet", () => {
    const a = parseChatArgs(
      ["--session", "s1", "--dashboard-url", "https://d?token=t", "--verbose"],
      {},
    )
    expect(a.verbose).toBe(true)
  })
})
