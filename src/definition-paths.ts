import * as fs from "node:fs"
import * as path from "node:path"

export function definitionsRoot(cwd: string = process.cwd()): string {
  const hydrated = path.join(cwd, ".kody-engine", "definitions")
  if (fs.existsSync(hydrated)) return hydrated
  const override = process.env.KODY_DEFINITIONS_ROOT?.trim()
  return override ? path.resolve(override) : hydrated
}

export function capabilitiesRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "capabilities")
}

export function agentsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "agents")
}

export function goalsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "goals")
}
