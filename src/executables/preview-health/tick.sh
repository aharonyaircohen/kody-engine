#!/usr/bin/env bash
set -euo pipefail

jobs_dir="${1:-.kody/duties}"
duty="${2:-preview-health}"

export KODY_PREVIEW_HEALTH_JOBS_DIR="$jobs_dir"
export KODY_PREVIEW_HEALTH_DUTY="$duty"

python3 <<'PY'
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

DECISIONS_LABEL = "kody:cto-decisions"
LEDGER_START = "<!-- kody-cto-decisions:start -->"
LEDGER_END = "<!-- kody-cto-decisions:end -->"
VERBS = ("fix-ci", "sync", "resolve")
AUTO_VERBS = {"resolve"}
MAX_ACTIONS_PER_TICK = 5
FAIL_CONCLUSIONS = {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}
RUNNING_STATUSES = {"IN_PROGRESS", "QUEUED"}
STALE_THRESHOLD = 10
STATE_BRANCH = "kody-state"


def log(message):
    print(f"[preview-health] {message}", file=sys.stderr)


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_gh(args, input_text=None, check=True):
    result = subprocess.run(
        ["gh", *args],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=os.getcwd(),
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"gh {' '.join(args)} failed")
    return result.stdout


def repo_slug():
    owner = os.environ.get("KODY_CFG_GITHUB_OWNER", "").strip()
    repo = os.environ.get("KODY_CFG_GITHUB_REPO", "").strip()
    if owner and repo:
        return f"{owner}/{repo}"
    return run_gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).strip()


