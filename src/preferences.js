import { dirname, join } from "node:path";
import { credentialsPath } from "./credentials.js";
import { readStore, writeStore, withStoreLock } from "./store.js";
import { CliError } from "./errors.js";

const defaults = { plain: false, reducedMotion: false, updates: {} };
const path = env => join(dirname(credentialsPath(env)), "preferences.json");
export function preferences(env = process.env) {
  const value = readStore(path(env));
  if (value === null) return structuredClone(defaults);
  if (value.version !== 1 || typeof value.plain !== "boolean" || typeof value.reducedMotion !== "boolean"
      || !value.updates || typeof value.updates !== "object" || Array.isArray(value.updates)
      || Object.keys(value).sort().join() !== "plain,reducedMotion,updates,version"
      || Object.values(value.updates).some(mode => !["ask", "auto", "off"].includes(mode))) {
    throw new CliError("preferences_version", "Unsupported preferences; existing settings preserved. Use --plain for this session.");
  }
  return value;
}
export function savePreferences(patch, env = process.env) {
  return withStoreLock(path(env), () => {
    const value = preferences(env);
    for (const key of Object.keys(patch)) if (!Object.hasOwn(defaults, key)) throw new CliError("preferences_invalid", "Unknown preference");
    const next = { ...value, ...patch, version: 1 };
    if (typeof next.plain !== "boolean" || typeof next.reducedMotion !== "boolean"
        || !next.updates || typeof next.updates !== "object" || Array.isArray(next.updates)
        || Object.values(next.updates).some(mode => !["ask", "auto", "off"].includes(mode))) throw new CliError("preferences_invalid", "Invalid preference");
    writeStore(path(env), next); return next;
  });
}
