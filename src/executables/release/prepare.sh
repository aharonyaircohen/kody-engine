#!/usr/bin/env bash
#
# release/prepare.sh — function library for the prepare phase.
#
# Functions exported:
#   read_pkg_version
#   bump_version <cur> <patch|minor|major>
#   write_pkg_version <file> <new>
#   resolve_version_files            -> prints \n-separated paths
#   generate_changelog               -> prints raw `subject||sha` lines
#   format_changelog <new_version>   -> reads stdin, prints markdown entry
#   prepend_changelog <entry>
#   remote_branch_exists <branch>
#   find_open_pr <branch>            -> prints url or empty
#   open_prepare_pr <new_version> <issue_number> <prefer>
#                                    -> echoes PR url; sets globals
#   set_kody_release_pr_marker <issue_number> <pr_url>
#
# Side-effects: bumps version files, generates CHANGELOG.md, commits +
# pushes a release branch, opens the prepare PR.

# shellcheck disable=SC2148

read_pkg_version() {
  python3 -c "import json,sys; print(json.load(open('package.json'))['version'])"
}

bump_version() {
  local cur="$1" kind="$2"
  local core="${cur%%-*}"
  if ! [[ "$core" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "[prepare] cannot parse version '$cur'" >&2
    return 1
  fi
  local maj="${BASH_REMATCH[1]}" min="${BASH_REMATCH[2]}" pat="${BASH_REMATCH[3]}"
  case "$kind" in
    major) maj=$((maj + 1)); min=0; pat=0 ;;
    minor) min=$((min + 1)); pat=0 ;;
    patch|*) pat=$((pat + 1)) ;;
  esac
  echo "${maj}.${min}.${pat}"
}

write_pkg_version() {
  local file="$1" new="$2"
  python3 - "$file" "$new" <<'PY'
import json, sys
path, new = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        text = f.read()
except FileNotFoundError:
    print("MISSING")
    sys.exit(0)
try:
    data = json.loads(text)
except Exception:
    print("UNCHANGED")
    sys.exit(0)
if data.get("version") == new:
    print("UNCHANGED")
    sys.exit(0)
data["version"] = new
with open(path, "w") as f:
    f.write(json.dumps(data, indent=2) + "\n")
print("WROTE")
PY
}

resolve_version_files() {
  local raw="${KODY_CFG_RELEASE_VERSIONFILES:-}"
  if [[ -z "$raw" ]]; then
    echo "package.json"
    return
  fi
  python3 - <<PY
import json, os
raw = os.environ.get("KODY_CFG_RELEASE_VERSIONFILES", "")
try:
    arr = json.loads(raw)
except Exception:
    print("package.json"); raise SystemExit
if isinstance(arr, list) and arr:
    for f in arr:
        if isinstance(f, str) and f:
            print(f)
else:
    print("package.json")
PY
}

generate_changelog() {
  local last_tag count
  if ! last_tag=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null); then
    git fetch --tags --quiet 2>/dev/null || true
    last_tag=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
  fi
  if [[ -n "$last_tag" ]]; then
    count=$(git rev-list --count "${last_tag}..HEAD" --no-merges 2>/dev/null || echo "?")
    echo "  changelog: ${count} commits since ${last_tag}" >&2
    git log "${last_tag}..HEAD" --pretty=format:'%s||%h' --no-merges 2>/dev/null || true
  else
    echo "  changelog: no previous v* tag found — using last 100 commits" >&2
    git log -n100 HEAD --pretty=format:'%s||%h' --no-merges 2>/dev/null || true
  fi
}

