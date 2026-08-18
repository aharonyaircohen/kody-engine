import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AuthMethodSpec, Context, PreflightScript, Profile } from "../implementations/types.js"
import { registerRuntimeCleanup } from "../runtimeCleanup.js"
import { readKodyVariables } from "./kodyVariables.js"
import { resolveRuntimeSecret } from "./runtimeSecrets.js"

interface GitHubRepository {
  full_name: string
}

interface GitHubUser {
  login: string
  avatar_url: string
  id: number
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

function browserOrigin(raw: string): string {
  if (!raw) throw new Error("QA target URL is unavailable")
  const parsed = new URL(raw)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("QA target URL must use http or https")
  }
  return parsed.origin
}

async function githubJson<T>(url: string, token: string, checkName: string): Promise<T> {
  const retryDelaysMs = [250, 750]
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    if (response.ok) return (await response.json()) as T
    const canRetry = response.status >= 500 && response.status <= 599 && attempt < retryDelaysMs.length
    if (!canRetry) throw new Error(`GitHub ${checkName} check returned ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
  }
  throw new Error(`GitHub ${checkName} check failed`)
}

function writeKodyStorageState(input: {
  origin: string
  repoUrl: string
  owner: string
  repo: string
  token: string
  user?: GitHubUser
}): { directory: string; file: string; auth: Record<string, unknown> } {
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
    ...(input.user ? { user: input.user } : {}),
  }
  // Kody requires the top-level user shape while hydrating auth, but identity
  // is not required for repository API headers. Leave it unresolved so the
  // dashboard can refresh it through its own authenticated /auth/me route.
  const unresolvedUser = { login: "", avatar_url: "", id: 0 }
  const auth = {
    repoUrl: input.repoUrl,
    owner: input.owner,
    repo: input.repo,
    token: input.token,
    user: input.user ?? unresolvedUser,
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
  return { directory, file, auth }
}

function parseSetCookie(value: string, hostname: string) {
  const parts = value.split(";").map((part) => part.trim())
  const pair = parts.shift() ?? ""
  const separator = pair.indexOf("=")
  if (separator <= 0) throw new Error("login response returned an invalid session cookie")
  const attributes = new Map<string, string>()
  for (const part of parts) {
    const index = part.indexOf("=")
    attributes.set(
      (index < 0 ? part : part.slice(0, index)).toLowerCase(),
      index < 0 ? "" : part.slice(index + 1),
    )
  }
  const sameSite = attributes.get("samesite")?.toLowerCase()
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    domain: attributes.get("domain")?.replace(/^\./, "") || hostname,
    path: attributes.get("path") || "/",
    expires: -1,
    httpOnly: attributes.has("httponly"),
    secure: attributes.has("secure"),
    sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax",
  }
}

function writeCookieStorageState(targetUrl: string, setCookies: string[]) {
  const target = new URL(targetUrl)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kody-browser-auth-"))
  fs.chmodSync(directory, 0o700)
  const file = path.join(directory, "storage-state.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      cookies: setCookies.map((cookie) => parseSetCookie(cookie, target.hostname)),
      origins: [],
    }),
    { mode: 0o600 },
  )
  return { directory, file }
}

interface BrowserStorageState {
  cookies: Array<{ name: string; domain: string; path: string; [key: string]: unknown }>
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

function currentStorageStatePath(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--storage-state") return args[index + 1]
    if (arg.startsWith("--storage-state=")) return arg.slice("--storage-state=".length)
  }
  return undefined
}

function browserSessionCookieHeader(profile: Profile, targetUrl: string): string | undefined {
  const playwright = profile.claudeCode.mcpServers.find((server) => server.name === "playwright")
  const storagePath = currentStorageStatePath(playwright?.args ?? [])
  if (!storagePath || !fs.existsSync(storagePath)) return undefined
  const hostname = new URL(targetUrl).hostname
  const state = JSON.parse(fs.readFileSync(storagePath, "utf-8")) as BrowserStorageState
  const cookies = (state.cookies ?? []).filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "")
    return hostname === domain || hostname.endsWith(`.${domain}`)
  })
  if (cookies.length === 0) return undefined
  return cookies.map((cookie) => `${cookie.name}=${String(cookie.value)}`).join("; ")
}

async function saveAccountRepositoryAuth(
  targetUrl: string,
  cookie: string,
  auth: Record<string, unknown>,
): Promise<void> {
  const origin = browserOrigin(targetUrl)
  const response = await fetch(`${origin}/api/kody/account/repositories`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ auth }),
  })
  if (!response.ok) throw new Error(`app repository setup returned ${response.status}`)
}

export async function prepareAccountCredentials(
  ctx: Context,
  profile: Profile,
  input: { names: string[]; targetUrl: string },
): Promise<boolean> {
  const cookie = browserSessionCookieHeader(profile, input.targetUrl)
  if (!cookie) {
    appendAuthMessage(ctx, "Auth: QA account credentials could not be prepared because the app session is missing.")
    return false
  }
  const origin = browserOrigin(input.targetUrl)
  for (const name of input.names) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      appendAuthMessage(ctx, "Auth: QA account credentials contain an invalid credential name.")
      return false
    }
    const credential = await resolveRuntimeSecret(name, ctx)
    if (!credential.value) {
      appendAuthMessage(ctx, `Auth: QA account setup is incomplete because no \`${name}\` secret was found.`)
      return false
    }
    const response = await fetch(`${origin}/api/kody/account/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ name, value: credential.value }),
    })
    if (!response.ok) {
      appendAuthMessage(ctx, `Auth: QA account credential setup returned ${response.status}.`)
      return false
    }
  }
  appendAuthMessage(ctx, "Auth: the QA account's required model credentials are already prepared by the engine.")
  return true
}

function mergeStorageStates(existingPath: string, nextPath: string): void {
  if (existingPath === nextPath || !fs.existsSync(existingPath)) return
  const existing = JSON.parse(fs.readFileSync(existingPath, "utf-8")) as BrowserStorageState
  const next = JSON.parse(fs.readFileSync(nextPath, "utf-8")) as BrowserStorageState
  const cookies = new Map<string, BrowserStorageState["cookies"][number]>()
  for (const cookie of [...(existing.cookies ?? []), ...(next.cookies ?? [])]) {
    cookies.set(`${cookie.name}\0${cookie.domain}\0${cookie.path}`, cookie)
  }
  const origins = new Map<string, BrowserStorageState["origins"][number]>()
  for (const entry of [...(existing.origins ?? []), ...(next.origins ?? [])]) {
    const current = origins.get(entry.origin)
    const localStorage = new Map<string, { name: string; value: string }>()
    for (const item of [...(current?.localStorage ?? []), ...(entry.localStorage ?? [])]) {
      localStorage.set(item.name, item)
    }
    origins.set(entry.origin, { origin: entry.origin, localStorage: [...localStorage.values()] })
  }
  fs.writeFileSync(
    nextPath,
    JSON.stringify({ cookies: [...cookies.values()], origins: [...origins.values()] }),
    { mode: 0o600 },
  )
}

function configurePlaywright(profile: Profile, storageStatePath: string): void {
  const playwright = profile.claudeCode.mcpServers.find((server) => server.name === "playwright")
  if (!playwright) throw new Error("Playwright MCP server is not configured")

  const args: string[] = []
  const currentArgs = playwright.args ?? []
  const existingStorageStatePath = currentStorageStatePath(currentArgs)
  if (existingStorageStatePath) mergeStorageStates(existingStorageStatePath, storageStatePath)
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
  const targetUrl = typeof ctx.data.previewUrl === "string" ? ctx.data.previewUrl : ""
  return prepareKodyRepositoryBrowserAuth(ctx, profile, {
    repositoryUrl,
    repositoryKey,
    credentialKey,
    methodName: method.name,
    targetUrl,
  })
}

export async function prepareKodyRepositoryBrowserAuth(
  ctx: Context,
  profile: Profile,
  input: {
    repositoryUrl: string
    repositoryKey?: string
    credentialKey: string
    methodName: string
    targetUrl: string
  },
): Promise<boolean> {
  const { repositoryUrl, credentialKey } = input
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
      `Auth: ${input.methodName} is incomplete because no \`${input.repositoryKey ?? "repository"}\` variable was found. Note this authenticated surface as a gap.`,
    )
    return false
  }
  if (!credential.value) {
    appendAuthMessage(
      ctx,
      `Auth: ${input.methodName} is incomplete because no \`${credentialKey}\` secret was found. Note this authenticated surface as a gap.`,
    )
    return false
  }

  let state: { directory: string; file: string; auth: Record<string, unknown> } | undefined
  try {
    const requested = githubRepositoryParts(repositoryUrl)
    const repository = await githubJson<GitHubRepository>(
      `https://api.github.com/repos/${encodeURIComponent(requested.owner)}/${encodeURIComponent(requested.repo)}`,
      credential.value,
      "repository",
    )
    const [owner, repo] = repository.full_name.split("/")
    if (!owner || !repo) throw new Error("GitHub returned incomplete repository data")
    const appCookie = browserSessionCookieHeader(profile, input.targetUrl)
    const user = appCookie
      ? await githubJson<GitHubUser>("https://api.github.com/user", credential.value, "user")
      : undefined
    state = writeKodyStorageState({
      origin: browserOrigin(input.targetUrl),
      repoUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      owner,
      repo,
      token: credential.value,
      user,
    })
    if (appCookie) await saveAccountRepositoryAuth(input.targetUrl, appCookie, state.auth)
    configurePlaywright(profile, state.file)
    const authDirectory = state.directory
    registerRuntimeCleanup(ctx, () => {
      fs.rmSync(authDirectory, { recursive: true, force: true })
    })
    appendAuthMessage(
      ctx,
      `Auth: ${input.methodName} is already authenticated by the engine-provided browser session. ` +
        "The credential is not available to you; never request, reveal, or report it.",
    )
    return true
  } catch (error) {
    if (state) fs.rmSync(state.directory, { recursive: true, force: true })
    const reason = error instanceof Error ? error.message : String(error)
    appendAuthMessage(
      ctx,
      `Auth: the engine could not prepare ${input.methodName} (${reason}). Note this authenticated surface as a gap.`,
    )
    return false
  }
}

