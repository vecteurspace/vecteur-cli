/**
 * Auto-update MVP (npm channel). Three pieces:
 *  - a NON-blocking notice: on start we print an offline-safe banner from cache and, at most
 *    once/day, refresh the cache from the npm registry in the background.
 *  - `vecteur update`: runs `npm i -g @vecteur/cli@latest`.
 *  - the `User-Agent: vecteur-cli/<version>` header (in api.ts) lets the server return 426 to
 *    hard-gate clients below a minimum supported version.
 * It never blocks or breaks the CLI: every network/FS path is best-effort and fails silent.
 */
import { VERSION } from "./version.js";
import { getUpdateCache, saveUpdateCache } from "./config.js";

const PKG = "@vecteur/cli";
const REGISTRY = `https://registry.npmjs.org/${PKG}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

/** true if `latest` is a strictly higher x.y.z than `current` (prerelease suffix ignored). */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/** Instant, offline banner from the cached registry version (undefined if up to date). */
export function updateNoticeFromCache(): string | undefined {
  const { latestKnownVersion } = getUpdateCache();
  if (latestKnownVersion && isNewer(latestKnownVersion, VERSION)) {
    return `A new Vecteur CLI is available: ${VERSION} → ${latestKnownVersion}. Run \`vecteur update\`.`;
  }
  return undefined;
}

/** Refresh the cached latest version from the registry, throttled to once/day. Fire-and-forget. */
export async function refreshUpdateCache(): Promise<void> {
  try {
    const { lastUpdateCheck } = getUpdateCache();
    if (lastUpdateCheck && Date.now() - lastUpdateCheck < CHECK_INTERVAL_MS) return;
    const res = await fetch(REGISTRY, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (data.version) saveUpdateCache(data.version);
  } catch {
    /* offline / registry down / timeout — silent, try again tomorrow */
  }
}

/**
 * Print the cached update banner (to stderr, TTY only, so it never pollutes piped/JSON output)
 * and kick off a background cache refresh that we intentionally do NOT await.
 */
export function maybeNotifyUpdate(): void {
  const notice = updateNoticeFromCache();
  if (notice && process.stderr.isTTY) {
    process.stderr.write(`\x1b[2m${notice}\x1b[0m\n`);
  }
  void refreshUpdateCache();
}

/** `vecteur update` — self-update via the global npm install. */
export async function runUpdate(): Promise<void> {
  const { spawn } = await import("node:child_process");
  console.log(`Updating ${PKG} to the latest version…`);
  await new Promise<void>((resolve) => {
    const child = spawn("npm", ["install", "-g", `${PKG}@latest`], { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(
        `Couldn't run npm (${(err as Error).message}). Update manually: npm i -g ${PKG}@latest` +
          `\n(or, for a standalone binary, grab the latest release: https://github.com/vecteurspace/vecteur-cli/releases)`,
      );
      resolve();
    });
    child.on("close", (code) => {
      if (code === 0) console.log("Done. Run `vecteur --version` to confirm.");
      else console.error(`npm exited with code ${code}. Try: npm i -g ${PKG}@latest`);
      resolve();
    });
  });
}
