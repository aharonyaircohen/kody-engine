import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

export const KODY_WORKFLOW_TEMPLATE_PATH = "templates/kody.yml"

export function loadKodyWorkflowTemplate(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, "../templates/kody.yml"), path.resolve(here, "../../templates/kody.yml")]
  const source = candidates.find((candidate) => fs.existsSync(candidate))
  if (!source) throw new Error(`Kody workflow template is missing: ${KODY_WORKFLOW_TEMPLATE_PATH}`)
  return fs.readFileSync(source, "utf8")
}
