import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 30_000,
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
