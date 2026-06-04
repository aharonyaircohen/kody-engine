# Operating Kody

How agents and operators drive Kody from GitHub.

For engine contributors: see [AGENTS.md](AGENTS.md) for the full architecture reference.

---

## 1. The core model

Kody is a **command bot**, not a chat partner. It acts only on a comment that literally contains `@kody <command>`.

A bare `@kody` on an issue starts a `run` session. A bare `@kody` on a PR starts a `fix` session. Everything else requires an explicit subcommand word.

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
- `@kody plan` — write an implementation plan, no code
- `@kody fix the type error` — apply feedback to a PR (default when on a PR with no command)
- `@kody build` — alias for `run`
- `@kody fix-ci --run-id 123` — fix a specific failing CI run

**Manual trigger via GitHub Actions:**

Use `workflow_dispatch` in the GitHub Actions UI and supply an issue number. No `@kody` comment is needed.

**Manual CLI:**

```bash
npx @kody-ade/kody-engine@latest kody-engine ci --issue <number>
```

---

## 3. Where each command runs

| Command(s) | Runs on | Input |
|---|---|---|
| `run`, `plan`, `research`, `classify`, `feature`, `bug`, `chore`, `reproduce` | Issue | Issue number |
| `fix`, `fix-ci`, `resolve`, `sync`, `revert`, `review`, `ui-review`, `qa-engineer` | PR | PR number |
| `release`, `release-prepare`, `release-publish`, `release-deploy` | Issue | Issue number |
| `job-scheduler`, `goal-scheduler` | — | Cron schedule (not comment-driven) |
| `init` | — | CLI only |

**Watch executables** (`job-scheduler`, `goal-scheduler`) fire on a cron schedule. They are not triggered by comments — they run unattended on every wake.

---

## 4. How to re-trigger

**Post a new `@kody` comment.** Editing an existing comment has no effect — the workflow is configured to listen to `issue_comment: types: [created]` only.

Or re-run via GitHub Actions `workflow_dispatch`.

---

## 5. What NOT to do

**Do not leave a plain human comment and expect Kody to read it.**
Without `@kody`, the workflow's `if:` gate never starts the job. Kody has no "inbox" — it only acts when explicitly mentioned.

**Do not expect another bot's or agent's prose to wake Kody.**
Even with `@kody`, Kody acts on bot-authored comments only when they include an explicit resolved command (`@kody <verb>`). Plain status chatter from a bot is dropped on purpose (loop protection). A duty that posts a bare `@kody sync` with no command word will be ignored.

**Do not write `@kodyade[bot]`, `@kody-engine`, or `@kody-foo`.**
The mention regex matches only a **standalone** `@kody`. Variants like `@kodyade[bot]` or `@kody-engine` are silently ignored — Kody will not respond.

**Do not rely on a comment from a non-allowlisted user when `access.allowedAssociations` is set in `kody.config.json`.**
When this config is present, only commenters with the listed GitHub author associations (e.g. `MEMBER`, `COLLABORATOR`, `OWNER`) may trigger Kody.

---

## Reference

- Dispatch trigger logic: `src/dispatch.ts` (`hasKodyMention`, `KODY_MENTION_RE`, bot self-dispatch gate, default-executable fallback)
- Workflow template & `if:` gate: `src/scripts/initFlow.ts` (`WORKFLOW_TEMPLATE`)
