# Release flow refactor: 4 executables → 1

Status: the merged `release/` executable now lives in `kody-store` as a company-store asset, not under `src/executables/release`.

## Goal

Replace the comment-driven release orchestrator (5 GHA runs, comment-as-state-machine) with a **single executable** that runs the entire release flow inside one GHA job. Identical user-facing behaviour; vastly simpler internals.

**Success criteria:** firing `@kody release` on the Tester repo produces a deploy PR (dev → main) whose body contains the matching CHANGELOG section. End-to-end in one workflow run.

## What changes

### Today
```
@kody release  →  release (orchestrator)
                  ├─ startFlow → posts @kody release-prepare
                  │              → release-prepare runs in a NEW workflow run
                  │                ├─ saveTaskState → posts state JSON comment
                  │                └─ advanceFlow → posts @kody release
                  ├─ mergeReleasePr → gh pr merge
                  ├─ dispatch → posts @kody release-publish
                  │              → release-publish runs in a NEW workflow run …
                  └─ … etc, 5 runs, ~5 comments, ~25 min total
```

### After
```
@kody release  →  release (single executable)
                  └─ release.sh: prepare → wait CI → merge → publish → deploy → notify
                     all in one bash script, one workflow run, ~20 min total
```

## File layout

### New (kept inside `release/`)
- `release/profile.json` — utility executable, single shell entry, minimal postflight.
- `release/release.sh` — top-level driver. ~50 lines. Sources the helpers and orchestrates.
- `release/prepare.sh` — function library: `bump_version`, `generate_changelog`, `format_changelog`, `prepend_changelog`, `open_prepare_pr`, `set_kody_release_pr_marker`.
- `release/wait.sh` — function library: `wait_for_ci <pr_number> <timeout_min>`. Polls `gh pr checks` until CLEAN/UNSTABLE clears, returns 0/1.
- `release/publish.sh` — function library: `tag_and_publish <version>`, `create_gh_release <tag>`.
- `release/deploy.sh` — function library: `open_deploy_pr <version> <issue>`, including marker-bracketed CHANGELOG section in body and idempotent `gh pr edit` on reuse.

All `.sh` files in `release/` use `function name() { ... }` form — no top-level execution.

### Deleted
- `src/executables/release-prepare/` (entire dir)
- `src/executables/release-publish/` (entire dir)
- `src/executables/release-deploy/` (entire dir)
- `src/scripts/mergeReleasePr.ts` (only used by the orchestrator postflight, gone)
- Reference removed from `src/scripts/index.ts`