export async function prepareEmailPasswordBrowserAuth(
  ctx: Context,
  profile: Profile,
  input: { login: string; targetUrl: string },
): Promise<boolean> {
  const password = await resolveRuntimeSecret("LOGIN_PASSWORD", ctx)
  if (!input.login || !password.value) return false
  let state: { directory: string; file: string } | undefined
  try {
    const origin = browserOrigin(input.targetUrl)
    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: input.login, password: password.value }),
    })
    if (!response.ok) throw new Error(`app login returned ${response.status}`)
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookies = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : [])
    if (cookies.length === 0) throw new Error("app login returned no session cookie")
    state = writeCookieStorageState(input.targetUrl, cookies)
    configurePlaywright(profile, state.file)
    const authDirectory = state.directory
    registerRuntimeCleanup(ctx, () => fs.rmSync(authDirectory, { recursive: true, force: true }))
    ctx.data.qaAuthBlock =
      "Auth: the app is already signed in through an engine-provided browser session. " +
      "The login credentials are not available to you; never request, reveal, or report them."
    return true
  } catch (error) {
    if (state) fs.rmSync(state.directory, { recursive: true, force: true })
    const reason = error instanceof Error ? error.message : String(error)
    ctx.data.qaAuthBlock = `Auth: the engine could not prepare the app login (${reason}). Note this authenticated surface as a gap.`
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
