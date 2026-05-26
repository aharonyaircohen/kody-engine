#!/usr/bin/env bash
#
# release/release.sh — single-job release driver.
#
# Replaces the orchestrator + 3-executable chain with one linear bash flow:
#   prepare → wait CI → merge → publish → deploy → notify
#
# Inputs (env, set by the executor):
#   KODY_ARG_ISSUE      triggering issue number (required)
#   KODY_ARG_BUMP       patch|minor|major (default: patch)
#   KODY_ARG_DRY_RUN    true|false
#   KODY_ARG_PREFER     ours|theirs (optional; for branch collision)
#
# Config (env, flattened from kody.config.json):
#   KODY_CFG_GIT_DEFAULTBRANCH         e.g. dev
#   KODY_CFG_RELEASE_RELEASEBRANCH     e.g. main (unset → deploy is no-op)
#   KODY_CFG_RELEASE_VERSIONFILES      JSON array
#   KODY_CFG_RELEASE_PUBLISHCOMMAND    optional; $VERSION substituted
#   KODY_CFG_RELEASE_NOTIFYCOMMAND     optional; $VERSION + $DEPLOY_PR_URL substituted
#   KODY_CFG_RELEASE_DRAFTRELEASE      "true" → create as draft
#   KODY_CFG_RELEASE_TIMEOUTMS         per-command timeout in ms
#
# Stdout signals:
#   KODY_PR_URL=<deploy PR url>
#   KODY_REASON=<text>
#   KODY_SKIP_AGENT=true
#   RELEASE_COMPLETED=true | RELEASE_FAILED=true (consumed by recordOutcome → finishFlow)

set -euo pipefail

HERE="$(dirname "$0")"
# shellcheck source=prepare.sh
source "$HERE/prepare.sh"
# shellcheck source=wait.sh
source "$HERE/wait.sh"
# shellcheck source=publish.sh
source "$HERE/publish.sh"
# shellcheck source=deploy.sh
source "$HERE/deploy.sh"

issue="${KODY_ARG_ISSUE:?required}"
bump="${KODY_ARG_BUMP:-patch}"
dry_run="${KODY_ARG_DRY_RUN:-false}"
prefer="${KODY_ARG_PREFER:-}"

default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
notify_cmd="${KODY_CFG_RELEASE_NOTIFYCOMMAND:-}"
notify_timeout_s=$(( ${KODY_CFG_RELEASE_TIMEOUTMS:-600000} / 1000 ))

# Tracks where we were when an error fired, for clearer failure messages.
current_step="init"

on_error() {
  local rc=$?
  echo "[release] FAILED during step '${current_step}' (exit ${rc})" >&2
  echo "KODY_REASON=release failed during ${current_step}"
  echo "RELEASE_FAILED=true"
  echo "KODY_SKIP_AGENT=true"
  exit "$rc"
}
trap on_error ERR

if [[ ! -f package.json ]]; then
  echo "[release] package.json not found in $(pwd)" >&2
  echo "KODY_REASON=release: package.json not found"
  echo "RELEASE_FAILED=true"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

# ── 1. Prepare ────────────────────────────────────────────────────────────
current_step="prepare"
old_version=$(read_pkg_version)
new_version=$(bump_version "$old_version" "$bump")
tag="v${new_version}"
echo "→ release: issue=#${issue} bump=${bump} ${old_version} → ${new_version}"

if [[ "$dry_run" == "true" ]]; then
  echo "RELEASE_PLAN=bump=${new_version} tag=${tag}"
  echo "KODY_REASON=dry-run — would bump to ${new_version}${prefer:+ (--prefer ${prefer})}"
  echo "RELEASE_COMPLETED=true"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

prep_pr_url=$(open_prepare_pr "$new_version" "$issue" "$prefer")
if [[ -z "$prep_pr_url" ]]; then
  echo "[release] prepare returned no PR URL" >&2
  exit 1
fi
echo "✓ prepare: ${prep_pr_url}"
set_kody_release_pr_marker "$issue" "$prep_pr_url"

