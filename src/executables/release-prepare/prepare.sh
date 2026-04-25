#!/usr/bin/env bash
#
# release-prepare: bump version files, generate CHANGELOG.md, commit on a
# release branch, open the release PR. Pure mechanical work — no agent.
#
# Inputs (env, set by the executor):
#   KODY_ARG_BUMP             patch|minor|major (default: patch)
#   KODY_ARG_DRY_RUN          true|false
#   KODY_ARG_PREFER           ours|theirs (optional)
#   KODY_ARG_ISSUE            triggering issue/PR number (optional)
#
# Config (env, flattened from kody.config.json):
#   KODY_CFG_GIT_DEFAULTBRANCH         e.g. main
#   KODY_CFG_RELEASE_VERSIONFILES      JSON array, e.g. ["package.json"]
#
# Stdout signals to the executor:
#   KODY_PR_URL=<url>      — set ctx.output.prUrl (final PR URL)
#   KODY_REASON=<text>     — set ctx.output.reason (failure or dry-run note)
#   KODY_SKIP_AGENT=true   — bypass the agent (always; this is a no-agent flow)

set -euo pipefail

# ── Helpers ────────────────────────────────────────────────────────────────

bump="${KODY_ARG_BUMP:-patch}"
dry_run="${KODY_ARG_DRY_RUN:-false}"
prefer="${KODY_ARG_PREFER:-}"
default_branch="${KODY_CFG_GIT_DEFAULTBRANCH:-main}"
dev_branch="${KODY_CFG_RELEASE_DEVBRANCH:-}"
# PR target: dev branch when configured (and different from default), else default.
pr_base="${dev_branch:-$default_branch}"
[[ "$pr_base" == "$default_branch" ]] && pr_base="$default_branch"
version_files_json="${KODY_CFG_RELEASE_VERSIONFILES:-}"

fail() {
  local reason="$1"
  echo "KODY_REASON=$reason"
  echo "KODY_SKIP_AGENT=true"
  exit "${2:-1}"
}

bump_version() {
  local cur="$1" kind="$2"
  local rest="${cur#*-}"
  local core="${cur%%-*}"
  if ! [[ "$core" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    fail "release prepare: cannot parse version '$cur' (expected x.y.z[-suffix])" 99
  fi
  local maj="${BASH_REMATCH[1]}" min="${BASH_REMATCH[2]}" pat="${BASH_REMATCH[3]}"
  case "$kind" in
    major) maj=$((maj + 1)); min=0; pat=0 ;;
    minor) min=$((min + 1)); pat=0 ;;
    patch|*) pat=$((pat + 1)) ;;
  esac
  echo "${maj}.${min}.${pat}"
}

read_pkg_version() {
  python3 -c "import json,sys; print(json.load(open('package.json'))['version'])"
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
indent = 2
with open(path, "w") as f:
    f.write(json.dumps(data, indent=indent) + "\n")
print("WROTE")
PY
}

resolve_version_files() {
  if [[ -z "$version_files_json" ]]; then
    echo "package.json"
    return
  fi
  python3 - <<PY
import json, os, sys
raw = os.environ.get("KODY_CFG_RELEASE_VERSIONFILES", "")
try:
    arr = json.loads(raw)
except Exception:
    print("package.json")
    sys.exit(0)
if isinstance(arr, list) and arr:
    for f in arr:
        if isinstance(f, str) and f:
            print(f)
else:
    print("package.json")
PY
}

generate_changelog() {
  local new_version="$1"
  local last_tag
  if last_tag=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null); then
    range="${last_tag}..HEAD"
    git log "$range" --pretty=format:'%s||%h' --no-merges 2>/dev/null || true
  else
    git log -n100 HEAD --pretty=format:'%s||%h' --no-merges 2>/dev/null || true
  fi
}

