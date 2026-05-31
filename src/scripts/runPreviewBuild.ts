/**
 * Preflight: build a per-PR preview image on the GHA runner, push to
 * Fly's registry, spin up a per-PR Fly Machine, and post the preview
 * URL on the PR.
 *
 * Runs inside the consumer's kody.yml workflow on ubuntu-latest (which
 * has docker pre-installed). The dashboard dispatches kody.yml with
 * `executable=preview-build` + `pr=<n>` when GitHub Actions is healthy;
 * the dashboard's Fly-builder spawn is the fallback.
 *
 * Required env (dispatcher / GHA-provided):
 *   GITHUB_REPOSITORY   owner/name (GHA built-in)
 *   GITHUB_SHA          head SHA of the PR (GHA built-in)
 *   GITHUB_TOKEN        GHA-provided, used for vault read + PR comment
 *   FLY_API_TOKEN       Fly org token (from consumer's vault)
 *   FLY_ORG_SLUG        defaults to "personal"
 *   FLY_REGION          defaults to "fra"
 *   KODY_MASTER_KEY     vault decryption key
 *   KODY_PREVIEW_GHCR_OWNER (optional) — enables base-image inheritance
 *
 * Optional vault key:
 *   NSC_TENANT_ID — when set, builds on a Namespace remote builder
 *   (OIDC-federated; kody.yml grants id-token: write) instead of the
 *   local GHA docker daemon. Best-effort: falls back to local on failure.
 *
 * Failure mode: any unhandled exception sets a non-zero exit and a
 * reason; the dashboard's webhook + Fly fallback path is unaffected.
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import type { PreflightScript } from "../executables/types.js"
import {
  basePreviewAppName,
  buildEnvFromVault,
  decryptVaultPayload,
  defaultImageTag,
  formatPreviewComment,
  previewAppName,
  type VaultDoc,
} from "./previewBuildHelpers.js"
import { setupNamespaceBuilder } from "./previewBuildNamespace.js"
import { runCmd } from "./previewBuildRun.js"

const FLY_MACHINES = "https://api.machines.dev/v1"
const FLY_GRAPHQL = "https://api.fly.io/graphql"
const REQ_TIMEOUT_MS = 30_000

/** Bundled at engine build time. tsup bundles every TS file in src/
 *  into dist/bin/kody.js, so import.meta.url resolves into dist/bin/.
 *  copy-assets.cjs places the templates at dist/bin/preview-build-templates/
 *  so this relative lookup works in both src (tsx) and dist (npm) runs.
 *  In tsx-from-src runs the path falls back to src/scripts/. */
function bundledDockerfilePath(mode: "dev" | "prod"): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file =
    mode === "dev"
      ? "default-Dockerfile.preview.dev"
      : "default-Dockerfile.preview.prod"
  // Bundled path (npm install of the published package).
  return path.join(here, "preview-build-templates", file)
}

function required(name: string): string {
  const v = (process.env[name] ?? "").trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}

function flyHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

async function ghJSON<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`GitHub ${url}: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

async function fetchVaultDoc(
  repo: string,
  ghToken: string,
  masterKey: string,
): Promise<VaultDoc> {
  const meta = await ghJSON<{ content: string }>(
    `https://api.github.com/repos/${repo}/contents/.kody/secrets.enc`,
    ghToken,
  )
  const payload = Buffer.from(meta.content, "base64").toString("utf8")
  const plaintext = decryptVaultPayload(payload, masterKey)
  return JSON.parse(plaintext) as VaultDoc
}

