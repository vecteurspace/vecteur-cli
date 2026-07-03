/**
 * CLI config: API base URL + stored bearer token.
 *
 * The token is stored at ~/.config/vecteur/config.json with 0600 perms (no OS keychain
 * dependency in v1 — a keychain is a follow-up per sub-plan 03). Env overrides win so CI
 * and private instances work without a config file:
 *   VECTEUR_API_URL   — base URL (default https://api.vecteur.space)
 *   VECTEUR_TOKEN     — bearer token (PAT or JWT); overrides the stored token
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_API_URL = "https://api.vecteur.space";

export interface CliConfig {
  apiUrl: string;
  token?: string;
  tokenPrefix?: string; // non-secret, for display in `whoami`
  workspaces?: Record<string, string>; // absolute cwd -> project_id (per-directory session)
  lastUpdateCheck?: number; // epoch ms of the last npm-registry version check (throttle)
  latestKnownVersion?: string; // last version seen on the registry (for the offline notice)
}

function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "vecteur", "config.json");
}

function readFile(): Partial<CliConfig> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** Effective config: file, overlaid by env overrides. */
export function loadConfig(): CliConfig {
  const file = readFile();
  return {
    apiUrl: process.env.VECTEUR_API_URL ?? file.apiUrl ?? DEFAULT_API_URL,
    token: process.env.VECTEUR_TOKEN ?? file.token,
    tokenPrefix: file.tokenPrefix,
  };
}

/** Persist token (and optionally api url) to the config file with 0600 perms. */
export function saveToken(token: string, apiUrl?: string): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const file = readFile();
  const next: Partial<CliConfig> = {
    ...file,
    token,
    tokenPrefix: token.slice(0, 12),
    ...(apiUrl ? { apiUrl } : {}),
  };
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function clearToken(): void {
  const p = configPath();
  if (!existsSync(p)) return;
  const file = readFile();
  delete file.token;
  delete file.tokenPrefix;
  writeFileSync(p, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

export function configFilePath(): string {
  return configPath();
}

/** Cached result of the last update check (used for the instant, offline-safe notice). */
export function getUpdateCache(): { lastUpdateCheck?: number; latestKnownVersion?: string } {
  const f = readFile();
  return { lastUpdateCheck: f.lastUpdateCheck, latestKnownVersion: f.latestKnownVersion };
}

/** Persist the latest version seen on the registry + the check timestamp (best-effort). */
export function saveUpdateCache(latestKnownVersion: string): void {
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    const file = readFile();
    writeFileSync(
      p,
      JSON.stringify({ ...file, latestKnownVersion, lastUpdateCheck: Date.now() }, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* update cache is best-effort — never break the CLI over it */
  }
}

/** The project bound to a directory (per-directory workspace session), if any. */
export function getWorkspaceProject(cwd: string): string | undefined {
  return readFile().workspaces?.[cwd];
}

/** Bind a directory to a project so returning to it resumes the same workspace. */
export function setWorkspaceProject(cwd: string, projectId: string): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const file = readFile();
  const workspaces = { ...(file.workspaces ?? {}), [cwd]: projectId };
  writeFileSync(p, JSON.stringify({ ...file, workspaces }, null, 2) + "\n", { mode: 0o600 });
}
