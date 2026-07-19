export type BrainDriver = "native" | "codex-app-server"

const RUNTIME_DRIVERS: Readonly<Record<string, BrainDriver>> = {
  native: "native",
  "codex app-server": "codex-app-server",
  "codex-app-server": "codex-app-server",
}

export function resolveBrainDriver(runtime: string): BrainDriver {
  const normalized = runtime.trim().toLowerCase()
  const driver = RUNTIME_DRIVERS[normalized]
  if (!driver) {
    throw new Error(`Unsupported Brain runtime: ${runtime}`)
  }
  return driver
}
