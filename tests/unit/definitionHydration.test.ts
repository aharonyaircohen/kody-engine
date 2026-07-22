import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { definitionVersion, hydrateDefinitions, hydrateDefinitionsFromEnv } from "../../src/definition-hydration.js"

let cwd: string

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kody-definitions-"))
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe("definition hydration", () => {
  it("verifies and materializes backend definitions outside .kody", async () => {
    const capabilityBundle = {
      schemaVersion: 1 as const,
      files: {
        "profile.json": '{"name":"audit","implementation":"run"}\n',
        "capability.md": "Audit carefully.\n",
      },
    }
    const agentBundle = {
      schemaVersion: 1 as const,
      files: { "agent.md": "# CTO\n\nGuard architecture.\n" },
    }
    const backend = {
      listDefinitions: vi
        .fn()
        .mockResolvedValueOnce([
          {
            slug: "audit",
            version: definitionVersion(capabilityBundle),
            bundle: capabilityBundle,
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ])
        .mockResolvedValueOnce([
          {
            slug: "cto",
            version: definitionVersion(agentBundle),
            bundle: agentBundle,
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ])
        .mockResolvedValueOnce([]),
    }

    const result = await hydrateDefinitions({
      cwd,
      tenantId: "acme/widgets",
      backend,
    })

    expect(fs.readFileSync(path.join(result.root, "capabilities/audit/capability.md"), "utf8")).toBe(
      "Audit carefully.\n",
    )
    expect(fs.readFileSync(path.join(result.root, "agents/cto.md"), "utf8")).toContain("Guard architecture.")
    expect(fs.existsSync(path.join(cwd, ".kody"))).toBe(false)
    expect(result.versions).toEqual({
      "agent:cto": definitionVersion(agentBundle),
      "capability:audit": definitionVersion(capabilityBundle),
    })
  })

  it("rejects a hash mismatch and unsafe bundle path", async () => {
    const validBundle = {
      schemaVersion: 1 as const,
      files: { "profile.json": "{}\n" },
    }
    await expect(
      hydrateDefinitions({
        cwd,
        tenantId: "acme/widgets",
        backend: {
          listDefinitions: vi
            .fn()
            .mockResolvedValueOnce([
              {
                slug: "audit",
                version: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                bundle: validBundle,
                updatedAt: "2026-07-18T00:00:00.000Z",
              },
            ])
            .mockResolvedValueOnce([]),
        },
      }),
    ).rejects.toThrow(/version mismatch/)

    await expect(
      hydrateDefinitions({
        cwd,
        tenantId: "acme/widgets",
        backend: {
          listDefinitions: vi
            .fn()
            .mockResolvedValueOnce([
              {
                slug: "audit",
                version: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                bundle: { schemaVersion: 1, files: { "../escape": "bad" } },
                updatedAt: "2026-07-18T00:00:00.000Z",
              },
            ])
            .mockResolvedValueOnce([]),
        },
      }),
    ).rejects.toThrow(/unsafe definition path/)
  })

  it("fails closed in GitHub Actions when backend credentials are absent", async () => {
    await expect(
      hydrateDefinitionsFromEnv(cwd, {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "acme/widgets",
      }),
    ).rejects.toThrow(/GitHub Actions workflow identity/)
  })
})
