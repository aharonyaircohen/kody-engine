import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { hydrateStateWorkspace, resetStateWorkspaceHydrationCacheForTests } from "../../src/stateWorkspace.js"

const config: KodyConfig = {
  quality: { typecheck: "", lint: "", format: "", testUnit: "" },
  git: { defaultBranch: "main" },
  github: { owner: "acme", repo: "widgets" },
  agent: { model: "test" },
}

describe("hydrateStateWorkspace", () => {
  let cwd: string
  const previous = { ...process.env }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-runtime-workspace-"))
    process.env.CONVEX_URL = "https://example.convex.cloud"
    process.env.KODY_SERVICE_KEY = "test-key"
    resetStateWorkspaceHydrationCacheForTests()
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    process.env = { ...previous }
    resetStateWorkspaceHydrationCacheForTests()
  })

  it("hydrates backend prompt documents into engine-owned runtime scratch", async () => {
    const backend = {
      listRepoDocs: vi.fn(async (_tenant: string, prefix: string) =>
        prefix === "context:"
          ? [
              {
                kind: "context:mission",
                doc: { body: "Build reliable software.\n" },
                updatedAt: "t",
              },
            ]
          : [
              {
                kind: "memory:plain",
                doc: {
                  meta: {
                    name: "Plain",
                    description: "Use plain language",
                    type: "preference",
                  },
                  body: "Keep it simple.\n",
                },
                updatedAt: "t",
              },
            ],
      ),
      getRepoDoc: vi.fn(async (_tenant: string, kind: string) =>
        kind === "instructions" ? { kind, doc: { body: "Be concise.\n" }, updatedAt: "t" } : null,
      ),
      listWorkflows: vi.fn(async () => []),
    }

    await hydrateStateWorkspace(config, cwd, backend as never)

    const root = path.join(cwd, ".kody-engine", "runtime")
    expect(fs.readFileSync(path.join(root, "context/mission.md"), "utf8")).toBe("Build reliable software.\n")
    expect(fs.readFileSync(path.join(root, "memory/INDEX.md"), "utf8")).toContain("[Plain](plain.md)")
    expect(fs.readFileSync(path.join(root, "instructions.md"), "utf8")).toBe("Be concise.\n")
    expect(fs.existsSync(path.join(cwd, ".kody"))).toBe(false)
  })

  it("hydrates each tenant workspace only once per process", async () => {
    const backend = {
      listRepoDocs: vi.fn(async () => []),
      getRepoDoc: vi.fn(async () => null),
      listWorkflows: vi.fn(async () => []),
    }

    await hydrateStateWorkspace(config, cwd, backend as never)
    const calls = backend.getRepoDoc.mock.calls.length
    await hydrateStateWorkspace(config, cwd, backend as never)

    expect(backend.getRepoDoc.mock.calls.length).toBe(calls)
  })
})
