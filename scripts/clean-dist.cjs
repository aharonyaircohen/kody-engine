const fs = require("node:fs")
const path = require("node:path")

const ROOT = path.resolve(__dirname, "..")

fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true })