async function flyAppExists(name: string, token: string): Promise<boolean> {
  const res = await fetch(`${FLY_MACHINES}/apps/${encodeURIComponent(name)}`, {
    headers: flyHeaders(token),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  if (res.status === 404) return false
  if (!res.ok) {
    throw new Error(`appExists ${name}: ${res.status} ${res.statusText}`)
  }
  return true
}

async function flyCreateApp(
  name: string,
  orgSlug: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${FLY_MACHINES}/apps`, {
    method: "POST",
    headers: flyHeaders(token),
    body: JSON.stringify({ app_name: name, org_slug: orgSlug }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  // 422 = name taken → idempotent.
  if (res.status === 422) return
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`createApp ${name}: ${res.status} ${text.slice(0, 200)}`)
  }
}

async function flyAllocateSharedIps(
  appName: string,
  token: string,
): Promise<void> {
  const mutation = `
    mutation AllocateIps($appId: ID!) {
      v4: allocateIpAddress(input: { appId: $appId, type: shared_v4 }) { ipAddress { address } }
      v6: allocateIpAddress(input: { appId: $appId, type: v6 }) { ipAddress { address } }
    }
  `
  const res = await fetch(FLY_GRAPHQL, {
    method: "POST",
    headers: flyHeaders(token),
    body: JSON.stringify({ query: mutation, variables: { appId: appName } }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`allocateSharedIps ${appName}: ${res.status}`)
  }
  const data = (await res.json()) as {
    errors?: Array<{ message: string }>
  }
  if (data.errors?.length) {
    const msgs = data.errors.map((e) => e.message).join("; ")
    if (!/already|exists/i.test(msgs)) {
      throw new Error(`allocateSharedIps: ${msgs}`)
    }
  }
}

async function flyListMachines(
  appName: string,
  token: string,
): Promise<Array<{ id: string; state: string }>> {
  const res = await fetch(
    `${FLY_MACHINES}/apps/${encodeURIComponent(appName)}/machines`,
    {
      headers: flyHeaders(token),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    },
  )
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`listMachines ${appName}: ${res.status}`)
  }
  const data = (await res.json()) as Array<{ id: string; state: string }>
  return data.map((m) => ({ id: m.id, state: m.state }))
}

async function flyDestroyMachine(
  appName: string,
  machineId: string,
  token: string,
): Promise<void> {
  await fetch(
    `${FLY_MACHINES}/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`,
    {
      method: "POST",
      headers: flyHeaders(token),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    },
  ).catch(() => undefined)
  const res = await fetch(
    `${FLY_MACHINES}/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
    {
      method: "DELETE",
      headers: flyHeaders(token),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    },
  )
  if (res.status === 404) return
  if (!res.ok) {
    throw new Error(`destroyMachine ${machineId}: ${res.status}`)
  }
}

async function flyCreatePreviewMachine(
  args: {
    appName: string
    region: string
    image: string
    env: Record<string, string>
  },
  token: string,
): Promise<string> {
  const body = {
    region: args.region,
    config: {
      image: args.image,
      env: args.env,
      auto_destroy: false,
      restart: { policy: "always" },
      // 4 GB / 2 CPU is the floor that compiles A-Guy-class pages
      // without OOM when something forces a runtime recompile.
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"], force_https: false },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: 8080,
          auto_stop_machines: "suspend",
          auto_start_machines: true,
          min_machines_running: 0,
        },
      ],
      checks: {
        httpget: {
          type: "http",
          port: 8080,
          method: "GET",
          path: "/",
          interval: "15s",
          timeout: "10s",
          grace_period: "30s",
        },
      },
    },
  }
  // Retry on MANIFEST_UNKNOWN — Fly's registry is eventually
  // consistent for ~5s after `docker push`.
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(
      `${FLY_MACHINES}/apps/${encodeURIComponent(args.appName)}/machines`,
      {
        method: "POST",
        headers: flyHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      },
    )
    if (res.ok) {
      const { id } = (await res.json()) as { id: string }
      return id
    }
    const text = await res.text().catch(() => "")
    lastErr = new Error(
      `createPreviewMachine ${res.status}: ${text.slice(0, 300)}`,
    )
    if (!/MANIFEST_UNKNOWN|manifest unknown/i.test(text)) break
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
  }
  throw lastErr ?? new Error("createPreviewMachine failed (unknown)")
}

/**
 * Find an existing `<!-- kody-fly-preview -->` comment on the PR and
 * PATCH its body in place. Posts a new one if none exists. Idempotent
 * across builds — devs see ONE comment that updates, not N.
 */
async function postOrUpdatePreviewComment(args: {
  repo: string
  pr: number
  body: string
  token: string
}): Promise<void> {
  const MARKER = "<!-- kody-fly-preview -->"
  const base = `https://api.github.com/repos/${args.repo}/issues/${args.pr}/comments`
  const headers = {
    Authorization: `Bearer ${args.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  }
  const listRes = await fetch(`${base}?per_page=100`, {
    headers,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  }).catch(() => null)
  let existingId: number | null = null
  if (listRes && listRes.ok) {
    const comments = (await listRes.json().catch(() => [])) as Array<{
      id: number
      body?: string
    }>
    const hit = comments.find((c) => (c.body ?? "").includes(MARKER))
    if (hit) existingId = hit.id
  }
  if (existingId) {
    await fetch(
      `https://api.github.com/repos/${args.repo}/issues/comments/${existingId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body: args.body }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      },
    )
    return
  }
  await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ body: args.body }),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  })
}

