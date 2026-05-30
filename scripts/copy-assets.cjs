const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")
const ASSET_DIRS = ["executables", "jobs", "plugins"]

for (const name of ASSET_DIRS) {
  const src = path.join(ROOT, "src", name)
  const dst = path.join(ROOT, "dist", name)
  fs.rmSync(dst, { recursive: true, force: true })
  if (!fs.existsSync(src)) continue
  fs.cpSync(src, dst, { recursive: true })
  console.log(`copied ${name}/`)
}

// Bundled Dockerfile templates consumed at runtime by the
// preview-build scripted executable (looked up via import.meta.url
// → ./preview-build-templates/<file> from dist/scripts/).
const TEMPLATES_SRC = path.join(ROOT, "src", "scripts", "preview-build-templates")
const TEMPLATES_DST = path.join(ROOT, "dist", "scripts", "preview-build-templates")
if (fs.existsSync(TEMPLATES_SRC)) {
  fs.rmSync(TEMPLATES_DST, { recursive: true, force: true })
  fs.cpSync(TEMPLATES_SRC, TEMPLATES_DST, { recursive: true })
  console.log("copied scripts/preview-build-templates/")
}
