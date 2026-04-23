/**
 * Preflight: scan the consumer repo for information a UI-review agent needs
 * to browse the app — routes, login page, admin panel, roles, frameworks,
 * Payload collections, API routes, env vars — and emit a compact
 * LLM-friendly summary.
 *
 * Populates:
 *   ctx.data.qaDiscovery — structured record (for tests / other scripts)
 *   ctx.data.qaContext   — serialized string for the prompt template
 *
 * Ported from legacy Kody-Engine-Lite/src/bin/qa-guide.ts.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import {
  detectFrameworks,
  discoverAdminComponents,
  discoverPayloadCollections,
  scanApiRoutes,
  scanEnvVars,
} from "./frameworkDetectors.js"
import type {
  AdminComponentInfo,
  ApiRouteInfo,
  CollectionInfo,
  FrameworkInfo,
} from "./frameworkDetectors.js"

export interface QaDiscovery {
  routes: { path: string; group: "admin" | "auth" | "api" | "frontend" }[]
  authFiles: string[]
  loginPage: string | null
  adminPath: string | null
  roles: string[]
  devCommand: string
  devPort: number
  frameworks: FrameworkInfo[]
  collections: CollectionInfo[]
  adminComponents: AdminComponentInfo[]
  apiRoutes: ApiRouteInfo[]
  envVars: string[]
}

const MAX_SERIALIZED_LENGTH = 8000

export function runQaDiscovery(cwd: string): QaDiscovery {
  const out: QaDiscovery = {
    routes: [],
    authFiles: [],
    loginPage: null,
    adminPath: null,
    roles: [],
    devCommand: "",
    devPort: 3000,
    frameworks: [],
    collections: [],
    adminComponents: [],
    apiRoutes: [],
    envVars: [],
  }

  detectDevServer(cwd, out)
  scanFrontendRoutes(cwd, out)
  detectAuthFiles(cwd, out)
  detectRoles(cwd, out)

  out.frameworks = detectFrameworks(cwd)
  const hasPayload = out.frameworks.some((f) => f.name === "payload-cms")
  if (hasPayload) out.collections = discoverPayloadCollections(cwd)
  out.adminComponents = discoverAdminComponents(cwd, out.collections.length > 0 ? out.collections : undefined)
  out.apiRoutes = scanApiRoutes(cwd)
  out.envVars = scanEnvVars(cwd)

  if (hasPayload && !out.adminPath) out.adminPath = "/admin"

  return out
}

function detectDevServer(cwd: string, out: QaDiscovery): void {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const pm = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
      ? "pnpm"
      : fs.existsSync(path.join(cwd, "yarn.lock"))
        ? "yarn"
        : fs.existsSync(path.join(cwd, "bun.lockb"))
          ? "bun"
          : "npm"
    if (pkg.scripts?.dev) out.devCommand = `${pm} dev`
    if (allDeps.next || allDeps.nuxt) out.devPort = 3000
    else if (allDeps.vite) out.devPort = 5173
  } catch {
    /* ignore */
  }
}

function scanFrontendRoutes(cwd: string, out: QaDiscovery): void {
  const appDirs = ["src/app", "app"]
  for (const appDir of appDirs) {
    const full = path.join(cwd, appDir)
    if (!fs.existsSync(full)) continue
    walkFrontendRoutes(full, "", out)
    break
  }
}

function walkFrontendRoutes(dir: string, prefix: string, out: QaDiscovery): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  const hasPage = entries.some((e) => e.isFile() && /^page\.(tsx?|jsx?)$/.test(e.name))
  if (hasPage) {
    const routePath = prefix || "/"
    const group: QaDiscovery["routes"][number]["group"] = prefix.startsWith("/admin")
      ? "admin"
      : prefix.includes("/login") || prefix.includes("/signup")
        ? "auth"
        : prefix.includes("/api")
          ? "api"
          : "frontend"

    out.routes.push({ path: routePath, group })
    if (prefix.includes("/login") && !out.loginPage) out.loginPage = routePath
    if (prefix.startsWith("/admin") && !out.adminPath) out.adminPath = prefix
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "node_modules" || entry.name === ".next") continue

    let segment = entry.name
    if (segment.startsWith("(") && segment.endsWith(")")) {
      walkFrontendRoutes(path.join(dir, entry.name), prefix, out)
      continue
    }
    if (segment.startsWith("[[") && segment.endsWith("]]")) {
      segment = `:${segment.slice(2, -2)}?`
    } else if (segment.startsWith("[") && segment.endsWith("]")) {
      segment = `:${segment.slice(1, -1)}`
    }

    walkFrontendRoutes(path.join(dir, entry.name), `${prefix}/${segment}`, out)
  }
}

