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

if [[ -n "$existing" ]]; then
  echo "  reusing existing deploy PR: ${existing}"
  pr_url="$existing"
else
  # Same Tracking-Issue marker as release-prepare — non-closing reference
  # so the originating release issue stays open through the deploy step
  # while the Kody Dashboard can still link this PR to the task for preview.
  issue_arg="${KODY_ARG_ISSUE:-}"
  tracking_line=""
  if [[ "$issue_arg" =~ ^[0-9]+$ && "$issue_arg" != "0" ]]; then
    tracking_line=$'\n\nTracking-Issue: #'"${issue_arg}"
  fi
  body="Automated deploy PR opened by kody — promotes \`${default_branch}\` to \`${release_branch}\` for release **v${version}**.

Merge this PR to deploy v${version} to \`${release_branch}\`.${tracking_line}"
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

echo "RELEASE_DEPLOY_PR=${pr_url}"
echo "KODY_PR_URL=${pr_url}"

# Optional post-deploy notification (e.g. Slack ping that a deploy PR is up).
notify_status="skipped"
if [[ -n "$notify_cmd" ]]; then
  cmd="${notify_cmd//\$VERSION/$version}"
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
