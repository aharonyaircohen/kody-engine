/**
 * Preflight: load `.kody/qa-guide.md` from the project root, if present.
 *
 * The QA guide is a committed file in the consumer repo that holds:
 *   - test-account credentials (email / password)
 *   - login steps
 *   - any other hand-written notes for the UI-review agent
 *
 * Populates:
 *   ctx.data.qaGuide     — raw markdown string ("" if absent)
 *   ctx.data.qaGuidePath — relative path if loaded, "" otherwise
 *
 * This script never errors — missing file is a valid state.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"

export const QA_GUIDE_REL_PATH = ".kody/qa-guide.md"

export const loadQaGuide: PreflightScript = async (ctx) => {
  const full = path.join(ctx.cwd, QA_GUIDE_REL_PATH)
  if (!fs.existsSync(full)) {
    ctx.data.qaGuide = ""
    ctx.data.qaGuidePath = ""
    return
  }
  try {
    ctx.data.qaGuide = fs.readFileSync(full, "utf-8")
    ctx.data.qaGuidePath = QA_GUIDE_REL_PATH
  } catch {
    ctx.data.qaGuide = ""
    ctx.data.qaGuidePath = ""
  }
}
