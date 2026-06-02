import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetRunIdCache } from "../../src/events.js"
import { loadProfile } from "../../src/profile.js"

function writeProfile(dir: string, body: Record<string, unknown>): string {
  const subdir = path.join(dir, "test-exec")
  fs.mkdirSync(subdir, { recursive: true })
  const profilePath = path.join(subdir, "profile.json")
  fs.writeFileSync(profilePath, JSON.stringify(body, null, 2))
  fs.writeFileSync(path.join(subdir, "prompt.md"), "test")
  return profilePath
}

const validProfile = {
  name: "test-exec",
  role: "primitive",
  describe: "test",
  inputs: [],
  claudeCode: {
    model: "inherit",
    permissionMode: "default",
    maxTurns: null,
    systemPromptAppend: null,
    tools: ["Read"],
    hooks: [],
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    mcpServers: [],
  },
  cliTools: [],
  scripts: { preflight: [], postflight: [] },
}

describe("Phase 4e: container resetBetweenChildren", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-phase4-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("defaults to true when the field is absent", () => {
    const file = writeProfile(tmp, {
      ...validProfile,
      role: "container",
      children: [{ exec: "noop", target: "issue", next: { "*": "done" } }],
    })
    const profile = loadProfile(file)
    expect(profile.resetBetweenChildren).toBe(true)
  })

  it("honours explicit false", () => {
    const file = writeProfile(tmp, {
      ...validProfile,
      role: "container",
      resetBetweenChildren: false,
      children: [{ exec: "noop", target: "issue", next: { "*": "done" } }],
    })
    const profile = loadProfile(file)
    expect(profile.resetBetweenChildren).toBe(false)
  })

  it("honours explicit true", () => {
    const file = writeProfile(tmp, {
      ...validProfile,
      role: "container",
      resetBetweenChildren: true,
      children: [{ exec: "noop", target: "issue", next: { "*": "done" } }],
    })
    const profile = loadProfile(file)
    expect(profile.resetBetweenChildren).toBe(true)
  })
})

describe("Phase 4g: profile unknown-key warning", () => {
  let tmp: string
  let stderrSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-phase4g-"))
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    stderrSpy.mockRestore()
  })

  it("is silent for an all-valid profile", () => {
    const file = writeProfile(tmp, validProfile)
    loadProfile(file)
    const warnings = stderrSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("unknown top-level keys"))
    expect(warnings).toEqual([])
  })

  it("warns on stderr when a top-level key is unrecognised", () => {
    const file = writeProfile(tmp, {
      ...validProfile,
      mcpServer: "typo-singular-instead-of-mcpServers",
    } as Record<string, unknown>)
    loadProfile(file)
    const warnings = stderrSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes("unknown top-level keys"))
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain("mcpServer")
  })

  it("does not throw — unknown keys remain non-fatal", () => {
    const file = writeProfile(tmp, {
      ...validProfile,
      experimental_field: 42,
    } as Record<string, unknown>)
    expect(() => loadProfile(file)).not.toThrow()
  })
})

describe("Phase 4f: commitAndPush idempotency", () => {
  let tmp: string
  beforeEach(() => {
    __resetRunIdCache()
    process.env.KODY_RUN_ID = "phase4f-run"
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-phase4f-"))
  })
  afterEach(() => {
    delete process.env.KODY_RUN_ID
    __resetRunIdCache()
    fs.rmSync(tmp, { recursive: true, force: true })
    delete process.env.KODY_COMMIT_IDEMPOTENCY
  })

  it("replays from sentinel on second call within the same run", async () => {
    // Pre-seed a sentinel as if a prior commitAndPush invocation wrote it.
    const sentinelDir = path.join(tmp, ".kody", "runs", "phase4f-run")
    fs.mkdirSync(sentinelDir, { recursive: true })
    fs.writeFileSync(
      path.join(sentinelDir, "commit-test-exec.lock"),
      JSON.stringify({
        commitResult: { committed: true, pushed: true, sha: "deadbeef" },
        changedFiles: ["src/foo.ts"],
        hasCommitsAhead: true,
        salvagedFromMissingMarker: false,
        writtenAt: "2026-05-11T00:00:00.000Z",
      }),
    )

    // Import the script and execute with a faked ctx; the sentinel branch
    // must be taken before doCommitAndPush is invoked.
    const { commitAndPush } = await import("../../src/scripts/commitAndPush.js")
    const ctx = {
      args: {},
      cwd: tmp,
      config: {
        quality: { typecheck: "", lint: "", testUnit: "", format: "" },
        git: { defaultBranch: "main" },
        github: { owner: "x", repo: "y" },
        agent: { model: "claude/claude-sonnet-4-6" },
      },
      data: { branch: "feature-branch" } as Record<string, unknown>,
      output: { exitCode: 0 } as { exitCode: number; prUrl?: string; reason?: string },
    }
    const profile = { name: "test-exec" } as Parameters<typeof commitAndPush>[1]
    await commitAndPush(ctx, profile, null)
    expect(ctx.data.commitIdempotencyReplay).toBe(true)
    expect(ctx.data.commitResult).toEqual({ committed: true, pushed: true, sha: "deadbeef" })
    expect(ctx.data.changedFiles).toEqual(["src/foo.ts"])
  })

  it("env override KODY_COMMIT_IDEMPOTENCY=0 disables the sentinel replay", async () => {
    process.env.KODY_COMMIT_IDEMPOTENCY = "0"
    const sentinelDir = path.join(tmp, ".kody", "runs", "phase4f-run")
    fs.mkdirSync(sentinelDir, { recursive: true })
    fs.writeFileSync(
      path.join(sentinelDir, "commit-test-exec.lock"),
      JSON.stringify({ commitResult: { committed: true, pushed: true } }),
    )

    const { commitAndPush } = await import("../../src/scripts/commitAndPush.js")
    const ctx = {
      args: {},
      cwd: tmp,
      config: {
        quality: { typecheck: "", lint: "", testUnit: "", format: "" },
        git: { defaultBranch: "main" },
        github: { owner: "x", repo: "y" },
        agent: { model: "claude/claude-sonnet-4-6" },
      },
      data: { branch: "feature-branch", agentDone: false } as Record<string, unknown>,
      output: { exitCode: 0 } as { exitCode: number; prUrl?: string; reason?: string },
    }
    const profile = { name: "test-exec" } as Parameters<typeof commitAndPush>[1]
    await commitAndPush(ctx, profile, null)
    expect(ctx.data.commitIdempotencyReplay).toBeUndefined()
  })
})