### Untouched
- `startFlow.ts`, `advanceFlow.ts` — used by other orchestrators (bug, feature, plan, …). Stay.
- `waitForCi.ts` — still used by `fix-ci`. Stay. (`release/wait.sh` is a small bash port for the merged executable; we don't reuse the TS one.)
- `setLifecycleLabel`, `loadIssueContext`, `loadTaskState`, `saveTaskState`, `recordOutcome`, `notifyTerminal`, `finishFlow`, `persistFlowState`. All survive in the new profile's preflight/postflight.
- A-Guy's `kody.config.json` — unchanged (same `releaseBranch`, `notifyCommand`, etc.).
- A-Guy's `kody.yml` — unchanged.
- Dashboard's Publish button — unchanged.

## New `release/profile.json` (sketch)

```json
{
  "name": "release",
  "role": "utility",
  "phase": "shipped",
  "describe": "Single-job release flow: prepare → wait → merge → publish → deploy → notify.",
  "inputs": [
    { "name": "issue", "flag": "--issue", "type": "int", "required": true },
    { "name": "bump", "flag": "--bump", "type": "enum", "values": ["patch","minor","major"], "required": false },
    { "name": "dry-run", "flag": "--dry-run", "type": "bool", "required": false },
    { "name": "prefer", "flag": "--prefer", "type": "enum", "values": ["ours","theirs"], "required": false }
  ],
  "claudeCode": { "maxTurns": 0, "permissionMode": "default", "tools": [], "hooks": [], "skills": [], "commands": [], "subagents": [], "plugins": [], "mcpServers": [] },
  "scripts": {
    "preflight": [
      { "script": "setLifecycleLabel", "with": { "label": "kody-flow:release", "color": "5319e7", "description": "kody flow: release" } },
      { "script": "loadIssueContext" },
      { "script": "loadTaskState" },
      { "shell": "release.sh" },
      { "script": "skipAgent" }
    ],
    "postflight": [
      { "script": "recordOutcome" },
      { "script": "saveTaskState" },
      { "script": "finishFlow", "with": { "reason": "release-completed", "label": "kody:done", "color": "0e8a16", "description": "kody: release complete" }, "runWhen": { "data.action.type": "RELEASE_COMPLETED" } },
      { "script": "finishFlow", "with": { "reason": "release-failed", "label": "kody:failed", "color": "e11d21", "description": "kody: release flow failed" }, "runWhen": { "data.action.type": "RELEASE_FAILED" } }
    ]
  }
}
```

`release.sh` writes `KODY_REASON=` + a recorded outcome in stdout. `recordOutcome` postflight maps shell signals to action types.

## release.sh (sketch)

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(dirname "$0")"
source "$HERE/prepare.sh"
source "$HERE/wait.sh"
source "$HERE/publish.sh"
source "$HERE/deploy.sh"

issue="${KODY_ARG_ISSUE:?required}"
bump="${KODY_ARG_BUMP:-patch}"
dry_run="${KODY_ARG_DRY_RUN:-false}"
prefer="${KODY_ARG_PREFER:-}"

default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
release_branch="${KODY_CFG_RELEASE_RELEASEBRANCH:-}"
notify_cmd="${KODY_CFG_RELEASE_NOTIFYCOMMAND:-}"
publish_cmd="${KODY_CFG_RELEASE_PUBLISHCOMMAND:-}"

trap 'echo "KODY_REASON=release failed during $current_step"; echo "RELEASE_FAILED=true"; echo "KODY_SKIP_AGENT=true"; exit 1' ERR

current_step="prepare"
echo "→ release: issue=#${issue} bump=${bump}"
old_version=$(read_pkg_version)
new_version=$(bump_version "$old_version" "$bump")
prep_pr_url=$(open_prepare_pr "$new_version" "$issue" "$prefer")
[[ "$dry_run" == "true" ]] && { echo "KODY_REASON=dry-run done"; exit 0; }

current_step="wait_ci"
prep_pr_num="${prep_pr_url##*/}"
wait_for_ci "$prep_pr_num" 60

current_step="merge"
gh pr merge "$prep_pr_num" --merge --admin

current_step="publish"
git fetch origin "$default_branch" --tags
git checkout "$default_branch"
git reset --hard "origin/$default_branch"
tag_and_publish "$new_version" "$publish_cmd"
release_url=$(create_gh_release "v${new_version}")

current_step="deploy"
deploy_pr_url=$(open_deploy_pr "$new_version" "$issue" "$default_branch" "$release_branch")

current_step="notify"
if [[ -n "$notify_cmd" ]]; then
  cmd="${notify_cmd//\$VERSION/$new_version}"
  cmd="${cmd//\$DEPLOY_PR_URL/$deploy_pr_url}"
  timeout 60 bash -c "$cmd" || echo "[release] notify failed (non-fatal)" >&2
fi

echo "KODY_PR_URL=${deploy_pr_url}"
echo "KODY_REASON=release v${new_version} complete"
echo "RELEASE_COMPLETED=true"
echo "KODY_SKIP_AGENT=true"
```

## Feature preservation checklist

| Feature                                     | Status                                  |
|---------------------------------------------|-----------------------------------------|
| Version bump (patch/minor/major)            | ✓ via `bump` input                      |
| `KODY_CFG_RELEASE_VERSIONFILES` honored     | ✓ in `prepare.sh`                       |
| CHANGELOG generation from git log buckets   | ✓                                        |
| Prepare PR with body + `Tracking-Issue`     | ✓                                        |
| `kody-release-pr:` marker on issue          | ✓                                        |
| Wait for prepare PR CI before merging       | ✓ (was 0.3.68 fix)                      |
| `gh pr merge --admin` (auto-merge)          | ✓                                        |
| Tag + push                                  | ✓                                        |
| `KODY_CFG_RELEASE_PUBLISHCOMMAND` runs      | ✓                                        |
| Draft GH release flag                       | ✓                                        |
| Deploy PR opened (dev → main)               | ✓                                        |
| Deploy PR body has marker-bracketed changelog | ✓ (handles `## v0.25.5 — date` format)|
| Deploy PR reuse + body refresh on re-run    | ✓                                        |
| `kody-release-pr` marker pivot to deploy PR | ✓                                        |
| `notifyCommand` `$VERSION` substitution     | ✓                                        |
| `notifyCommand` `$DEPLOY_PR_URL` substitution | ✓                                      |
| Lifecycle labels (`kody-flow:release` → `kody:done`) | ✓                                |
| `dry-run` flag                              | ✓                                        |
| `prefer ours` / `prefer theirs` on collision | ✓                                       |
| Idempotent re-runs (already-merged, existing-PR) | ✓                                   |
| **Lost (acceptable):** auto-fix-ci on prepare-PR CI failure  | ✗ — fail-fast instead. |
| **Lost (acceptable):** waitForCi on deploy PR after open     | ✗ — exits after deploy PR opens. |

## Migration steps

1. **Create new files.** Don't delete anything yet.
   - Write the four helper `.sh` files (port logic from the existing `prepare.sh` / `publish.sh` / `deploy.sh` into function bodies).
   - Write `release.sh` driver.
   - Write `wait.sh` (small bash port of `waitForCi.ts` — uses `gh pr checks <N>`).
2. **Replace `release/profile.json`** with the utility-style profile.
3. **Run `pnpm vitest run tests/unit`.** Should pass; tests don't reference the old release executables in a way that breaks.
4. **`pnpm build`** to bundle.
5. **`npm publish --tag beta --access public`** — note `--tag beta`, NOT `@latest`. A-Guy stays on whatever `@latest` resolves to.
6. **Pin Tester's `kody.yml`** to the exact version: `npx -y -p @kody-ade/kody-engine@<X.Y.Z> kody-engine`. Push.
7. **Set up Tester for a meaningful release:**
   - Ensure Tester has `dev` and `main` branches with a divergence (some commits on dev not on main).
   - Patch Tester's `kody.config.json`: `git.defaultBranch="dev"`, `release.releaseBranch="main"`. Push to dev.
8. **Fire `@kody release`** on a fresh test issue (dashboard Publish button or manual `gh issue comment`).
9. **Watch the workflow run.** Should complete in one job, end with deploy PR URL printed.
10. **Verify:**
    - Deploy PR exists, base=main, head=dev.
    - Deploy PR body contains marker-bracketed CHANGELOG section with the bumped-version's commits.
    - GH release `v<X.Y.Z>` created.
    - Issue labelled `kody:done`.
11. **If any step fails**, read run log → patch → bump version → re-publish to `@beta` → re-pin Tester → re-fire. Loop until success.
12. **On success: promote to `@latest`** with `npm dist-tag add @kody-ade/kody-engine@<X.Y.Z> latest`. A-Guy now picks it up on next workflow.
13. **Delete old executables and `mergeReleasePr.ts`** in a follow-up commit. Bump again, publish.

## Rollback

If the new merged executable misbehaves after `@latest` promotion:

```bash
npm dist-tag add @kody-ade/kody-engine@0.3.69 latest
```

A-Guy reverts on next CI run. No code revert needed — old code is still installable by version pin.

## Tester success signal (the only thing that matters)

After step 9, this command must succeed:

```bash
gh pr list --repo aharonyaircohen/Kody-Engine-Tester --base main --head dev --state open --json body --jq '.[0].body'
```

…and the printed body must contain `<!-- kody-changelog-start -->` followed by `### Features` (or whatever bucket label) and at least one bullet point with a real commit reference.
