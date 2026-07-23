import * as fs from "node:fs"
import * as path from "node:path"

export function definitionsRoot(cwd: string = process.cwd()): string {
  const override = process.env.KODY_DEFINITIONS_ROOT?.trim()
  const overrideCwd = process.env.KODY_DEFINITIONS_ROOT_CWD?.trim()
  if (override && overrideCwd && path.resolve(cwd) === path.resolve(overrideCwd)) {
    return path.resolve(override)
  }
  const hydrated = path.join(cwd, ".kody-engine", "definitions")
  if (fs.existsSync(hydrated)) return hydrated
  return override ? path.resolve(override) : hydrated
}

export function hasExplicitDefinitionsRoot(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env.KODY_DEFINITIONS_ROOT?.trim()
  const rootCwd = env.KODY_DEFINITIONS_ROOT_CWD?.trim()
  return Boolean(root && rootCwd && path.resolve(cwd) === path.resolve(rootCwd))
}

export function capabilitiesRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "capabilities")
}

export function implementationsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "implementations")
}

export function agentsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "agents")
}

export function goalsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "goals")
}