def default_branch(slug):
    configured = os.environ.get("KODY_CFG_GIT_DEFAULTBRANCH", "").strip()
    if configured:
        return configured
    return run_gh(["repo", "view", slug, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).strip()


def ensure_state_branch(slug):
    if run_gh(["api", f"/repos/{slug}/git/ref/heads/{STATE_BRANCH}"], check=False).strip():
        return
    branch = default_branch(slug)
    sha = run_gh(["api", f"/repos/{slug}/git/ref/heads/{branch}", "--jq", ".object.sha"]).strip()
    payload = json.dumps({"ref": f"refs/heads/{STATE_BRANCH}", "sha": sha})
    run_gh(["api", "--method", "POST", f"/repos/{slug}/git/refs", "--input", "-"], input_text=payload)


def initial_state():
    return {"version": 1, "rev": 0, "cursor": "seed", "data": {}, "done": False}


def load_state(slug, path):
    result = run_gh(
        ["api", f"/repos/{slug}/contents/{path}?ref={STATE_BRANCH}"],
        check=False,
    )
    if not result.strip():
        return {"path": path, "sha": None, "state": initial_state(), "created": True}
    obj = json.loads(result)
    raw = base64.b64decode(obj["content"]).decode("utf-8")
    return {"path": path, "sha": obj.get("sha"), "state": json.loads(raw), "created": False}


def state_unchanged(prev, next_state):
    return (
        prev.get("cursor") == next_state.get("cursor")
        and prev.get("done") == next_state.get("done")
        and prev.get("data") == next_state.get("data")
    )


def save_state(slug, loaded, next_state):
    if not loaded["created"] and state_unchanged(loaded["state"], next_state):
        return False
    ensure_state_branch(slug)
    body = json.dumps(next_state, indent=2) + "\n"
    payload = {
        "message": f"chore(jobs): update state for {os.environ['KODY_PREVIEW_HEALTH_DUTY']} (rev {next_state['rev']})",
        "content": base64.b64encode(body.encode("utf-8")).decode("ascii"),
        "branch": STATE_BRANCH,
    }
    if loaded.get("sha"):
        payload["sha"] = loaded["sha"]
    result = run_gh(
        ["api", "--method", "PUT", f"/repos/{slug}/contents/{loaded['path']}", "--input", "-"],
        input_text=json.dumps(payload),
        check=False,
    )
    if result.strip():
        return True
    reloaded = load_state(slug, loaded["path"])
    if not reloaded["created"] and state_unchanged(reloaded["state"], next_state):
        return False
    if reloaded.get("sha"):
        payload["sha"] = reloaded["sha"]
    else:
        payload.pop("sha", None)
    run_gh(["api", "--method", "PUT", f"/repos/{slug}/contents/{loaded['path']}", "--input", "-"], input_text=json.dumps(payload))
    return True


def read_ledger_modes():
    modes = {verb: "ask" for verb in VERBS}
    try:
        raw = run_gh(["issue", "list", "--label", DECISIONS_LABEL, "--state", "open", "--limit", "20", "--json", "number,body"])
        issues = json.loads(raw or "[]")
        if not issues:
            return modes
        body = sorted(issues, key=lambda x: x.get("number", 10**9))[0].get("body", "")
        if LEDGER_START not in body or LEDGER_END not in body:
            return modes
        inner = body.split(LEDGER_START, 1)[1].split(LEDGER_END, 1)[0]
        match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", inner)
        if not match:
            return modes
        ledger = json.loads(match.group(1))
        cto = ledger.get("staff", {}).get("cto", {})
        for verb in VERBS:
            if cto.get(verb, {}).get("mode") == "auto":
                modes[verb] = "auto"
    except Exception as err:
        log(f"ledger read failed; treating all verbs as ask: {err}")
    return modes


def ci_failing(rollup):
    if not isinstance(rollup, list):
        return False
    has_fail = any(str(check.get("conclusion", "")) in FAIL_CONCLUSIONS for check in rollup if isinstance(check, dict))
    running = any(str(check.get("status", "")) in RUNNING_STATUSES for check in rollup if isinstance(check, dict))
    return has_fail and not running


def behind_by(slug, base, head):
    try:
        raw = run_gh(["api", f"repos/{slug}/compare/{base}...{head}", "--jq", ".behind_by"])
        return int(raw.strip() or "0")
    except Exception as err:
        log(f"compare {base}...{head} failed: {err}")
        return 0


def detect_repair(slug, pr):
    mergeable = str(pr.get("mergeable") or "").upper()
    if mergeable == "UNKNOWN":
        return ("defer", f"PR #{pr['number']} mergeability still UNKNOWN; retry next tick.")
    if mergeable == "CONFLICTING":
        return ("resolve", f"PR #{pr['number']} has merge conflicts with `{pr['baseRefName']}`.")
    if ci_failing(pr.get("statusCheckRollup")):
        return ("fix-ci", f"PR #{pr['number']} has failing CI checks.")
    drift = behind_by(slug, pr["baseRefName"], pr["headRefName"])
    if drift >= STALE_THRESHOLD:
        return ("sync", f"PR #{pr['number']}'s branch is {drift} commits behind `{pr['baseRefName']}`.")
    return None


def duty_operator(jobs_dir, duty):
    try:
        with open(os.path.join(os.getcwd(), jobs_dir, duty, "profile.json"), "r", encoding="utf-8") as f:
            profile = json.load(f)
        mentions = profile.get("mentions", [])
        return mentions[0] if isinstance(mentions, list) and mentions else ""
    except Exception:
        return ""


def post_comment(pr_number, body):
    if os.environ.get("KODY_DRY_RUN") == "1":
        log(f"[dry-run] would comment on #{pr_number}: {body.splitlines()[0]}")
        return True
    try:
        run_gh(["pr", "comment", str(pr_number), "--body", body])
        return True
    except Exception as err:
        log(f"comment failed on #{pr_number}: {err}")
        return False


def recommend(pr_number, verb, reason, operator):
    mention = f"@{operator} " if operator else ""
    body = (
        f"{mention}**CTO recommendation** - `{verb}`\n\n"
        f"{reason} Recommended action: `{verb}` for PR #{pr_number}.\n\n"
        "_Confirm in dashboard inbox or run the action manually. CTO will not act on its own._"
    )
    return post_comment(pr_number, body)


def auto_run(pr_number, verb, reason):
    if os.environ.get("KODY_DRY_RUN") == "1":
        log(f"[dry-run] would dispatch kody.yml executable={verb} issue_number={pr_number}")
    else:
        try:
            run_gh(["workflow", "run", "kody.yml", "-f", f"executable={verb}", "-f", f"issue_number={pr_number}"])
        except Exception as err:
            log(f"workflow_dispatch failed #{pr_number} ({verb}): {err}")
            return False
    auto_reason = (
        "Policy: preview-health auto-runs `resolve` for merge conflicts."
        if verb in AUTO_VERBS
        else f"Graduated: operator approved `{verb}` repeatedly. A **Reject** on any `{verb}` returns me asking."
    )
    return post_comment(pr_number, f"**CTO action** - `{verb}` dispatched\n\n{reason}\n\n{auto_reason}")


def print_row(pr, verb, fp, action, note):
    print(f"| #{pr} | {verb} | {fp} | {action} | {note} |")


def main():
    slug = repo_slug()
    jobs_dir = os.environ["KODY_PREVIEW_HEALTH_JOBS_DIR"].rstrip("/")
    duty = os.environ["KODY_PREVIEW_HEALTH_DUTY"]
    state_path = f"{jobs_dir}/{duty}/state.json"
    loaded = load_state(slug, state_path)
    modes = read_ledger_modes()
    operator = duty_operator(jobs_dir, duty)

    prs = json.loads(
        run_gh([
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,updatedAt",
        ])
        or "[]"
    )

    prior = loaded["state"].get("data", {}).get("prs", {})
    open_numbers = {str(pr["number"]) for pr in prs}
    next_prs = {key: value for key, value in prior.items() if key in open_numbers and isinstance(value, dict)}

    print("| PR | verb | fingerprint | action | note |")
    print("|----|------|-------------|--------|------|")

    priority = {"resolve": 0, "fix-ci": 1, "sync": 2}
    queue = []
    for pr in prs:
        if pr.get("isDraft"):
            print_row(pr["number"], "-", "-", "skip", "draft")
            continue
        repair = detect_repair(slug, pr)
        if not repair:
            print_row(pr["number"], "-", "-", "skip", "healthy")
            continue
        verb, reason = repair
        if verb == "defer":
            print_row(pr["number"], "-", "-", "defer", "mergeable=UNKNOWN")
            continue
        queue.append((priority[verb], pr["number"], pr, verb, reason))

    actions_taken = 0
    for _, number, pr, verb, reason in sorted(queue):
        key = str(number)
        fp = f"{verb}|{pr.get('headRefOid', '')}"
        graduated = verb in AUTO_VERBS or modes.get(verb) == "auto"
        intended_stage = f"{verb}-auto" if graduated else f"{verb}-recommended"
        prev = next_prs.get(key, {})
        if prev.get("fp") == fp and prev.get("stage") == intended_stage:
            print_row(number, verb, fp[:24], "skip", "dedup")
            continue
        if actions_taken >= MAX_ACTIONS_PER_TICK:
            print_row(number, verb, fp[:24], "defer", "tick cap")
            continue

        ok = auto_run(number, verb, reason) if graduated else recommend(number, verb, reason, operator)
        action = "auto-ran" if graduated and ok else "auto-failed" if graduated else "recommended" if ok else "recommend-failed"
        if ok:
            actions_taken += 1
            next_prs[key] = {"fp": fp, "stage": intended_stage, "lastActAt": now_iso()}
        print_row(number, verb, fp[:24], action, "auto" if graduated else "advisory")

    next_state = {
        "version": 1,
        "rev": int(loaded["state"].get("rev", 0)) + 1,
        "cursor": "idle",
        "data": {"prs": next_prs, "lastFiredAt": now_iso()},
        "done": False,
    }
    save_state(slug, loaded, next_state)
    log(f"tick complete: {actions_taken} action(s), {len(next_prs)} tracked PR(s)")
    print("KODY_SKIP_AGENT=true")


main()
PY
