/**
 * Routing test for `dispatchDutyFileTicks`.
 *
 * Pins the rule that motivated the deterministic-tick path: duties that
 * declare `tickScript:` in frontmatter run via `duty-tick-scripted`
 * (no agent), everything else uses the configured target. Earlier the
 * dispatcher always invoked the LLM-driven `duty-tick`, which silently
 * dropped state when the model didn't echo the script's stdout.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { dispatchDutyFileTicks } from "../../src/scripts/dispatchDutyFileTicks.js"

vi.mock("../../src/executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/executor.js")>("../../src/executor.js")
  return { ...actual, runExecutable: vi.fn(async () => ({ exitCode: 0 })) }
})

import { runExecutable } from "../../src/executor.js"

const runExecutableMock = runExecutable as unknown as Mock

let tmp: string

beforeEach(() => {
  runExecutableMock.mockReset()
  runExecutableMock.mockResolvedValue({ exitCode: 0 })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-routing-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.clearAllMocks()
})

function writeJob(slug: string, frontmatter: string, body = "# job\n"): void {
  const fm = frontmatter ? `---\n${frontmatter}\n---\n` : ""
  fs.writeFileSync(path.join(tmp, ".kody", "duties", `${slug}.md`), fm + body)
}

function ctxFor(): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return {
    args: {},
    cwd: tmp,
    config,
    data: {},
    output: { exitCode: 0 },
  }
}

const PROFILE = {} as unknown as Profile

describe("dispatchDutyFileTicks routing", () => {
  it("routes a duty with `tickScript:` to duty-tick-scripted", async () => {
    writeJob("auto-resolve", "tickScript: .kody/scripts/auto-resolve-tick.sh\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("duty-tick-scripted")
  })

  it("routes a duty without `tickScript:` to the configured (default) target", async () => {
    writeJob("watch-stale-prs", "every: 6h\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).toHaveBeenCalledTimes(1)
    expect(runExecutableMock.mock.calls[0]![0]).toBe("duty-tick")
  })

  it("skips a duty with no `staff:` (every duty must name an executor)", async () => {
    writeJob("orphan-duty", "every: 1h")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    expect(runExecutableMock).not.toHaveBeenCalled()
  })

  it("mixes routing across slugs in one tick", async () => {
    writeJob("scripted-duty", "tickScript: .kody/scripts/x.sh\nstaff: kody")
    writeJob("agent-duty", "every: 1h\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const targets = runExecutableMock.mock.calls.map((call) => call[0])
    expect(targets).toContain("duty-tick-scripted")
    expect(targets).toContain("duty-tick")
  })

  it("deduplicates a slug present as both a folder-duty and a .md (folder wins, no double-fire)", async () => {
    // Folder-duty: scheduled, fires one-shot as itself.
    const folder = path.join(tmp, ".kody", "duties", "hybrid")
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(
      path.join(folder, "profile.json"),
      JSON.stringify({
        name: "hybrid",
        role: "primitive",
        describe: "hybrid",
        staff: "kody",
        every: "1h",
        inputs: [],
        claudeCode: {
          model: "inherit",
          permissionMode: "acceptEdits",
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
        scripts: { preflight: [{ script: "composePrompt" }], postflight: [] },
      }),
    )
    // Same slug also present as a legacy .md — must NOT also tick.
    writeJob("hybrid", "every: 1h\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const calls = runExecutableMock.mock.calls
    // Folder-duty fired one-shot as itself…
    expect(calls.some((c) => c[0] === "hybrid")).toBe(true)
    // …and the .md tick was skipped (no duty-tick run for the same slug).
    expect(calls.some((c) => c[0] === "duty-tick")).toBe(false)
  })
})

describe("dispatchDutyFileTicks: markdown shadowed by folder-duty (deprecation nudge)", () => {
  let stdoutSpy: MockInstance<(chunk: string | Uint8Array) => boolean>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  function writeFolderDuty(slug: string, profile: Record<string, unknown>): void {
    const folder = path.join(tmp, ".kody", "duties", slug)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, "profile.json"), JSON.stringify(profile))
    fs.writeFileSync(path.join(folder, "prompt.md"), "# stub\n")
  }

  function folderProfile(slug: string, every = "1h"): Record<string, unknown> {
    return {
      name: slug,
      role: "primitive",
      describe: slug,
      staff: "kody",
      every,
      inputs: [],
      claudeCode: {
        model: "inherit",
        permissionMode: "acceptEdits",
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
      scripts: { preflight: [{ script: "composePrompt" }], postflight: [] },
    }
  }

  it("emits a one-time deprecation nudge per shadowed slug per tick", async () => {
    writeFolderDuty("hybrid", folderProfile("hybrid", "24h"))
    writeJob("hybrid", "every: 1h\nstaff: kody")
    // second collision: also a shadowed slug, in the same tick
    writeFolderDuty("dual", folderProfile("dual", "24h"))
    writeJob("dual", "every: 1h\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const all = stdoutSpy.mock.calls.map((c) => String(c[0])).join("")
    expect(all).toMatch(
      /\[duties\] markdown duty 'hybrid' is shadowed by folder duty; migrate or remove/,
    )
    expect(all).toMatch(
      /\[duties\] markdown duty 'dual' is shadowed by folder duty; migrate or remove/,
    )
    // Each shadowed slug is visited once per tick → one nudge per slug.
    const hybridHits = all.match(/markdown duty 'hybrid' is shadowed/g) ?? []
    const dualHits = all.match(/markdown duty 'dual' is shadowed/g) ?? []
    expect(hybridHits).toHaveLength(1)
    expect(dualHits).toHaveLength(1)
  })

  it("does NOT nudge when a slug exists only as a .md (no shadow)", async () => {
    writeJob("solo-md", "every: 1h\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const all = stdoutSpy.mock.calls.map((c) => String(c[0])).join("")
    expect(all).not.toMatch(/is shadowed by folder duty/)
  })

  it("logs under [duties] (not [jobs]) for the deprecation nudge", async () => {
    writeFolderDuty("hybrid", folderProfile("hybrid", "24h"))
    writeJob("hybrid", "every: 1h\nstaff: kody")

    const ctx = ctxFor()
    await dispatchDutyFileTicks(ctx, PROFILE, {
      jobsDir: ".kody/duties",
      targetExecutable: "duty-tick",
      slugArg: "duty",
    })

    const all = stdoutSpy.mock.calls.map((c) => String(c[0])).join("")
    expect(all).toMatch(/\[duties\]/)
    expect(all).not.toMatch(/\[jobs\]/)
  })
})
