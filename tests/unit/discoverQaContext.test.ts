import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import {
  discoverQaContext,
  generateQaGuideTemplate,
  runQaDiscovery,
  serializeDiscoveryForLLM,
} from "../../src/scripts/discoverQaContext.js"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-qactx-"))
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function makeCtx(cwd: string): Context {
  return {
    args: {},
    cwd,
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    },
    data: {},
    output: { exitCode: 0 },
  }
}

const dummyProfile = {} as Profile

describe("runQaDiscovery", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("discovers Next.js routes, login page, admin path", () => {
    writeFile(tmp, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" }, scripts: { dev: "next dev" } }))
    writeFile(tmp, "src/app/page.tsx", "export default () => null")
    writeFile(tmp, "src/app/login/page.tsx", "export default () => null")
    writeFile(tmp, "src/app/admin/users/page.tsx", "export default () => null")

    const d = runQaDiscovery(tmp)
    expect(d.loginPage).toBe("/login")
    expect(d.adminPath).toBe("/admin/users")
    expect(d.routes.find((r) => r.group === "admin")).toBeDefined()
    expect(d.routes.find((r) => r.group === "auth")).toBeDefined()
    expect(d.devPort).toBe(3000)
    expect(d.devCommand).toContain("dev")
  })

  it("discovers Payload roles from a role enum", () => {
    writeFile(tmp, "package.json", JSON.stringify({ dependencies: { payload: "3.0.0" } }))
    writeFile(
      tmp,
      "src/collections/Users.ts",
      `export const Users = {
        slug: 'users',
        fields: [
          {
            name: 'role',
            type: 'select',
            options: ['admin', 'instructor', 'student'],
          },
        ],
      }`,
    )
    writeFile(
      tmp,
      "src/types/roles.ts",
      `export type Role = 'admin' | 'instructor' | 'student'
       export const ROLE = 'admin'`,
    )

    const d = runQaDiscovery(tmp)
    expect(d.roles).toEqual(expect.arrayContaining(["admin", "instructor", "student"]))
    // Payload detected → adminPath defaults to /admin
    expect(d.adminPath).toBe("/admin")
  })
})

describe("serializeDiscoveryForLLM", () => {
  it("caps output length and injects all sections", () => {
    const d = {
      routes: Array.from({ length: 40 }, (_, i) => ({
        path: `/route-${i}`,
        group: "frontend" as const,
      })),
      authFiles: [],
      loginPage: "/login",
      adminPath: "/admin",
      roles: ["admin", "user"],
      devCommand: "pnpm dev",
      devPort: 3000,
      frameworks: [{ name: "nextjs", version: "16.0.0", configFile: null }],
      collections: [],
      adminComponents: [],
      apiRoutes: [],
      envVars: ["DATABASE_URL"],
    }
    const out = serializeDiscoveryForLLM(d)
    expect(out).toContain("Login page: /login")
    expect(out).toContain("Admin panel: /admin")
    expect(out).toContain("Roles: admin, user")
    expect(out).toContain("DATABASE_URL")
    expect(out).toContain("... and 10 more routes")
  })
})

describe("generateQaGuideTemplate", () => {
  it("uses discovered roles in the test-accounts table", () => {
    const d = {
      routes: [],
      authFiles: [],
      loginPage: "/sign-in",
      adminPath: "/admin",
      roles: ["admin", "instructor"],
      devCommand: "pnpm dev",
      devPort: 3000,
      frameworks: [],
      collections: [],
      adminComponents: [],
      apiRoutes: [],
      envVars: [],
    }
    const md = generateQaGuideTemplate(d)
    expect(md).toContain("| admin | CHANGE_ME | CHANGE_ME |")
    expect(md).toContain("| instructor | CHANGE_ME | CHANGE_ME |")
    expect(md).toContain("`/sign-in`")
    expect(md).toContain("Admin panel: `/admin`")
  })

  it("falls back to generic admin/user rows when no roles discovered", () => {
    const d = {
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
    const md = generateQaGuideTemplate(d)
    expect(md).toContain("admin@example.com")
    expect(md).toContain("user@example.com")
  })
})

describe("discoverQaContext preflight", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("populates ctx.data.qaDiscovery and ctx.data.qaContext", async () => {
    writeFile(tmp, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }))
    writeFile(tmp, "src/app/page.tsx", "export default () => null")
    const ctx = makeCtx(tmp)
    await discoverQaContext(ctx, dummyProfile)
    expect(ctx.data.qaDiscovery).toBeDefined()
    expect(typeof ctx.data.qaContext).toBe("string")
    expect(ctx.data.qaContext as string).toContain("Dev server")
  })
})
