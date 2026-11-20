import { withAdmissionLock } from "./localfiles.js";
import { CliError } from "./errors.js";
import { runBlocks, blockText } from "./blocks.js";
import { openBrowser } from "./browser.js";
import { diagnose } from "./diagnostics.js";
import { humanCost, humanWorkflow, humanWorkflows, scaffold, terminalText } from "./format.js";
import { requestTimeout } from "./client.js";
import { preferences, savePreferences } from "./preferences.js";

export const SHORTCUTS = `Enter sends when ready; while a Run is working it keeps the draft.
Alt+Enter / Ctrl+J newline; backslash then Enter is the portable fallback.
Bracketed paste never sends. Plain/dumb multiline chunks stay drafts; a split-read
lone CR/CRLF is indistinguishable from Enter and can send.
Tab completes commands; arrows select; Esc closes a menu.
Home/End or Ctrl+A/E: line boundaries. Alt+B/F: words. Ctrl+W: cut word.
Ctrl+K/U: cut line tail/head. Ctrl+Y: restore cut. Ctrl+_: undo edit.
Up/Down: multiline movement, then history at its boundary. Ctrl+R: search history.
? on empty input: shortcuts. Ctrl+O: full block details. Ctrl+L: redraw.
Ctrl+C with text clears it (Ctrl+_ restores). Empty idle Ctrl+C twice exits.
Esc twice or empty Ctrl+C twice requests cancellation of the same cloud Run.
Ctrl+D on empty input saves and detaches; the cloud Run continues. /quit also exits.`;

