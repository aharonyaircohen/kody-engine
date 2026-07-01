import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { execFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}))

vi.mock("node:child_process", () => ({
  execFileSync,
}))

import { hydrateStateWorkspace, resetStateWorkspaceHydrationCacheForTests } from "../../src/stateWorkspace.js"

describe("hydrateStateWorkspace", () => {
  let cwd: string
  let cacheRoot: string
  const priorCache = process.env.KODY_STATE_REPO_CACHE

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-state-workspace-"))
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kody-state-cache-"))
    process.env.KODY_STATE_REPO_CACHE = cacheRoot
    process.env.KODY_STATE_WORKSPACE_FETCH_FOR_TESTS = "1"
    execFileSync.mockReset()
    resetStateWorkspaceHydrationCacheForTests()
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(cacheRoot, { recursive: true, force: true })
    if (priorCache === undefined) delete process.env.KODY_STATE_REPO_CACHE
    else process.env.KODY_STATE_REPO_CACHE = priorCache
    delete process.env.KODY_STATE_WORKSPACE_FETCH_FOR_TESTS
    resetStateWorkspaceHydrationCacheForTests()
  })

  it("overlays state capability folders without deleting unrelated repo capabilities", () => {
    const researchDir = path.join(cwd, ".kody", "capabilities", "research")
    const stateOwnedDir = path.join(cwd, ".kody", "capabilities", "dev-ci-health")
    fs.mkdirSync(researchDir, { recursive: true })
    fs.mkdirSync(stateOwnedDir, { recursive: true })
    fs.writeFileSync(path.join(researchDir, "profile.json"), '{"name":"research"}')
    fs.writeFileSync(path.join(researchDir, "install-codegraph.sh"), "#!/usr/bin/env bash\n")
    fs.writeFileSync(path.join(stateOwnedDir, "stale.txt"), "stale")

    mockStateRepoSnapshot("repo", (root) => {
      const capabilityDir = path.join(root, "capabilities", "dev-ci-health")
      fs.mkdirSync(capabilityDir, { recursive: true })
      fs.writeFileSync(path.join(capabilityDir, "profile.json"), '{"name":"dev-ci-health"}')
    })

    hydrateStateWorkspace({ state: { repo: "https://github.com/acme/state", path: "repo" } }, cwd)

    expect(fs.existsSync(path.join(researchDir, "install-codegraph.sh"))).toBe(true)
    expect(fs.readFileSync(path.join(stateOwnedDir, "profile.json"), "utf8")).toBe('{"name":"dev-ci-health"}')
    expect(fs.existsSync(path.join(stateOwnedDir, "stale.txt"))).toBe(false)
  })

  it("hydrates each state workspace only once per process", () => {
    mockStateRepoSnapshot("repo", (root) => {
      const capabilityDir = path.join(root, "capabilities", "review")
      fs.mkdirSync(capabilityDir, { recursive: true })
      fs.writeFileSync(path.join(capabilityDir, "profile.json"), '{"name":"review"}')
      fs.writeFileSync(path.join(capabilityDir, "capability.md"), "review")
    })

    const config = { state: { repo: "https://github.com/acme/state", path: "repo" } }
    hydrateStateWorkspace(config, cwd)
    const callsAfterFirstHydrate = execFileSync.mock.calls.length

    hydrateStateWorkspace(config, cwd)

    expect(execFileSync).toHaveBeenCalled()
    expect(execFileSync.mock.calls.length).toBe(callsAfterFirstHydrate)
    expect(fs.readFileSync(path.join(cwd, ".kody", "capabilities", "review", "capability.md"), "utf8")).toBe("review")
  })

  function mockStateRepoSnapshot(basePath: string, writeSnapshot: (root: string) => void): void {
    let cacheDir = ""
    execFileSync.mockImplementation((_cmd: string, rawArgs: string[]) => {
      const args = rawArgs[0] === "-c" ? rawArgs.slice(2) : rawArgs
      if (args[0] === "clone") {
        cacheDir = args[args.length - 1]!
        fs.mkdirSync(path.join(cacheDir, ".git"), { recursive: true })
        return ""
      }
      if (args.includes("checkout")) {
        if (!cacheDir) {
          const cIdx = args.indexOf("-C")
          cacheDir = cIdx >= 0 ? args[cIdx + 1]! : cacheDir
        }
        const root = path.join(cacheDir, basePath)
        fs.rmSync(root, { recursive: true, force: true })
        fs.mkdirSync(root, { recursive: true })
        writeSnapshot(root)
      }
      return ""
    })
  }
})
