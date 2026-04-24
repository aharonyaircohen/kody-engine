/**
 * Preflight diagnostic: logs Playwright browser cache status so we can see
 * from CI logs whether Chromium is available before the agent session starts.
 *
 * This does not fail the run — it's purely informational. The @playwright/mcp
 * server only exposes navigation tools once a Chromium binary is resolvable;
 * without this log, a missing browser silently manifests as "agent has no
 * mcp__playwright__* tools in its tool list."
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"

export const diagMcp: PreflightScript = async (_ctx) => {
  const home = os.homedir()
  const cacheDir = path.join(home, ".cache", "ms-playwright")

  let entries: string[] = []
  try {
    entries = fs.readdirSync(cacheDir)
  } catch {
    /* cache dir absent */
  }
  const hasChromium = entries.some((e) => e.startsWith("chromium"))

  process.stderr.write(
    `[kody diag] ms-playwright cache: ${
      entries.length === 0 ? "EMPTY (or missing)" : entries.join(", ")
    }\n`,
  )
  process.stderr.write(`[kody diag] chromium present: ${hasChromium ? "yes" : "no"}\n`)

  try {
    const v = execFileSync("npx", ["-y", "@playwright/mcp@latest", "--version"], {
      stdio: "pipe",
      timeout: 60_000,
      encoding: "utf8",
    }).trim()
    process.stderr.write(`[kody diag] @playwright/mcp version: ${v}\n`)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    process.stderr.write(`[kody diag] @playwright/mcp spawn FAILED: ${err}\n`)
  }
}
