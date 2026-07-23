const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
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
  assert(
    !entries.some((entry) => entry.includes("/__pycache__/") || entry.endsWith(".pyc")),
    "package tarball includes Python cache artifacts",
  )

  for (const required of [
    "package/dist/bin/kody.js",
    "package/dist/implementations/run/definition.json",
    "package/dist/implementations/run/runtime.json",
    "package/dist/capabilities/run/definition.json",
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
    assetRoots: {
      capabilities: "capabilities",
      implementations: "implementations",
      workflows: "workflows",
    },
  })
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
      return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`
    }
    return JSON.stringify(value)
  }
  const writeSeparatedAsset = (id) => {
    const capability = {
      id,
      action: id,
      purpose: `No-op ${id} package verification fixture.`,
      inputSchema: {
        type: "object",
        properties: { issue: { type: "integer" } },
        required: ["issue"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
      effects: [],
      permissions: [],
      success: `${id} succeeds`,
      failure: `${id} fails`,
    }
    writeJson(path.join(store, "capabilities", id, "definition.json"), capability)
    writeFile(path.join(store, "capabilities", id, "capability.md"), `# ${id}\n`)
    writeJson(path.join(store, "implementations", id, "definition.json"), {
      id,
      capabilityRef: { kind: "capability", id },
      compatibleCapabilityRevision: createHash("sha256")
        .update(canonical(capability))
        .digest("hex"),
      type: "script",
    })
    writeJson(path.join(store, "implementations", id, "runtime.json"), {
      adapter: "kody-engine-profile",
      role: "utility",
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
  }
  writeSeparatedAsset("classify")
  writeSeparatedAsset("noop")
  writeJson(path.join(store, "workflows", "feature", "workflow.json"), {
    id: "feature",
    steps: [{ id: "run", capability: "noop" }],
  })
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
  const versionOutput = run(bin, ["version"], { cwd: consumer })
  assert(versionOutput.includes(packed.version), "fresh tarball reports the wrong version")

  const helpOutput = run(bin, ["help", "--cwd", consumer], { cwd: consumer })
  assert(
    !helpOutput.includes("classify --issue") && !helpOutput.includes("feature --issue"),
    "fresh tarball exposed removed consumer-local capabilities",
  )

  process.stdout.write("package tarball verification passed\n")
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
