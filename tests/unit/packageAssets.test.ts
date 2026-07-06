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

  it("removes existing dist output before build", () => {
    copyScript("clean-dist.cjs", tmp)
    writeFile("dist/obsolete-output/stale/profile.json", "{}")
    writeFile("dist/implementations/stale/profile.json", "{}")

    execFileSync(process.execPath, [path.join(tmp, "scripts", "clean-dist.cjs")], {
      cwd: tmp,
      stdio: "pipe",
    })

    expect(fs.existsSync(path.join(tmp, "dist"))).toBe(false)
  })

  it("copies current package assets", () => {
    copyScript("copy-assets.cjs", tmp)
    writeFile("src/implementations/run/profile.json", "{}")
    writeFile("src/jobs/.keep", "")
    writeFile("src/capabilities/run/profile.json", "{}")
    writeFile("src/plugins/skills/probe/SKILL.md", "# Probe\n")
    writeFile("src/scripts/preview-build-templates/default-Dockerfile.preview.dev", "FROM node\n")
    writeFile("dist/implementations/stale/profile.json", "{}")

    execFileSync(process.execPath, [path.join(tmp, "scripts", "copy-assets.cjs")], {
      cwd: tmp,
      stdio: "pipe",
    })

    expect(fs.existsSync(path.join(tmp, "dist", "implementations", "stale"))).toBe(false)
    expect(fs.existsSync(path.join(tmp, "dist", "implementations", "run", "profile.json"))).toBe(true)
    expect(
      fs.existsSync(path.join(tmp, "dist", "bin", "preview-build-templates", "default-Dockerfile.preview.dev")),
    ).toBe(true)
  })
})

function copyScript(name: string, root: string): void {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", name), "utf8")
  writeFile(path.join("scripts", name), script, root)
}

function writeFile(file: string, content: string, root = tmp): void {
  const fullPath = path.join(root, file)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}
