import { beforeEach, describe, expect, it, vi } from "vitest"

interface Call {
  args: string[]
  env?: NodeJS.ProcessEnv
}

const calls: Call[] = []
type Behavior = { ok: true; stdout?: string } | { ok: false; stderr: string }
let behaviors: Behavior[] = []

function nextBehavior(): Behavior {
  return behaviors.shift() ?? { ok: true }
}

vi.mock("node:child_process", async (orig) => {
  const actual = (await orig()) as typeof import("node:child_process")
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: [cmd, ...args], env: options?.env })
      // Branch resolution always succeeds with a stable name unless overridden.
      if (args[0] === "symbolic-ref" && args[1] === "--short") {
        return "main\n"
      }
      const b = nextBehavior()
      if (b.ok) return b.stdout ?? ""
      const err: NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer } = new Error("git failed") as never
      err.stderr = Buffer.from(b.stderr)
      err.stdout = Buffer.from("")
      throw err
    }),
  }
})

beforeEach(() => {
  calls.length = 0
  behaviors = []
  delete process.env.GH_PAT
  delete process.env.KODY_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

const NON_FF_STDERR = "! [rejected]        main -> main (non-fast-forward)\nfetch first"

describe("pushWithRetry", () => {
  it("succeeds on first attempt without fetch/rebase", async () => {
    behaviors = [{ ok: true }]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    const result = pushWithRetry({ cwd: "/tmp/repo", branch: "main", backoffMs: 1 })

    expect(result).toEqual({ ok: true, attempts: 1 })
    const gitOps = calls.filter((c) => c.args[0] === "git").map((c) => c.args.slice(1).join(" "))
    // Exactly one push, no fetch, no rebase.
    expect(gitOps.filter((o) => o.startsWith("push"))).toHaveLength(1)
    expect(gitOps.filter((o) => o.startsWith("fetch"))).toHaveLength(0)
    expect(gitOps.filter((o) => o.startsWith("rebase"))).toHaveLength(0)
  })

  it("succeeds after N non-fast-forward rejections via fetch+rebase", async () => {
    // attempt 1: push rejected → fetch ok → rebase ok
    // attempt 2: push rejected → fetch ok → rebase ok
    // attempt 3: push ok
    behaviors = [
      { ok: false, stderr: NON_FF_STDERR },
      { ok: true }, // fetch
      { ok: true }, // rebase
      { ok: false, stderr: NON_FF_STDERR },
      { ok: true }, // fetch
      { ok: true }, // rebase
      { ok: true }, // push success
    ]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    const result = pushWithRetry({ cwd: "/tmp/repo", branch: "main", backoffMs: 1 })

    expect(result).toEqual({ ok: true, attempts: 3 })
    const gitOps = calls.filter((c) => c.args[0] === "git").map((c) => c.args.slice(1).join(" "))
    expect(gitOps.filter((o) => o.startsWith("push"))).toHaveLength(3)
    expect(gitOps.filter((o) => o.startsWith("fetch"))).toHaveLength(2)
    expect(gitOps.filter((o) => o.startsWith("rebase"))).toHaveLength(2)
    // Order: push, fetch, rebase, push, fetch, rebase, push
    const order = gitOps.filter((o) => /^(push|fetch|rebase)/.test(o)).map((o) => o.split(" ")[0])
    expect(order).toEqual(["push", "fetch", "rebase", "push", "fetch", "rebase", "push"])
  })

  it("aborts the rebase and fails loud on a real conflict", async () => {
    // attempt 1: push rejected → fetch ok → rebase fails (conflict)
    behaviors = [
      { ok: false, stderr: NON_FF_STDERR },
      { ok: true }, // fetch
      { ok: false, stderr: "CONFLICT (content): Merge conflict in src/foo.ts\nerror: could not apply abc1234" },
      { ok: true }, // rebase --abort
    ]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    const result = pushWithRetry({ cwd: "/tmp/repo", branch: "main", backoffMs: 1 })

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.reason).toMatch(/rebase onto origin\/main failed/)
      expect(result.reason).toMatch(/CONFLICT/)
      expect(result.attempts).toBe(1)
    }
    const gitOps = calls.filter((c) => c.args[0] === "git").map((c) => c.args.slice(1).join(" "))
    expect(gitOps).toContain("rebase --abort")
  })

  it("fails loud on non-rejection errors without retrying", async () => {
    // attempt 1: push fails with auth error — should NOT retry
    behaviors = [{ ok: false, stderr: "fatal: Authentication failed for 'https://github.com/foo/bar.git/'" }]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    const result = pushWithRetry({ cwd: "/tmp/repo", branch: "main", backoffMs: 1 })

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.reason).toMatch(/not retryable/i)
      expect(result.attempts).toBe(1)
    }
    const gitOps = calls.filter((c) => c.args[0] === "git").map((c) => c.args.slice(1).join(" "))
    expect(gitOps.filter((o) => o.startsWith("push"))).toHaveLength(1)
    expect(gitOps.filter((o) => o.startsWith("fetch"))).toHaveLength(0)
    expect(gitOps.filter((o) => o.startsWith("rebase"))).toHaveLength(0)
  })

  it("uses -u and HEAD:<branch> when setUpstream is true", async () => {
    behaviors = [{ ok: true }]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    pushWithRetry({ cwd: "/tmp/repo", branch: "feature/x", setUpstream: true, backoffMs: 1 })

    const pushCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "push")
    expect(pushCall?.args).toEqual(["git", "push", "-u", "origin", "HEAD:feature/x"])
  })

  it("overrides the checkout credential with Kody's explicit token without putting it in git arguments", async () => {
    process.env.GITHUB_TOKEN = "workflow-token"
    process.env.KODY_TOKEN = "configured-token"
    behaviors = [{ ok: true }]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    pushWithRetry({ cwd: "/tmp/repo", branch: "main", backoffMs: 1 })

    const pushCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "push")
    expect(pushCall?.args.join(" ")).not.toContain("configured-token")
    expect(pushCall?.env?.GIT_CONFIG_COUNT).toBe("2")
    expect(pushCall?.env?.GIT_CONFIG_VALUE_0).toBe("")
    expect(pushCall?.env?.GIT_CONFIG_VALUE_1).toMatch(/^Authorization: Basic /)
    expect(pushCall?.env?.GIT_CONFIG_VALUE_1).not.toContain("configured-token")
  })

  it("keeps checkout authentication unchanged when no explicit token exists", async () => {
    process.env.GITHUB_TOKEN = "workflow-token"
    process.env.GH_TOKEN = "workflow-token"
    behaviors = [{ ok: true }]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    pushWithRetry({ cwd: "/tmp/repo", branch: "main", backoffMs: 1 })

    const pushCall = calls.find((c) => c.args[0] === "git" && c.args[1] === "push")
    expect(pushCall?.env?.GIT_CONFIG_COUNT).toBeUndefined()
  })

  it("gives up after maxRetries persistent rejections", async () => {
    behaviors = [
      { ok: false, stderr: NON_FF_STDERR },
      { ok: true }, // fetch
      { ok: true }, // rebase
      { ok: false, stderr: NON_FF_STDERR },
      { ok: true }, // fetch
      { ok: true }, // rebase
      { ok: false, stderr: NON_FF_STDERR },
    ]
    const { pushWithRetry } = await import("../../src/pushWithRetry.js")

    const result = pushWithRetry({ cwd: "/tmp/repo", branch: "main", maxRetries: 3, backoffMs: 1 })

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.attempts).toBe(3)
      expect(result.reason).toMatch(/after 3 attempts/)
    }
  })
})
