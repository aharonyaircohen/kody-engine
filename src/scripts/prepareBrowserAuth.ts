import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AuthMethodSpec, Context, PreflightScript, Profile } from "../implementations/types.js"
import { registerRuntimeCleanup } from "../runtimeCleanup.js"
import { readKodyVariables } from "./kodyVariables.js"
import { resolveRuntimeSecret } from "./runtimeSecrets.js"

interface GitHubUser {
  login: string
  avatar_url: string
  id: number
}

interface GitHubRepository {
  full_name: string
}

function appendAuthMessage(ctx: Context, message: string): void {
  const current = typeof ctx.data.qaAuthBlock === "string" ? ctx.data.qaAuthBlock.trim() : ""
  ctx.data.qaAuthBlock = current ? `${current}\n\n${message}` : message
}

function githubRepositoryParts(repoUrl: string): { owner: string; repo: string } {
  const parsed = new URL(repoUrl)
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("repository must be an https://github.com/owner/repo URL")
  }
  const parts = parsed.pathname.split("/").filter(Boolean)
  if (parts.length !== 2) throw new Error("repository URL must contain exactly owner/repo")
  const repo = parts[1]!.replace(/\.git$/, "")
  if (!parts[0] || !repo) throw new Error("repository URL is incomplete")
  return { owner: parts[0], repo }
}

function browserOrigin(ctx: Context): string {
  const raw = typeof ctx.data.previewUrl === "string" ? ctx.data.previewUrl : ""
  if (!raw) throw new Error("QA target URL is unavailable")
  const parsed = new URL(raw)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("QA target URL must use http or https")
  }
  return parsed.origin
}

async function githubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
  return (await response.json()) as T
}

function writeKodyStorageState(input: {
  origin: string
  repoUrl: string
  owner: string
  repo: string
  token: string
  user: GitHubUser
}): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kody-browser-auth-"))
  fs.chmodSync(directory, 0o700)
  const file = path.join(directory, "storage-state.json")
  const now = Date.now()
  const repoEntry = {
    repoUrl: input.repoUrl,
    owner: input.owner,
    repo: input.repo,
    token: input.token,
    addedAt: now,
    isLogin: true,
    user: input.user,
  }
  const auth = {
    repoUrl: input.repoUrl,
    owner: input.owner,
    repo: input.repo,
    token: input.token,
    user: input.user,
    loggedInAt: now,
    repos: [repoEntry],
    currentRepoIndex: 0,
  }
  const storageState = {
    cookies: [],
    origins: [
      {
        origin: input.origin,
        localStorage: [{ name: "kody_auth", value: JSON.stringify(auth) }],
      },
    ],
  }
  fs.writeFileSync(file, JSON.stringify(storageState), { mode: 0o600 })
  return { directory, file }
}

function configurePlaywright(profile: Profile, storageStatePath: string): void {
  const playwright = profile.claudeCode.mcpServers.find((server) => server.name === "playwright")
  if (!playwright) throw new Error("Playwright MCP server is not configured")

  const args: string[] = []
  const currentArgs = playwright.args ?? []
  for (let index = 0; index < currentArgs.length; index += 1) {
    const arg = currentArgs[index]!
    if (arg === "--storage-state") {
      index += 1
      continue
    }
    if (arg.startsWith("--storage-state=")) continue
    args.push(arg)
  }
  if (!args.includes("--isolated")) args.push("--isolated")
  args.push("--storage-state", storageStatePath)
  playwright.args = args
}

function fieldsForKodyRepository(method: AuthMethodSpec): {
  repositoryKey: string
  credentialKey: string
} {
  const variables = method.fields.filter((field) => field.source === "variable")
  const secrets = method.fields.filter((field) => field.source === "secret")
  if (variables.length !== 1 || secrets.length !== 1) {
    throw new Error("kody-repository auth requires one variable field and one secret field")
  }
  return { repositoryKey: variables[0]!.key, credentialKey: secrets[0]!.key }
}

async function prepareMethod(ctx: Context, profile: Profile, method: AuthMethodSpec): Promise<boolean> {
  const { repositoryKey, credentialKey } = fieldsForKodyRepository(method)
  const variables = readKodyVariables(ctx.cwd)
  const repositoryUrl = variables[repositoryKey]?.trim() ?? ""
  const credential = await resolveRuntimeSecret(credentialKey, ctx)
  ctx.data.qaAuthSecretSources = {
    ...((ctx.data.qaAuthSecretSources as Record<string, string> | undefined) ?? {}),
    [credentialKey]: credential.source,
  }
  if (credential.warning) {
    const warnings = Array.isArray(ctx.data.qaAuthWarnings) ? (ctx.data.qaAuthWarnings as string[]) : []
    ctx.data.qaAuthWarnings = [...warnings, credential.warning]
  }

  if (!repositoryUrl && !credential.value) return false
  if (!repositoryUrl) {
    appendAuthMessage(
      ctx,
      `Auth: ${method.name} is incomplete because no \`${repositoryKey}\` variable was found. Note this authenticated surface as a gap.`,
    )
    return false
  }
  if (!credential.value) {
    appendAuthMessage(
      ctx,
      `Auth: ${method.name} is incomplete because no \`${credentialKey}\` secret was found. Note this authenticated surface as a gap.`,
    )
    return false
  }

  let state: { directory: string; file: string } | undefined
  try {
    const requested = githubRepositoryParts(repositoryUrl)
    const [user, repository] = await Promise.all([
      githubJson<GitHubUser>("https://api.github.com/user", credential.value),
      githubJson<GitHubRepository>(
        `https://api.github.com/repos/${encodeURIComponent(requested.owner)}/${encodeURIComponent(requested.repo)}`,
        credential.value,
      ),
    ])
    const [owner, repo] = repository.full_name.split("/")
    if (!owner || !repo || !user.login || !user.avatar_url || typeof user.id !== "number") {
      throw new Error("GitHub returned incomplete identity data")
    }
    state = writeKodyStorageState({
      origin: browserOrigin(ctx),
      repoUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      owner,
      repo,
      token: credential.value,
      user,
    })
    configurePlaywright(profile, state.file)
    const authDirectory = state.directory
    registerRuntimeCleanup(ctx, () => {
      fs.rmSync(authDirectory, { recursive: true, force: true })
    })
    appendAuthMessage(
      ctx,
      `Auth: ${method.name} is already authenticated by the engine-provided browser session. ` +
        "The credential is not available to you; never request, reveal, or report it.",
    )
    return true
  } catch (error) {
    if (state) fs.rmSync(state.directory, { recursive: true, force: true })
    const reason = error instanceof Error ? error.message : String(error)
    appendAuthMessage(
      ctx,
      `Auth: the engine could not prepare ${method.name} (${reason}). Note this authenticated surface as a gap.`,
    )
    return false
  }
}

export const prepareBrowserAuth: PreflightScript = async (ctx, profile) => {
  const methods = profile.auth?.methods ?? []
  for (const method of methods) {
    if (method.strategy !== "browser-storage-state" || method.adapter !== "kody-repository") continue
    if (await prepareMethod(ctx, profile, method)) return
  }
}
