/**
 * Tests for src/servers/serve.ts
 *
 * Covers the serve CLI flow preflight: parseTarget and buildProxyEnv helpers,
 * plus the exported ServeOptions interface.
 */

import { afterEach, describe, expect, it } from "vitest"
import { buildProxyEnv, parseTarget, type ServeOptions } from "../../src/servers/serve.js"

describe("parseTarget", () => {
  it("returns 'none' when positional is empty", () => {
    expect(parseTarget([])).toBe("none")
    expect(parseTarget(null)).toBe("none")
    expect(parseTarget(undefined)).toBe("none")
  })

  it("returns 'none' when positional is not an array", () => {
    expect(parseTarget("vscode")).toBe("none")
    expect(parseTarget({})).toBe("none")
    expect(parseTarget(123)).toBe("none")
  })

  it("returns 'none' for an empty array", () => {
    expect(parseTarget([])).toBe("none")
  })

  it("returns 'vscode' for 'vscode'", () => {
    expect(parseTarget(["vscode"])).toBe("vscode")
  })

  it("returns 'vscode' for 'code' (alias)", () => {
    expect(parseTarget(["code"])).toBe("vscode")
  })

  it("returns 'claude' for 'claude'", () => {
    expect(parseTarget(["claude"])).toBe("claude")
  })

  it("is case-insensitive for vscode/code", () => {
    expect(parseTarget(["VSCODE"])).toBe("vscode")
    expect(parseTarget(["Code"])).toBe("vscode")
  })

  it("is case-insensitive for claude", () => {
    expect(parseTarget(["Claude"])).toBe("claude")
    expect(parseTarget(["CLAUDE"])).toBe("claude")
  })

  it("throws for an unknown subcommand", () => {
    expect(() => parseTarget(["emacs"])).toThrow('unknown serve subcommand: "emacs" (expected: vscode, claude, or omit)')
    expect(() => parseTarget(["npx"])).toThrow()
  })

  it("ignores extra positional args after the first", () => {
    expect(parseTarget(["vscode", "extra"])).toBe("vscode")
    expect(parseTarget(["claude", "arg"])).toBe("claude")
  })
})

describe("buildProxyEnv", () => {
  const ORIGINAL_ENV = { ...process.env }

  afterEach(() => {
    // Reset env after each test
    process.env = { ...ORIGINAL_ENV }
  })

  it("sets ANTHROPIC_BASE_URL to the given url", () => {
    const env = buildProxyEnv("http://localhost:4000")
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://localhost:4000")
  })

  it("sets ANTHROPIC_API_KEY from the current environment", () => {
    process.env["ANTHROPIC_API_KEY"] = "my-key"
    const env = buildProxyEnv("http://localhost:4000")
    expect(env["ANTHROPIC_API_KEY"]).toBe("my-key")
  })

  it("preserves other environment variables", () => {
    process.env["PATH"] = "/usr/bin"
    process.env["HOME"] = "/root"
    const env = buildProxyEnv("http://localhost:4000")
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/root")
  })
})

describe("ServeOptions interface", () => {
  it("accepts a valid ServeOptions shape", () => {
    const opts: ServeOptions = {
      cwd: "/tmp",
      config: {
        quality: { typecheck: "tsc", lint: "eslint", format: "prettier", testUnit: "vitest" },
        git: { defaultBranch: "main" },
        github: { owner: "acme", repo: "widgets" },
        agent: { model: "anthropic/claude-haiku-4-5-20251001" },
      },
      args: [],
    }
    expect(opts.cwd).toBe("/tmp")
    expect(opts.args).toEqual([])
  })
})
