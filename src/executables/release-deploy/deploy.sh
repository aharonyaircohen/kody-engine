#!/usr/bin/env bash
#
# release-deploy: open a PR from the integration branch (git.defaultBranch)
# into the production target (release.releaseBranch) — the human gate for
# production deploy. The orchestrator's chain ENDS with this PR opened;
# merging it is a manual step. No agent.
#
# Behavior:
#   - If release.releaseBranch is unset OR equals git.defaultBranch:
#       no-op success (single-branch repos have nothing to deploy).
#   - Else: idempotently open PR `defaultBranch` → `releaseBranch`. If an
#     open PR for that pair already exists, reuse its URL.
#
# After the PR is opened, runs `release.notifyCommand` (if set) as a
# best-effort post-deploy hook.
#
# Inputs (env):
#   KODY_ARG_DRY_RUN          true|false
#   KODY_ARG_ISSUE            triggering issue/PR number (optional)
#
# Config (env):
#   KODY_CFG_GIT_DEFAULTBRANCH         e.g. dev
#   KODY_CFG_RELEASE_RELEASEBRANCH     e.g. main (unset → no-op)
#   KODY_CFG_RELEASE_NOTIFYCOMMAND     optional; $VERSION substituted
#   KODY_CFG_RELEASE_TIMEOUTMS         per-command timeout in ms (default 600000)
#
# Stdout signals:
#   KODY_PR_URL=<deploy PR url>
#   KODY_REASON=<text>
#   KODY_SKIP_AGENT=true

set -euo pipefail

dry_run="${KODY_ARG_DRY_RUN:-false}"
default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
release_branch="${KODY_CFG_RELEASE_RELEASEBRANCH:-}"
notify_cmd="${KODY_CFG_RELEASE_NOTIFYCOMMAND:-}"
timeout_ms="${KODY_CFG_RELEASE_TIMEOUTMS:-600000}"
timeout_s=$((timeout_ms / 1000))

# Read version from the integration branch tip (where the bump commit lives),
# not from the local working tree (the workflow may have checked out another
# branch). Falls back to local package.json if the fetch fails.
read_version() {
  local branch="$1"
  if git fetch origin "$branch" --quiet 2>/dev/null; then
    if pkg=$(git show "origin/${branch}:package.json" 2>/dev/null); then
      echo "$pkg" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])" 2>/dev/null && return
    fi
  fi
  python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "unknown"
}

version=$(read_version "$default_branch")
echo "→ release deploy: v${version}"

