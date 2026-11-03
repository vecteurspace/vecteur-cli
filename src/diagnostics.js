import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VecteurClient, resolveOrigin } from "./client.js";
import { credentialsPath, readCredentials } from "./credentials.js";
import { OWNER_CONTRACT_IDENTITY } from "./contract.js";
import { terminalText } from "./format.js";

/** Read-only diagnostics shared by the shell command and the interactive session. */
export async function diagnose({ env = process.env, origin, client, offline = false } = {}) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const saved = env.VECTEUR_TOKEN ? null : readCredentials(env);
  origin = resolveOrigin(env, saved, origin);
  const token = client?.config?.token ?? env.VECTEUR_TOKEN ?? saved?.logins?.[origin]?.token;
  client ??= new VecteurClient({ origin, token, timeout: 5_000 });
  const file = credentialsPath(env), folderFile = join(dirname(file), "folders.json");
  const lines = [
    `Vecteur ${manifest.version} · Node ${process.versions.node} (requires ${manifest.engines.node}) · ${process.platform}`,
    `Origin: ${origin}`, `Client contract: ${OWNER_CONTRACT_IDENTITY}`,
    `Terminal: ${process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "non-interactive"}; TERM=${env.TERM ?? "unset"}; ${env.NO_COLOR !== undefined ? "no color" : "color permitted"}`,
    `Credentials: ${file}`, `Folder registry: ${folderFile}`,
    `Store locks: credentials=${existsSync(file + ".lock") ? "present" : "absent"}, folders=${existsSync(folderFile + ".lock") ? "present" : "absent"}`,
  ];
  const { installation, installationText } = await import("./update.js");
  lines.push(installationText(installation({ env })));
  let ok = true;
  if (offline) lines.push("Offline: network and update checks disabled.");
  else try {
    const ready = await client.readiness();
    lines.push(`Origin: reachable and ready; contract ${ready.compatible ? "matches" : "DIFFERS"}`, `Server contract: ${ready.contract}`);
    ok = ready.compatible;
  } catch (error) { ok = false; lines.push(`Origin: ${error.code ?? "unavailable"}: ${error.message}`); }
  if (token && !offline) {
    try { const account = await client.accountMe(); lines.push(`Login: ${account.email} (${account.id})`); }
    catch (error) { ok = false; lines.push(`Login: ${error.code ?? "unavailable"}: ${error.message}`); }
  } else lines.push("Login: not signed in; vecteur or vecteur login");
  lines.push("Device pairing, grants, companion and desktop permissions: unavailable in stage 1.");
  lines.push("Updates: /update check or vecteur update --check identifies this exact installation; /settings controls automatic installation.");
  return { ok, text: terminalText(lines.join("\n")) };
}
