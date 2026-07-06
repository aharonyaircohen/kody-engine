const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")

const ASSET_DIRS = ["implementations", "capabilities", "jobs", "plugins"]

for (const name of ASSET_DIRS) {
  const src = path.join(ROOT, "src", name)
  const dst = path.join(ROOT, "dist", name)
  fs.rmSync(dst, { recursive: true, force: true })
  if (!fs.existsSync(src)) continue
  fs.cpSync(src, dst, { recursive: true })
  console.log(`copied ${name}/`)
}

// Bundled Dockerfile templates consumed at runtime by the
// preview-build scripted implementation. tsup bundles every TS file in
// src/ into the SAME `dist/bin/kody.js`, so import.meta.url lands in
// dist/bin/. The templates must sit next to that bundle for the
// runtime path lookup (path.join(__dirname, "preview-build-templates",
// "<file>")) to resolve.
const TEMPLATES_SRC = path.join(ROOT, "src", "scripts", "preview-build-templates")
const TEMPLATES_DST = path.join(ROOT, "dist", "bin", "preview-build-templates")
if (fs.existsSync(TEMPLATES_SRC)) {
  fs.rmSync(TEMPLATES_DST, { recursive: true, force: true })
  fs.cpSync(TEMPLATES_SRC, TEMPLATES_DST, { recursive: true })
  console.log("copied bin/preview-build-templates/")
}
