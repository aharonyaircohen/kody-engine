# Operating Kody

How agents and operators drive Kody from GitHub.

For engine contributors: see [AGENTS.md](AGENTS.md) for the full architecture reference.

---

## 1. The core model

Kody is a **command bot**, not a chat partner. It acts only on a comment that literally contains `@kody <command>`.

A bare `@kody` on an issue starts a `run` session. A bare `@kody` on a PR does **nothing** — the configured default (`defaultPrExecutable`) points to `fix`, but the engine does not ship a `fix` executable. Only an explicit subcommand word triggers a PR command.

---

## 2. How to trigger / run a task

**Comment on an issue or PR:**

```
@kody <command> [flags]
```

The first word after `@kody` is the command. Free text after the command is passed to the agent as-is.

Examples:
- `@kody run` — start a full implementation session on an issue (default when on an issue with no command)
- `@kody run fix the failing test on line 40` — run with a specific directive
- `@kody build` — alias for `run`
- `@kody release --bump minor` — run a release from the triggering issue
- `@kody resolve` — resolve merge conflicts on a PR
- `@kody sync` — merge default branch into a PR (no agent)
- `@kody revert abc123 def456` — revert specific commits on a PR (no agent)
- `@kody merge` — squash-merge a PR when CI is green (no agent)

**Manual trigger via GitHub Actions:**

Use `workflow_dispatch` in the GitHub Actions UI and supply an issue number. No `@kody` comment is needed.

**Manual CLI:**

```bash
kody-engine run --issue <number>
```

---

## 3. Engine-shipped commands

The table below lists every command the engine ships. Individual consumer repos may define additional executables under `.kody/executables/` — those are not listed here.

| Command | Runs on | Input | Notes |
|---|---|---|---|
| `run` | Issue | Issue number | Default when bare `@kody` on an issue. `build` is an alias. |
| `release` | Issue | Issue number | Deterministic release flow: prepare → merge → publish → deploy. |
| `resolve` | PR | PR number | Rebase/merge base branch; agent resolves conflicts if any. |
| `sync` | PR | PR number | Merge base branch into PR branch, push. No agent. |
| `revert` | PR | PR number + shas | `git revert` one or more commits. No agent. |
| `merge` | PR | PR number | Squash-merge when CI is green. No agent. |
| `preview-build` | PR | PR number | Build per-PR preview; also auto-runs on `pull_request` events when `onPullRequest` is configured. |
| `job-scheduler` | — | Cron | Not comment-driven. Ticks `.kody/duties/` on a schedule. |
| `goal-scheduler` | — | Cron | Not comment-driven. Ticks `.kody/goals/` on a schedule. |

**Internal / not user commands** (engine-shipped but not comment-triggerable):

`init` · `plan-verify` · `probe-skill` · `qa-goal` · `worker-ask` · `job-tick` · `goal-tick` · `release-prepare` · `release-publish` · `release-deploy` · `serve` · `pool-serve` · `runner-serve` · `brain-serve`

---

## 4. How to re-trigger

**Post a new `@kody` comment.** Editing an existing comment has no effect — the workflow is configured to listen to `issue_comment: types: [created]` only.

Or re-run via GitHub Actions `workflow_dispatch`.

---

## 5. What NOT to do

**Do not leave a plain human comment and expect Kody to read it.**
Without `@kody`, the workflow's `if:` gate never starts the job. Kody has no "inbox" — it only acts when explicitly mentioned.

**Do not expect another bot's or agent's prose to wake Kody.**
Even with `@kody`, Kody acts on bot-authored comments only when they include an explicit resolved command (`@kody <verb>`). Plain status chatter from a bot is dropped on purpose (loop protection). A duty that posts a bare `@kody sync` will work, but plain prose with no command word will be ignored.

**Do not write `@kodyade[bot]`, `@kody-engine`, or `@kody-foo`.**
The mention regex matches only a **standalone** `@kody`. Variants like `@kodyade[bot]` or `@kody-engine` are silently ignored — Kody will not respond.

**Do not rely on a comment from a non-allowlisted user when `access.allowedAssociations` is set in `kody.config.json`.**
When this config is present, only commenters with the listed GitHub author associations (e.g. `MEMBER`, `COLLABORATOR`, `OWNER`) may trigger Kody.

---

## Reference

- Dispatch trigger logic: `src/dispatch.ts` (`hasKodyMention`, `KODY_MENTION_RE`, bot self-dispatch gate, default-executable fallback)
- Workflow template & `if:` gate: `src/scripts/initFlow.ts` (`WORKFLOW_TEMPLATE`)
- Executable catalog (source of truth for the command table): `src/executables/*/profile.json`
- Config defaults (`defaultExecutable`, `defaultPrExecutable`): `src/config.ts`
