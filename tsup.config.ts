import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["bin/kody.ts"],
  format: ["esm"],
  outDir: "dist/bin",
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  bundle: true,
  platform: "node",
  target: "node22",
  banner: {
    js: "#!/usr/bin/env node",
  },
})
