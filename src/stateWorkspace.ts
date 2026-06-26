/**
 * Hydrate Kody-authored runtime assets from the configured state repo into a
 * temporary local `.kody` cache for existing file-based engine loaders.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { listStateDirectory, readStateText, type StateRepoConfig } from "./stateRepo.js"

const DIR_MAPPINGS: Array<{ stateDir: string; localDir: string }> = [
  { stateDir: "executables", localDir: path.join(".kody", "executables") },
  { stateDir: "capabilities", localDir: path.join(".kody", "capabilities") },
  { stateDir: "agents", localDir: path.join(".kody", "agents") },
  { stateDir: "context", localDir: path.join(".kody", "context") },
  { stateDir: "memory", localDir: path.join(".kody", "memory") },
]

const FILE_MAPPINGS: Array<{ statePath: string; localPath: string }> = [
  { statePath: "instructions.md", localPath: path.join(".kody", "instructions.md") },
  { statePath: "variables.json", localPath: path.join(".kody", "variables.json") },
  { statePath: "secrets.enc", localPath: path.join(".kody", "secrets.enc") },
]

function writeLocalFile(cwd: string, relativePath: string, content: string): void {
  const fullPath = path.join(cwd, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}

function hydrateDirectory(config: StateRepoConfig, cwd: string, stateDir: string, localDir: string): void {
  const entries = listStateDirectory(config, cwd, stateDir)
  if (entries.length === 0) return

  fs.rmSync(path.join(cwd, localDir), { recursive: true, force: true })
  for (const entry of entries) {
    if (!entry.name || !entry.type) continue
    const childState = path.posix.join(stateDir, entry.name)
    const childLocal = path.join(localDir, entry.name)
    if (entry.type === "dir") {
      hydrateDirectory(config, cwd, childState, childLocal)
    } else if (entry.type === "file") {
      const file = readStateText(config, cwd, childState)
      if (file) writeLocalFile(cwd, childLocal, file.content)
    }
  }
}

export function hydrateStateWorkspace(config: StateRepoConfig, cwd: string): void {
  // Best-effort: state hydration is an optimisation that pulls consumer-side
  // runtime files (executables, capabilities, agents, …) from the configured
  // state repo into a local `.kody` cache. Failures (no GH_TOKEN, 404, network
  // blip) must NOT take down the executable — without the cache the consumer
  // repo's own `.kody/` files still resolve and the run proceeds. Logged once
  // per failure so operators can see why hydration is skipped.
  for (const mapping of DIR_MAPPINGS) {
    try {
      hydrateDirectory(config, cwd, mapping.stateDir, mapping.localDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] state hydration skipped for ${mapping.stateDir}: ${msg}\n`)
    }
  }

  for (const mapping of FILE_MAPPINGS) {
    try {
      const file = readStateText(config, cwd, mapping.statePath)
      if (file) writeLocalFile(cwd, mapping.localPath, file.content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] state hydration skipped for ${mapping.statePath}: ${msg}\n`)
    }
  }
}
