/**
 * Preflight: build a per-PR preview image on the GHA runner, push to
 * Fly's registry, spin up a per-PR Fly Machine, and post the preview
 * URL on the PR.
 *
 * Runs in CI only — depends on `docker` + `gh` + a set of env vars the
 * dashboard's dispatcher supplies via the kody.yml workflow_dispatch.
 *
 * Required env (dispatched by the dashboard, never declared as
 * profile inputs because they're secrets / context the engine
 * already has):
 *
 *   GITHUB_REPOSITORY  owner/name (GHA built-in)
 *   FLY_API_TOKEN      Fly org token (from consumer's vault)
 *   FLY_ORG_SLUG       defaults to "personal"
 *   FLY_REGION         defaults to "fra"
 *   KODY_MASTER_KEY    vault decryption key
 *   GITHUB_TOKEN       GHA-provided, used for PR comment + clone
 *
 * Implementation outline (sequential):
 *   1. Compute appName via the per-PR hash scheme (matches
 *      basePreviewAppName in the dashboard).
 *   2. Read .kody/secrets.enc from the target repo at HEAD, decrypt
 *      with KODY_MASTER_KEY, filter out NEVER_PASS_TO_BUILD names.
 *   3. Write .env.production.local in cwd.
 *   4. Probe GHCR for a per-repo base image; if present, substitute
 *      into the bundled Dockerfile.preview.prod (same patch-step the
 *      Fly builder uses today).
 *   5. `docker login registry.fly.io -u x -p $FLY_API_TOKEN`.
 *   6. `docker build -f Dockerfile.preview -t registry.fly.io/<app>:<tag> .`
 *   7. `docker push registry.fly.io/<app>:<tag>`.
 *   8. POST Fly Machines API: ensure app, allocate shared IPs, destroy
 *      stale machines, create preview machine. Mirror to GHCR on base
 *      builds.
 *   9. PATCH (or POST) preview-ready comment on the PR using
 *      `<!-- kody-fly-preview -->` marker — same body shape the Fly
 *      builder produces today so devs see one consistent comment.
 *
 * Notes:
 *   - Dockerfile.preview templates need to ship in the engine package
 *     (currently they live in Kody-Dashboard/builder/). Bundle them
 *     under src/scripts/preview-build-templates/ at engine build time.
 *   - All of the above mirrors logic in
 *     Kody-Dashboard/builder/src/builder.ts — keep them in sync until
 *     the Fly path is retired (it isn't — it's still the fallback).
 *
 * STATUS: skeleton — fails loud until the steps above are implemented.
 * Don't ship to consumers until this returns a successful exit + a
 * live preview URL. Wire the dashboard router behind a feature flag
 * (`previews.useGithubBuild`) so we can roll back without code edits.
 */

import type { PreflightScript } from "../executables/types.js"

export const runPreviewBuild: PreflightScript = async (ctx, _profile, _args) => {
  ctx.skipAgent = true
  ctx.output.exitCode = 99
  ctx.output.reason =
    "runPreviewBuild: not implemented — see scripts/runPreviewBuild.ts for outline"
}
