import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  detectFrameworks,
  discoverAdminComponents,
  discoverPayloadCollections,
  scanApiRoutes,
  scanEnvVars,
} from "../../src/scripts/frameworkDetectors.js"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-fwdetect-"))
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe("detectFrameworks", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("returns empty when no package.json", () => {
    expect(detectFrameworks(tmp)).toEqual([])
  })

  it("detects Payload CMS with config file", () => {
    writeFile(tmp, "package.json", JSON.stringify({ dependencies: { payload: "3.0.0" } }))
    writeFile(tmp, "src/payload.config.ts", "export default {}")
    const out = detectFrameworks(tmp)
    expect(out).toContainEqual({ name: "payload-cms", version: "3.0.0", configFile: "src/payload.config.ts" })
  })

  it("detects Next.js and Prisma together", () => {
    writeFile(
      tmp,
      "package.json",
      JSON.stringify({
        dependencies: { next: "16.0.0" },
        devDependencies: { prisma: "5.0.0" },
      }),
    )
    writeFile(tmp, "next.config.ts", "export default {}")
    writeFile(tmp, "prisma/schema.prisma", "// schema")
    const names = detectFrameworks(tmp).map((f) => f.name)
    expect(names).toContain("nextjs")
    expect(names).toContain("prisma")
  })

  it("gracefully handles malformed package.json", () => {
    writeFile(tmp, "package.json", "{ this is not json")
    expect(detectFrameworks(tmp)).toEqual([])
  })
})

describe("discoverPayloadCollections", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("parses slug + fields + hasAdmin flag", () => {
    const source = `
      import type { CollectionConfig } from 'payload'
      export const Courses: CollectionConfig = {
        slug: 'courses',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'slug', type: 'text' },
          { name: 'instructor', type: 'relationship', relationTo: 'users' },
        ],
        admin: {
          components: { Field: './SomeField' },
        },
      }
    `
    writeFile(tmp, "src/collections/Courses.ts", source)
    const out = discoverPayloadCollections(tmp)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ slug: "courses", name: "Courses", hasAdmin: true })
    expect(out[0]!.fields).toEqual(expect.arrayContaining(["title", "slug", "instructor"]))
  })

  it("skips files without a slug", () => {
    writeFile(tmp, "src/collections/Helper.ts", "export const x = 1")
    expect(discoverPayloadCollections(tmp)).toEqual([])
  })
})

describe("scanApiRoutes", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("detects GET + POST route with dynamic segment", () => {
    writeFile(tmp, "src/app/api/users/[id]/route.ts", `
      export async function GET() { return Response.json({}) }
      export async function POST() { return Response.json({}) }
    `)
    const out = scanApiRoutes(tmp)
    expect(out).toHaveLength(1)
    expect(out[0]!.path).toBe("/api/users/:id")
    expect(out[0]!.methods.sort()).toEqual(["GET", "POST"])
  })

  it("treats route groups transparently", () => {
    writeFile(tmp, "app/api/(admin)/stats/route.ts", `
      export function GET() { return new Response() }
    `)
    const out = scanApiRoutes(tmp)
    expect(out[0]!.path).toBe("/api/stats")
  })

  it("returns [] when no app/api directory", () => {
    expect(scanApiRoutes(tmp)).toEqual([])
  })
})

describe("discoverAdminComponents", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("finds flat files and directory components", () => {
    writeFile(tmp, "src/ui/admin/CourseEditor.tsx", "export default () => null")
    writeFile(tmp, "src/ui/admin/SomeWidget/index.tsx", "export default () => null")
    const names = discoverAdminComponents(tmp).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(["CourseEditor", "SomeWidget"]))
  })

  it("links component to collection when referenced", () => {
    writeFile(tmp, "src/ui/admin/CourseEditor.tsx", "export default () => null")
    writeFile(
      tmp,
      "src/collections/Courses.ts",
      `export const Courses = { slug: 'courses', admin: { components: { Field: 'CourseEditor' } } }`,
    )
    const collections = discoverPayloadCollections(tmp)
    const comps = discoverAdminComponents(tmp, collections)
    const editor = comps.find((c) => c.name === "CourseEditor")
    expect(editor?.usedInCollection).toBe("courses")
  })
})

describe("scanEnvVars", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mktmp()
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("parses .env.example and filters builtins", () => {
    writeFile(
      tmp,
      ".env.example",
      [
        "# comment",
        "DATABASE_URL=postgres://x",
        "PAYLOAD_SECRET=xxx",
        "NODE_ENV=production",
        "",
        "# another",
        "STRIPE_KEY=sk_test_...",
      ].join("\n"),
    )
    const out = scanEnvVars(tmp)
    expect(out).toEqual(["DATABASE_URL", "PAYLOAD_SECRET", "STRIPE_KEY"])
  })

  it("returns [] when no env-template file", () => {
    expect(scanEnvVars(tmp)).toEqual([])
  })
})
