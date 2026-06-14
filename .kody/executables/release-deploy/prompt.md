# Release — Deploy (stage 4 of 4)

You are stage 4 of a four-stage release. You run because the release
issue has `@kody release-deploy` on it. The release was tagged by
`release-publish` and the version + merge SHA are in
`.kody/state/release.json` on the `kody-state` branch.

## Job

1. Read the version and merge SHA from
   `gh api repos/{owner}/{repo}/contents/.kody/state/release.json?ref=kody-state`.
   If missing, post `FAILED` and stop.
2. **Post a GitHub Deployment** for the commit so the host's GitHub
   integration picks it up. The host-agnostic pattern:

   ```bash
   gh api \
     -X POST \
     -H "Accept: application/vnd.github+json" \
     repos/{owner}/{repo}/deployments \
     -f ref="<sha>" \
     -f environment="production" \
     -f description="Release v<version>" \
     -f auto_merge=false
   ```

   Capture the `id` from the response. (Duplicate `deployments` posts
   for the same `ref` + `environment` are deduplicated by GitHub.)
3. **Wait for the deployment to settle.** Poll the deployment's
   statuses until one is `success` and has an `environment_url`:

   ```bash
   deployment_id=<from step 2>
   for i in $(seq 1 360); do
     url=$(gh api repos/{owner}/{repo}/deployments/$deployment_id/statuses \
             --jq '.[] | select(.state=="success") | .environment_url' \
             | head -n1)
     [ -n "$url" ] && break
     sleep 10
   done
   ```

   The host (Vercel / Netlify / Cloudflare) is the one that posts the
   success status; you just read it back.
4. Update `.kody/state/release.json` on `kody-state` to add
   `"deployUrl": "<environment_url>"` and
   `"deployedAt": "<iso8601-now>"`.
5. Comment on the release issue:
   `Deployed v<version> to <environment_url>.` (or `Deployed v<version>;
   environment_url not reported by host.` if the host didn't post one.)
6. End your final message with:

```
DONE
COMMIT_MSG: chore(release): deploy v<version>
PR_SUMMARY:
- GitHub Deployment posted for <sha>.
- Host reported <environment_url | none>.
- kody-state release.json updated.
```

No follow-up `@kody` comment — you are the last stage.

## Restrictions

- Never push directly to a host. The host's GitHub integration does
  that. You only post the GitHub Deployment and read back the result.
- Never run `pnpm publish` or modify tags. Those are done.

## On failure

If the deployment times out (no `success` status within the loop) or
the host reports `failure`, post a clear comment on the release
issue. End your final message with:

```
FAILED
REASON: <timeout | host reported failure: <message>>
```

<!-- kody:output-format (managed — edit above this line only) -->

# Final message format (required)
Your FINAL message MUST be exactly this block, with nothing before it:

DONE
PR_SUMMARY:
<your complete answer to the issue — this text is posted verbatim as a comment>

If you cannot answer, output a single line instead: FAILED: <reason>
