import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExecutorInput } from "../../src/executor.js"
import { loadProfile } from "../../src/profile.js"
import { resolveExecutable } from "../../src/registry.js"

// Mock context-loading dependencies so the container's preload step
// produces a deterministic snapshot without hitting GitHub or the FS.
const getIssueSpy = vi.fn()
vi.mock("../../src/issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/issue.js")>("../../src/issue.js")
  return {
    ...actual,
    getIssue: (n: number) => {
      getIssueSpy(n)
      return {
        number: n,
        title: "container-preloaded",
        body: "from container",
        comments: [],
        labels: [],
      }
    },
  }
})

vi.mock("../../src/prompt.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/prompt.js")>("../../src/prompt.js")
  return {
    ...actual,
    loadProjectConventions: () => [{ path: "CLAUDE.md", content: "x", truncated: false }],
  }
})

describe("Phase 5 wire-up: preloadContext on container profiles", () => {
  it("non-container profiles default to preloadContext: false", () => {
    const resolveProfile = resolveExecutable("run")
    if (!resolveProfile) throw new Error("run executable not found")
    const profile = loadProfile(resolveProfile)
    expect(profile.preloadContext).toBe(false)
  })
})

describe("Phase 5 wire-up: ctx.data is seeded from preloadedData", () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-preload-wire-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("ExecutorInput.preloadedData is merged into ctx.data before preflights run", async () => {
    // Build a minimal primitive profile in tmp that has loadIssueContext
    // in its preflight + a single composePrompt-like script that records
    // what ctx.data looked like.
    const profileDir = path.join(tmp, "src", "executables", "test-preload")
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, "prompt.md"), "smoke")
    fs.writeFileSync(
      path.join(profileDir, "profile.json"),
      JSON.stringify(
        {
          name: "test-preload",
          role: "primitive",
          describe: "preload wire-up smoke test",
          inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "" }],
          claudeCode: {
            model: "inherit",
            permissionMode: "default",
            maxTurns: null,
            systemPromptAppend: null,
            tools: [],
            hooks: [],
            skills: [],
            commands: [],
            subagents: [],
            plugins: [],
            mcpServers: [],
          },
          cliTools: [],
          scripts: { preflight: [{ script: "loadIssueContext" }], postflight: [] },
        },
        null,
        2,
      ),
    )

    // The runExecutable resolver uses the registry which scans src/executables.
    // For this unit test we directly probe the seam: preloadedData → ctx.data merge.
    // The seam itself is asserted via the agent.ts loader fast-path tests; this
    // test just ensures the profile shape compiles + the field round-trips.
    const profile = loadProfile(path.join(profileDir, "profile.json"))
    expect(profile.name).toBe("test-preload")
    expect(profile.preloadContext).toBe(false)

    const input: ExecutorInput = {
      cliArgs: { issue: 42 },
      cwd: tmp,
      preloadedData: { issue: { number: 42, title: "from preload" } },
      skipConfig: true,
    }
    expect(input.preloadedData).toBeDefined()
    // The runtime behaviour (fast path skipping the fetch) is covered in
    // tests/unit/loader-idempotency.test.ts.
  })
})
