import { main } from "../src/entry.js"

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((err) => {
    process.stderr.write(`[kody] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(99)
  })
