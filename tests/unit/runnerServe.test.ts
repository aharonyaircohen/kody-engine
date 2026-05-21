import { afterEach, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"

import { authOk, buildServer, parseJob, type RunnerJob } from "../../src/scripts/runnerServe.js"

// ── parseJob: pure validation ───────────────────────────────────────────────

describe("runnerServe: parseJob", () => {
  const valid = {
    jobId: "vibe-issue-7-123",
    repo: "owner/name",
    issueNumber: 7,
    githubToken: "ghp_x",
  }

  it("accepts a minimal valid job", () => {
    const out = parseJob(valid)
    expect("job" in out).toBe(true)
    if ("job" in out) {
      expect(out.job.repo).toBe("owner/name")
      expect(out.job.issueNumber).toBe(7)
    }
  })

  it("carries optional fields through", () => {
    const out = parseJob({ ...valid, ref: "dev", model: "gemini/x", sessionId: "s1", dashboardUrl: "https://d?token=t", allSecrets: { ANTHROPIC_API_KEY: "k" } })
    expect("job" in out).toBe(true)
    if ("job" in out) {
      expect(out.job.ref).toBe("dev")
      expect(out.job.dashboardUrl).toBe("https://d?token=t")
      expect(out.job.allSecrets).toEqual({ ANTHROPIC_API_KEY: "k" })
    }
  })

  it.each([
    [{}, /jobId required/],
    [{ ...valid, repo: "noslash" }, /owner\/name/],
    [{ ...valid, issueNumber: 0 }, /issueNumber/],
    [{ ...valid, issueNumber: -3 }, /issueNumber/],
    [{ ...valid, githubToken: "" }, /githubToken required/],
  ])("rejects invalid body %#", (body, re) => {
    const out = parseJob(body)
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toMatch(re as RegExp)
  })

  it("rejects non-object bodies", () => {
    expect("error" in parseJob(null)).toBe(true)
    expect("error" in parseJob("nope")).toBe(true)
  })

  it("accepts interactive mode with a sessionId (no issueNumber needed)", () => {
    const out = parseJob({ jobId: "j1", repo: "o/r", githubToken: "ghp_x", mode: "interactive", sessionId: "sess-1", idleExitMs: 600000 })
    expect("job" in out).toBe(true)
    if ("job" in out) {
      expect(out.job.mode).toBe("interactive")
      expect(out.job.sessionId).toBe("sess-1")
      expect(out.job.idleExitMs).toBe(600000)
    }
  })

  it("rejects interactive mode without a sessionId", () => {
    const out = parseJob({ jobId: "j1", repo: "o/r", githubToken: "ghp_x", mode: "interactive" })
    expect("error" in out).toBe(true)
    if ("error" in out) expect(out.error).toMatch(/sessionId/)
  })
})

// ── authOk ──────────────────────────────────────────────────────────────────

describe("runnerServe: authOk", () => {
  const mk = (headers: Record<string, string>) => ({ headers }) as never
  it("accepts matching X-Api-Key", () => {
    expect(authOk(mk({ "x-api-key": "secret" }), "secret")).toBe(true)
  })
  it("accepts matching Bearer", () => {
    expect(authOk(mk({ authorization: "Bearer secret" }), "secret")).toBe(true)
  })
  it("rejects mismatches and missing", () => {
    expect(authOk(mk({ "x-api-key": "nope" }), "secret")).toBe(false)
    expect(authOk(mk({}), "secret")).toBe(false)
  })
})

// ── buildServer: routes over a real socket ───────────────────────────────────

describe("runnerServe: buildServer routes", () => {
  let server: Server | null = null
  const API_KEY = "test-key"

  afterEach(() => {
    server?.close()
    server = null
  })

  async function start(runJob?: (j: RunnerJob) => Promise<void>): Promise<string> {
    server = buildServer({ apiKey: API_KEY, runJob: runJob ?? (async () => {}) })
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
    const { port } = server!.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  const validBody = {
    jobId: "j1",
    repo: "owner/name",
    issueNumber: 7,
    githubToken: "ghp_x",
  }

  it("GET /healthz is unauthenticated and reports busy=false", async () => {
    const base = await start()
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, busy: false })
  })

  it("POST /run requires auth", async () => {
    const base = await start()
    const res = await fetch(`${base}/run`, { method: "POST", body: JSON.stringify(validBody) })
    expect(res.status).toBe(401)
  })

  it("POST /run accepts a job (202) and invokes runJob", async () => {
    let received: RunnerJob | null = null
    const base = await start(async (j) => {
      received = j
    })
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "content-type": "application/json" },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(202)
    expect((await res.json()).started).toBe(true)
    // give the detached runJob a tick to fire
    await new Promise((r) => setTimeout(r, 10))
    expect(received).not.toBeNull()
    expect(received!.jobId).toBe("j1")
  })

  it("POST /run returns 409 when already busy", async () => {
    // runJob never resolves → server stays busy after the first accept
    const base = await start(() => new Promise<void>(() => {}))
    const headers = { "x-api-key": API_KEY, "content-type": "application/json" }
    const first = await fetch(`${base}/run`, { method: "POST", headers, body: JSON.stringify(validBody) })
    expect(first.status).toBe(202)
    const second = await fetch(`${base}/run`, { method: "POST", headers, body: JSON.stringify(validBody) })
    expect(second.status).toBe(409)
  })

  it("POST /run rejects an invalid body (400)", async () => {
    const base = await start()
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ repo: "bad" }),
    })
    expect(res.status).toBe(400)
  })

  it("unknown routes 404", async () => {
    const base = await start()
    const res = await fetch(`${base}/nope`, { headers: { "x-api-key": API_KEY } })
    expect(res.status).toBe(404)
  })
})
