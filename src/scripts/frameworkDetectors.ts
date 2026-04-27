/**
 * Pure helpers used by the discoverQaContext preflight. Detects frameworks
 * (Payload CMS, NextAuth, Prisma), scans Payload collections, admin
 * components, Next.js App Router API routes, and env-var templates.
 *
 * All functions are synchronous and filesystem-only — no network, no
 * agent. Ported from legacy Kody-Engine-Lite/src/bin/framework-detectors.ts.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface FrameworkInfo {
  name: string
  version: string | null
  configFile: string | null
}

export interface CollectionInfo {
  name: string
  slug: string
  filePath: string
  fields: string[]
  hasAdmin: boolean
}

export interface AdminComponentInfo {
  name: string
  filePath: string
  usedInCollection: string | null
}

export interface ApiRouteInfo {
  path: string
  methods: string[]
  filePath: string
}

// ─── Framework detection ──────────────────────────────────────────────────

export function detectFrameworks(cwd: string): FrameworkInfo[] {
  const out: FrameworkInfo[] = []

  let deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
    deps = { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    return out
  }

  if (deps.payload || deps["@payloadcms/next"]) {
    out.push({
      name: "payload-cms",
      version: deps.payload ?? deps["@payloadcms/next"] ?? null,
      configFile: findFile(cwd, ["payload.config.ts", "payload-config.ts", "src/payload.config.ts"]),
    })
  }
  if (deps["next-auth"]) {
    out.push({
      name: "nextauth",
      version: deps["next-auth"] ?? null,
      configFile: findFile(cwd, ["auth.ts", "auth.config.ts", "src/auth.ts", "src/auth.config.ts"]),
    })
  }
  if (deps.prisma || deps["@prisma/client"]) {
    out.push({
      name: "prisma",
      version: deps.prisma ?? deps["@prisma/client"] ?? null,
      configFile: findFile(cwd, ["prisma/schema.prisma"]),
    })
  }
  if (deps.next) {
    out.push({
      name: "nextjs",
      version: deps.next ?? null,
      configFile: findFile(cwd, ["next.config.ts", "next.config.mjs", "next.config.js"]),
    })
  }

  return out
}

function findFile(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(path.join(cwd, c))) return c
  }
  return null
}

// ─── Payload CMS collections ──────────────────────────────────────────────

const COLLECTION_DIRS = [
  "src/server/payload/collections",
  "src/payload/collections",
  "src/collections",
  "payload/collections",
]

export function discoverPayloadCollections(cwd: string): CollectionInfo[] {
  const out: CollectionInfo[] = []

  for (const dir of COLLECTION_DIRS) {
    const full = path.join(cwd, dir)
    if (!fs.existsSync(full)) continue

    let files: string[]
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    } catch {
      continue
    }

    for (const file of files) {
      try {
        const filePath = path.join(full, file)
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 10_000)

        const slugMatch = content.match(/slug:\s*['"]([a-z0-9-]+)['"]/)
        if (!slugMatch) continue

        const slug = slugMatch[1]!
        const name = file.replace(/\.(ts|tsx)$/, "")

        const fields: string[] = []
        const fieldMatches = content.matchAll(/name:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)
        for (const m of fieldMatches) {
          if (!fields.includes(m[1]!)) fields.push(m[1]!)
        }

        const hasAdmin =
          /components:\s*\{/.test(content) ||
          /Field:\s*['"]/.test(content) ||
          /Cell:\s*['"]/.test(content) ||
          /views:\s*\{/.test(content)

        out.push({
          name,
          slug,
          filePath: path.relative(cwd, filePath),
          fields: fields.slice(0, 20),
          hasAdmin,
        })
      } catch {
        /* skip malformed */
      }
    }
  }

  return out
}

// ─── Admin components ─────────────────────────────────────────────────────

const ADMIN_COMPONENT_DIRS = ["src/ui/admin", "src/admin/components", "src/components/admin"]

export function discoverAdminComponents(cwd: string, collections?: CollectionInfo[]): AdminComponentInfo[] {
  const out: AdminComponentInfo[] = []

  for (const dir of ADMIN_COMPONENT_DIRS) {
    const full = path.join(cwd, dir)
    if (!fs.existsSync(full)) continue

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = path.join(full, entry.name)
      let name: string
      let filePath: string

      if (entry.isDirectory()) {
        const indexFile = ["index.tsx", "index.ts", "index.jsx", "index.js"].find((f) =>
          fs.existsSync(path.join(entryPath, f)),
        )
        if (!indexFile) continue
        name = entry.name
        filePath = path.relative(cwd, path.join(entryPath, indexFile))
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        name = entry.name.replace(/\.(tsx?|jsx?)$/, "")
        filePath = path.relative(cwd, entryPath)
      } else {
        continue
      }

      let usedInCollection: string | null = null
      if (collections) {
        for (const col of collections) {
          try {
            const colContent = fs.readFileSync(path.join(cwd, col.filePath), "utf-8")
            if (colContent.includes(name)) {
              usedInCollection = col.slug
              break
            }
          } catch {
            /* skip */
          }
        }
      }

      out.push({ name, filePath, usedInCollection })
    }
  }

  return out
}

// ─── API routes ───────────────────────────────────────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

export function scanApiRoutes(cwd: string): ApiRouteInfo[] {
  const out: ApiRouteInfo[] = []
  const appDirs = ["src/app", "app"]

  for (const appDir of appDirs) {
    const apiDir = path.join(cwd, appDir, "api")
    if (!fs.existsSync(apiDir)) continue
    walkApiRoutes(apiDir, "/api", cwd, out)
    break
  }

  return out
}

function walkApiRoutes(dir: string, prefix: string, cwd: string, out: ApiRouteInfo[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  const routeFile = entries.find((e) => e.isFile() && /^route\.(ts|js|tsx|jsx)$/.test(e.name))
  if (routeFile) {
    try {
      const content = fs.readFileSync(path.join(dir, routeFile.name), "utf-8").slice(0, 5000)
      const methods = HTTP_METHODS.filter((m) =>
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(content),
      )
      if (methods.length > 0) {
        out.push({
          path: prefix,
          methods,
          filePath: path.relative(cwd, path.join(dir, routeFile.name)),
        })
      }
    } catch {
      /* skip */
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "node_modules" || entry.name === ".next") continue

    let segment = entry.name
    if (segment.startsWith("(") && segment.endsWith(")")) {
      walkApiRoutes(path.join(dir, entry.name), prefix, cwd, out)
      continue
    }
    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      segment = `:${segment.slice(2, -2)}?`
    } else if (segment.startsWith("[") && segment.endsWith("]")) {
      segment = `:${segment.slice(1, -1)}`
    }

    walkApiRoutes(path.join(dir, entry.name), `${prefix}/${segment}`, cwd, out)
  }
}

// ─── Env vars ─────────────────────────────────────────────────────────────

const BUILTIN_ENV_VARS = new Set([
  "NODE_ENV",
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "PWD",
  "HOSTNAME",
  "PORT",
  "CI",
  "GITHUB_ACTIONS",
])

export function scanEnvVars(cwd: string): string[] {
  const candidates = [".env.example", ".env.local.example", ".env.template"]
  for (const envFile of candidates) {
    const envPath = path.join(cwd, envFile)
    if (!fs.existsSync(envPath)) continue
    try {
      const content = fs.readFileSync(envPath, "utf-8")
      const vars: string[] = []
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/)
        if (match && !BUILTIN_ENV_VARS.has(match[1]!)) vars.push(match[1]!)
      }
      return vars
    } catch {
      return []
    }
  }
  return []
}
