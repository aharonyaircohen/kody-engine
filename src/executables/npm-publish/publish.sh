#!/usr/bin/env bash
#
# npm-publish: publish the current package.json version to npm.
#
# Secrets:
# - NPM_TOKEN must be present in the environment.
#   Kody loads secrets before executables run; this script must not read or
#   decrypt .kody/secrets.enc directly.
#
# Inputs:
# - KODY_ARG_DRY_RUN true|false
# - KODY_ARG_TAG npm dist-tag, default latest
# - KODY_ARG_ACCESS public|restricted, default public
#
# Stdout markers:
# - KODY_REASON=<text>
# - KODY_SKIP_AGENT=true

set -euo pipefail

dry_run="${KODY_ARG_DRY_RUN:-false}"
tag="${KODY_ARG_TAG:-latest}"
access="${KODY_ARG_ACCESS:-public}"
registry="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"

fail() {
  echo "KODY_REASON=$1"
  echo "KODY_SKIP_AGENT=true"
  exit "${2:-1}"
}

json_eval() {
  node -e "$1"
}

[[ -f package.json ]] || fail "npm publish: package.json not found" 99

pkg_name="$(json_eval "const p=require('./package.json'); if(!p.name) process.exit(1); console.log(p.name)")" \
  || fail "npm publish: package.json missing name" 99
pkg_version="$(json_eval "const p=require('./package.json'); if(!p.version) process.exit(1); console.log(p.version)")" \
  || fail "npm publish: package.json missing version" 99

if [[ "$access" != "public" && "$access" != "restricted" ]]; then
  fail "npm publish: --access must be public or restricted" 64
fi

echo "→ npm publish: ${pkg_name}@${pkg_version} tag=${tag} access=${access}"

if [[ "$dry_run" == "true" ]]; then
  echo "KODY_REASON=dry-run — would publish ${pkg_name}@${pkg_version} to npm with tag ${tag}"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

[[ -n "${NPM_TOKEN:-}" ]] || fail "npm publish: missing NPM_TOKEN secret" 64

tmp_npmrc="$(mktemp)"
auth_host="${registry#http://}"
auth_host="${auth_host#https://}"
auth_host="${auth_host%/}"
cleanup() {
  rm -f "$tmp_npmrc"
}
trap cleanup EXIT

chmod 600 "$tmp_npmrc"
printf '%s\n' "registry=${registry}" >"$tmp_npmrc"
printf '%s\n' "//${auth_host}/:_authToken=${NPM_TOKEN}" >>"$tmp_npmrc"

export NODE_AUTH_TOKEN="$NPM_TOKEN"
export NPM_CONFIG_USERCONFIG="$tmp_npmrc"
export HUSKY=0
export SKIP_HOOKS=1
export CI="${CI:-1}"

if npm view "${pkg_name}@${pkg_version}" version --registry "$registry" >/dev/null 2>&1; then
  echo "KODY_REASON=${pkg_name}@${pkg_version} is already published"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

publish_args=(publish --access "$access" --tag "$tag" --registry "$registry")

if [[ -f pnpm-lock.yaml && -x "$(command -v pnpm)" ]]; then
  echo " publish: pnpm ${publish_args[*]}"
  pnpm "${publish_args[@]}"
else
  echo " publish: npm ${publish_args[*]}"
  npm "${publish_args[@]}"
fi

echo "KODY_REASON=published ${pkg_name}@${pkg_version} to npm with tag ${tag}"
echo "KODY_SKIP_AGENT=true"