const rows = [];
const add = (name, description, run, options = {}) => rows.push({ name, description, run, ...options });
add("help", "Find commands and their purpose", (s, query) => s.message(help(query, s)), { argument: "[query]" });
add("shortcuts", "All editing, navigation and Run keys", s => s.message(SHORTCUTS));
add("status", "Account, Project, connection and current state", s => s.message(s.statusDetails()));
add("login", "Sign in through your browser", s => s.initialize({ login: true }));
add("logout", "Sign out here; preserve account drafts", s => s.logout(), { requires: "login" });
add("offline", "Draft without any network activity", s => {
  if (s.busy && !s.loginController) throw new CliError("session_busy", "Wait for this action to finish before disconnecting; your draft is kept");
  s.workOffline();
});
add("resume", "Reconnect or reconcile an interrupted ask", s => s.resume());
add("quit", "Save draft and detach; cloud Run continues", s => s.close(), { aliases: ["exit"] });
add("drafts", "Recover a saved draft", s => s.recoverDraft());
add("clear", "Clear this draft; Ctrl+_ restores the edit", s => { s.lastClearedDraft = s.draft; s.setDraft(""); });
add("mode", "Model, execution location and payer", s => s.message(s.modeDetails()));
add("model", "Choose the next Run's model", s => s.modelChoice(), { requires: "login" });
add("deep", "Deep engineering off or on for the next Runs (on by default with Pro)", s => s.toggleDeep(), { requires: "login" });
add("usage", "Read the Project's server-authored usage", async s => {
  if (!s.project) throw new CliError("project_unavailable", "Choose a Project first with /project");
  const client = s.client, project = s.project;
  const value = await client.customerCost(project.id);
  if (s.client === client && s.project === project) s.message(humanCost(value));
}, { requires: "login" });
add("settings", "Plain display, reduced motion and updates", async s => {
  const key = await s.choose("Settings", [
    { label: "Display: rich or plain", value: "plain" }, { label: "Reduced motion", value: "reducedMotion" },
    { label: "Automatic updates for this installation", value: "updates" },
  ]);
  if (key === "updates") { const { updatePreference } = await import("./update.js"); return updatePreference(s); }
  const value = await s.choose(key === "plain" ? "Display" : "Reduced motion", [
    { label: key === "plain" ? "Rich terminal" : "Enabled", value: key !== "plain" },
    { label: key === "plain" ? "Plain / screen reader" : "Disabled", value: key === "plain" },
  ]);
  savePreferences({ [key]: value }, s.env); s.emit("preferences", preferences(s.env)); s.message("Preference saved.");
});
add("update", "Check or update this exact installation", async (s, argument) => {
  if (argument && argument !== "check") throw new CliError("usage_invalid", "Use /update or /update check");
  const { interactiveUpdate } = await import("./update.js"); return interactiveUpdate(s, { check: argument === "check" });
}, { argument: "[check]" });
add("project", "Choose a Project or start a new study draft", async (s, argument) => {
  if (argument === "list") {
    const client = s.client, account = s.account;
    const projects = await client.projectList();
    if (s.client === client && s.account === account) s.message(projects.map(p => `${p.name} · ${p.role} · ${p.id}`).join("\n") || "No Projects yet.");
    return;
  }
  if (argument) throw new CliError("usage_invalid", "Use /project or /project list");
  const action = await s.choose("Project", [
    { label: "Open an existing Project without linking", value: "open" },
    { label: "Link an existing Project to this folder", value: "link" },
    { label: "Start a new study on next send", value: "new" },
  ]);
  if (action !== "new") return s.link({ persist: action === "link" });
  if (s.run?.open || s.registry.state().pendingRun || s.registry.state().pendingCreate) throw new CliError("run_busy", "Resolve or finish the current Run before starting a new study");
  await withAdmissionLock(() => s.registry.unlink(), s.env); s.binding = null; s.project = null; s.run = null; s.attachments = []; s.status = "New Project on first send"; s.change();
}, { argument: "[list]", requires: "login" });
add("workflow", "List the guided workflows, or start a draft from one", async (s, id) => {
  if (s.offline) throw new CliError("action_unavailable", "Offline — /resume");
  const { data } = await s.clientFactory({ origin: s.origin, token: "", timeout: requestTimeout(s.env) }).workflows();
  if (!id) return s.message(humanWorkflows(data).trimEnd());
  const workflow = data.find(item => item.id === id);
  if (!workflow) throw new CliError("workflow_not_found", `No workflow ${id}; /workflow lists them`);
  // The engineer's own text is never replaced; an untouched scaffold is.
  if (s.draft.trim() && !data.map(scaffold).includes(s.draft)) throw new CliError("draft_kept", "Your draft is kept; /clear it first to start from a workflow");
  // The blanks this draft may still hold: a send with one left is held here, before any upload or Project is made.
  s.blanks = data.flatMap(item => item.arguments.map(argument => `[${argument.description}]`));
  s.setDraft(scaffold(workflow)); s.message(humanWorkflow(workflow, false).trimEnd());
}, { argument: "[id]" });
add("link", "Link an existing Project to this folder", s => s.link(), { requires: "login" });
add("unlink", "Remove this folder's Project binding", async s => {
  if (s.run?.open || s.busy || s.registry.state().pendingRun || s.registry.state().pendingCreate) throw new CliError("run_busy", "Resolve or finish the current Run before unlinking");
  s.followController?.abort(); s.generation++; await withAdmissionLock(() => s.registry.unlink(), s.env); s.binding = null; s.project = null; s.run = null; s.status = "Folder unlinked"; s.change();
}, { requires: "login" });
add("history", "Read earlier Runs in this Project", s => s.history(), { requires: "login" });
add("name", "Name the Project", (s, value) => s.transition(async () => {
  if (s.project) { s.requireLogin(); s.project = await s.client.projectRename(s.project.id, value); } else s.projectName = value;
  s.change();
}), { argument: "<name>", required: true });
add("attach", "Select one file; preview its upload destination", async (s, path) => {
  if (!path) path = await s.choose("File path (only this file is read; blank cancels)", [], { typed: true });
  if (path.trim()) return s.attach(path.replace(/^(['"])(.*)\1$/, "$2"));
}, { argument: "<path>" });
add("clear-files", "Remove pending attachments", s => {
  if (s.busy || s.registry?.state().pendingRun) throw new CliError("session_busy", "Resolve the pending action before clearing files");
  s.attachments = []; s.change();
});
add("files", "Selected inputs, local authority and downloadable results", (s, argument) => {
  if (argument === 'revoke') return s.revokeFiles();
  const match = /^save (\d+)$/.exec(argument);
  if (match) return s.transition(() => s.offerSaves(Number(match[1])));
  const diff = /^diff (\d+)$/.exec(argument);
  if (diff) return s.transition(() => s.fileDiff(Number(diff[1])));
  if (argument) throw new CliError('usage_invalid', 'Use /files, /files revoke, /files save N or /files diff N');
  return s.listFiles();
}, {argument:'[revoke|save N|diff N]'});
add("download", "Save and verify a result file", (s, argument) => {
  const match = /^(\d+)(?:\s+(.+))?$/.exec(argument);
  if (!match) throw new CliError("usage_invalid", "Use /download <artifact number> [output path]");
  return s.download(Number(match[1]), match[2]);
}, { argument: "<number> [path]", required: true, requires: "login" });
add("export", "Export the answer, Run record and verified files to a new folder", (s, path) => s.exportRun(path || undefined), { argument: "[folder]", requires: "login" });
add("copy", "Copy the exact answer or save it to a new file", (s, path) => s.copy(path || undefined), { argument: "[path]" });
add("cancel", "Request cancellation; keep completed work", s => s.cancel(), { requires: "run" });
add("details", "Read the current or numbered block in full", (s, argument) => {
  const blocks = runBlocks(s.run);
  const block = argument ? blocks[Number(argument) - 1] : blocks.findLast(b => b.kind === "tool") ?? blocks.at(-1);
  s.message(block ? terminalText(blockText(block, { full: true })) : "No block details yet.");
}, { argument: "[number]" });
add("handoff", "Open your Claude Code or Codex here with Vecteur attached", (s, vendor) => {
  if (!["claude", "codex"].includes(vendor)) throw new CliError("usage_invalid", "Use /handoff claude or /handoff codex");
  if (s.busy) throw new CliError("session_busy", "Wait for this action to finish before handing off");
  s.emit("handoff", vendor);
}, { argument: "<claude|codex>", required: true });
add("web", "Open this Project in the browser", s => {
  const url = s.project ? `${s.origin}/dashboard/${encodeURIComponent(s.project.id)}` : s.origin;
  s.message(url); if (!s.noBrowser && !s.offline) void openBrowser(url);
});
add("doctor", "Diagnose connection and installation", async s => {
  const client = s.client, account = s.account;
  const result = await diagnose({ env: s.env, origin: s.origin, client, offline: s.offline });
  if (s.client === client && s.account === account) s.message(result.text);
});
export const COMMANDS = Object.freeze(rows.map(Object.freeze));
export function unavailable(row, session) {
  if (!row.requires) return "";
  if (session.offline) return "Offline — /resume";
  if (!session.account) return "Sign in — /login";
  if (row.requires === "login") return "";
  if (session.project?.role === "VIEWER") return "Read-only Project";
  return session.run?.open ? "" : "No running Run";
}
export function completions(query = "", session) {
  const text = query.replace(/^\//, "").toLowerCase();
  return COMMANDS.filter(row => `${row.name} ${row.description}`.toLowerCase().includes(text))
    .map(row => ({ ...row, disabled: session ? unavailable(row, session) : "" }))
    .sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) || Number(b.name === text) - Number(a.name === text));
}
export function help(query = "", session) {
  return completions(query, session).map(row => `/${row.name}${row.argument ? " " + row.argument : ""} — ${row.description}${row.disabled ? ` (${row.disabled})` : ""}`).join("\n") + "\n/shortcuts lists every key. Esc twice cancels the current Run.";
}
export const HELP = help();
export async function command(session, input) {
  if (input.startsWith("//")) return session.submit(input.slice(1));
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return session.submit(input);
  const [, name, argument = ""] = match;
  if (name === "device") { session.message("Computer connection is not available in this version."); return; }
  const row = COMMANDS.find(row => row.name === name || row.aliases?.includes(name));
  if (!row) throw new CliError("command_unknown", `Unknown /${name}; /help searches commands. Use // to send literal text starting with /.`);
  const reason = unavailable(row, session);
  if (reason) throw new CliError("action_unavailable", reason);
  let value = argument;
  if (row.required && !value.trim()) value = await session.choose(`/${row.name} ${row.argument} (blank cancels)`, [], { typed: true });
  if (row.required && !value.trim()) return;
  return row.run(session, value);
}
