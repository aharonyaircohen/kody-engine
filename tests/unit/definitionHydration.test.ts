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
    const implementationBundle = {
      schemaVersion: 1 as const,
      files: {
        "definition.json": '{"id":"audit-with-claude"}\n',
        "runtime.json": '{"adapter":"kody-engine-profile"}\n',
        "prompt.md": "Run the audit.\n",
        "scripts/check.sh": "#!/usr/bin/env bash\n",
      },
    }
    const assetBundle = {
      schemaVersion: 1 as const,
      files: {
        "skills/architecture-audit/SKILL.md": "# Architecture audit\n",
      },
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
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            slug: "audit-with-claude",
            version: definitionVersion(implementationBundle),
            bundle: implementationBundle,
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ])
        .mockResolvedValueOnce([
          {
            slug: "skill-architecture-audit",
            version: definitionVersion(assetBundle),
            bundle: assetBundle,
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ]),
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
    expect(fs.readFileSync(path.join(result.root, "implementations/audit-with-claude/prompt.md"), "utf8")).toBe(
      "Run the audit.\n",
    )
    expect(fs.readFileSync(path.join(result.root, "implementations/audit-with-claude/scripts/check.sh"), "utf8")).toContain(
      "bash",
    )
    expect(fs.readFileSync(path.join(result.root, "shared/skills/architecture-audit/SKILL.md"), "utf8")).toContain(
      "Architecture audit",
    )
    expect(fs.existsSync(path.join(cwd, ".kody"))).toBe(false)
    expect(result.versions).toEqual({
      "agent:cto": definitionVersion(agentBundle),
      "asset:skill-architecture-audit": definitionVersion(assetBundle),
      "capability:audit": definitionVersion(capabilityBundle),
      "implementation:audit-with-claude": definitionVersion(implementationBundle),
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

  it("requires repository identity when a backend is configured", async () => {
    await expect(
      hydrateDefinitionsFromEnv(cwd, {
        CONVEX_URL: "https://example.convex.cloud",
        KODY_SERVICE_KEY: "service-key",
      }),
    ).rejects.toThrow(/GITHUB_REPOSITORY/)
  })
})
