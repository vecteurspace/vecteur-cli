#!/usr/bin/env node
import { Executor } from "../src/executor.js";
import { withLocalLock, executionGrant, rootIdentity, qualify } from "../src/localfiles.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  CliError, VecteurClient, admittedFailure, configuration, isStateHash, isTokenShaped, redact,
  requestTimeout, resolveOrigin, shouldOpenBrowser, waitForDeviceAuthorization, isRequestKey, validateAnswers,
} from "../src/client.js";
import {
  clearCredentials, credentialsPath, readCredentials, setCurrentOrigin, writeCredentials, selectProject,
} from "../src/credentials.js";
import { downloadArtifact, downloadProjection, exportRun } from "../src/download.js";
import { humanProjects, resolveNamed, resolveRunProject, resolveWorkspace } from "../src/projects.js";
import { canonicalJson, currentTransferTables, human, stopViewOf, humanCost, progress } from "../src/format.js";
import { openBrowser } from "../src/browser.js";

function manifest() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}

function versionParts(raw) {
  const match = String(raw).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function refuseOldNode() {
  const declared = manifest().engines?.node;
  if (typeof declared !== "string" || !declared.startsWith(">=")) {
    throw new CliError("engines_invalid", "package engines.node must be a >= floor");
  }
  const floor = versionParts(declared.slice(2));
  const current = versionParts(process.versions.node);
  if (!floor || !current) {
    throw new CliError("engines_invalid", "package engines.node must be a >= floor");
  }
  const below = current[0] < floor[0]
    || (current[0] === floor[0] && current[1] < floor[1])
    || (current[0] === floor[0] && current[1] === floor[1] && current[2] < floor[2]);
  if (below) {
    throw new CliError("node_version_unsupported",
      `Node ${process.versions.node} is below engines.node ${declared}`);
  }
}

function helpText(version) {
  return `vecteur ${version}
  login | logout | whoami | project list | project create <name> [--workspace <name-or-id>] | project use <name-or-id> | project get <id> | run submit [-p <id>] -a <ask> [--parent <state-hash>] | run get <id> | run events <id> | run export <id> [--output <dir>] [-p <id>] | artifact get <id> [--output <path>] [-p <id>] | projection get <run-id> <projection-id> [--output <path>] [-p <id>] | mcp
  mcp setup claude|codex adds Vecteur to your Claude Code/Codex · handoff claude|codex opens it in this terminal with Vecteur attached
  status | doctor | (bare vecteur opens an interactive session)
  --help  --version  --json  --origin <url>  --no-browser  --offline  --plain  --no-color  --local  -p/--project  -a/--ask  --output <path>
  update [--check] [--yes] [--origin <url>] updates the executing installation
  run submit continues the Project's current head; --parent <state-hash> admits it only if that is still the head
  run submit --no-wait --request-key K [--parent H|none] [--attach PATH…] -p ID -a ASK --json
  run answer RUN --clarification ID --answers FILE|- --json
  Claude Code/Codex recipe: submit --no-wait --parent H --request-key K --attach PATH…; run get / run events; run answer; run export
`;
}

function writeStatus(env = process.env) {
  const saved = readCredentials(env);
  if (saved?.current) {
    process.stdout.write(`${saved.current}\nnext: vecteur whoami\n`);
  } else {
    process.stdout.write("not logged in\nnext: vecteur login\n");
  }
}

function parseCommand(argv) {
  let args = [...argv];
  const value = (candidate) => typeof candidate === "string" && candidate.length > 0 &&
    !candidate.startsWith("-");
  const takeFlag = (...names) => {
    const indexes = args.flatMap((arg, i) => names.includes(arg) ? [i] : []);
    if (indexes.length > 1) throw new CliError("usage_invalid", "Invalid command grammar");
    if (indexes.length === 0) return false;
    args = args.filter((_, i) => i !== indexes[0]);
    return true;
  };
  const takeOption = (...names) => {
    const indexes = args.flatMap((arg, i) => names.includes(arg) ? [i] : []);
    if (indexes.length > 1) throw new CliError("usage_invalid", "Invalid command grammar");
    if (indexes.length === 0) return undefined;
    const index = indexes[0];
    if (!value(args[index + 1]) && !(names.includes("--answers") && args[index + 1] === "-")) throw new CliError("usage_invalid", "Invalid command grammar");
    const option = args[index + 1];
    args = args.filter((_, i) => i !== index && i !== index + 1);
    return option;
  };
  const paths = [];
  while (args.includes("--attach")) {
    const index = args.indexOf("--attach");
    let end = index + 1;
    while (value(args[end])) paths.push(args[end++]);
    if (end === index + 1) throw new CliError("usage_invalid", "--attach requires explicit paths");
    args.splice(index, end - index);
  }
  const version = takeFlag("--version");
  const help = takeFlag("--help");
  const json = takeFlag("--json");
  const origin = takeOption("--origin");
  const noBrowser = takeFlag("--no-browser");
  const offline = takeFlag("--offline");
  const checkUpdate = takeFlag("--check"), yesUpdate = takeFlag("--yes");
  const plain = takeFlag("--plain");
  const noColor = takeFlag("--no-color");
  const local = takeFlag("--local");
  const projectId = takeOption("--project", "-p");
  const ask = takeOption("--ask", "-a");
  const workspace = takeOption("--workspace");
  const output = takeOption("--output");
  const parent = takeOption("--parent");
  const noWait = takeFlag("--no-wait"), requestKey = takeOption("--request-key");
  const allowExec = takeFlag("--allow-exec");
  if (allowExec && (noWait || requestKey !== undefined || args[0] !== "run" || args[1] !== "submit")) {
    throw new CliError("usage_invalid", "--allow-exec requires foreground run submit, without --no-wait or --request-key; MCP has no local executor");
  }
  const clarification = takeOption("--clarification"), answers = takeOption("--answers");
  if (parent !== undefined && (!(isStateHash(parent) || noWait && parent === "none") || args[0] !== "run" || args[1] !== "submit")) {
    throw new CliError("usage_invalid", "Invalid command grammar");
  }
  if (args.some((arg) => typeof arg === "string" && arg.startsWith("-"))) {
    throw new CliError("usage_invalid", "Invalid command grammar");
  }
  if (version) return { kind: "version" };
  if (help) return { kind: "help" };
  if (noWait || requestKey !== undefined || paths.length || clarification !== undefined || answers !== undefined) {
    const common = !noBrowser && !offline && !checkUpdate && !yesUpdate && !plain && !noColor && !local
      && workspace === undefined && output === undefined;
    if (common && args.length === 2 && args[0] === "run" && args[1] === "submit" && noWait
        && value(ask) && clarification === undefined && answers === undefined) {
      if (!isRequestKey(requestKey)) throw new CliError("request_key_invalid", "--request-key requires 8–64 letters, digits, _ or -");
      return { kind: "run_start", projectId, ask, requestKey, parent: parent === "none" ? null : parent, paths, origin, json };
    }
    if (common && args.length === 3 && args[0] === "run" && args[1] === "answer" && value(args[2])
        && value(clarification) && answers !== undefined && !noWait && requestKey === undefined && !paths.length
        && projectId === undefined && ask === undefined && parent === undefined) {
      return { kind: "run_answer", id: args[2], clarification, answers, origin, json };
    }
    throw new CliError("usage_invalid", "Invalid command grammar");
  }
  if (args.length === 1 && args[0] === "update" && !json && !local && !offline && !plain && !noColor
      && !noBrowser && projectId === undefined && ask === undefined && workspace === undefined && output === undefined && parent === undefined) {
    return { kind: "update", origin, check: checkUpdate, yes: yesUpdate };
  }
  if (checkUpdate || yesUpdate) throw new CliError("usage_invalid", "--check and --yes apply only to update");
  if (!args.length && !json && !local && projectId === undefined && ask === undefined
      && workspace === undefined && output === undefined && parent === undefined) {
    return { kind: "session", origin, noBrowser, plain, noColor, offline };
  }
  if (offline) throw new CliError("usage_invalid", "--offline applies only to an interactive session");
  if (plain || noColor) throw new CliError("usage_invalid", "--plain and --no-color apply to an interactive session");
  const extra = json || origin !== undefined || noBrowser || local
    || projectId !== undefined || ask !== undefined || workspace !== undefined || output !== undefined;
  if (args.length === 1 && ["status", "doctor"].includes(args[0]) && !extra) return { kind: args[0] };
  if (args.length === 1 && args[0] === "mcp" && !extra) return { kind: "mcp" };
  if (!extra && ((args.length === 3 && args[0] === "mcp" && args[1] === "setup") || (args.length === 2 && args[0] === "handoff"))) {
    return { kind: "vendor", mode: args[0] === "mcp" ? "setup" : "handoff", vendor: args.at(-1) };
  }
  if (args[0] === "project" && projectId === undefined && ask === undefined && output === undefined
      && !noBrowser && !local) {
    if (args.length === 3 && args[1] === "create" && value(args[2])) {
      return { kind: "project_create", name: args[2], workspace, origin, json };
    }
    if (workspace === undefined && args.length === 2 && args[1] === "list") {
      return { kind: "project_list", origin, json };
    }
    if (workspace === undefined && args.length === 3 && args[1] === "use" && value(args[2])) {
      return { kind: "project_use", name: args[2], origin, json };
    }
  }
  if (workspace !== undefined) throw new CliError("usage_invalid", "Invalid command grammar");
  if (args.length === 1 && args[0] === "login" && !local
      && projectId === undefined && ask === undefined && output === undefined) {
    return { kind: "login", origin, noBrowser, json };
  }
  if (args.length === 1 && args[0] === "logout" && !noBrowser
      && projectId === undefined && ask === undefined && output === undefined) {
    return { kind: "logout", origin, local, json };
  }
  if (args.length === 1 && args[0] === "whoami" && !noBrowser && !local
      && projectId === undefined && ask === undefined && output === undefined) {
    return { kind: "whoami", origin, json };
  }
  if (noBrowser || local) throw new CliError("usage_invalid", "Invalid command grammar");
  if (args.length === 3 && args[0] === "project" && args[1] === "get" && value(args[2])
      && projectId === undefined && ask === undefined && output === undefined) {
    return { kind: "project_get", id: args[2], origin, json };
  }
  if (args.length === 2 && args[0] === "run" && args[1] === "submit"
      && (projectId === undefined || value(projectId)) && value(ask) && output === undefined) {
    return { kind: "run_submit", projectId, ask, parent, origin, json, allowExec };
  }
  if (args.length === 3 && args[0] === "run" && args[1] === "get" && value(args[2])
      && projectId === undefined && ask === undefined && output === undefined) {
    return { kind: "run_get", id: args[2], origin, json };
  }
  if (args.length === 3 && args[0] === "run" && args[1] === "events" && value(args[2])
      && projectId === undefined && ask === undefined && output === undefined) {
    return { kind: "run_events", id: args[2], origin, json };
  }
  if (args.length === 3 && args[0] === "run" && args[1] === "export" && value(args[2]) && ask === undefined) {
    return { kind: "run_export", id: args[2], projectId, output, origin, json };
  }
  if (args.length === 3 && args[0] === "artifact" && args[1] === "get" && value(args[2])
      && ask === undefined) {
    return { kind: "artifact_get", id: args[2], projectId, output, origin, json };
  }
  if (args.length === 4 && args[0] === "projection" && args[1] === "get"
      && value(args[2]) && value(args[3]) && ask === undefined) {
    return { kind: "projection_get", runId: args[2], id: args[3], projectId, output, origin, json };
  }
  throw new CliError("usage_invalid", "Invalid command grammar");
}

/**
 * `--origin` moves the STORE's current origin, and only the store path may do it.
 *
 * When the credential came from the environment there is no stored login for the named origin
 * to become current, writing to the store is the one thing the CI path must not do, and reading
 * it is how an unreadable file broke a run that never needed one. Both callers ask here rather
 * than each remembering the rule, because one of them already forgot it.
 */
function rememberOrigin(flagOrigin, origin, env) {
  if (flagOrigin && !env.VECTEUR_TOKEN) setCurrentOrigin(origin, env);
}

function writeLoggedOut(json, path) {
  process.stdout.write(json
    ? canonicalJson({ logged_in: false, credentials: path })
    : `logged out\ncredentials removed: ${path}\n`);
}

async function login(command, env = process.env) {
  const origin = resolveOrigin(env, undefined, command.origin);
  const timeout = requestTimeout(env);
  const client = new VecteurClient({ origin, token: "", timeout });
  const grant = await client.deviceMint();
  const prompt = `Visit ${grant.verification_uri_complete}\nUser code: ${grant.user_code}\n`;
  (command.json ? process.stderr : process.stdout).write(prompt);
  if (shouldOpenBrowser(command.noBrowser, env)) openBrowser(grant.verification_uri_complete);
  const created = await waitForDeviceAuthorization(client, grant);
  if (!isTokenShaped(created.token)) {
    throw new CliError("pat_created_invalid", "Server returned malformed owner data");
  }
  const previous = readCredentials(env)?.logins?.[origin]?.token;
  if (previous) {
    try {
      await new VecteurClient({ origin, token: previous, timeout }).credentialSelfRevoke();
    } catch (error) {
      if (!(error instanceof CliError && ["pat_revoked", "pat_expired", "pat_invalid"].includes(error.code))) throw error;
    }
  }
  const path = writeCredentials({ origin, token: created.token }, env);
  const account = await new VecteurClient({ origin, token: created.token, timeout }).accountMe();
  process.stdout.write(command.json
    ? canonicalJson({ logged_in: true, origin, credentials: path, account })
    : `logged in to ${origin}\n${renderAccount(account, origin)}credentials: ${path}\n`);
}

async function logout(command, env = process.env) {
  const path = credentialsPath(env);
  let saved;
  try {
    saved = readCredentials(env);
  } catch (error) {
    if (!command.local) throw error;
    clearCredentials(env);
    writeLoggedOut(command.json, path);
    return;
  }
  if (!saved) {
    writeLoggedOut(command.json, path);
    return;
  }
  const origin = resolveOrigin(env, saved, command.origin);
  const token = saved.logins[origin]?.token;
  if (!token) {
    throw new CliError("origin_mismatch",
      `the stored login is for ${saved.current} and ${command.origin !== undefined ? "--origin" : "VECTEUR_BASE_URL"} names `
      + `${origin} — set VECTEUR_TOKEN for that origin, or log in to it`);
  }
  if (!command.local) {
    try {
      await new VecteurClient({ origin, token, timeout: requestTimeout(env) }).credentialSelfRevoke();
    } catch (error) {
      if (error instanceof CliError && (error.code === "request_failed" || error.code === "request_timeout")) {
        throw new CliError("logout_offline",
          "logout requires the origin; pass --local to delete only this machine's store");
      }
      throw error;
    }
  }
  writeLoggedOut(command.json, clearCredentials(env, origin));
}

function renderAccount(account, origin) {
  return `${account.display_name} <${account.email}> (${account.id}) at ${origin}\n`;
}

async function whoami(command, env = process.env) {
  const config = configuration(env, undefined, command.origin);
  rememberOrigin(command.origin, config.origin, env);
  const account = await new VecteurClient(config).accountMe();
  process.stdout.write(command.json
    ? canonicalJson(account)
    : renderAccount(account, config.origin));
}

async function main() {
  refuseOldNode();
  const command = parseCommand(process.argv.slice(2));
  if (command.allowExec) qualify();
  if (command.kind === "version") {
    process.stdout.write(`vecteur ${manifest().version}\n`);
    return;
  }
  if (command.kind === "help") {
    process.stdout.write(helpText(manifest().version));
    return;
  }
  if (command.kind === "status") {
    writeStatus();
    return;
  }
  if (command.kind === "doctor") {
    const { diagnose } = await import("../src/diagnostics.js");
    const result = await diagnose();
    process.stdout.write(result.text + "\n");
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command.kind === "session") {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI !== undefined) {
      if (command.plain || command.noColor || command.origin || command.noBrowser || command.offline) {
        throw new CliError("terminal_required", "Interactive options need a terminal; use existing subcommands for scripts");
      }
      writeStatus(); return;
    }
    const { startTerminal } = await import("../src/terminal.js");
    await startTerminal(command);
    return;
  }
  if (command.kind === "update") {
    const { updateCommand } = await import("../src/update.js");
    await updateCommand(command);
    return;
  }
  if (command.kind === "vendor") {
    const { VENDORS, executingServer, runVendor, shellLine, vendorArgv } = await import("../src/vendors.js");
    const argv = vendorArgv(command.vendor, command.mode, command.mode === "handoff" ? executingServer() : undefined);
    process.stderr.write(command.mode === "setup"
      ? `Adding Vecteur to ${VENDORS[command.vendor]} with its own command:\n  ${shellLine(argv)}\n`
      : `Opening your ${VENDORS[command.vendor]} terminal with Vecteur attached for this session only.\n`
        + `${VENDORS[command.vendor]} keeps its own login and billing; exit it to return here.\n`);
    process.exitCode = await runVendor(argv);
    return;
  }
  if (command.kind === "mcp") {
    const { serveVecteurMcp } = await import("../src/mcp.js");
    serveVecteurMcp();
    return;
  }

  // Login and logout run BEFORE a client is constructed from configuration(): requiring a
  // valid login in order to log in (or to delete a corrupt store locally) is the shape of
  // bug that makes a first run or a recovery impossible. VECTEUR_TOKEN is the CI path and
  // is never written or revoked here.
  if (command.kind === "login") {
    await login(command);
    return;
  }
  if (command.kind === "logout") {
    await logout(command);
    return;
  }
  if (command.kind === "whoami") {
    await whoami(command);
    return;
  }

  const config = configuration(process.env, undefined, command.origin);
  rememberOrigin(command.origin, config.origin, process.env);
  const client = new VecteurClient(config);
  const onEvent = command.json ? null : (event) => process.stderr.write(progress(event));
  let value;
  let renderOptions = {};
  if (command.kind === "project_list") {
    const [account, projects] = await Promise.all([client.accountMe(), client.projectList()]);
    value = { projects, active_projects: account.entitlements.active_projects,
      selected_project_id: config.projectId ?? null };
    process.stdout.write(command.json ? canonicalJson(value) : humanProjects(value));
    return;
  } else if (command.kind === "project_create") {
    const account = await client.accountMe();
    value = await client.projectCreate(command.name, resolveWorkspace(account, command.workspace));
  } else if (command.kind === "project_use") {
    if (process.env.VECTEUR_TOKEN) throw new CliError("persistent_login_required",
      "project use requires a persistent login; unset VECTEUR_TOKEN and run `vecteur login`");
    value = resolveNamed(await client.projectList(), command.name, "project");
    selectProject(config.origin, value.id);
  } else if (command.kind === "project_get") value = await client.projectGet(command.id);
  else if (command.kind === "artifact_get") {
    const projectId = await resolveRunProject(client, command.projectId);
    value = await downloadArtifact(client, command.id, projectId, command.output);
    process.stdout.write(command.json ? canonicalJson(value)
      : `Downloaded ${value.bytes} bytes to ${value.path} (${value.content_type})\n`);
    return;
  }
  else if (command.kind === "run_export") {
    const projectId = await resolveRunProject(client, command.projectId);
    value = await exportRun(client, await client.runGet(command.id), projectId,
      command.output ?? `vecteur-run-${command.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12)}`);
    process.stdout.write(command.json ? canonicalJson(value) : `Exported Run ${value.run_id} (${value.terminal}) to ${value.directory}\n`
      + value.files.map(file => `  ${file.path} · ${file.bytes} bytes${file.cas_ref ? " · verified" : ""}\n`).join(""));
    return;
  }
  else if (command.kind === "projection_get") {
    const projectId = await resolveRunProject(client, command.projectId);
    const run = await client.runGet(command.runId);
    const matches = run.events.filter(event => event.kind === "engineering_projection"
      && event.payload?.projection_id === command.id && event.payload?.kind === "transfer_table");
    if (matches.length !== 1) throw new CliError("projection_invalid", "Run has no unique transfer table projection");
    value = await downloadProjection(client, projectId, command.runId, matches[0].payload, command.output);
    process.stdout.write(command.json ? canonicalJson(value)
      : `Downloaded ${value.bytes} bytes to ${value.path} (${value.content_type}; ${value.disposition})\n`);
    return;
  }
  else if (command.kind === "run_start") {
    const projectId = await resolveRunProject(client, command.projectId);
    value = await client.runStartLocal(projectId, command.ask, { requestKey: command.requestKey,
      parentStateHash: command.parent, paths: command.paths });
    process.stdout.write(canonicalJson(value));
    return;
  }
  else if (command.kind === "run_answer") {
    let answers;
    try { answers = JSON.parse(readFileSync(command.answers === "-" ? 0 : command.answers, "utf8")); }
    catch { throw new CliError("answers_invalid", "--answers must name a readable JSON answer array, or - for stdin"); }
    value = await client.clarificationAnswer(command.id, command.clarification, validateAnswers(answers));
    process.stdout.write(canonicalJson(value));
    return;
  }
  else if (command.kind === "run_submit") {
    const projectId = await resolveRunProject(client, command.projectId);
    let executor;
    if (command.allowExec) {
      const project = await client.projectGet(projectId);
      const pin = { origin: client.config.origin, accountId: "credential:" + createHash("sha256").update(client.config.token).digest("hex"), projectId, role: project.role,
        root: rootIdentity(process.cwd()), provenance: "invocation", credential: { token: client.config.token,
          kind: process.env.VECTEUR_TOKEN ? "environment" : "stored" } };
      const grant = await withLocalLock(() => executionGrant(pin));
      executor = new Executor({ client, grant, pin: () => pin, session: true });
    }
    value = await client.runSubmit(projectId, command.ask, onEvent, undefined, command.parent, undefined, undefined, executor);
    if (!command.json) {
      try {
        const currentTransferIds = await verifiedTransferIds(client, value);
        const stopped = stopViewOf(value.events);
        const stopOffer = stopped ? await client.stopOffer(value.run_id) : undefined;
        if (stopped?.cause === "plan_limit") await client.stopEvent(value.run_id, { event: "shown", surface: "cli" });
        process.stdout.write(human(value, { projectId, currentTransferIds, stopOffer, origin: config.origin }));
        // A stop states the limit that fired; "22 % used" below it reads as a contradiction (record §3). `vecteur` usage stays one command away.
        if (!stopped) {
          const cost = await client.customerCost(projectId);
          process.stdout.write(`\n${humanCost(cost)}`);
        }
      } catch (error) {
        throw admittedFailure(error, value.run_id);
      }
      return;
    }
  } else if (command.kind === "run_get") value = await client.runGet(command.id);
  else value = await client.runEvents(command.id, onEvent);
  if (!command.json && !renderOptions.projectId && config.projectId) {
    renderOptions = { projectId: config.projectId };
  }
  if (!command.json && Array.isArray(value?.events)) {
    renderOptions.currentTransferIds = await verifiedTransferIds(client, value);
    const stopped = stopViewOf(value.events);
    if (stopped) {
      renderOptions.stopOffer = await client.stopOffer(value.run_id);
      if (stopped.cause === "plan_limit") await client.stopEvent(value.run_id, { event: "shown", surface: "cli" });
    }
    renderOptions.origin = config.origin;
  }
  process.stdout.write(command.json ? canonicalJson(value) : human(value, renderOptions));
}

