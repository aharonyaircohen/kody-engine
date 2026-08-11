import { runLiveReleaseGate } from "../src/liveReleaseGate.js"

const token = process.env.KODY_RELEASE_GATE_TOKEN?.trim()
if (!token) throw new Error("KODY_RELEASE_GATE_TOKEN is required")

const result = await runLiveReleaseGate({
  dashboardUrl: process.env.KODY_RELEASE_GATE_DASHBOARD_URL?.trim() || "https://kody-dashboard-khaki.vercel.app",
  owner: process.env.KODY_RELEASE_GATE_OWNER?.trim() || "aharonyaircohen",
  repo: process.env.KODY_RELEASE_GATE_REPO?.trim() || "Kody-Engine-Tester",
  token,
  workflowId: process.env.KODY_RELEASE_GATE_WORKFLOW?.trim() || "engine-release-gate",
  timeoutMs: Number(process.env.KODY_RELEASE_GATE_TIMEOUT_MS || 15 * 60_000),
  pollMs: Number(process.env.KODY_RELEASE_GATE_POLL_MS || 5_000),
})

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
