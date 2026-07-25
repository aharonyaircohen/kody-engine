import * as fs from "node:fs"
import * as path from "node:path"

export function definitionsRoot(cwd: string = process.cwd()): string {
  const override = process.env.KODY_DEFINITIONS_ROOT?.trim()
  const overrideCwd = process.env.KODY_DEFINITIONS_ROOT_CWD?.trim()
  if (override && overrideCwd && path.resolve(cwd) === path.resolve(overrideCwd)) {
    return storeCatalogRoot(path.resolve(override))
  }
  const hydrated = path.join(cwd, ".kody-engine", "definitions")
  if (fs.existsSync(hydrated)) return hydrated
  return override ? storeCatalogRoot(path.resolve(override)) : hydrated
}

export function hasExplicitDefinitionsRoot(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env.KODY_DEFINITIONS_ROOT?.trim()
  const rootCwd = env.KODY_DEFINITIONS_ROOT_CWD?.trim()
  return Boolean(root && rootCwd && path.resolve(cwd) === path.resolve(rootCwd))
}

export function capabilitiesRoot(cwd: string = process.cwd()): string {
  return storeAssetRoot(cwd, "capabilities") ?? path.join(definitionsRoot(cwd), "capabilities")
}

export function implementationsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "implementations")
}

export function agentsRoot(cwd: string = process.cwd()): string {
  return storeAssetRoot(cwd, "agent") ?? path.join(definitionsRoot(cwd), "agents")
}

function storeCatalogRoot(root: string): string {
  const manifest = readStoreManifest(root)
  const roots = ["capabilities", "workflows", "loops"]
    .map((kind) => manifest?.assetRoots?.[kind])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => path.dirname(value))
  return roots.length === 3 && new Set(roots).size === 1 ? path.join(root, roots[0]!) : root
}

function storeAssetRoot(cwd: string, kind: string): string | null {
  const override = process.env.KODY_DEFINITIONS_ROOT?.trim()
  if (!override) return null
  const overrideCwd = process.env.KODY_DEFINITIONS_ROOT_CWD?.trim()
  if (overrideCwd && path.resolve(cwd) !== path.resolve(overrideCwd)) return null
  const root = path.resolve(override)
  const configured = readStoreManifest(root)?.assetRoots?.[kind]
  return typeof configured === "string" && configured.trim() ? path.join(root, configured) : null
}

function readStoreManifest(root: string): { assetRoots?: Record<string, unknown> } | null {
  const file = path.join(root, "kody-store.json")
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { assetRoots?: Record<string, unknown> }
  } catch {
    return null
  }
}

export function goalsRoot(cwd: string = process.cwd()): string {
  return path.join(definitionsRoot(cwd), "goals")
}
