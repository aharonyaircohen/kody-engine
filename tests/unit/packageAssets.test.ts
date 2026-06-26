import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let tmp: string

describe("package asset copying", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-package-assets-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("removes legacy dist asset folders before copying current agent assets", () => {
    copyAssetScript(tmp)
    writeFile("src/executables/run/profile.json", "{}")
    writeFile("src/jobs/.keep", "")
    writeFile("src/capabilities/run/profile.json", "{}")
    writeFile("src/plugins/skills/probe/SKILL.md", "# Probe\n")
    writeFile("src/scripts/preview-build-templates/default-Dockerfile.preview.dev", "FROM node\n")
    writeFile("dist/agent-actions/stale/profile.json", "{}")
    writeFile("dist/agent-responsibilities/stale/profile.json", "{}")
    writeFile("dist/duties/stale/profile.json", "{}")
    writeFile("dist/executables/stale/profile.json", "{}")
    writeFile("dist/scripts/preview-build-templates/stale", "stale")

    execFileSync(process.execPath, [path.join(tmp, "scripts", "copy-assets.cjs")], {
      cwd: tmp,
      stdio: "pipe",
    })

    expect(fs.existsSync(path.join(tmp, "dist", "agent-actions"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dist", "agent-responsibilities"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dist", "duties"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dist", "executables", "stale"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dist", "scripts", "preview-build-templates"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dist", "executables", "run", "profile.json"))).toBe(true)
    expect(
      fs.existsSync(path.join(tmp, "dist", "bin", "preview-build-templates", "default-Dockerfile.preview.dev")),
    ).toBe(true)
  })
})

function copyAssetScript(root: string): void {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "copy-assets.cjs"), "utf8")
  writeFile("scripts/copy-assets.cjs", script, root)
}

function writeFile(file: string, content: string, root = tmp): void {
  const fullPath = path.join(root, file)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}
