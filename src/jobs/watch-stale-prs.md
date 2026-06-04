---
every: 7d
staff: kody
---

# watch-stale-prs

> Weekly digest of open PRs that haven't been touched in a while. Writes a
> markdown report at `.kody/reports/watch-stale-prs.md` (surfaced by the
> dashboard's `/reports` page).
>
> Cadence is enforced by the engine via the `every: 7d` frontmatter — this
> file only fires once per 7 days regardless of how often `job-scheduler`
> wakes. No prose cadence guard needed.

## Job

Find every open PR untouched for **≥ 7 days** and write a report listing
them, sorted by staleness (oldest first). When there are no stale PRs,
write a short "all clear" report so operators know the check ran.

### What "stale" means

A PR is stale if:

- `state` is `OPEN`, AND
- `updatedAt` is more than 7 days before now.

Use `gh pr list --state open --limit 100 --json number,title,url,updatedAt,author`
to enumerate. Filter and sort client-side; do not call `gh` once per PR.

### Report shape

Write to `.kody/reports/watch-stale-prs.md`. Overwrite each run.

When stale PRs exist:

```markdown
# Stale PRs — <ISO date>

🟡 <N> PR(s) untouched for > 7 days.

| # | Title | Author | Days stale | Updated |
|---|-------|--------|------------|---------|
| [#123](url) | <title> | @user | 14 | 2026-04-25 |
| ... | | | | |
```

When none:

```markdown
# Stale PRs — <ISO date>

🟢 No open PRs untouched for more than 7 days.
```

Truncate to the 50 oldest if the list is longer; append a final line
`> … and N more not shown`.

## Allowed Commands

- `gh pr list --state open --limit 100 --json number,title,url,updatedAt,author`
- `gh api -X GET /repos/{owner}/{repo}/contents/.kody/reports/watch-stale-prs.md`
  — only to fetch the existing file's `sha` for an update.
- `gh api -X PUT /repos/{owner}/{repo}/contents/.kody/reports/watch-stale-prs.md`
  — to write the report (base64-encoded `content`, `message`, and `sha`
  when updating). This is the **only** permitted write path for this job.

## Restrictions

- Never edit, create, or delete any other file in the working tree.
- Never `git commit`, `git push`, or open a PR.
- Never post comments on PRs or issues; the report file is the only
  output channel.
- Never call `gh` per-PR — one `pr list` is enough.

## State

`cursor`: always `"idle"` — this job has no phases; each fire is a
one-shot report write.

`data`:

- `lastStaleCount` (number) — how many stale PRs were in the most recent
  report. Diagnostic only; the engine ignores it.

(Engine-managed fields like `lastFiredAt` live under `data` automatically;
do not write or rely on them from the prompt.)

`done`: always `false` — this job is evergreen.