export const runPreviewBuild: PreflightScript = async (
  ctx,
  _profile,
  _args,
) => {
  ctx.skipAgent = true

  // Inputs from env + ctx.
  const pr = Number(ctx.args.pr)
  if (!Number.isFinite(pr) || pr <= 0) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runPreviewBuild: invalid pr arg "${ctx.args.pr}"`
    return
  }
  let repo: string
  let ref: string
  let masterKey: string
  let ghToken: string
  try {
    repo = required("GITHUB_REPOSITORY")
    ref = required("GITHUB_SHA")
    masterKey = required("KODY_MASTER_KEY")
    // Engine's resolveAuthToken sets GH_TOKEN; the kody.yml workflow
    // exposes KODY_TOKEN. Match the same fallback chain the engine
    // uses everywhere else (KODY_TOKEN | GH_TOKEN | GITHUB_TOKEN | GH_PAT).
    ghToken = (
      process.env.KODY_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      process.env.GH_PAT ??
      ""
    ).trim()
    if (!ghToken) {
      throw new Error(
        "GitHub auth token missing (KODY_TOKEN / GH_TOKEN / GITHUB_TOKEN / GH_PAT all empty)",
      )
    }
  } catch (err) {
    ctx.output.exitCode = 99
    ctx.output.reason = `runPreviewBuild: ${err instanceof Error ? err.message : String(err)}`
    return
  }
  const ghcrOwner = process.env.KODY_PREVIEW_GHCR_OWNER?.trim() || ""

  const appName = previewAppName(repo, pr)
  const tag = defaultImageTag(repo, ref)

  try {
    // 1. Vault → build env. Single source of truth for FLY_API_TOKEN
    //    too — pulled from the doc here so we don't need it as a
    //    separate repo secret.
    const doc = await fetchVaultDoc(repo, ghToken, masterKey)
    const { buildEnv, buildMode } = buildEnvFromVault(doc)
    const flyToken = doc.secrets?.FLY_API_TOKEN?.value?.trim()
    if (!flyToken) {
      ctx.output.exitCode = 99
      ctx.output.reason =
        "runPreviewBuild: vault has no FLY_API_TOKEN — add it via the dashboard's /secrets page"
      return
    }
    const orgSlug =
      doc.secrets?.FLY_ORG_SLUG?.value?.trim() ||
      (process.env.FLY_ORG_SLUG ?? "personal").trim()
    const region =
      doc.secrets?.FLY_DEFAULT_REGION?.value?.trim() ||
      (process.env.FLY_REGION ?? "fra").trim()
    // Opt-in: when the vault carries a Namespace tenant id, build on a
    // Namespace remote builder (faster, cached) instead of the local
    // GHA docker daemon. Empty → unchanged local-build behaviour.
    const nscTenantId = doc.secrets?.NSC_TENANT_ID?.value?.trim() || ""
    console.log(
      `[preview-build] vault: ${Object.keys(buildEnv).length} secrets, mode=${buildMode}`,
    )

    // 2. Write .env.production.local for Next.js build-time read.
    if (Object.keys(buildEnv).length > 0) {
      const lines = Object.entries(buildEnv).map(
        ([k, v]) => `${k}=${JSON.stringify(v)}`,
      )
      await writeFile(
        path.join(ctx.cwd, ".env.production.local"),
        lines.join("\n") + "\n",
        "utf8",
      )
    }

    // 3. Drop the bundled Dockerfile.preview into the working tree.
    //    Consumer Dockerfile.preview (if shipped) wins over the bundled.
    //    Fatal if neither exists — the docker build can't proceed.
    const consumerDockerfile = path.join(ctx.cwd, "Dockerfile.preview")
    const { stat } = await import("node:fs/promises")
    let hasConsumerDockerfile = false
    try {
      await stat(consumerDockerfile)
      hasConsumerDockerfile = true
    } catch {
      hasConsumerDockerfile = false
    }
    if (!hasConsumerDockerfile) {
      const bundled = bundledDockerfilePath(buildMode)
      await copyFile(bundled, consumerDockerfile)
      console.log(
        `[preview-build] using bundled Dockerfile.preview.${buildMode} (from ${bundled})`,
      )
    } else {
      console.log("[preview-build] using repo Dockerfile.preview")
    }

    // 4. Probe GHCR for the per-repo base image. When present, the
    //    Dockerfile FROMs it and skips deps install + cold compile.
    let baseImage: string | null = null
    if (ghcrOwner) {
      const baseRef = `${ghcrOwner.toLowerCase()}/${basePreviewAppName(repo)}`
      const tok = await fetch(
        `https://ghcr.io/token?scope=repository:${baseRef}:pull&service=ghcr.io`,
        { signal: AbortSignal.timeout(15_000) },
      ).catch(() => null)
      if (tok?.ok) {
        const { token: bearer } = (await tok.json()) as { token: string }
        const probe = await fetch(`https://ghcr.io/v2/${baseRef}/manifests/latest`, {
          method: "HEAD",
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          },
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null)
        if (probe?.status === 200) {
          baseImage = `ghcr.io/${baseRef}:latest`
          console.log(`[preview-build] inheriting from base ${baseImage}`)
        }
      }
    }

    // 5. Fly app prep — idempotent.
    if (!(await flyAppExists(appName, flyToken))) {
      await flyCreateApp(appName, orgSlug, flyToken)
    }
    await flyAllocateSharedIps(appName, flyToken)

    // 6. Docker login, then build + push the image to Fly's registry.
    //    Primary path: a Namespace remote builder (when the vault carries
    //    NSC_TENANT_ID) — faster cold builds + a persistent cache, via
    //    OIDC federation (kody.yml grants id-token: write). Best-effort:
    //    setup returns null on any failure and we build on the local GHA
    //    docker daemon instead, so previews never depend on Namespace.
    await runCmd(
      "docker",
      ["login", "registry.fly.io", "-u", "x", "--password-stdin"],
      { input: flyToken, cwd: ctx.cwd },
    )

    const imageRef = `registry.fly.io/${appName}:${tag}`
    const nsBuilder = nscTenantId
      ? await setupNamespaceBuilder({
          tenantId: nscTenantId,
          builderName: `kody-preview-${pr}`,
        })
      : null

    if (nsBuilder) {
      // Remote build on Namespace, pushed straight to Fly's registry.
      const a = [
        "buildx",
        "build",
        "--builder",
        nsBuilder,
        "-f",
        "Dockerfile.preview",
        "-t",
        imageRef,
        "--push",
      ]
      if (baseImage) a.push("--build-arg", `BASE_IMAGE=${baseImage}`)
      a.push(".")
      await runCmd("docker", a, { cwd: ctx.cwd })
    } else {
      // Local build on the GHA runner's docker daemon, then push.
      const buildArgs: string[] = [
        "build",
        "-f",
        "Dockerfile.preview",
        "-t",
        imageRef,
      ]
      if (baseImage) buildArgs.push("--build-arg", `BASE_IMAGE=${baseImage}`)
      buildArgs.push(".")
      await runCmd("docker", buildArgs, {
        cwd: ctx.cwd,
        env: { DOCKER_BUILDKIT: "1" },
      })
      await runCmd("docker", ["push", imageRef], { cwd: ctx.cwd })
    }

    // 7. Destroy stale preview machines (prior sync) then create the new one.
    const stale = await flyListMachines(appName, flyToken)
    for (const m of stale) {
      await flyDestroyMachine(appName, m.id, flyToken).catch(() => undefined)
    }

    const machineId = await flyCreatePreviewMachine(
      {
        appName,
        region,
        image: `registry.fly.io/${appName}:${tag}`,
        env: buildEnv,
      },
      flyToken,
    )
    console.log(
      `[preview-build] done — machine ${machineId} at https://${appName}.fly.dev`,
    )

    // 8. Post (or update) the preview-ready comment.
    await postOrUpdatePreviewComment({
      repo,
      pr,
      body: formatPreviewComment({
        appName,
        ref,
        nowIso: new Date().toISOString(),
      }),
      token: ghToken,
    })
  } catch (err) {
    ctx.output.exitCode = 1
    ctx.output.reason = `runPreviewBuild: ${err instanceof Error ? err.message : String(err)}`
    console.error("[preview-build] failed:", err)
    return
  }
}
