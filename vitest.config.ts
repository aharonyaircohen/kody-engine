import crypto from "node:crypto"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const here = path.dirname(fileURLToPath(import.meta.url))

const WORKING_STORE_ROOT = path.resolve(here, "../kody-store")
// CI clones the real company store at ../kody-store (workflow step `Checkout
// company store for tests`). Local sandbox runs without that clone hit a
// stub-only working tree (empty capability.md, missing kody-chat executable).
// When the working tree is the stub, fall back to the engine's github cache
// (sha256(repo#ref).slice(0,24)) so the published content is reachable.
const STORE_REPO = "aharonyaircohen/kody-company-store"
const STORE_REF = "stable"
const STORE_CACHE_KEY = crypto.createHash("sha256").update(`${STORE_REPO}#${STORE_REF}`).digest("hex").slice(0, 24)
const CACHED_STORE_ROOT = path.join(os.homedir(), ".cache", "kody", "company-store", STORE_CACHE_KEY)
const STORE_ROOT = fs.existsSync(path.join(WORKING_STORE_ROOT, ".git")) ? WORKING_STORE_ROOT : CACHED_STORE_ROOT

export default defineConfig({
  test: {
    testTimeout: 30_000,
    env: {
      KODY_COMPANY_STORE: STORE_ROOT,
      KODY_STORE_PATH: STORE_ROOT,
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
