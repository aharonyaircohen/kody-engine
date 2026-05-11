/**
 * Extracted to break a circular import: profile.ts imports from
 * lifecycles/index.ts, which needs to throw ProfileError. Re-exported from
 * profile.ts so existing callers stay unchanged.
 */

export class ProfileError extends Error {
  constructor(
    public profilePath: string,
    message: string,
  ) {
    super(`Invalid profile at ${profilePath}:\n  ${message}`)
    this.name = "ProfileError"
  }
}