format_changelog() {
  local new_version="$1"
  local date_str
  date_str=$(date -u +%Y-%m-%d)
  python3 - "$new_version" "$date_str" <<PY
import sys, re
new_version, date_str = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
buckets = {k: [] for k in ("feat", "fix", "perf", "refactor", "docs", "chore", "other")}
for line in raw.splitlines():
    line = line.strip()
    if not line:
        continue
    if "||" not in line:
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
      python3 - "$entry" <<'PY'
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
    python3 - "$entry" <<'PY'
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

# ── Flow ───────────────────────────────────────────────────────────────────

if [[ ! -f package.json ]]; then
  fail "release prepare: package.json not found" 99
fi

old_version=$(read_pkg_version)
new_version=$(bump_version "$old_version" "$bump")
tag="v${new_version}"
release_branch="release/${tag}"

echo "→ release prepare: ${old_version} → ${new_version} (${bump})"

if [[ "$dry_run" == "true" ]]; then
  echo "RELEASE_PLAN=bump=${new_version} tag=${tag}"
  echo "KODY_REASON=dry-run — would bump to ${new_version}${prefer:+ (--prefer ${prefer})}"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Branch-collision gate.
collides=false
if remote_branch_exists "$release_branch"; then
  collides=true
  case "$prefer" in
    theirs)
      existing=$(find_open_pr "$release_branch")
      if [[ -n "$existing" ]]; then
        echo "  reusing existing PR (--prefer theirs): ${existing}"
        echo "KODY_PR_URL=${existing}"
        echo "KODY_REASON=reused existing release PR"
        echo "KODY_SKIP_AGENT=true"
        exit 0
      fi
      fail "release prepare --prefer theirs: ${release_branch} exists on remote but has no open PR — nothing to reuse" 4
      ;;
    ours)
      echo "  branch ${release_branch} exists on remote — will force-push (--prefer ours)"
      ;;
    *)
      fail "release prepare: branch ${release_branch} already exists on remote. Use --prefer ours to force-push, or --prefer theirs to reuse the existing PR." 4
      ;;
  esac
fi

# Bump version files.
mapfile -t files < <(resolve_version_files)
touched=()
for f in "${files[@]}"; do
  res=$(write_pkg_version "$f" "$new_version")
  if [[ "$res" == "WROTE" ]]; then
    touched+=("$f")
  fi
done
if [[ ${#touched[@]} -eq 0 ]]; then
  fail "release prepare: no version strings updated (files: ${files[*]})"
fi
echo "  wrote    ${touched[*]}"

# Changelog.
raw_log=$(generate_changelog "$new_version") || raw_log=""
entry=$(printf '%s' "$raw_log" | format_changelog "$new_version")
prepend_changelog "$entry"
echo "  wrote    CHANGELOG.md"

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

# Open PR (or link to existing one if --prefer ours collided).
pr_url=""
if [[ "$collides" == "true" && "$prefer" == "ours" ]]; then
  pr_url=$(find_open_pr "$release_branch")
fi

if [[ -z "$pr_url" ]]; then
  body_max=60000
  if [[ ${#entry} -gt $body_max ]]; then
    body_entry="${entry:0:$body_max}

_… truncated; see CHANGELOG.md_"
  else
    body_entry="$entry"
  fi
  body=$'Automated release PR opened by kody.\n\n'"$body_entry"$'\n\nThe release orchestrator will merge this into `'"${pr_base}"$'` and continue to publish + deploy.'
  pr_url=$(printf '%s' "$body" | gh pr create --head "$release_branch" --base "$pr_base" --title "chore: release ${tag}" --body-file -)
fi

if [[ -z "$pr_url" ]]; then
  fail "release prepare: gh pr create returned empty URL" 4
fi

echo "RELEASE_PR=${pr_url}"
echo "KODY_PR_URL=${pr_url}"
echo "KODY_REASON=opened release PR for ${tag}"
echo "KODY_SKIP_AGENT=true"
