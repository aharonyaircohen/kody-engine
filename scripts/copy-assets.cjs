const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")
const ASSET_DIRS = ["executables", "plugins"]

for (const name of ASSET_DIRS) {
  const src = path.join(ROOT, "src", name)
  const dst = path.join(ROOT, "dist", name)
  fs.rmSync(dst, { recursive: true, force: true })
  if (!fs.existsSync(src)) continue
  fs.cpSync(src, dst, { recursive: true })
  console.log(`copied ${name}/`)
}
