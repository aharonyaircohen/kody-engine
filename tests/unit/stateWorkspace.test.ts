import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { listStateDirectory, readStateText } = vi.hoisted(() => ({
  listStateDirectory: vi.fn(),
  readStateText: vi.fn(),
}))

vi.mock("../../src/stateRepo.js", () => ({
  listStateDirectory,
  readStateText,
}))

import { hydrateStateWorkspace } from "../../src/stateWorkspace.js"

describe("hydrateStateWorkspace", () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-state-workspace-"))
    listStateDirectory.mockReset()
    readStateText.mockReset()
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("overlays state capability folders without deleting unrelated repo capabilities", () => {
    const researchDir = path.join(cwd, ".kody", "capabilities", "research")
    const stateOwnedDir = path.join(cwd, ".kody", "capabilities", "dev-ci-health")
    fs.mkdirSync(researchDir, { recursive: true })
    fs.mkdirSync(stateOwnedDir, { recursive: true })
    fs.writeFileSync(path.join(researchDir, "profile.json"), '{"name":"research"}')
    fs.writeFileSync(path.join(researchDir, "install-codegraph.sh"), "#!/usr/bin/env bash\n")
    fs.writeFileSync(path.join(stateOwnedDir, "stale.txt"), "stale")

    listStateDirectory.mockImplementation((_config, _cwd, dirPath: string) => {
      if (dirPath === "capabilities") return [{ name: "dev-ci-health", type: "dir" }]
      if (dirPath === "capabilities/dev-ci-health") return [{ name: "profile.json", type: "file" }]
      return []
    })
    readStateText.mockImplementation((_config, _cwd, filePath: string) => {
      if (filePath === "capabilities/dev-ci-health/profile.json") {
        return { path: filePath, sha: "sha", content: '{"name":"dev-ci-health"}' }
      }
      return null
    })

    hydrateStateWorkspace({ state: { repo: "https://github.com/acme/state", path: "repo" } }, cwd)

    expect(fs.existsSync(path.join(researchDir, "install-codegraph.sh"))).toBe(true)
    expect(fs.readFileSync(path.join(stateOwnedDir, "profile.json"), "utf8")).toBe('{"name":"dev-ci-health"}')
    expect(fs.existsSync(path.join(stateOwnedDir, "stale.txt"))).toBe(false)
  })
})
