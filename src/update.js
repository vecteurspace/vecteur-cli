import { constants, accessSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, readlinkSync, symlinkSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync, statfsSync } from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CliError, VecteurClient, resolveOrigin } from "./client.js";
import { preferences, savePreferences } from "./preferences.js";
import { terminalText } from "./format.js";
import { credentialsPath } from "./credentials.js";
import { writeStore, readStore } from "./store.js";

const run = promisify(execFile), REGISTRY = "https://registry.npmjs.org", PACKAGE = "@vecteur/cli";
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = root => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const fail = (code, text) => { throw new CliError(code, text); };
const MAX_BYTES = 512 * 1024 * 1024;
const official = origin => origin === "https://vecteur.space";
const versionCompare = (a, b) => {
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
};
function owned(path, directory = false) {
  const stat = lstatSync(path);
  return (!directory || stat.isDirectory()) && !stat.isSymbolicLink()
    && (!process.getuid || stat.uid === process.getuid()) && !(stat.mode & 0o022);
}
function pathBinary(env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const file = resolve(dir, process.platform === "win32" ? "vecteur.cmd" : "vecteur");
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
  return null;
}
/** Inspect paths only. Never execute the other PATH binary, even for its version. */
export function installation({ entry = process.argv[1], env = process.env, root = ownRoot } = {}) {
  const launcher = resolve(entry), realEntry = realpathSync(launcher), pkg = manifest(root);
  const pointer = lstatSync(launcher);
  const identity = [pointer.dev, pointer.ino, pointer.mtimeMs, pointer.size];
  let path = pathBinary(env), pathVersion = null;
  try { const other = manifest(resolve(dirname(realpathSync(path)), "..")); if (other.name === PACKAGE) pathVersion = other.version; } catch {}
  const parent = dirname(launcher);
  // The pointer is outside every immutable npm generation. A direct JS path is never replaced.
  const prefix = parent.endsWith("/node_modules/.bin") ? resolve(parent, "../..")
    : parent.endsWith("/bin") ? dirname(parent) : null;
  let reason = "Direct script or unmanaged installation; use its package manager";
  if (launcher.includes("/.vecteur-updates/generation-")) reason = "Launch this installation through its original launcher; retained generation files stay immutable";
  else if (process.platform === "win32") reason = "Windows launcher recovery has not been qualified; use npm explicitly";
  else if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length) reason = "Custom Node options/loaders: automatic replacement is unavailable";
  else if (prefix && lstatSync(launcher).isSymbolicLink() && realEntry === join(realpathSync(root), "bin/vecteur.js")) {
    try {
      if (!owned(parent, true) || !owned(prefix, true) || !owned(realEntry) || !owned(root, true)) throw new Error();
      accessSync(parent, constants.W_OK); accessSync(prefix, constants.W_OK);
      reason = "";
    } catch { reason = "Installation is not a writable, user-owned npm prefix"; }
  }
  const key = createHash("sha256").update(launcher).digest("hex");
  return { launcher, realEntry, identity, root, prefix, version: pkg.version, channel: pkg.vecteur?.channel ?? "unknown", node: process.execPath,
    path, pathVersion, reason, qualified: !reason, key };
}
export function installationText(info) {
  return [`Running: ${info.launcher} (${info.version})`, `Resolved: ${info.realEntry}`, `Node: ${info.node}`,
    info.path && info.path !== info.launcher ? `PATH: ${info.path} (${info.pathVersion ?? "version unknown"}); updating it does not change the running installation.` : "PATH selects this launcher.",
    info.pathVersion && info.pathVersion !== info.version ? `To use the PATH installation: ${quote(info.path)}` : "",
    info.reason || "Update layout: npm launcher with retained immutable generations"].filter(Boolean).join("\n");
}
function manualRecovery(plan) {
  const { info, release } = plan;
  if (info.pathVersion && info.pathVersion === (release.cli?.version ?? release.requiredVersion) && info.path !== info.launcher) return `Launch the matching installed CLI: ${quote(info.path)}`;
  if (!release.cli) return "Use /offline to keep drafting; this older origin supplies no structured update pin.";
  if (!info.prefix) return `Unmanaged checkout: use its build/package instructions. Offline launch: ${quote(info.launcher)} --offline`;
  const global = dirname(info.launcher).endsWith("/bin");
  return `Manual npm recovery for this prefix (close its clients first): npm install ${global ? "--global " : ""}--prefix ${quote(info.prefix)} --ignore-scripts --registry ${REGISTRY} ${PACKAGE}@${release.cli.version}`;
}
const prefKey = (info, origin) => `${info.key}:${origin}`;
export async function updatePreference(session) {
  const info = installation({ env: session.env });
  const mode = await session.choose(`Updates for ${info.launcher} at ${session.origin}`, [
    { label: "Ask before installing (default)", value: "ask" },
    { label: "Automatically install verified upgrades when idle", value: "auto" },
    { label: "Off — check only with /update", value: "off" },
  ]);
  const prefs = preferences(session.env);
  savePreferences({ updates: { ...prefs.updates, [prefKey(info, session.origin)]: mode } }, session.env);
  session.message(`Updates: ${mode}${mode === "auto" && info.reason ? `; deferred: ${info.reason}` : ""}.`);
}
export async function checkUpdate({ origin, env = process.env, release, force = false } = {}) {
  const info = installation({ env });
  origin = resolveOrigin(env, undefined, origin);
  const cache = join(dirname(credentialsPath(env)), `release-${createHash("sha256").update(origin).digest("hex")}.json`);
  if (!release && !force) {
    const saved = readStore(cache);
    if (saved?.origin === origin && saved.at <= Date.now() && Date.now() - saved.at < 86_400_000) release = saved.release;
  }
  release ??= await new VecteurClient({ origin, timeout: 5_000 }).readiness();
  if (release.compatible) writeStore(cache, { origin, at: Date.now(), release });
  else { try { unlinkSync(cache); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  const cli = release.cli;
  const reason = !official(origin) ? "Custom origin: executable acquisition is disabled"
    : !cli?.integrity || cli.channel !== "stable" ? "This origin has no published, integrity-pinned stable package"
      : info.reason;
  return { info, origin, release, reason, mode: preferences(env).updates[prefKey(info, origin)] ?? "ask",
    needed: !!cli && (!release.compatible || cli.version !== info.version),
    upgrade: !!cli && versionCompare(cli.version, info.version) > 0 };
}
function cleanEnvironment(directory) {
  // npm sees no Vecteur token, npm token, user config, custom loader or proxy.
  return { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, SystemRoot: process.env.SystemRoot,
    npm_config_registry: REGISTRY, npm_config_userconfig: join(directory, "empty.npmrc"),
    npm_config_globalconfig: join(directory, "empty-global.npmrc"), npm_config_cache: join(directory, "cache"),
    npm_config_ignore_scripts: "true", npm_config_umask: "077", npm_config_audit: "false", npm_config_fund: "false" };
}
function syncDirectory(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function unchanged(info) {
  const stat = lstatSync(info.launcher);
  return stat.isSymbolicLink() && JSON.stringify([stat.dev, stat.ino, stat.mtimeMs, stat.size]) === JSON.stringify(info.identity)
    && realpathSync(info.launcher) === info.realEntry;
}
export function inspectGeneration(directory) {
  const root = realpathSync(directory); let bytes = 0;
  function visit(path) {
    for (const name of readdirSync(path)) {
      const file = join(path, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(file);
        if (!target.startsWith(root + "/")) fail("update_closure", "A generation symlink escapes its dependency closure");
      } else if (stat.isDirectory()) visit(file);
      else if (!stat.isFile() || !owned(file)) fail("update_closure", "Unsafe package file ownership or type");
      else bytes += stat.size;
      if (bytes > MAX_BYTES) fail("update_storage", "Update generation exceeds 512 MiB; existing launchers are unchanged");
    }
  }
  visit(root); return bytes;
}
export function activateLauncher(launcher, target) {
  const temporary = `${launcher}.${randomUUID()}.tmp`;
  try { symlinkSync(target, temporary); renameSync(temporary, launcher); syncDirectory(dirname(launcher)); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
/** The lock serializes pointer writers; readers retain their original real module paths forever. */
export async function stageUpdate(plan, { signal, progress = () => {} } = {}) {
  if (plan.reason) fail("update_unavailable", plan.reason);
  const { info, release } = plan, cli = release.cli;
  const directory = join(info.prefix, ".vecteur-updates");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!owned(directory, true)) fail("update_permissions", "Update directory must be private and owned by you");
  const lock = join(directory, "install.lock");
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch { fail("update_locked", `Another updater owns ${lock}; inspect it after a crash before removing it`); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, launcher: info.launcher })); fsyncSync(fd);
  let stage;
  try {
    if (!unchanged(info)) fail("update_changed", "Another process changed this launcher; check again");
    // Never delete a possibly-live generation to make room.
    if (readdirSync(directory).filter(name => name.startsWith("generation-")).length >= 5) fail("update_storage", `Five generations retained in ${directory}; inspect inactive generations before another update`);
    const retained = readdirSync(directory).filter(name => name.startsWith("generation-")).reduce((n, name) => n + inspectGeneration(join(directory, name)), 0);
    const disk = statfsSync(directory);
    if (retained > 2 * MAX_BYTES || disk.bavail * disk.bsize < MAX_BYTES) fail("update_storage", "Not enough space for a verified generation and rollback; old bytes retained");
    stage = join(directory, `generation-${cli.version}-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, "empty.npmrc"), "", { mode: 0o600 }); writeFileSync(join(stage, "empty-global.npmrc"), "", { mode: 0o600 });
    const env = cleanEnvironment(stage);
    const npm = async args => (await run("npm", args, { cwd: stage, env, signal, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    const npmVersion = (await npm(["--version"])).trim();
    if (!/^12\.\d+\.\d+$/.test(npmVersion) || (await npm(["config", "get", "include-attestations"])).trim() !== "false") fail("update_npm_unsupported", "This adapter requires npm 12 with verified attestation output; update npm explicitly through your Node manager");
    const metadataSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
    const metadataResponse = await fetch(`${REGISTRY}/@vecteur%2fcli/${cli.version}`, { redirect: "error", signal: metadataSignal });
    if (!metadataResponse.ok) fail("update_unpublished", "The required CLI package is not published");
    let metadataBytes = 0; const chunks = [];
    for await (const chunk of metadataResponse.body) {
      metadataBytes += chunk.length;
      if (metadataBytes > 2 * 1024 * 1024) fail("update_metadata", "Registry metadata exceeds the size limit");
      chunks.push(chunk);
    }
    const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (metadata.name !== PACKAGE || metadata.version !== cli.version || metadata.dist?.integrity !== cli.integrity
        || !metadata.dist.attestations || !metadata.dist.signatures?.length) fail("update_provenance", "Published package lacks matching integrity, signatures or provenance; installation kept");
    writeFileSync(join(stage, "package.json"), JSON.stringify({ private: true, dependencies: { [PACKAGE]: cli.version } }), { mode: 0o600 });
    progress("Resolving the signed npm dependency closure");
    await npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", REGISTRY]);
    const lockfile = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
    const packages = Object.entries(lockfile.packages ?? {}).filter(([path]) => path);
    if (!packages.length || packages.length > 200) fail("update_closure", "Unexpected dependency closure");
    for (const [path, item] of packages) {
      if (!path.startsWith("node_modules/") || path.includes("..") || item.link || !/^https:\/\/registry\.npmjs\.org\//.test(item.resolved ?? "")
          || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity ?? "")) fail("update_closure", "Dependency closure contains an untrusted source or missing integrity");
    }
    if (lockfile.packages["node_modules/@vecteur/cli"]?.integrity !== cli.integrity) fail("update_integrity", "Resolved package differs from the origin pin");
    progress("Downloading and verifying package signatures and provenance");
    await npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", REGISTRY]);
    const audit = JSON.parse(await npm(["audit", "signatures", "--json", "--include-attestations", "--registry", REGISTRY]));
    if (audit.invalid?.length || audit.missing?.length || !audit.verified?.some(row => row.name === PACKAGE && row.version === cli.version && row.registry?.replace(/\/$/, "") === REGISTRY && row.attestations)) fail("update_provenance", "npm did not verify this CLI's release provenance");
    inspectGeneration(join(stage, "node_modules"));
    const root = join(stage, "node_modules/@vecteur/cli"), pkg = manifest(root);
    if (pkg.name !== PACKAGE || pkg.version !== cli.version || pkg.bin?.vecteur !== "bin/vecteur.js"
        || pkg.vecteur?.updateProtocol !== 1 || pkg.vecteur?.channel !== cli.channel) fail("update_package", "Staged package has an unexpected entrypoint or release channel");
    const source = readFileSync(join(root, "src/contract.js"), "utf8");
    if (!source.includes(`export const OWNER_CONTRACT_IDENTITY = ${JSON.stringify(cli.contract)};`)) fail("update_contract", "Staged package does not match the origin contract");
    const entry = join(root, "bin/vecteur.js");
    // This is the first execution of newly acquired code, after npm's verification.
    const probe = await run(process.execPath, [entry, "--version"], { cwd: stage, env, signal, timeout: 10_000 });
    if (probe.stdout.trim() !== `vecteur ${cli.version}`) fail("update_version", "Staged CLI did not pass its version/Node check");
    const ready = await new VecteurClient({ origin: plan.origin, timeout: 5_000 }).readiness(signal);
    if (ready.contract !== cli.contract || ready.cli?.version !== cli.version || ready.cli?.integrity !== cli.integrity) fail("update_release_changed", "The origin changed its release during download; check again");
    const receipt = { origin: plan.origin, launcher: info.launcher, previous: info.realEntry, target: entry, version: cli.version, contract: cli.contract };
    // Recovery is self-contained and independent of the replacement or any npm dependency.
    const recovery = join(directory, "recover.mjs");
    receipt.recovery = recovery;
    writeStore(join(directory, "activation.json"), receipt);
    writeFileSync(recovery, `import {readFileSync,symlinkSync,renameSync,lstatSync,readlinkSync,openSync,closeSync,writeFileSync,fsyncSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
${syncDirectory.toString()}
${activateLauncher.toString()}
${rollbackLauncher.toString()}
const r=JSON.parse(readFileSync(new URL('./activation.json',import.meta.url)));rollbackLauncher(r);console.log('Restored '+r.previous);
`, { mode: 0o600 });
    if (signal?.aborted) fail("update_cancelled", "Update cancelled before activation");
    if (!unchanged(info)) fail("update_changed", "Launcher changed during staging; original bytes retained");
    progress("Activating the verified CLI; previous package bytes remain available");
    activateLauncher(info.launcher, entry);
    return { ...receipt, recovery, directory };
  } catch (error) {
    // No node_modules tree is ever overwritten; failures before pointer activation are inert.
    if (error instanceof CliError) throw error;
    throw new CliError("update_failed", `Update did not complete; original package bytes retained. ${error.code ?? error.name}`);
  } finally { closeSync(fd); unlinkSync(lock); }
}
export async function interactiveUpdate(session, { check = false, automatic = false } = {}) {
  if (session.offline) { session.message("Offline: no update request was made. /resume reconnects."); return; }
  if (session.busy || session.prompt || session.loginChallenge || session.run?.open || session.registry?.state().pendingRun || session.registry?.state().pendingCreate) {
    if (!automatic) session.message("Update deferred until the Run, login or unresolved submission is finished; your draft stays here.");
    return;
  }
  const plan = await checkUpdate({ origin: session.origin, env: session.env, release: automatic ? session.release : undefined, force: !automatic });
  if (session.closed || session.offline) return;
  if (automatic && plan.mode === "off") return;
  if (check || !plan.needed || plan.reason) {
    if (!automatic || plan.needed) session.message(`${installationText(plan.info)}\n${plan.release.cli || plan.release.requiredVersion ? `Origin requires ${plan.release.cli?.version ?? plan.release.requiredVersion}.` : "Origin does not publish update metadata."}\n${plan.reason || (plan.needed ? "Update available." : "This installation matches the origin.")}\n${plan.reason ? manualRecovery(plan) : ""}`);
    return;
  }
  let action = automatic && plan.mode === "auto" && plan.upgrade && plan.release.compatible && plan.info.channel === plan.release.cli.channel ? "once" : await session.choose(
    `${plan.upgrade ? "Update" : "Switch"} this installation ${plan.info.version} → ${plan.release.cli.version}? Draft saved; pending files must be reselected.`, [
      { label: "Update and continue", value: "once" }, { label: "Keep this installation updated automatically", value: "auto" },
      { label: "Keep drafting here", value: "later" },
    ]);
  if (action === "later") return;
  if (action === "auto") {
    const prefs = preferences(session.env);
    savePreferences({ updates: { ...prefs.updates, [prefKey(plan.info, session.origin)]: "auto" } }, session.env);
  }
  await session.transition(async () => {
    if (session.run?.open || session.offline || session.registry?.state().pendingRun || session.registry?.state().pendingCreate) fail("update_deferred", "Session changed; update deferred");
    session.registry?.saveDraft(session.draft);
    const receipt = await stageUpdate(plan, { signal: session.lifecycle.signal, progress: text => { session.status = text; session.change(); } });
    session.restart = { receipt, args: ["--origin", session.origin, ...(session.noBrowser ? ["--no-browser"] : []), ...(session.terminalFlags ?? [])], env: session.env, cwd: session.cwd };
    session.message(`Verified CLI ${receipt.version} activated. Restarting; no ask is sent. Recovery: ${quote(process.execPath)} ${quote(receipt.recovery)}`);
    session.close();
  });
}
export function rollbackLauncher(receipt) {
  const lock = join(dirname(receipt.recovery), "install.lock");
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch { throw new Error(`Recovery deferred: another updater owns ${lock}`); }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, launcher: receipt.launcher })); fsyncSync(fd);
    if (!lstatSync(receipt.launcher).isSymbolicLink() || resolve(dirname(receipt.launcher), readlinkSync(receipt.launcher)) !== receipt.target) throw new Error("Recovery refused: another process changed the launcher");
    activateLauncher(receipt.launcher, receipt.previous);
  } finally { closeSync(fd); unlinkSync(lock); }
}
export async function restartUpdate({ receipt, args, env, cwd }) {
  const nonce = randomUUID();
  const child = spawn(process.execPath, [receipt.launcher, ...args], { cwd,
    env: { ...env, VECTEUR_UPDATE_SESSION: nonce }, stdio: ["inherit", "inherit", "inherit", "ipc"] });
  return new Promise(resolveExit => {
    let ready = false, finished = false, killTimer;
    const timer = setTimeout(() => {
      if (ready) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(1); }, 2_000);
    }, 20_000);
    child.on("message", value => {
      if (!finished && !killTimer && value?.type === "vecteur-ready" && value.nonce === nonce && value.version === receipt.version
          && value.contract === receipt.contract && value.origin === receipt.origin) {
        ready = true; clearTimeout(timer); child.disconnect();
        process.stderr.write(`Updated to Vecteur ${receipt.version}; origin compatibility confirmed.\n`);
      }
    });
    const finish = code => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer);
      if (!ready) {
        try { rollbackLauncher(receipt); process.stderr.write(`Restart was not verified; previous launcher restored. Run ${quote(receipt.launcher)} --offline to recover your draft.\n`); }
        catch (error) { process.stderr.write(terminalText(`${error.message}; recovery: ${quote(process.execPath)} ${quote(receipt.recovery)}\n`)); }
      }
      resolveExit(ready ? code ?? 1 : 1);
    };
    child.once("error", () => finish(1)); child.once("exit", finish);
  });
}
export async function updateCommand(options) {
  const plan = await checkUpdate({ origin: options.origin, force: true });
  process.stdout.write(terminalText(`${installationText(plan.info)}\n${plan.release.cli || plan.release.requiredVersion ? `Origin requires ${plan.release.cli?.version ?? plan.release.requiredVersion}.` : "No release metadata."}\n${plan.reason || "Verified update can be staged with --yes."}\n${plan.reason ? manualRecovery(plan) : ""}\n`));
  if (options.check) return;
  if (!options.yes) fail("update_confirmation", "Use vecteur update --check or explicitly pass --yes to change this launcher");
  if (plan.needed) {
    const receipt = await stageUpdate(plan);
    process.stdout.write(terminalText(`Activated ${receipt.version}. Launch ${quote(receipt.launcher)}. Recovery: ${quote(process.execPath)} ${quote(receipt.recovery)}\n`));
  }
}
