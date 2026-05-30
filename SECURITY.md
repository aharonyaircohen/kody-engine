# Security Policy

kody runs an autonomous coding agent inside your CI with access to a GitHub
token and your model-provider keys. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via either:

- GitHub's [private security advisories](https://github.com/aharonyaircohen/kody-engine/security/advisories/new) (preferred), or
- email **office@guykoren.co.il** with subject `kody-engine security`.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal repro repo helps),
- the engine version (`@kody-ade/kody-engine@X.Y.Z`) and Node version.

You'll get an acknowledgement within **5 business days**. We'll work with you on
a fix and coordinate a disclosure timeline, and credit you in the release notes
unless you prefer to remain anonymous.

## Supported versions

Only the latest published `@kody-ade/kody-engine` release receives security
fixes. Consumer repos are version-pinned in their `kody.yml`; upgrade by
resyncing the workflow to the latest engine version.

## Scope & operational notes

kody is designed to run in CI with scoped credentials. When deploying it:

- **Use a least-privilege token.** kody needs `contents`, `pull-requests`, and
  `issues` write. A dedicated PAT (`KODY_TOKEN`) is recommended over the broad
  default `GITHUB_TOKEN` only where downstream-CI triggering is required —
  scope it to the single consumer repo.
- **Model-provider keys are secrets.** Store them as encrypted Actions secrets,
  never in committed config. The engine reads them from `process.env` only.
- **The agent commits through `commitAndPush`**, which enforces a `.kody/` write
  allowlist — the agent cannot write arbitrary runtime state. See the
  `.kody/` write allowlist invariant in [AGENTS.md](AGENTS.md).
- **Locked-toolbox mode** (`tools:` frontmatter on a job) revokes `Bash` and
  shell access for that job, restricting it to a fixed set of high-level MCP
  intents. Prefer it for any job that doesn't need a general shell.

Treat any repo where kody runs as one where an automated agent can open PRs and
push to branches. Review kody's PRs as you would any contributor's.
