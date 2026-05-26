#!/usr/bin/env bash
#
# release/deploy.sh — function library for the deploy phase.
#
# Functions:
#   read_changelog_section <branch> <ver>   -> prints the body of the matching ## header block
#   build_pr_body <ver> <changelog> <default_branch> <release_branch> <issue>
#                                            -> echoes the deploy PR body
#   open_deploy_pr <new_version> <issue>    -> echoes deploy PR URL (or empty if no-op)

# shellcheck disable=SC2148

# Extract the section for $ver from CHANGELOG.md fetched from origin/$branch.
# Handles three header shapes:
#   "## [0.25.0] - 2026-04-15"   (bracketed, dash separator)
#   "## 0.22.0 (2026-03-25)"     (bare, parenthesized date)
#   "## v0.25.5 — 2026-05-05"    (v-prefixed, em-dash, kody style)
read_changelog_section() {
  local branch="$1" ver="$2" raw=""
  if ! raw=$(git show "origin/${branch}:CHANGELOG.md" 2>/dev/null); then
    return 0
  fi
  printf '%s' "$raw" | awk -v ver="$ver" '
    BEGIN { capture = 0 }
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
    NF { if (!started) started = 1; out[++n] = $0; last = n; next }
    started { out[++n] = $0 }
    END { for (i = 1; i <= last; i++) print out[i] }
  '
}

build_pr_body() {
  local ver="$1" changelog="$2" default_branch="$3" release_branch="$4" issue="$5"
  printf 'Automated deploy PR opened by kody — promotes `%s` to `%s` for release **v%s**.\n\n' \
    "$default_branch" "$release_branch" "$ver"
  if [[ -n "$changelog" ]]; then
    printf '<!-- kody-changelog-start -->\n## What'\''s changing in v%s\n\n%s\n<!-- kody-changelog-end -->\n\n' \
      "$ver" "$changelog"
  fi
  printf 'Merge this PR to deploy v%s to `%s`.' "$ver" "$release_branch"
  if [[ "$issue" =~ ^[0-9]+$ && "$issue" != "0" ]]; then
    printf '\n\nTracking-Issue: #%s\n' "$issue"
  else
    printf '\n'
  fi
}

# Open or reuse the deploy PR (default_branch → release_branch).
# Returns the PR URL via stdout. Empty stdout = single-branch repo, no-op.
# Refreshes existing PR's body via gh pr edit (idempotent).
open_deploy_pr() {
  local new_version="$1"
  local issue_arg="$2"
  local default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
  local release_branch="${KODY_CFG_RELEASE_RELEASEBRANCH:-}"

  # Single-branch repos: nothing to deploy.
  if [[ -z "$release_branch" || "$release_branch" == "$default_branch" ]]; then
    echo "[deploy] no releaseBranch configured (or equals defaultBranch) — skipping deploy PR" >&2
    echo ""
    return 0
  fi

  # Read the section from the integration branch (where release-prepare just merged).
  local changelog_section
  changelog_section=$(read_changelog_section "$default_branch" "$new_version" || true)
  if [[ -z "$changelog_section" ]]; then
    echo "[deploy] no CHANGELOG section for v${new_version} on origin/${default_branch} — minimal body" >&2
  fi

  local body
  body=$(build_pr_body "$new_version" "$changelog_section" "$default_branch" "$release_branch" "$issue_arg")

  # GitHub rejects a PR body over 65536 chars (GraphQL createPullRequest).
  # A large accumulated CHANGELOG section can blow past it, so clamp: drop the
  # changelog to a budget and rebuild, then hard-truncate as a final guard.
  local body_max=65000
  if (( ${#body} > body_max )); then
    echo "[deploy] PR body ${#body} chars > ${body_max} — truncating changelog" >&2
    local budget=$(( body_max - 2000 ))
    changelog_section="${changelog_section:0:budget}"$'\n\n_…changelog truncated; see CHANGELOG.md on the branch._'
    body=$(build_pr_body "$new_version" "$changelog_section" "$default_branch" "$release_branch" "$issue_arg")
    (( ${#body} > body_max )) && body="${body:0:body_max}"
  fi

  # Idempotency: reuse an open PR for this branch pair if one exists.
  local existing pr_url
  existing=$(gh pr list --head "$default_branch" --base "$release_branch" --state open --json url --limit 1 2>/dev/null \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[0]["url"] if data else "")' 2>/dev/null \
    || echo "")

  if [[ -n "$existing" ]]; then
    echo "  reusing existing deploy PR: ${existing}" >&2
    pr_url="$existing"
    # Refresh body via REST API instead of `gh pr edit` — gh's edit path
    # uses GraphQL which requires read:org scope on KODY_TOKEN. REST PATCH
    # works with plain `repo` scope.
    local pr_num="${pr_url##*/}"
    local owner="${KODY_CFG_GITHUB_OWNER:-}"
    local repo="${KODY_CFG_GITHUB_REPO:-}"
    if [[ -z "$owner" || -z "$repo" ]]; then
      # Fall back to extracting from the URL if config missing.
      local stripped="${pr_url#https://github.com/}"
      owner="${stripped%%/*}"
      repo=$(echo "$stripped" | cut -d/ -f2)
    fi
    local edit_err
    local refreshed_title="deploy: ${default_branch} → ${release_branch} (v${new_version})"
    if ! edit_err=$(gh api --method PATCH "repos/${owner}/${repo}/pulls/${pr_num}" \
        -f title="$refreshed_title" \
        -f body="$body" 2>&1 >/dev/null); then
      echo "[deploy] WARN: failed to refresh deploy PR title+body for ${pr_url}: ${edit_err}" >&2
    else
      echo "  refreshed deploy PR title + body via REST" >&2
    fi
  else
    if ! pr_url=$(printf '%s' "$body" | gh pr create --head "$default_branch" --base "$release_branch" --title "deploy: ${default_branch} → ${release_branch} (v${new_version})" --body-file -); then
      echo "[deploy] gh pr create failed" >&2
      return 1
    fi
  fi

  if [[ -z "$pr_url" ]]; then
    echo "[deploy] empty PR URL after gh pr create" >&2
    return 1
  fi

  # Persist the deploy-PR marker on the originating issue body, replacing
  # any prepare-PR marker so the dashboard pivots to the deploy PR.
  if [[ "$issue_arg" =~ ^[0-9]+$ && "$issue_arg" != "0" ]]; then
    local pr_number="${pr_url##*/}"
    if [[ "$pr_number" =~ ^[0-9]+$ ]]; then
      local cur_body cleaned_body
      cur_body=$(gh issue view "$issue_arg" --json body -q .body 2>/dev/null || echo "")
      cleaned_body=$(printf '%s' "$cur_body" | sed -E '/<!-- kody-release-pr:[^>]*-->/d')
      {
        printf '%s' "$cleaned_body"
        printf '\n\n<!-- kody-release-pr: #%s -->\n' "$pr_number"
      } | gh issue edit "$issue_arg" --body-file - >/dev/null 2>&1 || \
        echo "[deploy] WARN: failed to write kody-release-pr marker to issue #${issue_arg}" >&2
    fi
  fi

  echo "$pr_url"
  return 0
}