format_changelog() {
  local new_version="$1"
  local date_str raw
  date_str=$(date -u +%Y-%m-%d)
  # Capture stdin BEFORE invoking python — the python heredoc below
  # redirects sys.stdin to the heredoc text itself, so we can't rely on
  # `sys.stdin.read()` to see the piped `subject||sha` lines. Pass the
  # raw log through an env var instead.
  raw=$(cat)
  RAW_CHANGELOG="$raw" NEW_VER="$new_version" DATE_STR="$date_str" python3 - <<'PY'
import os, re, sys
new_version = os.environ["NEW_VER"]
date_str = os.environ["DATE_STR"]
raw = os.environ.get("RAW_CHANGELOG", "")
buckets = {k: [] for k in ("feat", "fix", "perf", "refactor", "docs", "chore", "other")}
for line in raw.splitlines():
    line = line.strip()
    if not line or "||" not in line:
        continue
    subject, sha = line.split("||", 1)
    if re.match(r"(?i)^chore:\s*release\s+v\d", subject):
        continue
    m = re.match(r"^(\w+)(?:\(.*?\))?\s*:\s*(.+)$", subject)
    if m:
        kind = m.group(1).lower()
        msg = m.group(2)
    else:
        kind = "other"
        msg = subject
    buckets.setdefault(kind, buckets["other"]).append(f"- {msg} ({sha})")
labels = [
    ("feat", "Features"),
    ("fix", "Fixes"),
    ("perf", "Performance"),
    ("refactor", "Refactoring"),
    ("docs", "Docs"),
    ("chore", "Chores"),
    ("other", "Other"),
]
parts = [f"## v{new_version} — {date_str}", ""]
emitted = False
for key, label in labels:
    items = buckets.get(key) or []
    if not items:
        continue
    parts.append(f"### {label}")
    parts.extend(items)
    parts.append("")
    emitted = True
if not emitted:
    parts.append("_No notable commits since the last release._")
    parts.append("")
sys.stdout.write("\n".join(parts))
PY
}

prepend_changelog() {
  local entry="$1"
  local header='# Changelog

All notable changes to this project will be documented in this file.

'
  if [[ -f CHANGELOG.md ]]; then
    if grep -qE '^#\s*Changelog\b' CHANGELOG.md; then
      python3 - "$entry" <<'PY'
import sys
entry = sys.argv[1]
with open("CHANGELOG.md") as f:
    prior = f.read()
idx = prior.index("\n", prior.index("# Changelog"))
new = prior[: idx + 1] + "\n" + entry + prior[idx + 1 :]
with open("CHANGELOG.md", "w") as f:
    f.write(new)
PY
    else
      python3 - "$entry" <<PY
import sys
entry = sys.argv[1]
header = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n"
with open("CHANGELOG.md") as f:
    prior = f.read()
with open("CHANGELOG.md", "w") as f:
    f.write(header + entry + prior)
PY
    fi
  else
    python3 - "$entry" <<PY
import sys
entry = sys.argv[1]
header = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n"
with open("CHANGELOG.md", "w") as f:
    f.write(header + entry)
PY
  fi
}

remote_branch_exists() {
  local branch="$1"
  git ls-remote --heads origin "$branch" 2>/dev/null | grep -q .
}

find_open_pr() {
  local branch="$1"
  gh pr list --head "$branch" --state open --json url --limit 1 2>/dev/null \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[0]["url"] if data else "")' 2>/dev/null \
    || echo ""
}

