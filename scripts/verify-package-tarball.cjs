const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-package-tarball-"))

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const distBin = path.join(root, "dist", "bin", "kody.js")
  assert(fs.existsSync(distBin), "dist/bin/kody.js is missing; run pnpm build before package verification")

  const packJson = run("npm", ["pack", "--json", "--pack-destination", tmp])
  const packed = JSON.parse(packJson)[0]
  const tarball = path.join(tmp, packed.filename)
  const entries = run("tar", ["-tf", tarball], { cwd: tmp }).trim().split("\n")
  const hasEntry = (entry) => entries.includes(entry)

  for (const required of [
    "package/dist/bin/kody.js",
    "package/dist/implementations/run/profile.json",
    "package/dist/capabilities/run/profile.json",
  ]) {
    assert(hasEntry(required), `package tarball is missing ${required}`)
  }

  for (const obsolete of [
    "package/dist/bin/implementations/feature/profile.json",
    "package/dist/implementations/feature/profile.json",
  ]) {
    assert(!hasEntry(obsolete), `package tarball still includes obsolete ${obsolete}`)
  }

  const store = path.join(tmp, "store")
  const consumer = path.join(tmp, "consumer")
  const install = path.join(tmp, "install")
  fs.mkdirSync(install, { recursive: true })

  writeJson(path.join(store, "kody-store.json"), {
    assetRoots: { capabilities: "capabilities" },
  })
  writeJson(path.join(store, "capabilities", "feature", "profile.json"), {
    name: "feature",
    action: "feature",
    workflow: {
      steps: [{ capability: "noop", target: "issue" }],
    },
  })
  writeFile(path.join(store, "capabilities", "feature", "capability.md"), "# Feature\n")
  writeJson(path.join(store, "capabilities", "classify", "profile.json"), {
    name: "classify",
    action: "classify",
    role: "utility",
    describe: "No-op classify package verification fixture.",
    inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "Issue number." }],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: 0,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [{ script: "skipAgent" }], postflight: [] },
  })
  writeFile(path.join(store, "capabilities", "classify", "capability.md"), "# Classify\n")
  writeJson(path.join(store, "capabilities", "noop", "profile.json"), {
    name: "noop",
    action: "noop",
    role: "utility",
    describe: "No-op package verification fixture.",
    inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "Issue number." }],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: 0,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [{ script: "skipAgent" }], postflight: [] },
  })
  writeFile(path.join(store, "capabilities", "noop", "capability.md"), "# Noop\n")
  writeJson(path.join(consumer, "kody.config.json"), {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/claude-haiku-4-5-20251001" },
  })
  writeJson(path.join(consumer, ".kody", "capabilities", "classify", "profile.json"), {
    name: "classify",
    role: "utility",
    describe: "Removed-script override package verification fixture.",
    inputs: [{ name: "issue", flag: "--issue", type: "int", required: true, describe: "Issue number." }],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: 0,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [{ script: "skipAgent" }], postflight: [{ script: "writeRunSummary" }] },
  })
  writeFile(path.join(consumer, ".kody", "capabilities", "classify", "capability.md"), "# Stale Classify\n")
  writeJson(path.join(consumer, ".kody", "capabilities", "feature", "profile.json"), {
    name: "feature",
    action: "feature",
    implementation: "feature",
  })
  writeFile(path.join(consumer, ".kody", "capabilities", "feature", "capability.md"), "# Stale Feature\n")

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: install })
  const bin = path.join(install, "node_modules", ".bin", "kody-engine")
  const classifyOutput = run(bin, ["classify", "--issue", "1", "--cwd", consumer], {
    cwd: consumer,
    env: { KODY_COMPANY_STORE: store, VITEST: "1" },
  })
  assert(!classifyOutput.includes("Invalid profile"), "fresh tarball install hit an Invalid profile error")
  assert(
    !classifyOutput.includes("profile references unknown scripts"),
    "fresh tarball install let a removed-script capability override shadow the store",
  )

  const featureOutput = run(bin, ["feature", "--issue", "1", "--cwd", consumer], {
    cwd: consumer,
    env: { KODY_COMPANY_STORE: store, VITEST: "1" },
  })
  assert(!featureOutput.includes("Invalid profile"), "fresh tarball install could not start feature workflow")

  process.stdout.write("package tarball verification passed\n")
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
