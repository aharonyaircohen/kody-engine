#!/usr/bin/env bash
#
# release-deploy: open a PR from the integration branch (dev) into the
# default branch (main) — the human gate for production deploy. The
# orchestrator's chain ENDS with this PR opened; merging it is a manual
# step. No agent.
#
# Behavior:
#   - If release.devBranch is unset OR equals git.defaultBranch:
#       no-op success (single-branch repos have nothing to deploy).
#   - Else: idempotently open PR `devBranch` → `defaultBranch`. If an
#     open PR already exists for that pair, reuse its URL.
#
# After the PR is opened, runs `release.notifyCommand` (if set) as a
# best-effort post-deploy hook.
#
# Inputs (env):
#   KODY_ARG_DRY_RUN          true|false
#   KODY_ARG_ISSUE            triggering issue/PR number (optional)
#
# Config (env):
#   KODY_CFG_GIT_DEFAULTBRANCH         e.g. main
#   KODY_CFG_RELEASE_DEVBRANCH         e.g. dev (unset → no-op)
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
dev_branch="${KODY_CFG_RELEASE_DEVBRANCH:-}"
notify_cmd="${KODY_CFG_RELEASE_NOTIFYCOMMAND:-}"
timeout_ms="${KODY_CFG_RELEASE_TIMEOUTMS:-600000}"
timeout_s=$((timeout_ms / 1000))

read_pkg_version() {
  python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "unknown"
}

version=$(read_pkg_version)
echo "→ release deploy: v${version}"

# Single-branch repos: nothing to deploy.
if [[ -z "$dev_branch" || "$dev_branch" == "$default_branch" ]]; then
  echo "KODY_REASON=no devBranch configured (or equals defaultBranch) — nothing to deploy"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  echo "KODY_REASON=dry-run — would open PR ${dev_branch} → ${default_branch}"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

export HUSKY=0 SKIP_HOOKS=1 CI="${CI:-1}"

# Idempotency: reuse an open PR for this branch pair if one exists.
existing=$(gh pr list --head "$dev_branch" --base "$default_branch" --state open --json url --limit 1 2>/dev/null \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[0]["url"] if data else "")' 2>/dev/null \
  || echo "")

if [[ -n "$existing" ]]; then
  echo "  reusing existing deploy PR: ${existing}"
  pr_url="$existing"
else
  body="Automated deploy PR opened by kody — promotes \`${dev_branch}\` to \`${default_branch}\` for release **v${version}**.

Merge this PR to deploy v${version} to \`${default_branch}\`."
  if ! pr_url=$(printf '%s' "$body" | gh pr create --head "$dev_branch" --base "$default_branch" --title "deploy: ${dev_branch} → ${default_branch} (v${version})" --body-file -); then
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

echo "KODY_REASON=opened deploy PR ${dev_branch} → ${default_branch} (notify=${notify_status})"
echo "KODY_SKIP_AGENT=true"