# Returns the PREPARE PR url on stdout. Bumps version files, generates
# CHANGELOG, commits on a release branch, pushes, opens (or reuses) the PR.
# Globals it sets via export so release.sh can pass them to deploy/publish:
#   PREPARE_NEW_VERSION
#   PREPARE_TAG
#   PREPARE_RELEASE_BRANCH
#   PREPARE_CHANGELOG_ENTRY
open_prepare_pr() {
  local new_version="$1"
  local issue_arg="$2"
  local prefer="$3"
  local default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"

  local tag="v${new_version}"
  local release_branch="release/${tag}"

  export PREPARE_NEW_VERSION="$new_version"
  export PREPARE_TAG="$tag"
  export PREPARE_RELEASE_BRANCH="$release_branch"

  # Branch-collision gate.
  local collides=false
  if remote_branch_exists "$release_branch"; then
    collides=true
    case "$prefer" in
      theirs)
        local existing
        existing=$(find_open_pr "$release_branch")
        if [[ -n "$existing" ]]; then
          echo "  reusing existing PR (--prefer theirs): ${existing}" >&2
          echo "$existing"
          return 0
        fi
        echo "[prepare] --prefer theirs: ${release_branch} exists but no open PR" >&2
        return 1
        ;;
      ours)
        echo "  branch ${release_branch} exists — will force-push (--prefer ours)" >&2
        ;;
      *)
        echo "[prepare] branch ${release_branch} already exists. Use --prefer ours/theirs." >&2
        return 1
        ;;
    esac
  fi

  # Bump version files.
  local files=()
  while IFS= read -r f; do
    files+=("$f")
  done < <(resolve_version_files)
  local touched=()
  for f in "${files[@]}"; do
    local res
    res=$(write_pkg_version "$f" "$new_version")
    if [[ "$res" == "WROTE" ]]; then
      touched+=("$f")
    fi
  done
  if [[ ${#touched[@]} -eq 0 ]]; then
    echo "[prepare] no version strings updated (files: ${files[*]})" >&2
    return 1
  fi
  echo "  wrote    ${touched[*]}" >&2

  # Changelog.
  local raw_log entry
  raw_log=$(generate_changelog) || raw_log=""
  entry=$(printf '%s' "$raw_log" | format_changelog "$new_version")
  prepend_changelog "$entry"
  echo "  wrote    CHANGELOG.md" >&2
  export PREPARE_CHANGELOG_ENTRY="$entry"

  # Commit + push.
  export HUSKY=0 SKIP_HOOKS=1
  git checkout -b "$release_branch"
  for f in "${touched[@]}" CHANGELOG.md; do
    git add -- "$f"
  done
  git -c commit.gpgsign=false commit -m "chore: release ${tag}"
  if [[ "$collides" == "true" && "$prefer" == "ours" ]]; then
    git push -u --force-with-lease origin "$release_branch"
  else
    git push -u origin "$release_branch"
  fi

  # Open PR.
  local pr_url=""
  if [[ "$collides" == "true" && "$prefer" == "ours" ]]; then
    pr_url=$(find_open_pr "$release_branch")
  fi

  if [[ -z "$pr_url" ]]; then
    local body_max=60000 body_entry
    if [[ ${#entry} -gt $body_max ]]; then
      body_entry="${entry:0:$body_max}

_… truncated; see CHANGELOG.md_"
    else
      body_entry="$entry"
    fi
    local tracking_line=""
    if [[ "$issue_arg" =~ ^[0-9]+$ && "$issue_arg" != "0" ]]; then
      tracking_line=$'\n\nTracking-Issue: #'"${issue_arg}"
    fi
    local body
    body=$'Automated release PR opened by kody.\n\n'"$body_entry"$'\n\nThe release flow will merge this into `'"${default_branch}"$'` and continue to publish + deploy.'"${tracking_line}"
    pr_url=$(printf '%s' "$body" | gh pr create --head "$release_branch" --base "$default_branch" --title "chore: release ${tag}" --body-file -)
  fi

  if [[ -z "$pr_url" ]]; then
    echo "[prepare] gh pr create returned empty URL" >&2
    return 1
  fi

  echo "$pr_url"
  return 0
}

set_kody_release_pr_marker() {
  local issue_arg="$1" pr_url="$2"
  if [[ ! "$issue_arg" =~ ^[0-9]+$ ]] || [[ "$issue_arg" == "0" ]]; then
    return 0
  fi
  local pr_number="${pr_url##*/}"
  if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  local cur_body cleaned_body
  cur_body=$(gh issue view "$issue_arg" --json body -q .body 2>/dev/null || echo "")
  cleaned_body=$(printf '%s' "$cur_body" | sed -E '/<!-- kody-release-pr:[^>]*-->/d')
  {
    printf '%s' "$cleaned_body"
    printf '\n\n<!-- kody-release-pr: #%s -->\n' "$pr_number"
  } | gh issue edit "$issue_arg" --body-file - >/dev/null 2>&1 || \
    echo "[prepare] WARN: failed to write kody-release-pr marker to issue #${issue_arg}" >&2
}