function detectAuthFiles(cwd: string, out: QaDiscovery): void {
  const candidates = [
    "middleware.ts",
    "middleware.js",
    "src/middleware.ts",
    "src/middleware.js",
    "src/app/api/auth",
    "src/auth",
    "src/lib/auth",
    "auth.config.ts",
    "auth.ts",
    "src/app/api/oauth",
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(cwd, c))) out.authFiles.push(c)
  }
}

function detectRoles(cwd: string, out: QaDiscovery): void {
  const rolePaths = ["src/types", "src/lib", "src/utils", "src/constants", "src/access", "src/collections"]
  for (const rp of rolePaths) {
    const dir = path.join(cwd, rp)
    if (!fs.existsSync(dir)) continue
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(dir, f), "utf-8").slice(0, 5000)
        const roleMatches = content.match(/(?:role|Role|ROLE)\s*[=:]\s*['"](\w+)['"]/g)
        if (roleMatches) {
          for (const m of roleMatches) {
            const val = m.match(/['"](\w+)['"]/)
            if (val && !out.roles.includes(val[1]!)) out.roles.push(val[1]!)
          }
        }
        const enumMatch = content.match(/(?:enum|type)\s+\w*[Rr]ole\w*\s*[={]([^}]+)/s)
        if (enumMatch) {
          const vals = enumMatch[1]!.match(/['"](\w+)['"]/g)
          if (vals) {
            for (const v of vals) {
              const clean = v.replace(/['"]/g, "")
              if (!out.roles.includes(clean)) out.roles.push(clean)
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── LLM serialization ────────────────────────────────────────────────────

export function serializeDiscoveryForLLM(d: QaDiscovery): string {
  const sections: string[] = []
  sections.push(`Dev server: ${d.devCommand || "pnpm dev"} at http://localhost:${d.devPort}`)

  if (d.loginPage) sections.push(`Login page: ${d.loginPage}`)
  if (d.adminPath) sections.push(`Admin panel: ${d.adminPath}`)
  if (d.roles.length > 0) sections.push(`Roles: ${d.roles.join(", ")}`)

  if (d.frameworks.length > 0) {
    sections.push(
      `\nFrameworks: ${d.frameworks.map((f) => `${f.name}${f.version ? ` (${f.version})` : ""}`).join(", ")}`,
    )
  }

  if (d.collections.length > 0) {
    sections.push("\nCollections (Payload CMS):")
    for (const col of d.collections.slice(0, 15)) {
      const fields = col.fields.slice(0, 10).join(", ")
      let line = `- ${col.slug}: fields=[${fields}]`
      if (col.hasAdmin) line += " (has custom admin components)"
      line += ` — ${col.filePath}`
      sections.push(line)
    }
    if (d.collections.length > 15) sections.push(`- ... and ${d.collections.length - 15} more collections`)
  }

  if (d.adminComponents.length > 0) {
    sections.push("\nCustom Admin Components:")
    for (const comp of d.adminComponents.slice(0, 10)) {
      let line = `- ${comp.name} (${comp.filePath})`
      if (comp.usedInCollection) line += ` → used in "${comp.usedInCollection}" collection`
      sections.push(line)
    }
  }

  if (d.apiRoutes.length > 0) {
    sections.push("\nAPI Routes:")
    for (const route of d.apiRoutes.slice(0, 20)) {
      sections.push(`- ${route.methods.join("/")} ${route.path} — ${route.filePath}`)
    }
    if (d.apiRoutes.length > 20) sections.push(`- ... and ${d.apiRoutes.length - 20} more routes`)
  }

  if (d.routes.length > 0) {
    sections.push("\nFrontend Routes:")
    for (const route of d.routes.slice(0, 30)) {
      sections.push(`- [${route.group}] ${route.path}`)
    }
    if (d.routes.length > 30) sections.push(`- ... and ${d.routes.length - 30} more routes`)
  }

  if (d.envVars.length > 0) sections.push(`\nRequired env vars: ${d.envVars.join(", ")}`)

  let result = sections.join("\n")
  if (result.length > MAX_SERIALIZED_LENGTH) {
    const cutoff = result.lastIndexOf("\n", MAX_SERIALIZED_LENGTH - 20)
    result = result.slice(0, cutoff > 0 ? cutoff : MAX_SERIALIZED_LENGTH - 20) + "\n... (truncated)"
  }
  return result
}

// ─── QA guide template (for `kody init` scaffolding) ────────────────────

/**
 * Generate a starter `.kody/qa-guide.md` for a repo. Uses discovery to
 * pre-fill routes, login page, roles, admin path, and framework context.
 * Credentials are left as CHANGE_ME placeholders — the repo maintainer
 * fills them in and commits.
 */
export function generateQaGuideTemplate(d: QaDiscovery): string {
  const lines: string[] = []
  lines.push("# QA guide")
  lines.push("")
  lines.push("This file is read by `kody ui-review`. Fill in the credential placeholders")
  lines.push("below and commit — the agent uses them to log in to your preview deployment.")
  lines.push("")

  lines.push("## Test accounts")
  lines.push("")
  lines.push("<!-- Replace CHANGE_ME with real credentials for your preview environment.")
  lines.push("     Remove any role row you don't have an account for. -->")
  lines.push("")
  lines.push("| Role | Email | Password |")
  lines.push("|------|-------|----------|")
  if (d.roles.length > 0) {
    for (const role of d.roles) {
      lines.push(`| ${role} | CHANGE_ME | CHANGE_ME |`)
    }
  } else {
    lines.push("| admin | admin@example.com | CHANGE_ME |")
    lines.push("| user | user@example.com | CHANGE_ME |")
  }
  lines.push("")

  lines.push("## Login")
  lines.push("")
  lines.push(`- Login page: \`${d.loginPage ?? "/login"}\``)
  if (d.adminPath) lines.push(`- Admin panel: \`${d.adminPath}\``)
  lines.push("")
  lines.push("### Steps")
  lines.push(`1. Navigate to \`${d.loginPage ?? "/login"}\``)
  lines.push("2. Enter credentials from the table above")
  lines.push("3. Submit the login form")
  lines.push("4. Verify the redirect lands on the expected page")
  lines.push("")

  if (d.roles.length > 0) {
    lines.push("## Roles")
    lines.push("")
    for (const role of d.roles) lines.push(`- \`${role}\``)
    lines.push("")
  }

  if (d.routes.length > 0) {
    lines.push("## Key pages")
    lines.push("")
    const groups: Record<string, string[]> = {}
    for (const r of d.routes) {
      if (!groups[r.group]) groups[r.group] = []
      groups[r.group]!.push(r.path)
    }
    for (const [group, routes] of Object.entries(groups)) {
      lines.push(`### ${group[0]!.toUpperCase()}${group.slice(1)}`)
      for (const r of routes.slice(0, 15).sort()) lines.push(`- \`${r}\``)
      if (routes.length > 15) lines.push(`- … and ${routes.length - 15} more`)
      lines.push("")
    }
  }

  lines.push("## Notes for the reviewer")
  lines.push("")
  lines.push("<!-- Add any repo-specific quirks the UI-review agent should know:")
  lines.push("     seed data assumptions, feature flags, preview-only behaviors, etc. -->")
  lines.push("")

  return lines.join("\n")
}

// ─── Preflight entry ──────────────────────────────────────────────────────

export const discoverQaContext: PreflightScript = async (ctx) => {
  const discovery = runQaDiscovery(ctx.cwd)
  ctx.data.qaDiscovery = discovery
  ctx.data.qaContext = serializeDiscoveryForLLM(discovery)
}
