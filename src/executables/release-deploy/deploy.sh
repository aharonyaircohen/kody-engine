#!/usr/bin/env bash
#
# release-deploy: run the configured deployCommand and/or notifyCommand
# after release-publish has tagged and published the artifact. No agent.
#
# Both commands are optional. With neither set, deploy is a no-op success
# (the orchestrator still advances to "done").
#
# Inputs (env):
#   KODY_ARG_DRY_RUN          true|false
#   KODY_ARG_ISSUE            triggering issue/PR number (optional)
#
# Config (env):
#   KODY_CFG_RELEASE_DEPLOYCOMMAND     optional; $VERSION substituted
#   KODY_CFG_RELEASE_NOTIFYCOMMAND     optional; $VERSION substituted
#   KODY_CFG_RELEASE_TIMEOUTMS         per-command timeout in ms (default 600000)
#
# Stdout signals:
#   KODY_REASON=<text>
#   KODY_SKIP_AGENT=true

set -euo pipefail

dry_run="${KODY_ARG_DRY_RUN:-false}"
deploy_cmd="${KODY_CFG_RELEASE_DEPLOYCOMMAND:-}"
notify_cmd="${KODY_CFG_RELEASE_NOTIFYCOMMAND:-}"
timeout_ms="${KODY_CFG_RELEASE_TIMEOUTMS:-600000}"
timeout_s=$((timeout_ms / 1000))

read_pkg_version() {
  python3 -c "import json; print(json.load(open('package.json'))['version'])"
}

if [[ ! -f package.json ]]; then
  echo "KODY_REASON=release deploy: package.json not found"
  echo "KODY_SKIP_AGENT=true"
  exit 99
fi

version=$(read_pkg_version)
echo "→ release deploy: v${version}"

if [[ -z "$deploy_cmd" && -z "$notify_cmd" ]]; then
  echo "KODY_REASON=no deployCommand or notifyCommand configured — nothing to run"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

if [[ "$dry_run" == "true" ]]; then
  echo "KODY_REASON=dry-run — would run deploy/notify commands"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

export HUSKY=0 SKIP_HOOKS=1 CI="${CI:-1}"

deploy_status="skipped"
if [[ -n "$deploy_cmd" ]]; then
  cmd="${deploy_cmd//\$VERSION/$version}"
  echo "  deploy: ${cmd}"
  if timeout "${timeout_s}" bash -c "$cmd"; then
    deploy_status="ok"
  else
    deploy_status="failed"
    echo "KODY_REASON=release deploy: deployCommand failed"
    echo "KODY_SKIP_AGENT=true"
    exit 1
  fi
fi

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

echo "KODY_REASON=deploy=${deploy_status} notify=${notify_status}"
echo "KODY_SKIP_AGENT=true"
