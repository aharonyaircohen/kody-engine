import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // TEMP DIAGNOSTIC: --prof on the fork worker (where the CI-only CPU loop /
    // ReDoS spins). --prof is banned in NODE_OPTIONS but allowed via execArgv,
    // which vitest forwards to the worker fork. Revert once root-caused.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--prof"] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/**/index.ts"],
      // Ratchet floor — set at the current measured baseline so coverage can
      // only go up. Raise these as gaps get filled; never lower them.
      thresholds: {
        statements: 58,
        branches: 53,
        functions: 60,
        lines: 59,
      },
    },
  },
})
