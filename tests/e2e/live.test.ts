/**
 * E2E (live): genuinely end-to-end runs against a real GitHub repo and a
 * real model. These mutate external state (branches, PRs, comments), so they
 * are SKIPPED by default and never run in CI.
 *
 * To run locally:
 *   KODY_E2E_LIVE=1 \
 *   KODY_E2E_REPO=aharonyaircohen/Kody-Engine-Tester \
 *   KODY_E2E_ISSUE=<n> \
 *   GH_TOKEN=… ANTHROPIC_API_KEY=… \
 *   pnpm test:e2e
 *
 * Note: CLI-boot / argument-validation checks are NOT here — those moved to
 * the offline smoke tier (tests/smoke/cli.test.ts). This tier is reserved for
 * checks that need the real outside world.
 */

import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const LIVE = process.env.KODY_E2E_LIVE === "1"
const REPO_ROOT = process.cwd()

describe.skipIf(!LIVE)("e2e (live): real flow against a configured repo", () => {
  it("dispatches `run` end to end and returns a known exit code", () => {
    const issue = process.env.KODY_E2E_ISSUE
    if (!issue) throw new Error("KODY_E2E_ISSUE is required when KODY_E2E_LIVE=1")

    const tsx = path.join(REPO_ROOT, "node_modules", ".bin", "tsx")
    const entry = path.join(REPO_ROOT, "bin", "kody.ts")

    let status = 0
    try {
      execFileSync(tsx, [entry, "run", "--issue", issue], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 600_000,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      status = (err as { status?: number }).status ?? 1
    }

    // Any of the engine's documented exit codes is an acceptable real outcome;
    // a crash (99) or invalid-args (64) is not.
    expect([0, 1, 2, 3, 4]).toContain(status)
  })
})
