# Repository quality gates

Kody verifies its branch before it opens a normal pull request. A failed gate
gets one repair attempt; if it remains red, Kody does not present the work as
ready for review.

## Automatic discovery

When a `quality` command is not set in `kody.config.json`, Kody reads the
repository's `package.json` and uses these conventional scripts when present:

| Gate | Recognized scripts, in priority order |
|---|---|
| Typecheck | `typecheck`, `type-check`, `check:types` |
| Lint | `lint` |
| Unit tests | `test:unit`, `test` |
| Format check | `format:check`, `format-check`, `prettier:check` |

The command uses the lockfile's package manager. For example, an npm project
with a `test:unit` script runs `npm run test:unit`; a pnpm project runs
`pnpm run test:unit`.

Discovery happens on every run. It therefore also covers this common order:

1. Connect an empty repository to Kody.
2. Run `kody-engine init`.
3. Add the application's `package.json` and scripts later.
4. Run Kody again; the new scripts are now verification gates.

## Explicit configuration

Set commands directly when a repository uses different names or needs a
larger command:

```json
{
  "quality": {
    "typecheck": "npm run typecheck",
    "lint": "npm run lint",
    "testUnit": "npm run verify",
    "format": ""
  }
}
```

An explicitly configured value wins over discovery. An explicit empty string
disables that one gate. Quality commands run without repository credentials:
Kody removes secrets before executing agent-edited code.

## What CI still owns

The local Kody gate is the first delivery boundary, not a replacement for pull
request CI. Browser tests, deployment checks, platform-specific jobs, and any
other repository workflow still run on the pull request. A green local gate
does not justify claiming those later checks passed.
