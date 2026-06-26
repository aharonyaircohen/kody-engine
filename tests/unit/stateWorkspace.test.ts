/**
 * stateWorkspace.hydrateStateWorkspace — best-effort state hydration.
 *
 * Hydration pulls consumer-side runtime files from the configured state repo
 * into a local `.kody` cache. Failures (no GH_TOKEN, 404, network blip) must
 * NOT take down the executable — without the cache the consumer repo's own
 * `.kody/` files still resolve. Verifies the function swallows gh errors and
 * still leaves consumer-authored files in place.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hydrateStateWorkspace } from "../../src/stateWorkspace.js"

describe("hydrateStateWorkspace", () => {
  const originalEnv = { ...process.env }
  let stderrWrites: string[] = []
  let originalWrite: typeof process.stderr.write

  beforeEach(() => {
    // Reproduce the CI shape where gh refuses without GH_TOKEN in a GitHub
    // Actions environment. Without this, gh returns 404 and the failure
    // path is never exercised.
    process.env.GITHUB_ACTIONS = "true"
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN

    stderrWrites = []
    originalWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"))
      return true
    }
  })

  afterEach(() => {
    ;(process.stderr.write as unknown) = originalWrite
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  })

  it("swallows gh api failures and leaves the cwd's existing files in place", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-hydrate-"))
    const capabilityDir = path.join(root, ".kody", "capabilities", "smoke")
    fs.mkdirSync(capabilityDir, { recursive: true })
    const marker = path.join(capabilityDir, "profile.json")
    fs.writeFileSync(marker, '{"name":"smoke","action":"smoke","executable":"smoke"}')

    // owner="o", repo="r" → stateRepo resolves to o/kody-state. In the CI
    // shape above gh exits non-zero (no GH_TOKEN), so listStateDirectory
    // throws. hydrate must catch, log, and continue — not take down the run.
    expect(() =>
      hydrateStateWorkspace(
        {
          state: { repo: "https://github.com/o/kody-state", path: "r" },
          github: { owner: "o", repo: "r" },
        },
        root,
      ),
    ).not.toThrow()

    // Consumer-authored file is untouched (hydrate failed before any wipe).
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.readFileSync(marker, "utf-8")).toBe('{"name":"smoke","action":"smoke","executable":"smoke"}')
    // We log once per failed directory/file so operators see why hydration is off.
    expect(stderrWrites.join("")).toMatch(/state hydration skipped/)
  })
})