# Read the CHANGELOG section for $version from the integration branch
# (where release-prepare just committed it). Handles both header shapes
# observed in the wild: `## [0.25.0] - 2026-04-15` and `## 0.22.0 (...)`.
# Prints the body lines (without the matched header). Empty stdout =
# fall back to the minimal PR body — never break the release.
read_changelog_section() {
  local branch="$1" ver="$2" raw=""
  if ! raw=$(git show "origin/${branch}:CHANGELOG.md" 2>/dev/null); then
    return 0
  fi
  printf '%s' "$raw" | awk -v ver="$ver" '
    BEGIN { capture = 0 }
    # Match all observed header shapes:
    #   "## [0.25.0] - 2026-04-15"   (bracketed, dash separator)
    #   "## 0.22.0 (2026-03-25)"     (bare, parenthesized date)
    #   "## v0.25.5 — 2026-05-05"    (v-prefixed, em-dash, kody release-prepare style)
    /^##[[:space:]]/ {
      if (capture) { exit }
      header = $0
      sub(/^##[[:space:]]+/, "", header)
      sub(/^\[/, "", header); sub(/\].*/, "", header)
      sub(/[[:space:]].*/, "", header)
      sub(/[(].*/, "", header)
      sub(/^v/, "", header)
      if (header == ver) { capture = 1; next }
    }
    capture { print }
  ' | awk '
    # Trim leading and trailing blank lines from the captured block.
    NF { if (!started) started = 1; out[++n] = $0; last = n; next }
    started { out[++n] = $0 }
    END { for (i = 1; i <= last; i++) print out[i] }
  '
}

changelog_section=$(read_changelog_section "$default_branch" "$version" || true)
if [[ -z "$changelog_section" ]]; then
  echo "  no CHANGELOG section for v${version} on origin/${default_branch} — using minimal PR body"
fi

# Build the kody-managed body block. A marker pair lets us update the
# section idempotently on re-runs without clobbering anything a human
# pasted outside the markers.
build_pr_body() {
  local tracking_line="$1"
  printf 'Automated deploy PR opened by kody — promotes `%s` to `%s` for release **v%s**.\n\n' \
    "$default_branch" "$release_branch" "$version"
  if [[ -n "$changelog_section" ]]; then
    printf '<!-- kody-changelog-start -->\n## What'\''s changing in v%s\n\n%s\n<!-- kody-changelog-end -->\n\n' \
      "$version" "$changelog_section"
  fi
  printf 'Merge this PR to deploy v%s to `%s`.%s\n' \
    "$version" "$release_branch" "$tracking_line"
}

# Single-branch repos: nothing to deploy.
if [[ -z "$release_branch" || "$release_branch" == "$default_branch" ]]; then
  echo "KODY_REASON=no releaseBranch configured (or equals defaultBranch) — nothing to deploy"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  echo "KODY_REASON=dry-run — would open PR ${default_branch} → ${release_branch}"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

export HUSKY=0 SKIP_HOOKS=1 CI="${CI:-1}"

# Idempotency: reuse an open PR for this branch pair if one exists.
existing=$(gh pr list --head "$default_branch" --base "$release_branch" --state open --json url --limit 1 2>/dev/null \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[0]["url"] if data else "")' 2>/dev/null \
  || echo "")

# Hoisted so the kody-release-pr marker write below also runs in the
# reuse-existing-PR path.
issue_arg="${KODY_ARG_ISSUE:-}"

# Same Tracking-Issue marker as release-prepare — non-closing reference
# so the originating release issue stays open through the deploy step
# while the Kody Dashboard can still link this PR to the task for preview.
tracking_line=""
if [[ "$issue_arg" =~ ^[0-9]+$ && "$issue_arg" != "0" ]]; then
  tracking_line=$'\n\nTracking-Issue: #'"${issue_arg}"
fi
body=$(build_pr_body "$tracking_line")

# GitHub rejects a PR body over 65536 chars (GraphQL createPullRequest). A
# large accumulated CHANGELOG section can blow past it, so clamp: drop the
# changelog to a budget and rebuild, then hard-truncate as a final guard.
body_max=65000
if (( ${#body} > body_max )); then
  echo "[kody release-deploy] PR body ${#body} chars > ${body_max} — truncating changelog" >&2
  budget=$(( body_max - 2000 ))
  changelog_section="${changelog_section:0:budget}"$'\n\n_…changelog truncated; see CHANGELOG.md on the branch._'
  body=$(build_pr_body "$tracking_line")
  (( ${#body} > body_max )) && body="${body:0:body_max}"
fi

if [[ -n "$existing" ]]; then
  echo "  reusing existing deploy PR: ${existing}"
  pr_url="$existing"
  # Refresh the body so re-runs converge on the current changelog. Best-
  # effort: a failed edit (e.g. permission-denied) shouldn't fail the
  # release — the PR already exists and its title/branch are unchanged.
  if ! printf '%s' "$body" | gh pr edit "$pr_url" --body-file - >/dev/null 2>&1; then
    echo "[kody release-deploy] WARN: failed to refresh deploy PR body" >&2
  fi
else
  if ! pr_url=$(printf '%s' "$body" | gh pr create --head "$default_branch" --base "$release_branch" --title "deploy: ${default_branch} → ${release_branch} (v${version})" --body-file -); then
    echo "KODY_REASON=release deploy: gh pr create failed"
    echo "KODY_SKIP_AGENT=true"
    exit 1
  fi
fi

if [[ -z "$pr_url" ]]; then
  echo "KODY_REASON=release deploy: empty PR URL after gh pr create"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

# Persist the deploy-PR marker on the originating issue body. Mirrors the
# release-prepare path — the issue body is owned by the orchestrator, so
# this signal survives any @kody fix that overwrites the PR body. The
# marker replaces the prepare-PR ref so the dashboard pivots to the deploy
# PR (the now-current task) automatically.
if [[ "${issue_arg:-}" =~ ^[0-9]+$ && "${issue_arg:-0}" != "0" ]]; then
  pr_number="${pr_url##*/}"
  if [[ "$pr_number" =~ ^[0-9]+$ ]]; then
    cur_body=$(gh issue view "$issue_arg" --json body -q .body 2>/dev/null || echo "")
    cleaned_body=$(printf '%s' "$cur_body" | sed -E '/<!-- kody-release-pr:[^>]*-->/d')
    {
      printf '%s' "$cleaned_body"
      printf '\n\n<!-- kody-release-pr: #%s -->\n' "$pr_number"
    } | gh issue edit "$issue_arg" --body-file - >/dev/null 2>&1 || \
      echo "[kody release-deploy] WARN: failed to write kody-release-pr marker to issue #${issue_arg}"
  fi
fi

echo "RELEASE_DEPLOY_PR=${pr_url}"
echo "KODY_PR_URL=${pr_url}"

# Optional post-deploy notification (e.g. Slack ping that a deploy PR is up).
# Substituted placeholders in the configured command:
#   $VERSION         — release version (e.g. 0.25.4)
#   $DEPLOY_PR_URL   — URL of the deploy PR just opened/reused
# The notifyCommand can use $DEPLOY_PR_URL to pull real content (e.g.
# `gh pr view $DEPLOY_PR_URL --json body --jq .body`) instead of
# rendering a hardcoded one-liner.
notify_status="skipped"
if [[ -n "$notify_cmd" ]]; then
  cmd="${notify_cmd//\$VERSION/$version}"
  cmd="${cmd//\$DEPLOY_PR_URL/$pr_url}"
  echo "  notify: ${cmd}"
  if timeout "${timeout_s}" bash -c "$cmd"; then
    notify_status="ok"
  else
    notify_status="failed"
    echo "[kody release-deploy] notifyCommand failed (non-fatal)" >&2
  fi
fi

echo "KODY_REASON=opened deploy PR ${default_branch} → ${release_branch} (notify=${notify_status})"
echo "KODY_SKIP_AGENT=true"
