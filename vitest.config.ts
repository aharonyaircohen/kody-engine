import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 30_000,
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