# ── 2. Wait for prepare PR CI ─────────────────────────────────────────────
current_step="wait_prepare_ci"
prep_pr_num="${prep_pr_url##*/}"
wait_for_ci "$prep_pr_num" 60 || {
  echo "[release] CI failed/timeout on prepare PR #${prep_pr_num}" >&2
  exit 1
}

# ── 3. Merge prepare PR ───────────────────────────────────────────────────
current_step="merge"
if gh pr merge "$prep_pr_num" --merge --admin 2>&1; then
  echo "✓ merged: PR #${prep_pr_num}"
elif gh pr merge "$prep_pr_num" --merge 2>&1 | grep -qi "already merged"; then
  echo "  (already merged)"
else
  echo "[release] gh pr merge failed for PR #${prep_pr_num}" >&2
  exit 1
fi

# ── 4. Publish (tag + GH release) ─────────────────────────────────────────
current_step="publish"
git fetch origin "$default_branch" --tags
git checkout "$default_branch"
git reset --hard "origin/$default_branch"

# Sanity: confirm the bump landed on the integration branch.
landed_version=$(read_pkg_version)
if [[ "$landed_version" != "$new_version" ]]; then
  echo "[release] WARN: package.json on ${default_branch} is ${landed_version}, expected ${new_version} after merge" >&2
fi

publish_status=$(tag_and_publish "$new_version")
release_url=$(create_gh_release "$tag" || echo "")
echo "✓ publish: tag=${tag} status=${publish_status} release_url=${release_url:-<none>}"

if [[ "$publish_status" == "failed" ]]; then
  echo "[release] publishCommand failed but tag + GH release exist" >&2
  echo "KODY_REASON=tag + GH release created, but publishCommand failed"
  echo "RELEASE_FAILED=true"
  echo "KODY_SKIP_AGENT=true"
  exit 1
fi

# ── 5. Deploy PR (default → release branch) ───────────────────────────────
# Distinguish three outcomes: rc!=0 is a real failure (do NOT mask as no-op);
# rc==0 + empty URL is a genuine single-branch no-op; rc==0 + URL is success.
current_step="deploy"
set +e
deploy_pr_url=$(open_deploy_pr "$new_version" "$issue")
deploy_rc=$?
set -e
release_branch="${KODY_CFG_RELEASE_RELEASEBRANCH:-}"
if [[ "$deploy_rc" -ne 0 ]]; then
  echo "[release] deploy step failed (rc=${deploy_rc}) — published v${new_version} but the ${default_branch}→${release_branch} promotion PR was not opened" >&2
  echo "KODY_REASON=release v${new_version}: published, but the ${default_branch}→${release_branch} deploy PR failed"
  echo "RELEASE_TAG=${tag}"
  [[ -n "$release_url" ]] && echo "RELEASE_URL=${release_url}"
  echo "RELEASE_FAILED=true"
  exit 1
fi
if [[ -z "$deploy_pr_url" ]]; then
  echo "  (deploy: no-op — single-branch repo)"
else
  echo "✓ deploy: ${deploy_pr_url}"
fi

# ── 6. Notify ─────────────────────────────────────────────────────────────
current_step="notify"
notify_status="skipped"
if [[ -n "$notify_cmd" ]]; then
  cmd="${notify_cmd//\$VERSION/$new_version}"
  cmd="${cmd//\$DEPLOY_PR_URL/${deploy_pr_url:-}}"
  echo "  notify: ${cmd}"
  if timeout "$notify_timeout_s" bash -c "$cmd"; then
    notify_status="ok"
  else
    notify_status="failed"
    echo "[release] notifyCommand failed (non-fatal)" >&2
  fi
fi

# ── 7. Done ───────────────────────────────────────────────────────────────
current_step="done"
[[ -n "$deploy_pr_url" ]] && echo "KODY_PR_URL=${deploy_pr_url}"
echo "RELEASE_TAG=${tag}"
[[ -n "$release_url" ]] && echo "RELEASE_URL=${release_url}"
[[ -n "$deploy_pr_url" ]] && echo "RELEASE_DEPLOY_PR=${deploy_pr_url}"
echo "KODY_REASON=release v${new_version} complete (notify=${notify_status})"
echo "RELEASE_COMPLETED=true"
echo "KODY_SKIP_AGENT=true"
