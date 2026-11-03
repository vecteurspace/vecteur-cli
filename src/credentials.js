import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CliError } from "./errors.js";
import { readStore, withStoreLock, writeStore } from "./store.js";

/**
 * PERSISTENT LOGINS, ONE FILE, PER ORIGIN.
 *
 * SRD 06's release bar for this door is "one persistent login, the same product from any
 * working directory". Before persistence, `configuration()` read `VECTEUR_TOKEN` from the
 * environment and nothing else, so "logged in" lasted one shell.
 *
 * THE TOKEN IS NEVER AN ARGUMENT and is never printed, not even a prefix. `vecteur login`
 * acquires it through the browser device grant. A credential passed as `--token vct_…` is
 * visible in `ps`, in `/proc/<pid>/cmdline` to every local user, and in the shell history
 * file afterwards — the exact exposure `SHIP-007` exists to rotate away in this same product.
 *
 * The store lives OUTSIDE every git tree, one file, 0600 — the same shape `scripts/with-secrets.py`
 * holds the fleet's own store in, for the same reason. One file is the only store; there is no
 * second reader.
 */
/** `$XDG_CONFIG_HOME/vecteur/credentials.json`, or `~/.config/vecteur/credentials.json`. */
export function credentialsPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(env.HOME || homedir(), ".config");
  return join(base, "vecteur", "credentials.json");
}

function persistStore(store, env) {
  return writeStore(credentialsPath(env), { current: store.current, logins: store.logins });
}

function unreadable(env) {
  return new CliError("credentials_unreadable",
    `${credentialsPath(env)} is not readable JSON — run \`vecteur logout --local\` and log in again`);
}

function isLogin(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.token === "string"
    && Object.keys(value).every(key => ["token", "project_id"].includes(key))
    && (value.project_id === undefined || (typeof value.project_id === "string" && value.project_id.length > 0));
}

function fromLegacy(parsed) {
  // Migrated in place: the 0.4.0 file is exactly `{origin, token}` strings, which is already
  // one valid login, so rewriting it as `{current, logins}` keeps the credential and one store.
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(parsed).sort().join("\n") === "origin\ntoken"
    && typeof parsed.origin === "string" && typeof parsed.token === "string"
    ? { current: parsed.origin, logins: { [parsed.origin]: { token: parsed.token } } }
    : null;
}

function fromStore(parsed) {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.keys(parsed).sort().join("\n") === "current\nlogins"
    && typeof parsed.current === "string" && parsed.current.length > 0
    && parsed.logins && typeof parsed.logins === "object" && !Array.isArray(parsed.logins)
    && Object.entries(parsed.logins).every(([origin, login]) => origin.length > 0
      && (typeof login === "string" || isLogin(login)))
    && Object.hasOwn(parsed.logins, parsed.current)
    ? { current: parsed.current, logins: Object.fromEntries(Object.entries(parsed.logins).map(([origin, login]) =>
      [origin, typeof login === "string" ? { token: login } : login])) }
    : null;
}

/**
 * Per-origin `{token, project_id?}` logins, or `null` when nobody has logged in.
 * Both legacy single-origin and string-map stores migrate in place on first read.
 */
export function readCredentials(env = process.env, locked = false) {
  let parsed;
  try {
    parsed = readStore(credentialsPath(env));
    if (parsed === null) return null;
  } catch {
    throw unreadable(env);
  }
  const store = fromStore(parsed);
  if (store) {
    if (Object.values(parsed.logins).some(login => typeof login === "string")) {
      if (!locked) return withStoreLock(credentialsPath(env), () => readCredentials(env, true));
      persistStore(store, env);
    }
    return store;
  }
  const migrated = fromLegacy(parsed);
  if (!migrated) throw unreadable(env);
  if (!locked) return withStoreLock(credentialsPath(env), () => readCredentials(env, true));
  persistStore(migrated, env);
  return migrated;
}

export function writeCredentials({ origin, token }, env = process.env) {
  return withStoreLock(credentialsPath(env), () => {
    const saved = readCredentials(env) ?? { current: origin, logins: {} };
    saved.logins[origin] = { token };
    saved.current = origin;
    return persistStore(saved, env);
  });
}

export function setCurrentOrigin(origin, env = process.env) {
  return withStoreLock(credentialsPath(env), () => {
    const saved = readCredentials(env);
    if (!saved || !Object.hasOwn(saved.logins, origin) || saved.current === origin) return;
    saved.current = origin;
    persistStore(saved, env);
  });
}

export function clearCredentials(env = process.env, origin = undefined) {
  return withStoreLock(credentialsPath(env), () => {
    const path = credentialsPath(env);
    if (origin === undefined) {
      rmSync(path, { force: true });
      return path;
    }
    let saved;
    try {
      saved = readCredentials(env);
    } catch {
      rmSync(path, { force: true });
      return path;
    }
    if (!saved) {
      rmSync(path, { force: true });
      return path;
    }
    delete saved.logins[origin];
    if (!Object.keys(saved.logins).length) {
      rmSync(path, { force: true });
      return path;
    }
    if (saved.current === origin) saved.current = Object.keys(saved.logins).sort()[0];
    persistStore(saved, env);
    return path;
  });
}

/** Selection is an id only; every use resolves it against the live authorized list. */
export function selectProject(origin, projectId, env = process.env) {
  if (env.VECTEUR_TOKEN) throw new CliError("persistent_login_required",
    "project use requires a persistent login; unset VECTEUR_TOKEN and run `vecteur login`");
  return withStoreLock(credentialsPath(env), () => {
    const saved = readCredentials(env);
    if (!saved?.logins[origin]) throw new CliError("persistent_login_required", "run `vecteur login` first");
    saved.logins[origin].project_id = projectId;
    persistStore(saved, env);
  });
}
