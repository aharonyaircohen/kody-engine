# NPM Publish

## Purpose

Publish current `package.json` version to npm from the repository CI sandbox.

## Requirements

- Store npm automation token as `NPM_TOKEN` in `.kody/secrets.enc`.
- Kody must load that secret into the `NPM_TOKEN` environment variable before the executable runs.
- The executable must not read or decrypt `.kody/secrets.enc` directly.
- Run only after version in `package.json` is ready to publish.

## Instructions

Use the `npm-publish` executable for the implementation details.
The duty owns the public action name and the reason this action exists; the executable owns the method.
