/**
 * Single source of truth for the CLI version. Kept in sync with package.json by
 * `version.test.ts` (the build/test fails if they drift). Used for `--version`, the
 * `User-Agent` header (lets the server gate old clients with 426), and the update check.
 */
export const VERSION = "0.2.1";