async function verifiedTransferIds(client, run) {
  const ids = new Set();
  for (const projection of currentTransferTables(run.events ?? [])) {
    const read = await client.projectionGet(
      projection.project_id, run.run_id, projection, async () => {},
    );
    if (read.disposition === "current") ids.add(projection.projection_id);
  }
  return ids;
}

// Skip option values when identifying the new doors: a legacy ask containing "answer"
// must still print the legacy error bytes, including on a parser/configuration failure.
function lifecycleInvocation(argv) {
  const tokens = [];
  let noWait = false;
  const options = new Set(["--origin", "--project", "-p", "--ask", "-a", "--workspace", "--output", "--parent",
    "--request-key", "--clarification", "--answers"]);
  for (let i = 0; i < argv.length; i++) {
    if (options.has(argv[i])) { i++; continue; }
    if (argv[i] === "--no-wait") { noWait = true; continue; }
    if (argv[i] === "--attach") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) i++;
      continue;
    }
    if (!argv[i].startsWith("-")) tokens.push(argv[i]);
  }
  return tokens[0] === "run" && (tokens[1] === "answer" || tokens[1] === "submit" && noWait);
}

main().catch((error) => {
  const code = error instanceof CliError ? error.code : "internal_error";
  const argv = process.argv.slice(2);
  const structured = lifecycleInvocation(argv);
  const message = redact(error?.message ?? "CLI failed");
  const details = Object.fromEntries(["run_id", "request_key", "parent_state_hash"]
    .filter(field => error instanceof CliError && Object.hasOwn(error, field))
    .map(field => [field, typeof error[field] === "string" ? redact(error[field]) : error[field]]));
  process.stderr.write(structured ? canonicalJson({ code, message, ...details }) : `${code}: ${message}\n`);
  process.exitCode = code === "usage_invalid" ? 2 : 1;
});
