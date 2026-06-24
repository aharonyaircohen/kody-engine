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

  describe("reasoning effort", () => {
    it("captures --reasoning-effort flag for every canonical level", () => {
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "off"], {}).reasoningEffort).toBe("off")
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "low"], {}).reasoningEffort).toBe("low")
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "medium"], {}).reasoningEffort).toBe("medium")
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "high"], {}).reasoningEffort).toBe("high")
    })

    it("accepts case-insensitive --reasoning-effort values", () => {
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "HIGH"], {}).reasoningEffort).toBe("high")
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "Medium"], {}).reasoningEffort).toBe("medium")
    })

    it("drops --reasoning-effort to undefined for unknown values (don't fail the parse)", () => {
      // The dashboard may forward stale or typo'd values; we don't
      // reject the request, we just fall through to the next resolution
      // source (env → config → unset).
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", "nuclear"], {}).reasoningEffort).toBeUndefined()
      expect(parseChatArgs(["--session", "s1", "--reasoning-effort", ""], {}).reasoningEffort).toBeUndefined()
    })

    it("falls back to REASONING_EFFORT env var when the flag is absent", () => {
      const a = parseChatArgs(["--session", "s1"], { REASONING_EFFORT: "high" })
      expect(a.reasoningEffort).toBe("high")
    })

    it("CLI flag wins over env when both are set", () => {
      const a = parseChatArgs(["--session", "s1", "--reasoning-effort", "low"], {
        REASONING_EFFORT: "high",
      })
      expect(a.reasoningEffort).toBe("low")
    })

    it("ignores empty REASONING_EFFORT env (Actions sends '' for unset inputs)", () => {
      const a = parseChatArgs(["--session", "s1"], { REASONING_EFFORT: "" })
      expect(a.reasoningEffort).toBeUndefined()
    })

    it("is undefined by default — engine's cheapest path (no thinking block)", () => {
      const a = parseChatArgs(["--session", "s1"], {})
      expect(a.reasoningEffort).toBeUndefined()
    })
  })
})
