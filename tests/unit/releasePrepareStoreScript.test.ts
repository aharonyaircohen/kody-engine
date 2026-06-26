import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const STORE_ROOT = process.env.KODY_STORE_PATH ?? path.resolve(process.cwd(), "..", "kody-store")
const RELEASE_PREPARE_SCRIPT = path.join(STORE_ROOT, ".kody", "executables", "release-prepare", "prepare.sh")

describe("kody-store release-prepare script", () => {
  it("uses GitHub auto-close syntax for release issue linkage", () => {
    if (!fs.existsSync(RELEASE_PREPARE_SCRIPT)) return

    const script = fs.readFileSync(RELEASE_PREPARE_SCRIPT, "utf8")

    expect(script).toContain("Closes #")
    expect(script).not.toContain("Tracking-Issue:")
  })
})
