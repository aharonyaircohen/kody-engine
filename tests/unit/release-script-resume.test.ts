import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(__dirname, "../..")

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}

describe("release.sh resume behavior", () => {
  it("opens the deploy PR for an already-prepared default branch release", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-release-resume-"))
    try {
      const releaseDir = path.join(tmp, "release")
      const binDir = path.join(tmp, "bin")
      fs.mkdirSync(releaseDir)
      fs.mkdirSync(binDir)
      fs.copyFileSync(path.join(repoRoot, "src/executables/release/release.sh"), path.join(releaseDir, "release.sh"))
      fs.chmodSync(path.join(releaseDir, "release.sh"), 0o755)

      fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "1.2.3" }))
      fs.writeFileSync(
        path.join(releaseDir, "prepare.sh"),
        [
          'read_pkg_version() { echo "1.2.3"; }',
          'bump_version() { echo "9.9.9"; }',
          'open_prepare_pr() { echo "SHOULD_NOT_PREPARE"; return 99; }',
          "set_kody_release_pr_marker() { :; }",
          "",
        ].join("\n"),
      )
      fs.writeFileSync(path.join(releaseDir, "wait.sh"), "wait_for_ci() { :; }\n")
      fs.writeFileSync(
        path.join(releaseDir, "publish.sh"),
        'tag_and_publish() { echo "ok"; }\ncreate_gh_release() { echo "https://example.test/releases/$1"; }\n',
      )
      fs.writeFileSync(
        path.join(releaseDir, "deploy.sh"),
        'open_deploy_pr() { echo "https://example.test/pr/$1/$2"; }\n',
      )

      writeExecutable(
        path.join(binDir, "git"),
        [
          "#!/usr/bin/env bash",
          'if [[ "$1" == "fetch" ]]; then exit 0; fi',
          'if [[ "$1" == "show" && "$2" == "origin/dev:package.json" ]]; then echo \'{"version":"1.2.3"}\'; exit 0; fi',
          'if [[ "$1" == "show" && "$2" == "origin/main:package.json" ]]; then echo \'{"version":"1.2.2"}\'; exit 0; fi',
          'if [[ "$1" == "checkout" || "$1" == "reset" ]]; then exit 0; fi',
          'echo "unexpected git $*" >&2',
          "exit 1",
          "",
        ].join("\n"),
      )

      const out = execFileSync(path.join(releaseDir, "release.sh"), {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          KODY_ARG_ISSUE: "291",
          KODY_CFG_GIT_DEFAULTBRANCH: "dev",
          KODY_CFG_RELEASE_RELEASEBRANCH: "main",
        },
      })

      expect(out).toContain("resuming prepared v1.2.3")
      expect(out).toContain("KODY_PR_URL=https://example.test/pr/1.2.3/291")
      expect(out).not.toContain("SHOULD_NOT_PREPARE")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
