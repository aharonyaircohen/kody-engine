import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const here = path.dirname(fileURLToPath(import.meta.url))

// Tests depend on company-store assets (capabilities, agents, executables)
// that ship from the sibling `kody-company-store` repo. CI clones that
// sibling to `../kody-store`; local dev checkouts do the same. Some
// environments (sandboxed runners, the kody-engine fix-ci agent) don't have
// the sibling repo but DO carry a previously fetched copy in the standard
// company-store cache (~/.cache/kody/company-store/<sha(repo#ref)>). Prefer
// the cached copy when present so tests can run without the sibling clone —
// fall back to the dev/CI sibling otherwise.
function resolveCompanyStorePath(): string {
  const sibling = path.resolve(here, "../kody-store")
  if (fs.existsSync(path.join(sibling, ".kody"))) return sibling
  const cacheDir = path.join(
    os.homedir(),
    ".cache",
    "kody",
    "company-store",
    crypto
      .createHash("sha256")
      .update("aharonyaircohen/kody-company-store#stable")
      .digest("hex")
      .slice(0, 24),
  )
  if (fs.existsSync(path.join(cacheDir, ".kody"))) return cacheDir
  return sibling
}

export default defineConfig({
  test: {
    testTimeout: 30_000,
    env: {
      KODY_COMPANY_STORE: resolveCompanyStorePath(),
      KODY_COMPANY_STORE_REF: "stable",
    },
    coverage: {
      provider: "v8",
      // json-summary feeds scripts/check-coverage-floor.ts (the posttest
      // 0%-cliff guard). vitest can't express "aggregate ratchet + per-file
      // floor" in one config — its glob thresholds only enforce per-file when
      // the GLOBAL `perFile` flag is on — so the per-file guard lives there.
      reporter: ["text", "text-summary", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/**/index.ts"],
      // Aggregate ratchet — set below the current measured baseline so coverage
      // can only go up. Raise these as gaps get filled; never lower them.
      // (Current: ~63/57/65/64. Per-file 0%-cliff is enforced separately.)
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 63,
        lines: 61,
      },
    },
  },
})
