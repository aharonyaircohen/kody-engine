# AgentResponsibility dispatch contract

How a agentResponsibility (or any engine-side code) fires another agentAction, without
hitting the bot-self-dispatch deadlock that has bitten this project
repeatedly.

## TL;DR

Never write a bot-authored `@kody <slug>` comment to drive a stage. Use the
typed dispatch APIs instead. Humans typing `@kody …` still works — the
rule is only about the bot writing that shape back to itself.

The dispatch target IS the context. The agentAction's preflight derives
everything it needs from the issue/PR it's pointed at — no side-channel
flags via `workflow_dispatch` inputs.

| You are…                                              | Use this                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| TS code in the same run (agentAction chain, postflight)| `runAgentActionChain(name, opts)`                               |
| TS code that needs a fresh run                        | `gh workflow run kody.yml -f agentAction=<name> -f issue_number=<n>` |
| AgentResponsibility markdown (LLM-driven, has `gh` via Bash)         | `gh workflow run kody.yml -f agentAction=<name> -f issue_number=<n>` |
| A human in a comment                                  | `@kody <slug> [args]` — unchanged, still the way               |

## Why bot `@kody` comments are banned

The webhook's `dispatch.ts` filters bot-authored comments to prevent
infinite self-dispatch loops — a hard requirement after a multi-hour
outage caused by exactly that. Side effect: any agentResponsibility that posted
`gh issue comment "@kody qa-engineer …"` from inside a kody.yml run got
silently swallowed. The agentResponsibility would mark "running", wait 2h, never see a
report, mark "stalled", requeue, and loop forever.

## Runtime enforcement

`postIssueComment` / `postPrReviewComment` (`src/issue.ts`) throw
`BotDispatchCommentError` when:

1. The process is running as a bot (`GITHUB_ACTIONS=true` AND
   `GITHUB_ACTOR` matches `*[bot]` / `kody-bot` / `kodyade`, OR
   `KODY_APP_ID` is set), AND
2. The body starts with `@kody <slug>` where `<slug>` is the dispatch
   grammar (kebab-safe identifier).

Chat replies, status pings, QA reports, and prose that happens to mention
`@kody` mid-sentence are unaffected — the regex matches the start of the
body only. Non-bot callers (dashboard chat under the user's PAT) are
exempt: `isRunningAsBot()` checks `GITHUB_ACTIONS`/`GITHUB_ACTOR`,
neither of which is set in the Next.js server.

## Target-as-context

`kody.yml`'s `workflow_dispatch` already has every input a agentResponsibility needs:

- `agentAction` — picks the stage
- `issue_number` — the issue or PR the stage acts on
- `base` — optional safe branch context for agentActions that accept a base override

What a agentResponsibility does NOT pass: flags like `--scope`, `--focus`, etc. Those
live in the **target**:

- `qa-engineer` reads `--scope` from the tracking issue's title via the
  `deriveQaScopeFromIssue` preflight (parses `QA: <scope> (#<pr>)`).
- `ui-review` reads everything it needs from the PR diff and the linked
  issue.
- Future agentActions follow the same rule: if the dispatcher needs to
  pass a parameter, persist it in the target first.

This keeps `kody.yml` frozen (the "never touch YAML" rule) and makes the
dispatch surface uniform — every agentResponsibility boils down to two inputs.

## When to use `runAgentActionChain` instead

If the next stage runs IN THE SAME PROCESS — classifier → build, spec
flow, postflight → next agentAction — use `runAgentActionChain(name, opts)`.
Zero startup cost, zero webhook-filter risk.

Cross-run dispatch (`gh workflow run kody.yml`) is only needed when the
next stage must run in its own GitHub Actions run — agentResponsibilities firing under a
fast scheduler that can't afford the next stage's full cost on the same
tick.

## Lint / CI

Recommended CI gate on consumer repos: fail the build if any
`.kody/agent-responsibilities/*/agent-responsibility.md` or `.kody/agent-actions/**/*.md` body contains
`gh issue comment.*@kody` or `gh pr comment.*@kody`. Cheap grep on the
regression surface. The engine's runtime throw catches helpers that
bypass the grep; the grep catches agentResponsibility markdown the LLM follows verbatim.

## Consumer migration

For each repo running kody.yml:

1. Grep your agentResponsibilities: `rg 'gh (issue|pr) comment.*@kody' .kody/agent-responsibilities`.
   Replace every hit with `gh workflow run kody.yml -f agentAction=<name>
   -f issue_number=<n>`.
2. If the agentAction needs a parameter that isn't already in the target
   (issue body, PR diff, labels), either persist it there first OR add a
   preflight script that derives it (see `deriveQaScopeFromIssue` for
   the pattern).
3. Engine version: bump to ≥ 0.4.173 (ships the throw guard +
   `deriveQaScopeFromIssue`).
